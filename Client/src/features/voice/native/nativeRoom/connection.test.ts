import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../../../../tests/helpers/nativeRoomMocks";
import type { Participant, VideoQuality } from "livekit-client";
import { createNativeRoom } from "../nativeRoom";
import { nativeCounters } from "../counters";
import {
  setEncryptionDegraded,
  setLocalDeafened,
  voiceStore,
} from "../../../../stores/voice.store";
import {
  createRoomEventHandlers,
  type RoomEventDeps,
} from "../../../../lib/voice/roomEventHandlers";
import {
  audio,
  emit,
  micCalls,
  gateCalls,
  video,
  views,
  settle,
  cameraOptions,
  startCamera,
  track2,
  screenOptions,
  share,
  rejectOnce,
  connected,
  reportEncryption,
} from "../../../../../tests/helpers/nativeRoomHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("../../../../lib/logger", () => mocks.loggerMock());
vi.mock("../videoRenderer", () => mocks.videoRendererMock());
vi.mock("../screenPicker", () => mocks.screenPickerMock());
vi.mock("../../../../platform/desktop", () => mocks.platformDesktopMock());

const { log, host, track } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  host.calls.length = 0;
  host.handlers.clear();
  host.unsubscribed = 0;
  host.connectResult = Promise.resolve({
    session: 1,
    identity: "user-1",
    frames: "ws://127.0.0.1:9/tok",
  });
  host.publishCamera = () => Promise.resolve("TR_cam");
  host.startCamera = () => Promise.resolve({ capture: 5, width: 1280, height: 720 });
  host.changeCamera = () => Promise.resolve({ capture: 7, width: 960, height: 720 });
  host.setVideoView = () => Promise.resolve();
  host.getStats = () => Promise.resolve(null);
  host.pick = () =>
    Promise.resolve({
      source: "screen:7",
      quality: "low",
      fps: 30,
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
      simulcast: false,
    });
  host.startScreen = () => Promise.resolve({ capture: 4, width: 1280, height: 720 });
  host.changeScreen = () => Promise.resolve({ capture: 6, width: 800, height: 600 });
  host.setScreenQuality = () =>
    Promise.resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 });
  host.notedQuality.length = 0;
  host.pickChange = () => Promise.resolve("window:9");
  host.publishScreenAudio = () => Promise.resolve("TR_audio");
  host.noted = [];
  nativeCounters.screenTracks = 0;
  host.renderers.length = 0;
  nativeCounters.openRooms = 0;
  nativeCounters.listeners = 0;
  nativeCounters.rust = null;
  setLocalDeafened(false);
});

function emitEncryptionStatus(identity: string, encrypted: boolean): void {
  emit({ session: 1, event: { type: "encryptionStatus", identity, encrypted } });
}

