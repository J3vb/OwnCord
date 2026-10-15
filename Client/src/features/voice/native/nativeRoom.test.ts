import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NativeVoiceEnvelope } from "../../../platform/contracts/nativeVoice";
import type { Participant } from "livekit-client";

vi.mock("livekit-client", () => ({
  RoomEvent: {
    Connected: "connected",
    Disconnected: "disconnected",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    ParticipantPermissionsChanged: "participantPermissionsChanged",
    EncryptionError: "encryptionError",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    TrackPublished: "trackPublished",
    TrackUnpublished: "trackUnpublished",
    TrackMuted: "trackMuted",
  },
  Track: {
    Kind: { Audio: "audio", Video: "video" },
    Source: {
      Camera: "camera",
      Microphone: "microphone",
      ScreenShare: "screen_share",
      ScreenShareAudio: "screen_share_audio",
    },
    sourceToProto: (source: string) =>
      ({ camera: 1, microphone: 2, screen_share: 3, screen_share_audio: 4 })[source],
  },
  DisconnectReason: { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1 },
}));
vi.mock("../../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

interface FakeMedia {
  url: string;
  disposed: boolean;
  mediaStreamTrack?: { id: string; events: string[] };
  track?: unknown;
  maxFramerate?: number;
}

const host = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  handlers: new Set<(e: NativeVoiceEnvelope) => void>(),
  connectResult: Promise.resolve({
    session: 1,
    identity: "user-1",
    frames: "ws://127.0.0.1:9/tok",
  }),
  publishCamera: (): Promise<string> => Promise.resolve("TR_cam"),
  startCamera: (): Promise<unknown> => Promise.resolve({ capture: 5, width: 1280, height: 720 }),
  setDevice: (): Promise<void> => Promise.resolve(),
  setVideoView: (): Promise<void> => Promise.resolve(),
  pick: (): Promise<unknown> =>
    Promise.resolve({
      source: "screen:7",
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    }),
  startScreen: (): Promise<unknown> => Promise.resolve({ capture: 4, width: 1280, height: 720 }),
  changeScreen: (): Promise<unknown> => Promise.resolve({ capture: 6, width: 800, height: 600 }),
  pickChange: (): Promise<string | null> => Promise.resolve("window:9"),
  noted: [] as string[],
  unsubscribed: 0,
  renderers: [] as FakeMedia[],
}));
vi.mock("./videoRenderer", () => ({
  NativeVideoRenderer: class {
    disposed = false;
    readonly mediaStreamTrack = {
      id: `canvas-${host.renderers.length}`,
      events: [] as string[],
      readyState: "live",
      stop() {
        this.readyState = "ended";
      },
      dispatchEvent(e: Event) {
        this.events.push(e.type);
        return true;
      },
    };
    constructor(readonly url: string) {
      host.renderers.push(this);
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock("./screenPicker", () => ({
  pickScreenSource: () => host.pick(),
  pickChangeSource: () => host.pickChange(),
  noteChangedSource: (source: string) => host.noted.push(source),
}));
vi.mock("../../../platform/desktop", () => ({
  desktop: {
    nativeVoice: {
      connect: (...args: unknown[]) => {
        host.calls.push(["connect", args]);
        return host.connectResult;
      },
      disconnect: (...args: unknown[]) => {
        host.calls.push(["disconnect", args]);
        return Promise.resolve({ rooms: 0, localTracks: 0, captureStreams: 0, threads: 12 });
      },
      setMicrophone: (...args: unknown[]) => {
        host.calls.push(["setMicrophone", args]);
        return Promise.resolve();
      },
      setPttGated: (...args: unknown[]) => {
        host.calls.push(["setPttGated", args]);
        return Promise.resolve();
      },
      setVoiceGate: (...args: unknown[]) => {
        host.calls.push(["setVoiceGate", args]);
        return Promise.resolve();
      },
      setInputGain: (...args: unknown[]) => {
        host.calls.push(["setInputGain", args]);
        return Promise.resolve();
      },
      setAudioProcessing: (...args: unknown[]) => {
        host.calls.push(["setAudioProcessing", args]);
        return Promise.resolve();
      },
      setSubscribed: (...args: unknown[]) => {
        host.calls.push(["setSubscribed", args]);
        return Promise.resolve();
      },
      setVideoView: (...args: unknown[]) => {
        host.calls.push(["setVideoView", args]);
        return host.setVideoView();
      },
      setVolume: (...args: unknown[]) => {
        host.calls.push(["setVolume", args]);
        return Promise.resolve();
      },
      setScreenshareVolume: (...args: unknown[]) => {
        host.calls.push(["setScreenshareVolume", args]);
        return Promise.resolve();
      },
      setDevice: (...args: unknown[]) => {
        host.calls.push(["setDevice", args]);
        return host.setDevice();
      },
      publishCamera: (...args: unknown[]) => {
        host.calls.push(["publishCamera", args]);
        return host.publishCamera();
      },
      unpublishCamera: (...args: unknown[]) => {
        host.calls.push(["unpublishCamera", args]);
        return Promise.resolve();
      },
      startCamera: (...args: unknown[]) => {
        host.calls.push(["startCamera", args]);
        return host.startCamera();
      },
      stopCamera: (...args: unknown[]) => {
        host.calls.push(["stopCamera", args]);
        return Promise.resolve();
      },
      startScreen: (...args: unknown[]) => {
        host.calls.push(["startScreen", args]);
        return host.startScreen();
      },
      publishScreen: (...args: unknown[]) => {
        host.calls.push(["publishScreen", args]);
        return Promise.resolve("TR_screen");
      },
      stopScreen: (...args: unknown[]) => {
        host.calls.push(["stopScreen", args]);
        return Promise.resolve();
      },
      changeScreen: (...args: unknown[]) => {
        host.calls.push(["changeScreen", args]);
        return host.changeScreen();
      },
      onEvent: (handler: (e: NativeVoiceEnvelope) => void) => {
        host.handlers.add(handler);
        return () => {
          host.handlers.delete(handler);
          host.unsubscribed++;
        };
      },
    },
  },
}));

import { createNativeRoom } from "./nativeRoom";
import { nativeCounters } from "./counters";
import { setEncryptionDegraded, setLocalDeafened, voiceStore } from "../../../stores/voice.store";
import { createRoomEventHandlers, type RoomEventDeps } from "../../../lib/roomEventHandlers";

const audio = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  enhancedNoiseSuppression: false,
};
const emit = (envelope: NativeVoiceEnvelope) => {
  for (const h of host.handlers) h(envelope);
};
const track = (sid: string, source: "microphone" | "screen_share_audio") => ({
  sid,
  kind: "audio" as const,
  source,
  muted: false,
  encrypted: true,
});

beforeEach(() => {
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
  host.setVideoView = () => Promise.resolve();
  host.pick = () =>
    Promise.resolve({
      source: "screen:7",
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
      simulcast: false,
    });
  host.startScreen = () => Promise.resolve({ capture: 4, width: 1280, height: 720 });
  host.changeScreen = () => Promise.resolve({ capture: 6, width: 800, height: 600 });
  host.pickChange = () => Promise.resolve("window:9");
  host.noted = [];
  nativeCounters.screenTracks = 0;
  host.renderers.length = 0;
  nativeCounters.openRooms = 0;
  nativeCounters.listeners = 0;
  nativeCounters.rust = null;
  setLocalDeafened(false);
});

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

const micCalls = () => host.calls.filter(([name]) => name === "setMicrophone");
const gateCalls = () => host.calls.filter(([name]) => name === "setPttGated");

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
        ["setVoiceGate", [1, 0.05]],
        ["setMicrophone", [1, true]],
      ]);
      host.calls.length = 0;

      room.setVoiceGate(0.02, () => {});
      expect(host.calls).toEqual([["setVoiceGate", [1, 0.02]]]);
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
      expect(host.calls).toEqual([["setVoiceGate", [1, 0.03]]]);
      expect(verdicts).toEqual([true]);
      host.calls.length = 0;

      // A quiet room at RMS 0.002 for a little over a second: the gate settles
      // 10 dB above it.
      for (; now <= 1100; now += 50) {
        emit({ session: 1, event: { type: "inputLevel", rms: 0.002, open: true } });
      }
      expect(steps).toHaveLength(1);
      expect(steps[0]).toBeCloseTo(0.002 * 10 ** 0.5, 5);
      expect(host.calls).toEqual([["setVoiceGate", [1, steps[0], true]]]);
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

  it("OC-0473: re-reports a remote decrypt failure the way the web worker does until it clears", async () => {
    vi.useFakeTimers();
    try {
      const room = createNativeRoom(audio);
      const encryptionError = vi.fn();
      room.on("encryptionError", encryptionError);
      await room.connect("u", "t");
      const status = (identity: string, encrypted: boolean): void =>
        emit({ session: 1, event: { type: "encryptionStatus", identity, encrypted } });
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

  it("OC-0473: a native decrypt degradation clears once the peer decrypts again", async () => {
    vi.useFakeTimers();
    try {
      const room = createNativeRoom(audio);
      const handlers = createRoomEventHandlers({ isNativeRoom: () => true } as RoomEventDeps);
      room.on("encryptionError", (err, p) =>
        handlers.handleEncryptionError(err as Error, p as Participant),
      );
      await room.connect("u", "t");
      emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
      const status = (encrypted: boolean): void =>
        emit({ session: 1, event: { type: "encryptionStatus", identity: "user-2", encrypted } });

      // A failure past the grace window reads "Unsecured"...
      status(false);
      vi.advanceTimersByTime(3000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
      // ...and the peer's frames decrypting again clears it.
      status(true);
      vi.advanceTimersByTime(3000);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);

      // The local E2EE not running is not the peer's to clear.
      status(false);
      vi.advanceTimersByTime(3000);
      emit({
        session: 1,
        event: { type: "encryptionStatus", identity: "user-1", encrypted: false },
      });
      status(true);
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
    expect(room.engine.pcManager).toBeUndefined();
    expect(room.localParticipant.getTrackPublication("microphone")).toBeUndefined();
    expect(room.localParticipant.permissions).toBeUndefined();
    await expect(room.localParticipant.setCameraEnabled(true)).rejects.toThrow(/Linux/);
    await expect(room.localParticipant.setCameraEnabled(false)).resolves.toBeUndefined();
  });
});

const video = (sid: string, source: "camera" | "screen_share" = "camera") => ({
  sid,
  kind: "video" as const,
  source,
  muted: false,
  encrypted: true,
});

const views = () => host.calls.filter(([n]) => n === "setVideoView").map(([, a]) => a);
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("NativeRoom remote video", () => {
  it("raises a subscribed video track backed by a renderer on the frame socket", async () => {
    const room = createNativeRoom(audio);
    const subscribed = vi.fn();
    room.on("trackSubscribed", subscribed);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers).toHaveLength(0);
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers.map((r) => r.url)).toEqual(["ws://127.0.0.1:9/tok/remote/TR_v"]);
    const [raised, pub, participant] = subscribed.mock.calls[0]!;
    expect(raised).toMatchObject({
      kind: "video",
      sid: "TR_v",
      mediaStreamTrack: { id: "canvas-0" },
    });
    expect(pub).toMatchObject({ source: "camera", track: raised });
    expect(participant).toBe(room.remoteParticipants.get("user-2"));
    expect(room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.track).toBe(
      raised,
    );
    // Audio still raises nothing: its playout is native.
    emit({ session: 1, event: { type: "trackSubscribed", identity: "user-2", track: track2() } });
    expect(subscribed).toHaveBeenCalledTimes(1);
  });

  it("disposes the renderer and raises TrackUnsubscribed when the track goes away", async () => {
    const room = createNativeRoom(audio);
    const unsubscribed = vi.fn();
    room.on("trackUnsubscribed", unsubscribed);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({ session: 1, event: { type: "trackUnsubscribed", identity: "user-2", sid: "TR_v" } });
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(unsubscribed.mock.calls[0]![0]).toMatchObject({ kind: "video", sid: "TR_v" });
    // A resubscribe gets a fresh renderer; an unpublish disposes it too.
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({ session: 1, event: { type: "trackUnpublished", identity: "user-2", sid: "TR_v" } });
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, true]);
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    expect(room.remoteParticipants.get("user-2")!.trackPublications.size).toBe(0);
  });

  it("replaces the renderer when a subscribed track is subscribed again", async () => {
    const room = createNativeRoom(audio);
    const unsubscribed = vi.fn();
    room.on("trackUnsubscribed", unsubscribed);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, false]);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  it("forwards the layer controls RemoteTracks drives to the native session (P3-07)", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    expect(pub.isEnabled).toBe(true);

    // Hidden: the stream stops.
    pub.setEnabled(false);
    expect(pub.isEnabled).toBe(false);
    // Shown in a 160-px tile: the layer waits for the enable, one update.
    pub.setVideoDimensions({ width: 160, height: 90 });
    pub.setEnabled(true);
    expect(pub.isEnabled).toBe(true);
    // Resized to 480 px, then focused (the top layer); a repeat sends nothing.
    pub.setVideoDimensions({ width: 480, height: 270 });
    pub.setEnabled(true);
    pub.setVideoQuality(2);
    pub.setEnabled(true);
    await settle();
    expect(views()).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", true, "low"],
      [1, "user-2", "TR_v", true, "medium"],
      [1, "user-2", "TR_v", true, "high"],
    ]);

    // A resubscribe comes enabled at the top layer, so hiding it is sent again.
    pub.setEnabled(false);
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(pub.isEnabled).toBe(true);
    pub.setEnabled(false);
    await settle();
    expect(views().slice(-2)).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", false, "high"],
    ]);
  });

  it("sends a publication's next view only once the host has applied the previous one", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    let applied!: () => void;
    host.setVideoView = () => new Promise<void>((r) => (applied = r));

    // Hidden, then shown again before the host finished hiding it.
    pub.setEnabled(false);
    pub.setEnabled(true);
    await settle();
    expect(views()).toEqual([[1, "user-2", "TR_v", false, "high"]]);
    applied();
    await settle();
    expect(views()).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", true, "high"],
    ]);
  });

  it("raises the unsubscriptions before the participant leaves", async () => {
    const room = createNativeRoom(audio);
    const order: string[] = [];
    room.on("trackUnsubscribed", () => order.push("trackUnsubscribed"));
    room.on("participantDisconnected", () => order.push("participantDisconnected"));
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    expect(order).toEqual(["trackUnsubscribed", "participantDisconnected"]);
    expect(host.renderers[0]!.disposed).toBe(true);
  });

  it("raises TrackPublished for a new publication and TrackUnpublished when it goes", async () => {
    const room = createNativeRoom(audio);
    const order: string[] = [];
    room.on("trackPublished", (pub) =>
      order.push(`published ${(pub as { trackSid: string }).trackSid}`),
    );
    room.on("trackUnsubscribed", () => order.push("trackUnsubscribed"));
    room.on("trackUnpublished", (pub) =>
      order.push(`unpublished ${(pub as { trackSid: string }).trackSid}`),
    );
    room.on("participantDisconnected", () => order.push("participantDisconnected"));
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_s", "screen_share") },
    });
    emit({ session: 1, event: { type: "trackUnpublished", identity: "user-2", sid: "TR_s" } });
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    // livekit-client's order: unsubscribed, then unpublished, then the leave.
    expect(order).toEqual([
      "published TR_v",
      "published TR_s",
      "unpublished TR_s",
      "trackUnsubscribed",
      "unpublished TR_v",
      "participantDisconnected",
    ]);
  });

  it("opt-in watching: the backend's auto-subscription of an unwatched stream raises no track", async () => {
    const room = createNativeRoom(audio);
    const watched = new Set<string>();
    const onRemoteVideo = vi.fn();
    const handlers = createRoomEventHandlers({
      isWatched: (uid: number, screen: boolean) => watched.has(`${uid}:${String(screen)}`),
      getOnRemoteVideoCallback: () => onRemoteVideo,
    } as unknown as RoomEventDeps);
    room.on("trackPublished", (pub, p) => handlers.handleTrackPublished(pub as never, p as never));
    room.on("trackSubscribed", (t, pub, p) =>
      handlers.handleTrackSubscribed(t as never, pub as never, p as never),
    );
    await room.connect("u", "t");
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );

    // The backend subscribes every track as it is published; the shared
    // handler unsubscribes the camera at once, and the late subscription
    // that was already on its way is dropped.
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    expect(host.renderers).toHaveLength(0);
    expect(onRemoteVideo).toHaveBeenCalledTimes(1);
    expect(onRemoteVideo).toHaveBeenCalledWith(2, null, false);

    // Watch: subscribed again, and the stream arrives.
    watched.add("2:false");
    room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.setSubscribed(true);
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-2", "TR_v", true]]);
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers).toHaveLength(1);
    expect(onRemoteVideo).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("auto-played cameras (WP 1B-3): the backend's subscription is kept, and Stop watching drops it", async () => {
    const room = createNativeRoom(audio);
    // RemoteTracks' rule with auto-play on: a camera is watched unless stopped.
    const stopped = new Set<number>();
    const onRemoteVideo = vi.fn();
    const handlers = createRoomEventHandlers({
      isWatched: (uid: number, screen: boolean) => !screen && !stopped.has(uid),
      getOnRemoteVideoCallback: () => onRemoteVideo,
    } as unknown as RoomEventDeps);
    room.on("trackPublished", (pub, p) => handlers.handleTrackPublished(pub as never, p as never));
    room.on("trackSubscribed", (t, pub, p) =>
      handlers.handleTrackSubscribed(t as never, pub as never, p as never),
    );
    await room.connect("u", "t");
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );

    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.calls).not.toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    expect(host.renderers).toHaveLength(1);
    expect(onRemoteVideo).toHaveBeenCalledTimes(1);
    expect(onRemoteVideo.mock.calls[0]![1]).not.toBeNull();

    stopped.add(2);
    room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.setSubscribed(false);
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    vi.unstubAllGlobals();
  });

  it("carries the backend's encryption report, so the shared handler unsubscribes an unencrypted track", async () => {
    const room = createNativeRoom(audio);
    const onRemoteVideo = vi.fn();
    const handlers = createRoomEventHandlers({
      isWatched: () => true,
      getOnRemoteVideoCallback: () => onRemoteVideo,
    } as unknown as RoomEventDeps);
    room.on("trackPublished", (pub, p) => handlers.handleTrackPublished(pub as never, p as never));
    await room.connect("u", "t");

    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    const encrypted = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    expect((encrypted as unknown as { trackInfo: unknown }).trackInfo).toEqual({ encryption: 1 });
    expect(host.calls).not.toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    expect(voiceStore.getState().encryptionDegraded).toBe(false);

    emit({
      session: 1,
      event: {
        type: "trackPublished",
        identity: "user-3",
        track: { ...video("TR_plain"), encrypted: false },
      },
    });
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-3", "TR_plain", false]]);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
    setEncryptionDegraded(false);
  });

  it("disposes every renderer on disconnect", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-3", track: video("TR_s", "screen_share") },
    });
    await room.disconnect();
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, true]);
  });
});

const cameraOptions = {
  source: "camera",
  simulcast: true,
  videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
};

/** Start a native camera capture as the shared enableCamera does, then
 *  publish it, returning the track. */
const startCamera = async (room: ReturnType<typeof createNativeRoom>) =>
  (await room.localParticipant.createCameraTracks(cameraOptions))[0]!;

describe("NativeRoom camera", () => {
  it("captures in the host and publishes it natively", async () => {
    let capture = 0;
    host.startCamera = () => Promise.resolve({ capture: ++capture, width: 1280, height: 720 });
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    expect(host.calls.filter(([n]) => n === "startCamera")).toEqual([
      ["startCamera", [1, "", { fps: 30, maxWidth: 0, maxHeight: 0 }]],
    ]);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toEqual([
      [
        "publishCamera",
        [
          1,
          1,
          { width: 1280, height: 720, maxBitrate: 1_700_000, maxFramerate: 30, simulcast: true },
        ],
      ],
    ]);
    // The self-view preview reads the host capture back over the socket.
    expect(host.renderers[0]!.url).toBe("ws://127.0.0.1:9/tok/camera");
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("unpublishes by its mediaStreamTrack and ignores other tracks", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    await room.localParticipant.unpublishTrack({} as MediaStreamTrack);
    expect(host.renderers[0]!.disposed).toBe(false);
    expect(host.calls.filter(([n]) => n === "stopCamera")).toHaveLength(0);
    await room.localParticipant.unpublishTrack(cam.mediaStreamTrack);
    // Stopping the track stops the host capture and unpublishes it.
    expect(host.calls.filter(([n]) => n === "stopCamera")).toEqual([
      ["stopCamera", [1, cam.capture]],
    ]);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("caps the host capture at the selected preset's resolution", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await room.localParticipant.createCameraTracks({
      ...cameraOptions,
      resolution: { width: 1280, height: 720 },
    });
    expect(host.calls.filter(([n]) => n === "startCamera")).toEqual([
      ["startCamera", [1, "", { fps: 30, maxWidth: 1280, maxHeight: 720 }]],
    ]);
  });

  it("refuses a browser camera track and a capture without a session", async () => {
    const room = createNativeRoom(audio);
    await expect(room.localParticipant.createCameraTracks(cameraOptions)).rejects.toThrow(
      /not connected/,
    );
    await room.connect("u", "t");
    await expect(
      room.localParticipant.publishTrack(
        { kind: "video", source: "camera", mediaStreamTrack: {} } as never,
        cameraOptions,
      ),
    ).rejects.toThrow(/Linux/);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toHaveLength(0);
  });

  it("starts no capture when the room disconnected during the start", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    let finish!: () => void;
    host.startCamera = () =>
      new Promise((r) => (finish = () => r({ capture: 5, width: 1280, height: 720 })));
    const starting = room.localParticipant.createCameraTracks(cameraOptions);
    await Promise.resolve();
    await room.disconnect();
    finish();
    await expect(starting).rejects.toThrow(/disconnected/);
    expect(host.renderers).toHaveLength(0);
  });

  it("refuses a publish that names no encoding rather than inventing one", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await expect(room.localParticipant.publishTrack(cam, { source: "camera" })).rejects.toThrow(
      /videoEncoding/,
    );
    await expect(
      room.localParticipant.publishTrack(cam, {
        source: "camera",
        videoEncoding: { maxBitrate: 1_700_000 },
      }),
    ).rejects.toThrow(/maxFramerate/);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toHaveLength(0);
  });

  it("scopes a stale unpublish to its own publication, not the camera replacing it", async () => {
    let capture = 0;
    host.startCamera = () => Promise.resolve({ capture: ++capture, width: 1280, height: 720 });
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await startCamera(room);
    await room.localParticipant.publishTrack(first, cameraOptions);
    const second = await startCamera(room);
    await room.localParticipant.publishTrack(second, cameraOptions);
    // A late unpublish of the replaced camera must leave the new one
    // published and its capture running.
    await room.localParticipant.unpublishTrack(first.mediaStreamTrack);
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(second);
    expect(host.calls.filter(([n]) => n === "stopCamera")).toEqual([["stopCamera", [1, 1]]]);
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, false]);
  });

  it("stops the host capture and disposes the preview on disconnect", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    await room.disconnect();
    expect(host.calls.some(([n, a]) => n === "stopCamera" && a[1] === cam.capture)).toBe(true);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("ends the camera track when the host reports the device gone", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    emit({ session: 1, event: { type: "cameraCaptureEnded", capture: cam.capture } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toContain("ended");
  });
});