describe("NativeRoom connect/disconnect", () => {
  it("subscribes before connecting, then reports connected with our identity", async () => {
    const room = createNativeRoom(audio);
    const connecting = room.connect("ws://127.0.0.1:7881/lk", "tok");
    expect(host.handlers.size).toBe(1);
    expect(room.state).toBe("connecting");
    await connecting;
    expect(room.state).toBe("connected");
    expect(room.localParticipant.identity).toBe("user-1");
    expect(host.calls).toEqual([["connect", ["ws://127.0.0.1:7881/lk", "tok", audio]]]);
    expect(nativeCounters).toMatchObject({ openRooms: 1, listeners: 1 });
  });

  it("replays events that arrived before the session id was known", async () => {
    const room = createNativeRoom(audio);
    let resolveConnect!: (v: { session: number; identity: string; frames: string }) => void;
    host.connectResult = new Promise((r) => (resolveConnect = r));
    const connecting = room.connect("u", "t");
    emit({
      session: 3,
      event: {
        type: "connected",
        participants: [
          {
            identity: "user-2",
            tracks: [
              { sid: "TR_a", kind: "audio", source: "microphone", muted: false, encrypted: true },
            ],
          },
        ],
      },
    });
    resolveConnect({ session: 3, identity: "user-1", frames: "" });
    await connecting;
    expect([...room.remoteParticipants.keys()]).toEqual(["user-2"]);
    expect(room.remoteParticipants.get("user-2")?.audioTrackPublications.size).toBe(1);
  });

  it("keeps the join grant sent before the snapshot while connect is pending", async () => {
    const room = createNativeRoom(audio);
    const changed = vi.fn();
    room.on("participantPermissionsChanged", changed);
    let resolveConnect!: (v: { session: number; identity: string; frames: string }) => void;
    host.connectResult = new Promise((r) => (resolveConnect = r));
    const connecting = room.connect("u", "t");
    emit({ session: 3, event: { type: "permission", canPublish: true, canPublishSources: [2] } });
    emit({ session: 3, event: { type: "connected", participants: [] } });
    resolveConnect({ session: 3, identity: "user-1", frames: "" });
    await connecting;
    expect(room.localParticipant.permissions).toEqual({ canPublish: true, canPublishSources: [2] });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("raises no TrackPublished for the snapshot replayed during connect, only for a later one", async () => {
    const room = createNativeRoom(audio);
    const published: string[] = [];
    room.on("trackPublished", (pub) => published.push((pub as { trackSid: string }).trackSid));
    let resolveConnect!: (v: { session: number; identity: string; frames: string }) => void;
    host.connectResult = new Promise((r) => (resolveConnect = r));
    const connecting = room.connect("u", "t");
    emit({
      session: 3,
      event: {
        type: "connected",
        participants: [{ identity: "user-2", tracks: [video("TR_first")] }],
      },
    });
    resolveConnect({ session: 3, identity: "user-1", frames: "" });
    await connecting;
    expect(room.remoteParticipants.get("user-2")?.trackPublications.size).toBe(1);
    expect(published).toEqual([]);

    emit({
      session: 3,
      event: {
        type: "connected",
        participants: [{ identity: "user-2", tracks: [video("TR_again")] }],
      },
    });
    expect(published).toEqual(["TR_again"]);
  });

  it("raises no TrackPublished for a trackPublished envelope replayed during connect", async () => {
    const room = createNativeRoom(audio);
    const published: string[] = [];
    room.on("trackPublished", (pub) => published.push((pub as { trackSid: string }).trackSid));
    let resolveConnect!: (v: { session: number; identity: string; frames: string }) => void;
    host.connectResult = new Promise((r) => (resolveConnect = r));
    const connecting = room.connect("u", "t");
    emit({
      session: 3,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_queued") },
    });
    resolveConnect({ session: 3, identity: "user-1", frames: "" });
    await connecting;
    expect(room.remoteParticipants.get("user-2")?.trackPublications.size).toBe(1);
    expect(published).toEqual([]);

    emit({
      session: 3,
      event: {
        type: "trackPublished",
        identity: "user-2",
        track: video("TR_live", "screen_share"),
      },
    });
    expect(published).toEqual(["TR_live"]);
  });

  it("ignores events for another session", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({ session: 99, event: { type: "participantConnected", identity: "user-5" } });
    expect(room.remoteParticipants.size).toBe(0);
  });

  it("releases the subscription and closes only its own session on disconnect", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await room.disconnect();
    expect(host.unsubscribed).toBe(1);
    expect(host.calls.at(-1)).toEqual(["disconnect", [1]]);
    expect(room.state).toBe("disconnected");
    expect(nativeCounters).toMatchObject({ openRooms: 0, listeners: 0, rust: { threads: 12 } });
    // Idempotent: a second disconnect issues nothing.
    await room.disconnect();
    expect(host.calls.filter(([n]) => n === "disconnect")).toHaveLength(1);
  });

  it("uncounts a room the server dropped once it is disconnected", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    expect(nativeCounters.openRooms).toBe(1);
    emit({ session: 1, event: { type: "disconnected", reason: "ServerShutdown" } });
    expect(room.state).toBe("disconnected");
    await room.disconnect();
    expect(nativeCounters.openRooms).toBe(0);
    await room.disconnect();
    expect(nativeCounters.openRooms).toBe(0);
  });

  it("releases the subscription and rethrows when connect fails", async () => {
    const room = createNativeRoom(audio);
    host.connectResult = Promise.reject(new Error("no key"));
    await expect(room.connect("u", "t")).rejects.toThrow("no key");
    expect(host.unsubscribed).toBe(1);
    expect(room.state).toBe("disconnected");
    expect(nativeCounters).toMatchObject({ openRooms: 0, listeners: 0 });
    // Nothing to close: no native session id was ever issued.
    await room.disconnect();
    expect(host.calls.filter(([n]) => n === "disconnect")).toHaveLength(0);
  });
});

describe("NativeRoom device switching", () => {
  it("forwards audio device switches to the native session, mapping default to empty", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await expect(room.switchActiveDevice("audioinput", "guid-mic")).resolves.toBe(true);
    await expect(room.switchActiveDevice("audiooutput", "default")).resolves.toBe(true);
    await expect(room.switchActiveDevice("videoinput", "cam")).resolves.toBe(false);
    expect(host.calls.filter(([n]) => n === "setDevice")).toEqual([
      ["setDevice", [1, "audioinput", "guid-mic"]],
      ["setDevice", [1, "audiooutput", ""]],
    ]);
  });

  it("treats the host's fallback-to-default as a successful switch (voice #19)", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    host.setDevice = () => Promise.reject("capture device gone; switched to the default");
    await expect(room.switchActiveDevice("audioinput", "gone")).resolves.toBe(true);

    // A real failure still rejects.
    host.setDevice = () => Promise.reject("no capture device");
    await expect(room.switchActiveDevice("audioinput", "gone")).rejects.toThrow();
  });
});

describe("NativeRoom room surface", () => {
  it("routes the microphone toggle to the native session", async () => {
    const room = createNativeRoom(audio);
    await expect(room.localParticipant.setMicrophoneEnabled(true)).rejects.toThrow(/not connected/);
    await room.connect("u", "t");
    await room.localParticipant.setMicrophoneEnabled(true);
    expect(host.calls.at(-1)).toEqual(["setMicrophone", [1, true]]);
    await room.localParticipant.setMicrophoneEnabled(false);
    expect(host.calls.at(-1)).toEqual(["setMicrophone", [1, false]]);
  });

  it("forwards the channel's configured audio bitrate on an enable", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await room.localParticipant.setMicrophoneEnabled(true, undefined, {
      audioPreset: { maxBitrate: 96_000 },
    });
    expect(host.calls.at(-1)).toEqual(["setMicrophone", [1, true, 96_000]]);
  });

  it("reuses the last configured bitrate for an enable that carries no options", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await room.localParticipant.setMicrophoneEnabled(true, undefined, {
      audioPreset: { maxBitrate: 96_000 },
    });
    await room.localParticipant.setMicrophoneEnabled(true);
    expect(host.calls.at(-1)).toEqual(["setMicrophone", [1, true, 96_000]]);
  });

  describe("push-to-talk gate", () => {
    // DP-30 / D5: while push-to-talk is armed the capture stays open and the
    // session's gate sends silence, so a press never reopens the device.
    it("a PTT cycle leaves the capture open: the key only flips the session's gate", async () => {
      const room = createNativeRoom(audio);
      room.setPttGated(true);
      await room.connect("u", "t");
      host.calls.length = 0;

      // The join, with the key up: the gate is closed before capture opens.
      await room.localParticipant.setMicrophoneEnabled(true);
      expect(host.calls).toEqual([
        ["setPttGated", [1, true]],
        ["setMicrophone", [1, true]],
      ]);

      room.setPttGated(false);
      room.setPttGated(true);
      room.setPttGated(false);
      expect(micCalls()).toEqual([["setMicrophone", [1, true]]]);
      expect(gateCalls().slice(1)).toEqual([
        ["setPttGated", [1, false]],
        ["setPttGated", [1, true]],
        ["setPttGated", [1, false]],
      ]);
    });

    it("an explicit mute still stops the capture, and a press never reopens it", async () => {
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      room.setPttGated(true);
      await room.localParticipant.setMicrophoneEnabled(false);
      expect(micCalls().at(-1)).toEqual(["setMicrophone", [1, false]]);
      host.calls.length = 0;

      room.setPttGated(false);
      expect(host.calls).toEqual([["setPttGated", [1, false]]]);
      host.calls.length = 0;

      // Unmuted while the key is held: live at once.
      await room.localParticipant.setMicrophoneEnabled(true);
      expect(host.calls).toEqual([
        ["setPttGated", [1, false]],
        ["setMicrophone", [1, true]],
      ]);
    });
  });

  describe("input-sensitivity gate", () => {
    // The web path's detector runs in the mic processor, which the native
    // room has none of: the session's capture gates on the same threshold.
    it("sends the threshold to the session, ahead of the capture on an enable", async () => {
      const room = createNativeRoom(audio);
      room.setVoiceGate(0.05, () => {});
      await room.connect("u", "t");
      host.calls.length = 0;

      await room.localParticipant.setMicrophoneEnabled(true);
      expect(host.calls).toEqual([
        ["setPttGated", [1, false]],
        // The slider's gate asks RNNoise's verdict too.
        ["setVoiceGate", [1, 0.05, false, true]],
        ["setMicrophone", [1, true]],
      ]);
      host.calls.length = 0;

      room.setVoiceGate(0.02, () => {});
      expect(host.calls).toEqual([["setVoiceGate", [1, 0.02, false, true]]]);
    });

    it("reports the session's verdicts as the local speaking verdict", async () => {
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      const verdicts: Array<boolean | null> = [];
      room.setVoiceGate(0.05, (speaking) => verdicts.push(speaking));
      // The gate starts open, as the web detector does.
      expect(verdicts).toEqual([true]);

      emit({ session: 1, event: { type: "voiceGate", open: false } });
      emit({ session: 1, event: { type: "voiceGate", open: true } });
      expect(verdicts).toEqual([true, false, true]);
    });

    it("a zero threshold runs no gate: no verdict, LiveKit decides", async () => {
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      const verdicts: Array<boolean | null> = [];
      room.setVoiceGate(0, (speaking) => verdicts.push(speaking));
      emit({ session: 1, event: { type: "voiceGate", open: true } });
      expect(verdicts).toEqual([null]);
    });

    // Automatic sensitivity runs the web detector's noise-floor estimate over
    // the capture's level reports, and moves the session's gate without
    // restarting it.
    it("auto starts at the seed and retunes the gate from the level reports", async () => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      await room.localParticipant.setMicrophoneEnabled(true);
      host.calls.length = 0;
      const steps: number[] = [];
      const verdicts: Array<boolean | null> = [];
      room.setVoiceGate("auto", (speaking) => verdicts.push(speaking), {
        seed: 0.03,
        onThreshold: (next) => steps.push(next),
      });
      // Automatic sensitivity also asks RNNoise's verdict of the native gate.
      expect(host.calls).toEqual([["setVoiceGate", [1, 0.03, false, true]]]);
      expect(verdicts).toEqual([true]);
      host.calls.length = 0;

      // A quiet room at RMS 0.002 for a little over a second: the gate settles
      // 10 dB above it.
      for (; now <= 1100; now += 50) {
        emit({ session: 1, event: { type: "inputLevel", rms: 0.002, open: true } });
      }
      expect(steps).toHaveLength(1);
      expect(steps[0]).toBeCloseTo(0.002 * 10 ** 0.5, 5);
      expect(host.calls).toEqual([["setVoiceGate", [1, steps[0], true, true]]]);
      // Its verdicts still reach the speaking ring.
      emit({ session: 1, event: { type: "voiceGate", open: false } });
      expect(verdicts).toEqual([true, false]);

      // An input volume move forgets the floor: the next second's reports
      // only re-learn it, as the web detector's resetFloor does.
      room.setInputGain(200);
      host.calls.length = 0;
      const resetAt = now;
      for (; now < resetAt + 1000; now += 50) {
        emit({ session: 1, event: { type: "inputLevel", rms: 0.004, open: true } });
      }
      expect(host.calls).toEqual([]);
      vi.restoreAllMocks();
    });

    it("a fixed threshold ignores the level reports", async () => {
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      await room.localParticipant.setMicrophoneEnabled(true);
      room.setVoiceGate(0.05, () => {});
      host.calls.length = 0;
      for (let i = 0; i < 100; i++) {
        emit({ session: 1, event: { type: "inputLevel", rms: 0.001, open: true } });
      }
      expect(host.calls).toEqual([]);
    });
  });

  describe("audio processing", () => {
    const changed = {
      ...audio,
      echoCancellation: !audio.echoCancellation,
      enhancedNoiseSuppression: true,
    };

    it("sends a changed set to the running session", async () => {
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      host.calls.length = 0;
      room.setAudioProcessing(changed);
      expect(host.calls).toEqual([["setAudioProcessing", [1, changed]]]);
    });

    it("before a connection sends nothing, and the connect carries the new options", async () => {
      const room = createNativeRoom(audio);
      room.setAudioProcessing(changed);
      expect(host.calls).toEqual([]);
      await room.connect("u", "t");
      expect(host.calls[0]).toEqual(["connect", ["u", "t", changed]]);
    });
  });

  describe("input volume and level", () => {
    // The session's capture applies the input volume, as the web processor's
    // gain does; a new session starts at 100 %, so the saved one goes with
    // every enable, after the gates.
    it("sends the input volume to the session, and with every enable", async () => {
      const room = createNativeRoom(audio);
      room.setInputGain(150);
      expect(host.calls).toEqual([]);
      await room.connect("u", "t");
      host.calls.length = 0;

      await room.localParticipant.setMicrophoneEnabled(true);
      expect(host.calls).toEqual([
        ["setPttGated", [1, false]],
        ["setInputGain", [1, 150]],
        ["setMicrophone", [1, true]],
      ]);
      host.calls.length = 0;

      room.setInputGain(50);
      room.setInputGain(300);
      expect(host.calls).toEqual([
        ["setInputGain", [1, 50]],
        ["setInputGain", [1, 200]],
      ]);
    });

    it("forwards the capture's level reports to the listener", async () => {
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      await room.localParticipant.setMicrophoneEnabled(true);
      const levels: Array<[number | null, boolean]> = [];
      room.setInputLevelListener((rms, open) => levels.push([rms, open]));
      emit({ session: 1, event: { type: "inputLevel", rms: 0.02, open: true } });
      emit({ session: 1, event: { type: "inputLevel", rms: 0.001, open: false } });
      room.setInputLevelListener(null);
      emit({ session: 1, event: { type: "inputLevel", rms: 0.03, open: true } });
      expect(levels).toEqual([
        [0.02, true],
        [0.001, false],
      ]);
    });

    // Neither a mute nor a leave reports a last level, so the meter would
    // freeze on the last one: the room says the capture stopped, and a report
    // still in flight is dropped.
    it("tells the listener when the capture stops, and drops late reports", async () => {
      const room = createNativeRoom(audio);
      await room.connect("u", "t");
      const levels: Array<[number | null, boolean]> = [];
      room.setInputLevelListener((rms, open) => levels.push([rms, open]));
      await room.localParticipant.setMicrophoneEnabled(true);
      emit({ session: 1, event: { type: "inputLevel", rms: 0.02, open: true } });
      await room.localParticipant.setMicrophoneEnabled(false);
      emit({ session: 1, event: { type: "inputLevel", rms: 0.03, open: true } });
      expect(levels).toEqual([
        [0.02, true],
        [null, false],
      ]);

      await room.localParticipant.setMicrophoneEnabled(true);
      emit({ session: 1, event: { type: "inputLevel", rms: 0.01, open: false } });
      await room.disconnect();
      expect(levels.slice(2)).toEqual([
        [0.01, false],
        [null, false],
      ]);
      // A second stop (leave after mute) says nothing more.
      await room.disconnect();
      expect(levels).toHaveLength(4);
    });
  });

  it("deafen unsubscribes remote audio publications through the session", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: {
        type: "trackPublished",
        identity: "user-2",
        track: { sid: "TR_a", kind: "audio", source: "microphone", muted: false, encrypted: true },
      },
    });
    const pub = room.remoteParticipants.get("user-2")!.audioTrackPublications.get("TR_a")!;
    pub.setSubscribed(false);
    pub.setSubscribed(false); // unchanged: no second command
    expect(host.calls.filter(([n]) => n === "setSubscribed")).toEqual([
      ["setSubscribed", [1, "user-2", "TR_a", false]],
    ]);
    expect(pub.isSubscribed).toBe(false);
  });

  it("keeps voice tracks that appear while deafened unsubscribed, but not stream audio", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    setLocalDeafened(true);
    emit({ session: 1, event: { type: "participantConnected", identity: "user-3" } });
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-3", track: track("TR_mic", "microphone") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-3", track: track("TR_mic", "microphone") },
    });
    emit({
      session: 1,
      event: {
        type: "trackSubscribed",
        identity: "user-3",
        track: track("TR_stream", "screen_share_audio"),
      },
    });
    expect(host.calls.filter(([n]) => n === "setSubscribed")).toEqual([
      ["setSubscribed", [1, "user-3", "TR_mic", false]],
    ]);
    const pubs = room.remoteParticipants.get("user-3")!.audioTrackPublications;
    expect(pubs.get("TR_mic")!.isSubscribed).toBe(false);
    expect(pubs.get("TR_stream")!.isSubscribed).toBe(true);
  });

  it("starts each participant at its saved volume and forwards volume changes", async () => {
    const room = createNativeRoom(audio, (identity) => (identity === "user-2" ? 0.5 : 1));
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "connected", participants: [{ identity: "user-2", tracks: [] }] },
    });
    emit({ session: 1, event: { type: "participantConnected", identity: "user-3" } });
    expect(host.calls.filter(([n]) => n === "setVolume")).toEqual([
      ["setVolume", [1, "user-2", 0.5]],
      ["setVolume", [1, "user-3", 1]],
    ]);
    const p = room.remoteParticipants.get("user-3")!;
    p.setVolume(1.8);
    expect(p.getVolume()).toBe(1.8);
    expect(host.calls.at(-1)).toEqual(["setVolume", [1, "user-3", 1.8]]);
    await room.disconnect();
    p.setVolume(0.2);
    expect(host.calls.at(-1)).toEqual(["disconnect", [1]]);
  });

  it("sends each participant's screen-share audio volume, again after a rejoin", async () => {
    const volumes = new Map([["user-2", 0.4]]);
    const room = createNativeRoom(audio, undefined, (identity) => volumes.get(identity) ?? 1);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "connected", participants: [{ identity: "user-2", tracks: [] }] },
    });
    emit({ session: 1, event: { type: "participantConnected", identity: "user-3" } });
    const sent = () => host.calls.filter(([n]) => n === "setScreenshareVolume");
    expect(sent()).toEqual([
      ["setScreenshareVolume", [1, "user-2", 0.4]],
      ["setScreenshareVolume", [1, "user-3", 1]],
    ]);
    host.calls.length = 0;
    volumes.set("user-3", 0);
    room.applyScreenshareVolumes();
    expect(sent()).toEqual([
      ["setScreenshareVolume", [1, "user-2", 0.4]],
      ["setScreenshareVolume", [1, "user-3", 0]],
    ]);
    // The backend keeps a gain for the session: a participant who left while
    // it changed is sent the current one when they return.
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    volumes.set("user-2", 1);
    host.calls.length = 0;
    emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
    expect(sent()).toEqual([["setScreenshareVolume", [1, "user-2", 1]]]);
  });

  it("tracks the server's grant for every source and announces each change", async () => {
    const room = createNativeRoom(audio);
    const changed = vi.fn();
    room.on("participantPermissionsChanged", changed);
    await room.connect("u", "t");
    expect(room.localParticipant.permissions).toBeUndefined();
    // The connect-time grant: microphone (2) and camera (1), no screen share.
    emit({
      session: 1,
      event: { type: "permission", canPublish: true, canPublishSources: [2, 1] },
    });
    expect(room.localParticipant.permissions).toEqual({
      canPublish: true,
      canPublishSources: [2, 1],
    });
    expect(changed).toHaveBeenLastCalledWith(undefined, room.localParticipant);
    changed.mockClear();
    // A moderator mute withdraws publishing altogether.
    emit({ session: 1, event: { type: "permission", canPublish: false, canPublishSources: [] } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.permissions).toEqual({ canPublish: false, canPublishSources: [] });
    // An open grant: an empty source list means every source.
    emit({ session: 1, event: { type: "permission", canPublish: true, canPublishSources: [] } });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(room.localParticipant.permissions).toEqual({ canPublish: true, canPublishSources: [] });
  });

  it("maps native events onto livekit RoomEvents", async () => {
    const room = createNativeRoom(audio);
    const speakers = vi.fn();
    const disconnected = vi.fn();
    const encryptionError = vi.fn();
    room
      .on("activeSpeakersChanged", speakers)
      .on("disconnected", disconnected)
      .on("encryptionError", encryptionError);
    await room.connect("u", "t");
    emit({ session: 1, event: { type: "activeSpeakers", identities: ["user-2", "user-3"] } });
    expect(speakers).toHaveBeenCalledWith([{ identity: "user-2" }, { identity: "user-3" }]);
    expect(room.isSignalingConnected()).toBe(true);
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(room.state).toBe("reconnecting");
    expect(room.isSignalingConnected()).toBe(false);
    emit({ session: 1, event: { type: "reconnected" } });
    expect(room.state).toBe("connected");
    expect(room.isSignalingConnected()).toBe(true);
    emit({ session: 1, event: { type: "encryptionStatus", identity: "user-1", encrypted: false } });
    expect(encryptionError).toHaveBeenCalledTimes(1);
    emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    expect(room.remoteParticipants.size).toBe(0);
    emit({ session: 1, event: { type: "disconnected", reason: "ServerShutdown" } });
    expect(disconnected).toHaveBeenCalledWith(0);
    expect(room.state).toBe("disconnected");
    expect(room.isSignalingConnected()).toBe(false);
    room.removeAllListeners();
    emit({ session: 1, event: { type: "disconnected", reason: "ClientInitiated" } });
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("raises TrackMuted when a remote microphone mutes, so its speaking ring clears at once", async () => {
    const room = createNativeRoom(audio);
    const muted = vi.fn();
    room.on("trackMuted", muted);
    await room.connect("u", "t");
    const mic = {
      sid: "TR_mic",
      kind: "audio" as const,
      source: "microphone" as const,
      muted: false,
      encrypted: true,
    };
    emit({ session: 1, event: { type: "trackPublished", identity: "user-2", track: mic } });

    emit({
      session: 1,
      event: { type: "trackMuted", identity: "user-2", sid: "TR_mic", muted: true },
    });

    const p = room.remoteParticipants.get("user-2");
    expect(muted).toHaveBeenCalledWith(p?.trackPublications.get("TR_mic"), p);
    expect(p?.getTrackPublication("microphone")?.isMuted).toBe(true);
    emit({
      session: 1,
      event: { type: "trackMuted", identity: "user-2", sid: "TR_mic", muted: false },
    });
    expect(muted).toHaveBeenCalledTimes(1);
  });

  it("re-reports a remote decrypt failure the way the web worker does until it clears", async () => {
    vi.useFakeTimers();
    try {
      const room = createNativeRoom(audio);
      const encryptionError = vi.fn();
      room.on("encryptionError", encryptionError);
      await room.connect("u", "t");
      const status = emitEncryptionStatus;
      emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
      emit({ session: 1, event: { type: "participantConnected", identity: "user-3" } });

      // The backend reports the transition once; the room re-reports it as
      // the web worker's once-a-second InvalidKey, attributed to the peer.
      status("user-2", false);
      expect(encryptionError).toHaveBeenCalledTimes(1);
      const [err, participant] = encryptionError.mock.calls[0]!;
      expect(participant).toBe(room.remoteParticipants.get("user-2"));
      expect((err as Error).message.startsWith("InvalidKey:")).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(encryptionError).toHaveBeenCalledTimes(3);
      // Decrypting again stops the reports.
      status("user-2", true);
      vi.advanceTimersByTime(5000);
      expect(encryptionError).toHaveBeenCalledTimes(3);

      // A peer who leaves while failing is no longer reported.
      status("user-3", false);
      emit({ session: 1, event: { type: "participantDisconnected", identity: "user-3" } });
      vi.advanceTimersByTime(5000);
      expect(encryptionError).toHaveBeenCalledTimes(4);

      // Leaving the room stops a running report.
      status("user-2", false);
      await room.disconnect();
      vi.advanceTimersByTime(5000);
      expect(encryptionError).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a native decrypt degradation clears once the peer decrypts again", async () => {
    vi.useFakeTimers();
    try {
      const room = createNativeRoom(audio);
      const handlers = createRoomEventHandlers({ isNativeRoom: () => true } as RoomEventDeps);
      room.on("encryptionError", (err, p) =>
        handlers.handleEncryptionError(err as Error, p as Participant),
      );
      await room.connect("u", "t");
      emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });

      // A failure past the grace window reads "Unsecured"...
      emitEncryptionStatus("user-2", false);
      vi.advanceTimersByTime(3000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
      // ...and the peer's frames decrypting again clears it.
      emitEncryptionStatus("user-2", true);
      vi.advanceTimersByTime(3000);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);

      // The local E2EE not running is not the peer's to clear.
      emitEncryptionStatus("user-2", false);
      vi.advanceTimersByTime(3000);
      emit({
        session: 1,
        event: { type: "encryptionStatus", identity: "user-1", encrypted: false },
      });
      emitEncryptionStatus("user-2", true);
      vi.advanceTimersByTime(5000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
      await room.disconnect();
    } finally {
      setEncryptionDegraded(false);
      vi.useRealTimers();
    }
  });

  it("answers the Room calls the shared modules make without a browser", async () => {
    const room = createNativeRoom(audio);
    await expect(room.setE2EEEnabled(true)).resolves.toBeUndefined();
    await expect(room.startAudio()).resolves.toBeUndefined();
    await expect(room.switchActiveDevice("audioinput", "x")).rejects.toThrow(/not connected/);
    expect(room.canPlaybackAudio).toBe(true);
    // LP-5: stats stand-ins that report nothing until the room is connected.
    await expect(room.engine.pcManager.publisher.getStats()).resolves.toBeUndefined();
    expect(room.localParticipant.getTrackPublication("microphone")).toBeUndefined();
    expect(room.localParticipant.permissions).toBeUndefined();
    await expect(room.localParticipant.setCameraEnabled(true)).rejects.toThrow(/Linux/);
    await expect(room.localParticipant.setCameraEnabled(false)).resolves.toBeUndefined();
  });
});

describe("NativeRoom initial surface", () => {
  it("is nameless, plays out natively and has no signalling socket before it connects", () => {
    const room = createNativeRoom(audio);
    expect(room.name).toBe("");
    expect(room.nativePlayout).toBe(true);
    expect(room.engine.client).toStrictEqual({ ws: undefined });
    expect(room.localParticipant.identity).toBe("");
    expect(room.isSignalingConnected()).toBe(false);
  });

  it("refuses a second connect without touching the first session", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await expect(room.connect("u", "t")).rejects.toThrow("native room already connected");
    expect(host.calls.filter(([n]) => n === "connect")).toHaveLength(1);
    expect(room.state).toBe("connected");
    expect(nativeCounters).toMatchObject({ openRooms: 1, listeners: 1 });
  });

  it("keeps every listener registered for one event", async () => {
    const room = createNativeRoom(audio);
    const first = vi.fn();
    const second = vi.fn();
    room.on("reconnecting", first);
    room.on("reconnecting", second);
    await room.connect("u", "t");
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    room.off("reconnecting", first);
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("raises the lifecycle events from the backend", async () => {
    const room = createNativeRoom(audio);
    const seen: string[] = [];
    room.on("connected", () => seen.push("connected"));
    room.on("reconnecting", () => seen.push("reconnecting"));
    room.on("reconnected", () => seen.push("reconnected"));
    await room.connect("u", "t");
    emit({ session: 1, event: { type: "connected", participants: [] } });
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(room.state).toBe("reconnecting");
    emit({ session: 1, event: { type: "reconnected" } });
    expect(room.state).toBe("connected");
    expect(seen).toEqual(["connected", "reconnecting", "reconnected"]);
  });

  it("maps the disconnect reason", async () => {
    const reasons: unknown[] = [];
    for (const reason of ["ClientInitiated", "ServerShutdown", ""]) {
      const room = createNativeRoom(audio);
      room.on("disconnected", (r) => reasons.push(r));
      // oxlint-disable-next-line no-await-in-loop -- each room claims the next session
      await room.connect("u", "t");
      emit({ session: 1, event: { type: "disconnected", reason } });
      expect(room.state).toBe("disconnected");
      // oxlint-disable-next-line no-await-in-loop -- the next room needs the registry clear
      await room.disconnect();
    }
    expect(reasons).toEqual([1, 0, 0]);
  });

  it("starts a reconnected session with no leftover envelope replay", async () => {
    const room = createNativeRoom(audio);
    const published: string[] = [];
    room.on("trackPublished", (pub) => published.push((pub as { trackSid: string }).trackSid));
    await room.connect("u", "t");
    await room.disconnect();

    let resolveConnect!: (v: { session: number; identity: string; frames: string }) => void;
    host.connectResult = new Promise((r) => (resolveConnect = r));
    const connecting = room.connect("u", "t");
    emit({
      session: 2,
      event: {
        type: "connected",
        participants: [{ identity: "user-2", tracks: [video("TR_replayed")] }],
      },
    });
    resolveConnect({ session: 2, identity: "user-1", frames: "" });
    await connecting;
    expect(room.remoteParticipants.get("user-2")?.trackPublications.size).toBe(1);
    expect(published).toEqual([]);
  });
});

describe("NativeRoom command failures are logged and swallowed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("push-to-talk gate", async () => {
    const room = await connected();
    const err = new Error("gate");
    rejectOnce("setPttGated", err);
    room.setPttGated(true);
    await settle();
    expect(log.warn).toHaveBeenCalledWith("Push-to-talk could not switch the native gate", err);
  });

  it("input-sensitivity gate", async () => {
    const room = await connected();
    const err = new Error("gate");
    rejectOnce("setVoiceGate", err);
    room.setVoiceGate(40, vi.fn());
    await settle();
    expect(log.warn).toHaveBeenCalledWith("Voice sensitivity could not reach the native gate", err);
  });

  it("automatic sensitivity retune", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const room = await connected();
    await room.localParticipant.setMicrophoneEnabled(true);
    const steps: number[] = [];
    room.setVoiceGate("auto", vi.fn(), { seed: 0.03, onThreshold: (next) => steps.push(next) });
    await settle();
    const err = new Error("gate");
    rejectOnce("setVoiceGate", err);
    for (; now <= 1100; now += 50) {
      emit({ session: 1, event: { type: "inputLevel", rms: 0.002, open: true } });
    }
    await settle();
    expect(steps).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      "Automatic sensitivity could not reach the native gate",
      err,
    );
  });

  it("input volume", async () => {
    const room = await connected();
    const err = new Error("gain");
    rejectOnce("setInputGain", err);
    room.setInputGain(150);
    await settle();
    expect(log.warn).toHaveBeenCalledWith("Input volume could not reach the native capture", err);
  });

  it("audio processing", async () => {
    const room = await connected();
    const err = new Error("apm");
    rejectOnce("setAudioProcessing", err);
    room.setAudioProcessing({ ...audio, noiseSuppression: false });
    await settle();
    expect(log.warn).toHaveBeenCalledWith(
      "Audio processing could not reach the native capture",
      err,
    );
  });

  it("subscription changes", async () => {
    const room = await connected();
    emit({ session: 1, event: { type: "trackPublished", identity: "user-2", track: track2() } });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("microphone")!;
    const err = new Error("subscribe");
    rejectOnce("setSubscribed", err);
    pub.setSubscribed(false);
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native setSubscribed failed", {
      identity: "user-2",
      sid: "TR_a",
      subscribed: false,
      err,
    });
  });

  it("video layer changes", async () => {
    const room = await connected();
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    const err = new Error("view");
    rejectOnce("setVideoView", err);
    pub.setEnabled(false);
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native setVideoView failed", {
      identity: "user-2",
      sid: "TR_v",
      enabled: false,
      err,
    });
  });

  it("a layer change that fails does not block the next one", async () => {
    const room = await connected();
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    rejectOnce("setVideoView", new Error("view"));
    pub.setEnabled(false);
    pub.setEnabled(true);
    await settle();
    expect(views()).toEqual([[1, "user-2", "TR_v", true, "high"]]);
  });

  it("per-user volume", async () => {
    const room = await connected();
    emit({ session: 1, event: { type: "trackPublished", identity: "user-2", track: track2() } });
    host.calls.length = 0;
    const err = new Error("volume");
    rejectOnce("setVolume", err);
    room.remoteParticipants.get("user-2")!.setVolume(0.5);
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native setVolume failed", {
      identity: "user-2",
      volume: 0.5,
      err,
    });
  });

  it("screen-share audio volume", async () => {
    const room = createNativeRoom(audio, undefined, () => 0.25);
    await room.connect("u", "t");
    emit({ session: 1, event: { type: "trackPublished", identity: "user-2", track: track2() } });
    const err = new Error("volume");
    rejectOnce("setScreenshareVolume", err);
    room.applyScreenshareVolumes();
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native setScreenshareVolume failed", {
      identity: "user-2",
      volume: 0.25,
      err,
    });
  });
});