function track2() {
  return track("TR_a", "microphone");
}

const screenOptions = {
  source: "screen_share",
  simulcast: false,
  videoEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 },
};
const share = async (room: ReturnType<typeof createNativeRoom>) => {
  const [screen] = await room.localParticipant.createScreenTracks();
  return screen!;
};

describe("NativeRoom screen share", () => {
  it("changes the live share's source in the host, keeping the track and its preview", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await screen.changeSource();
    // The share keeps the capture settings it was started with.
    expect(host.calls.at(-1)).toEqual([
      "changeScreen",
      [1, "window:9", { fps: 30, maxWidth: 1920, maxHeight: 1080 }],
    ]);
    expect(screen).toMatchObject({ capture: 6, width: 800, height: 600 });
    expect(host.noted).toEqual(["window:9"]);
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(screen);
    expect(host.renderers).toHaveLength(1);
    expect(host.renderers[0]!.disposed).toBe(false);
    // The new capture ending on its own ends the share; Stop stops it by id.
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 6 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toContain("ended");
    screen.stop();
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 6]]);
  });

  it("a cancelled or refused change leaves the live capture as it was", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    host.pickChange = () => Promise.resolve(null);
    await expect(screen.changeSource()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(host.calls.map(([n]) => n)).not.toContain("changeScreen");
    host.pickChange = () => Promise.resolve("portal");
    host.changeScreen = () => Promise.reject(new Error("screen capture portal did not start"));
    await expect(screen.changeSource()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(screen.capture).toBe(4);
    expect(host.noted).toEqual([]);
  });

  it("a Stop that reached the host after the swap still stops the new capture", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    let resolve!: (v: unknown) => void;
    host.changeScreen = () => new Promise((r) => (resolve = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(host.calls.map(([n]) => n)).toContain("changeScreen"));
    screen.stop();
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 4]]);
    resolve({ capture: 6, width: 800, height: 600 });
    await changing;
    expect(screen.capture).toBe(4);
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 6]]);
  });

  it("captures the picked source natively and previews it on the frame socket", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    expect(host.calls.at(-1)).toEqual([
      "startScreen",
      [1, "screen:7", { fps: 30, maxWidth: 1920, maxHeight: 1080 }],
    ]);
    expect(screen).toMatchObject({ kind: "video", source: "screen_share", capture: 4 });
    expect(host.renderers.map((r) => r.url)).toEqual(["ws://127.0.0.1:9/tok/screen"]);
    expect(screen.mediaStreamTrack).toBe(host.renderers[0]!.mediaStreamTrack);
    expect(nativeCounters.screenTracks).toBe(1);
  });

  it("publishes the capture at its size and unpublishes it by its preview track", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    const pub = await room.localParticipant.publishTrack(screen, screenOptions);
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [
        1,
        4,
        { width: 1280, height: 720, maxBitrate: 1_500_000, maxFramerate: 5, simulcast: false },
      ],
    ]);
    expect(pub).toMatchObject({ trackSid: "TR_screen", source: "screen_share" });
    // getLocalScreenshareStream reads it by source.
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(screen);
    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack);
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 4]]);
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
    expect(host.renderers[0]!.disposed).toBe(true);
    // The shared code stops the track next: nothing more reaches the host.
    screen.stop();
    expect(host.calls.filter(([n]) => n === "stopScreen")).toHaveLength(1);
    expect(nativeCounters.screenTracks).toBe(0);
  });

  it("publishes with simulcast when the picked quality asks for it", async () => {
    host.pick = () =>
      Promise.resolve({
        source: "screen:7",
        capture: { fps: 30, maxWidth: 1280, maxHeight: 720 },
        maxBitrate: 3_000_000,
        maxFramerate: 30,
        simulcast: true,
      });
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [
        1,
        4,
        { width: 1280, height: 720, maxBitrate: 3_000_000, maxFramerate: 30, simulcast: true },
      ],
    ]);
  });

  it("maps a closed picker to a dismissed picker and a portal that never started to its own outcome", async () => {
    const dismissed = { name: "NotAllowedError", message: "Permission denied by user" };
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    host.pick = () => Promise.resolve(null);
    await expect(share(room)).rejects.toMatchObject(dismissed);
    expect(host.calls.filter(([n]) => n === "startScreen")).toHaveLength(0);
    host.pick = () =>
      Promise.resolve({
        source: "portal",
        capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
        maxBitrate: 6_000_000,
        maxFramerate: 30,
      });
    // The portal cannot say whether the user cancelled, so it is not the
    // silent dismissal but its own outcome.
    host.startScreen = () => Promise.reject("screen capture portal did not start");
    await expect(share(room)).rejects.toMatchObject({
      name: "NotAllowedError",
      message: "screen capture portal did not start",
    });
    // A failure before the first frame and the first-frame timeout are
    // errors the user is told about, not cancels.
    for (const failure of [
      "that screen or window is no longer available",
      "screen capture failed to start",
      "screen capture produced no frame in time",
    ]) {
      host.startScreen = () => Promise.reject(failure);
      // oxlint-disable-next-line no-await-in-loop -- each start must settle before the next
      await expect(share(room)).rejects.toBe(failure);
    }
    expect(host.renderers).toHaveLength(0);
  });

  it("raises ended on the preview when the desktop ends its capture, not a stale one", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await share(room);
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 3 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual(["ended"]);
  });

  it("ends a track whose capture ended before its start result arrived", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    host.startScreen = () => {
      emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
      return Promise.resolve({ capture: 4, width: 1280, height: 720 });
    };
    const screen = await share(room);
    expect(screen.mediaStreamTrack.readyState).toBe("ended");
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual(["ended"]);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 1280, height: 720 });
    const next = await share(room);
    expect(next.mediaStreamTrack.readyState).toBe("live");
  });

  it("stops the previous capture's track when a new capture replaces it", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await share(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    const second = await share(room);
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, false]);
    expect(host.calls.filter(([n]) => n === "stopScreen")).toEqual([["stopScreen", [1, 4]]]);
    first.stop();
    expect(second.capture).toBe(5);
    expect(nativeCounters.screenTracks).toBe(1);
  });

  it("releases the screen track on disconnect and refuses one without a session", async () => {
    const room = createNativeRoom(audio);
    await expect(share(room)).rejects.toThrow(/not connected/);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.disconnect();
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
    expect(nativeCounters.screenTracks).toBe(0);
  });

  it("drops a capture that finished starting after the room disconnected", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    let finish: (() => void) | undefined;
    host.startScreen = () =>
      new Promise((r) => (finish = () => r({ capture: 4, width: 1, height: 1 })));
    const sharing = share(room);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await room.disconnect();
    finish!();
    await expect(sharing).rejects.toThrow(/disconnected/);
    expect(host.renderers).toHaveLength(0);
  });
});