describe("NativeRoom participant model", () => {
  it("lists only the audio publications as audio and finds a publication by its source", async () => {
    const room = await connected();
    emit({ session: 1, event: { type: "trackPublished", identity: "user-2", track: track2() } });
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_cam") },
    });
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_scr", "screen_share") },
    });
    const peer = room.remoteParticipants.get("user-2")!;
    expect([...peer.audioTrackPublications.keys()]).toEqual(["TR_a"]);
    expect(peer.getTrackPublication("microphone")?.trackSid).toBe("TR_a");
    expect(peer.getTrackPublication("camera")?.trackSid).toBe("TR_cam");
    expect(peer.getTrackPublication("screen_share")?.trackSid).toBe("TR_scr");
    expect(peer.getTrackPublication("screen_share_audio")).toBeUndefined();
  });

  it("a publication that is not watched yet is enabled at the top layer", async () => {
    const room = await connected();
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_cam") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    expect(pub.isEnabled).toBe(true);
    expect(pub.isSubscribed).toBe(true);
    pub.setEnabled(true);
    await settle();
    expect(views()).toEqual([]);
  });

  it("maps a layer request to the native quality", async () => {
    const room = await connected();
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    pub.setVideoQuality(0);
    pub.setVideoQuality(1);
    // OFF has no layer of its own: it reads as the top one.
    pub.setVideoQuality(3 as VideoQuality);
    await settle();
    expect(views().map((v) => v[4])).toEqual(["low", "medium", "high"]);
  });

  it("picks the smallest layer that covers the tile", async () => {
    const room = await connected();
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    const sizes: Array<[number, number]> = [
      [320, 100],
      [100, 321],
      [641, 360],
      [1920, 1080],
      [640, 360],
      [90, 320],
    ];
    for (const [width, height] of sizes) pub.setVideoDimensions({ width, height });
    await settle();
    expect(views().map((v) => v[4])).toEqual(["low", "medium", "high", "medium", "low"]);
  });
});

describe("NativeRoom input level reports", () => {
  it("drops reports and a stop before the capture ever started", async () => {
    const room = await connected();
    const levels = vi.fn();
    room.setInputLevelListener(levels);
    emit({ session: 1, event: { type: "inputLevel", rms: 0.3, open: true } });
    await room.localParticipant.setMicrophoneEnabled(false);
    await room.disconnect();
    expect(levels).not.toHaveBeenCalled();
  });
});

describe("NativeRoom backend events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    setLocalDeafened(false);
  });

  it("a peer that leaves stops its decrypt reports, and an unknown leaver raises nothing", async () => {
    const room = await connected();
    const left = vi.fn();
    room.on("participantDisconnected", left);
    emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
    const idle = vi.getTimerCount();
    reportEncryption("user-2", false);
    expect(vi.getTimerCount()).toBe(idle + 1);
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    expect(vi.getTimerCount()).toBe(idle);
    expect(left).toHaveBeenCalledTimes(1);
    emit({ session: 1, event: { type: "participantDisconnected", identity: "nobody" } });
    expect(left).toHaveBeenCalledTimes(1);
  });

  it("raises TrackUnpublished only for a publication it knows", async () => {
    const room = await connected();
    const unpublished = vi.fn();
    room.on("trackUnpublished", unpublished);
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    emit({ session: 1, event: { type: "trackUnpublished", identity: "user-2", sid: "TR_other" } });
    emit({ session: 1, event: { type: "trackUnpublished", identity: "nobody", sid: "TR_v" } });
    expect(unpublished).not.toHaveBeenCalled();
    emit({ session: 1, event: { type: "trackUnpublished", identity: "user-2", sid: "TR_v" } });
    expect(unpublished).toHaveBeenCalledTimes(1);
  });

  it("reports an unprotected local session once, and a protected one never", async () => {
    const room = await connected();
    const failed = vi.fn();
    room.on("encryptionError", failed);
    reportEncryption("user-1", true);
    expect(failed).not.toHaveBeenCalled();
    reportEncryption("user-1", false);
    expect(failed).toHaveBeenCalledTimes(1);
    expect((failed.mock.calls[0]![0] as Error).message).toBe("native E2EE not active");
    expect(failed.mock.calls[0]).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("raises no decrypt failure for a peer it does not know, but keeps watching", async () => {
    const room = await connected();
    const failed = vi.fn();
    room.on("encryptionError", failed);
    reportEncryption("user-9", false);
    expect(failed).not.toHaveBeenCalled();
    emit({ session: 1, event: { type: "participantConnected", identity: "user-9" } });
    vi.advanceTimersByTime(1000);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]![0]).toMatchObject({
      message: "InvalidKey: native decrypt failure",
    });
  });

  it("a new snapshot replaces the roster, its video and its decrypt reports", async () => {
    const room = await connected();
    emit({
      session: 1,
      event: {
        type: "connected",
        participants: [{ identity: "user-2", tracks: [video("TR_v")] }],
      },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    reportEncryption("user-2", false);
    const watching = vi.getTimerCount();
    expect(watching).toBeGreaterThan(0);
    expect(host.renderers[0]!.disposed).toBe(false);

    emit({
      session: 1,
      event: { type: "connected", participants: [{ identity: "user-3", tracks: [] }] },
    });
    expect([...room.remoteParticipants.keys()]).toEqual(["user-3"]);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(watching - 1);
  });

  it("leaving ends the decrypt reports of the session", async () => {
    const room = await connected();
    emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
    reportEncryption("user-2", false);
    const failed = vi.fn();
    room.on("encryptionError", failed);
    const watching = vi.getTimerCount();
    emit({ session: 1, event: { type: "disconnected", reason: "ServerShutdown" } });
    expect(vi.getTimerCount()).toBe(watching - 1);
    vi.advanceTimersByTime(5000);
    expect(failed).not.toHaveBeenCalled();
  });

  it("leaves a video publication subscribed while deafened", async () => {
    await connected();
    setLocalDeafened(true);
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    expect(host.calls.filter(([n]) => n === "setSubscribed")).toEqual([]);
  });
});

describe("NativeRoom bookkeeping of replaced tracks", () => {
  it("logs under the room's own tag", () => {
    expect(log.tags).toContain("nativeRoom");
  });

  it("turning the camera off forgets a publication whose track was replaced", async () => {
    const room = await connected();
    const old = await startCamera(room);
    host.startCamera = () => Promise.resolve({ capture: 6, width: 1280, height: 720 });
    await startCamera(room);
    await room.localParticipant.publishTrack(old, cameraOptions);
    await room.localParticipant.setCameraEnabled(false);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("turning the share off forgets a publication whose track was replaced", async () => {
    const room = await connected();
    const old = await share(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    await share(room);
    await room.localParticipant.publishTrack(old, screenOptions);
    await room.localParticipant.setScreenShareEnabled(false);
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
  });

  it("a stopped share drops its own publication and its host capture", async () => {
    const room = await connected();
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    host.calls.length = 0;
    screen.stop();
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
    expect(host.calls).toEqual([["stopScreen", [1, 4]]]);
  });

  it("stopping the current share leaves a publication that belongs to another track", async () => {
    const room = await connected();
    const old = await share(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    const current = await share(room);
    await room.localParticipant.publishTrack(old, screenOptions);
    current.stop();
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(old);
  });
});
