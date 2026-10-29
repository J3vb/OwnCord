import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  NativeVoiceEnvelope,
  NativeVoiceStats,
} from "../../../platform/contracts/nativeVoice";
import type { Participant, VideoQuality } from "livekit-client";

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
const log = vi.hoisted(() => ({
  tags: [] as string[],
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../../lib/logger", () => ({
  createLogger: (tag: string) => {
    log.tags.push(tag);
    return log;
  },
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
  changeCamera: (): Promise<unknown> => Promise.resolve({ capture: 7, width: 960, height: 720 }),
  setDevice: (): Promise<void> => Promise.resolve(),
  getStats: (): Promise<NativeVoiceStats | null> => Promise.resolve(null),
  setVideoView: (): Promise<void> => Promise.resolve(),
  pick: (): Promise<unknown> =>
    Promise.resolve({
      source: "screen:7",
      quality: "low",
      fps: 30,
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    }),
  setScreenQuality: (): Promise<unknown> =>
    Promise.resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 }),
  notedQuality: [] as Array<[string, number]>,
  startScreen: (): Promise<unknown> => Promise.resolve({ capture: 4, width: 1280, height: 720 }),
  changeScreen: (): Promise<unknown> => Promise.resolve({ capture: 6, width: 800, height: 600 }),
  pickChange: (): Promise<string | null> => Promise.resolve("window:9"),
  publishScreenAudio: (): Promise<string> => Promise.resolve("TR_audio"),
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
  // The picker's quality mapping (pinned in screenPicker.test.ts), as a table.
  shareSettings: (quality: string) =>
    ({
      low: {
        capture: { fps: 5, maxWidth: 1280, maxHeight: 720 },
        maxBitrate: 1_500_000,
        maxFramerate: 5,
        simulcast: false,
      },
      medium: {
        capture: { fps: 30, maxWidth: 1280, maxHeight: 720 },
        maxBitrate: 3_000_000,
        maxFramerate: 30,
        simulcast: true,
      },
      high: {
        capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
        maxBitrate: 6_000_000,
        maxFramerate: 30,
        simulcast: true,
      },
    })[quality],
  pickScreenSource: () => host.pick(),
  pickChangeSource: () => host.pickChange(),
  noteChangedSource: (source: string) => host.noted.push(source),
  noteChangedQuality: (quality: string, fps: number) => host.notedQuality.push([quality, fps]),
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
      getStats: (...args: unknown[]) => {
        host.calls.push(["getStats", args]);
        return host.getStats();
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
      unpublishScreen: (...args: unknown[]) => {
        host.calls.push(["unpublishScreen", args]);
        return Promise.resolve();
      },
      publishScreenAudio: (...args: unknown[]) => {
        host.calls.push(["publishScreenAudio", args]);
        return host.publishScreenAudio();
      },
      unpublishScreenAudio: (...args: unknown[]) => {
        host.calls.push(["unpublishScreenAudio", args]);
        return Promise.resolve();
      },
      stopScreen: (...args: unknown[]) => {
        host.calls.push(["stopScreen", args]);
        return Promise.resolve();
      },
      changeCamera: (...args: unknown[]) => {
        host.calls.push(["changeCamera", args]);
        return host.changeCamera();
      },
      changeScreen: (...args: unknown[]) => {
        host.calls.push(["changeScreen", args]);
        return host.changeScreen();
      },
      setScreenQuality: (...args: unknown[]) => {
        host.calls.push(["setScreenQuality", args]);
        return host.setScreenQuality();
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
import { desktop } from "../../../platform/desktop";
import { savePref } from "../../../lib/preferences";
import { NativeScreenAudioTrack } from "./screenAudioTrack";
import type { NativeScreenTrack } from "./screenTrack";
import { nativeCounters } from "./counters";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "../cameraSwitch";
import { setEncryptionDegraded, setLocalDeafened, voiceStore } from "../../../stores/voice.store";
import { createConnectionStatsPoller } from "../../../lib/connectionStats";
import { readSenderSample } from "../shareSenderStats";
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

  it("re-reports a remote decrypt failure the way the web worker does until it clears", async () => {
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
    // LP-5: stats stand-ins that report nothing until the room is connected.
    await expect(room.engine.pcManager.publisher.getStats()).resolves.toBeUndefined();
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

  it("forwards the layer controls RemoteTracks drives to the native session", async () => {
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

  it("auto-played cameras: the backend's subscription is kept, and Stop watching drops it", async () => {
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
          {
            width: 1280,
            height: 720,
            maxBitrate: 1_700_000,
            maxFramerate: 30,
            simulcast: true,
            codec: "vp8",
          },
        ],
      ],
    ]);
    // The self-view preview reads the host capture back over the socket.
    expect(host.renderers[0]!.url).toBe("ws://127.0.0.1:9/tok/camera");
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("publishCamera passes the codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    for (const [videoCodec, codec] of [
      ["h264", "h264"],
      ["vp8", "vp8"],
      ["vp9", "vp9"],
      // The native engine has no H.265: anything else is VP8.
      ["h265", "vp8"],
    ] as const) {
      host.calls.length = 0;
      // oxlint-disable-next-line no-await-in-loop -- one publish at a time
      await room.localParticipant.publishTrack(cam, { ...cameraOptions, videoCodec });
      const call = host.calls.find(([n]) => n === "publishCamera")!;
      expect(call[1][2]).toMatchObject({ codec });
    }
  });

  it("a codec republish keeps the capture and publishes with the new codec", async () => {
    const { room, cam } = await publishedCamera();
    const capture = cam.capture;
    await room.localParticipant.publishTrack(cam, { ...cameraOptions, videoCodec: "h264" });
    host.calls.length = 0;
    // The shared republish: unpublish without stopping the track, then publish.
    await room.localParticipant.unpublishTrack(cam.mediaStreamTrack, false);
    expect(host.calls.map(([n]) => n)).toEqual(["unpublishCamera"]);
    expect(host.renderers[0]!.disposed).toBe(false);
    await room.localParticipant.publishTrack(cam, { ...cameraOptions, videoCodec: "vp8" });
    expect(host.calls.map(([n]) => n)).toEqual(["unpublishCamera", "publishCamera"]);
    expect(host.calls.filter(([n]) => n === "stopCamera")).toHaveLength(0);
    expect(host.calls.at(-1)).toEqual([
      "publishCamera",
      [1, capture, expect.objectContaining({ codec: "vp8" })],
    ]);
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
  return screen as NativeScreenTrack;
};
const audioOptions = { source: "screen_share_audio", simulcast: false };
/** A share whose pick asked for audio: the video track and the audio track. */
const shareWithAudio = async (room: ReturnType<typeof createNativeRoom>) => {
  const pick = host.pick;
  host.pick = () => pick().then((p) => ({ ...(p as object), audio: true }));
  const [screen, audioTrack] = await room.localParticipant.createScreenTracks();
  return { screen: screen as NativeScreenTrack, audioTrack: audioTrack as NativeScreenAudioTrack };
};

const publishedCamera = async () => {
  const room = createNativeRoom(audio);
  await room.connect("u", "t");
  const cam = await startCamera(room);
  await room.localParticipant.publishTrack(cam, cameraOptions);
  host.calls.length = 0;
  return { room, cam };
};
const names = () => host.calls.map(([n]) => n);

describe("NativeRoom camera switch", () => {
  it("switches the camera in place: same sid, same preview track, new capture id", async () => {
    const { room, cam } = await publishedCamera();
    const preview = cam.mediaStreamTrack;
    await expect(cam.setDeviceId("/dev/video2")).resolves.toBe(true);
    expect(host.calls).toEqual([
      ["changeCamera", [1, "/dev/video2", { fps: 30, maxWidth: 0, maxHeight: 0 }]],
    ]);
    expect(names()).not.toContain("stopCamera");
    expect(names()).not.toContain("startCamera");
    expect(names()).not.toContain("publishCamera");
    expect(cam).toMatchObject({ capture: 7, width: 960, height: 720, device: "/dev/video2" });
    expect(cam.mediaStreamTrack).toBe(preview);
    expect(host.renderers).toHaveLength(1);
    expect(host.renderers[0]!.disposed).toBe(false);
    const publication = room.localParticipant.getTrackPublication("camera")!;
    expect(publication.track).toBe(cam);
    expect(publication.trackSid).toBe("TR_cam");
    // Stop now names the new capture.
    cam.stop();
    expect(host.calls.at(-1)).toEqual(["stopCamera", [1, 7]]);
  });

  it("a failed in-place switch throws CameraSwitchUnavailable and stops nothing", async () => {
    const { room, cam } = await publishedCamera();
    host.changeCamera = () => Promise.reject("busy");
    await expect(cam.setDeviceId("/dev/video2")).rejects.toBeInstanceOf(CameraSwitchUnavailable);
    expect(names()).toEqual(["changeCamera"]);
    expect(cam).toMatchObject({ capture: 5, device: "" });
    expect(host.renderers[0]!.disposed).toBe(false);
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("a picked device that opens but gives no frame is unusable, not a cue to restart", async () => {
    const { room, cam } = await publishedCamera();
    host.changeCamera = () => Promise.reject(new Error("camera capture produced no frame in time"));
    const err = await cam.setDeviceId("/dev/video2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraDeviceUnusable);
    expect(err).not.toBeInstanceOf(CameraSwitchUnavailable);
    expect(names()).toEqual(["changeCamera"]);
    expect(cam).toMatchObject({ capture: 5, device: "" });
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("a stop during the switch neither retargets nor falls back", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    cam.stop();
    expect(host.calls.at(-1)).toEqual(["stopCamera", [1, 5]]);
    resolve({ capture: 7, width: 960, height: 720 });
    const err = await switching.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CameraSwitchUnavailable);
    expect(cam.capture).toBe(5);
    // The swap landed after the stop named the old capture: the new one stops too.
    expect(host.calls.at(-1)).toEqual(["stopCamera", [1, 7]]);
  });

  it("a stop during a failing switch is not reported as unavailable", async () => {
    const { cam } = await publishedCamera();
    let reject!: (e: unknown) => void;
    host.changeCamera = () => new Promise((_, r) => (reject = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    cam.stop();
    reject("camera stopped during the change");
    const err = await switching.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CameraSwitchUnavailable);
  });

  it("a capture-ended event that beats the switch reply ends the track", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    emit({ session: 1, event: { type: "cameraCaptureEnded", capture: 7 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
    resolve({ capture: 7, width: 960, height: 720 });
    await expect(switching).resolves.toBe(true);
    expect(host.renderers[0]!.mediaStreamTrack!.events).toContain("ended");
  });

  it("picking the current device is a no-op", async () => {
    const { cam } = await publishedCamera();
    await expect(cam.setDeviceId("")).resolves.toBe(true);
    expect(host.calls).toEqual([]);
  });
});

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

  it("a live quality change sends the preset's capture and encoding with the published codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    expect(screen).toMatchObject({ quality: "low", fps: 30 });

    await screen.setQuality("high", 30, "h264");

    // High at 30 fps: 1080p, 6 Mbps and the lower simulcast layer; the codec
    // is the one the share goes out with, not the saved preference.
    expect(host.calls.at(-1)).toEqual([
      "setScreenQuality",
      [
        1,
        4,
        { fps: 30, maxWidth: 1920, maxHeight: 1080 },
        {
          width: 1280,
          height: 720,
          maxBitrate: 6_000_000,
          maxFramerate: 30,
          simulcast: true,
          codec: "h264",
        },
      ],
    ]);
    // The host sized the capture; the track and the publication follow it.
    expect(screen).toMatchObject({ quality: "high", fps: 30, width: 1920, height: 1080 });
    expect(screen.publishEncoding).toEqual({
      maxBitrate: 6_000_000,
      maxFramerate: 30,
      simulcast: true,
    });
    expect(screen.captureRequest).toEqual({ fps: 30, maxWidth: 1920, maxHeight: 1080 });
    const pub = room.localParticipant.getTrackPublication("screen_share")!;
    expect(pub.trackSid).toBe("TR_screen2");
    expect(pub.track).toBe(screen);
    expect(host.notedQuality).toEqual([["high", 30]]);
    // VP9 is a native codec (WP M-11b) and goes out as asked; H.265 is not
    // and publishes as VP8.
    await screen.setQuality("low", 30, "vp9");
    expect(host.calls.at(-1)![1][3]).toMatchObject({ codec: "vp9" });
    await screen.setQuality("low", 30, "h265");
    expect(host.calls.at(-1)![1][3]).toMatchObject({ codec: "vp8" });
  });

  it("a refused quality change leaves the share and its quality as they were", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    host.setScreenQuality = () =>
      Promise.resolve({ ok: false, stage: "refused", message: "a source change is pending" });

    await expect(screen.setQuality("high", 30, "vp8")).rejects.toMatchObject({
      name: "ScreenQualityError",
      stage: "refused",
    });

    expect(screen).toMatchObject({ quality: "low", fps: 30, width: 1280, height: 720 });
    expect(screen.captureRequest).toEqual({ fps: 30, maxWidth: 1920, maxHeight: 1080 });
    expect(room.localParticipant.getTrackPublication("screen_share")!.trackSid).toBe("TR_screen");
    expect(host.notedQuality).toEqual([]);
  });

  it("a publish-stage failure throws a typed error that names the stage", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    host.setScreenQuality = () =>
      Promise.resolve({ ok: false, stage: "publish", message: "publish failed" });

    await expect(screen.setQuality("high", 30, "vp8")).rejects.toMatchObject({
      name: "ScreenQualityError",
      stage: "publish",
      message: "publish failed",
    });
    expect(host.notedQuality).toEqual([]);
  });

  it("a quality change after a Stop is refused without asking the host", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    screen.stop();
    host.calls.length = 0;

    await expect(screen.setQuality("high", 30, "vp8")).rejects.toMatchObject({ stage: "refused" });
    expect(names()).not.toContain("setScreenQuality");
  });

  it("a Stop that overtook the host's reply leaves the stopped share alone", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let resolve!: (v: unknown) => void;
    host.setScreenQuality = () => new Promise((r) => (resolve = r));
    const changing = screen.setQuality("high", 30, "vp8");
    await vi.waitFor(() => expect(names()).toContain("setScreenQuality"));
    screen.stop();
    resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 });
    await expect(changing).rejects.toMatchObject({ stage: "refused" });

    expect(screen.quality).toBe("low");
    expect(host.notedQuality).toEqual([]);
  });

  it("a codec republish after a quality change publishes the new encoding", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await screen.setQuality("high", 30, "vp8");

    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack, false);
    await room.localParticipant.publishTrack(screen, screenOptions);

    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [
        1,
        4,
        {
          width: 1920,
          height: 1080,
          maxBitrate: 6_000_000,
          maxFramerate: 30,
          simulcast: true,
          codec: "vp8",
        },
      ],
    ]);
  });

  it("Change source keeps the changed capture request", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await screen.setQuality("medium", 30, "vp8");

    await screen.changeSource();

    expect(host.calls.at(-1)).toEqual([
      "changeScreen",
      [1, "window:9", { fps: 30, maxWidth: 1280, maxHeight: 720 }],
    ]);
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
        {
          width: 1280,
          height: 720,
          maxBitrate: 1_500_000,
          maxFramerate: 5,
          simulcast: false,
          codec: "vp8",
        },
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

  it("publishScreen passes the codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "h264" });
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "h264" })],
    ]);
    // H.265 is not a native codec: it publishes VP8.
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "h265" });
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "vp8" })],
    ]);
  });

  it("publishScreen passes vp9", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "vp9" });
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "vp9" })],
    ]);
  });

  it("a codec republish keeps the screen capture and publishes with the new codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "h264" });
    host.calls.length = 0;
    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack, false);
    expect(host.calls).toEqual([["unpublishScreen", [1, 4]]]);
    expect(host.renderers[0]!.disposed).toBe(false);
    expect(nativeCounters.screenTracks).toBe(1);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "vp8" });
    expect(host.calls.map(([n]) => n)).toEqual(["unpublishScreen", "publishScreen"]);
    expect(host.calls.filter(([n]) => n === "stopScreen")).toHaveLength(0);
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "vp8" })],
    ]);
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(screen);
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
        {
          width: 1280,
          height: 720,
          maxBitrate: 3_000_000,
          maxFramerate: 30,
          simulcast: true,
          codec: "vp8",
        },
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

const sample = (over: Partial<NativeVoiceStats> = {}): NativeVoiceStats => ({
  atMs: 1000,
  publisher: [
    {
      type: "candidate-pair",
      id: "CP1",
      currentRoundTripTime: 0.042,
      bytesSent: 900,
      bytesReceived: 1200,
    },
    { type: "outbound-rtp", id: "OA1", kind: "audio", packetsSent: 100, bytesSent: 4000 },
    {
      type: "inbound-rtp",
      id: "IA1",
      kind: "audio",
      packetsReceived: 100,
      bytesReceived: 3000,
      packetsLost: 0,
      jitter: 0.004,
    },
  ],
  subscriber: [],
  remoteVideo: {},
  localVideo: {},
  ...over,
});
const getStatsCalls = () => host.calls.filter(([n]) => n === "getStats");
const transports = (room: ReturnType<typeof createNativeRoom>) =>
  room.engine.pcManager as unknown as {
    publisher: { getStats(): Promise<ReadonlyMap<string, unknown> | undefined> };
    subscriber: { getStats(): Promise<ReadonlyMap<string, unknown> | undefined> };
  };
const tile = async (room: ReturnType<typeof createNativeRoom>) => {
  emit({
    session: 1,
    event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
  });
  return room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.track!;
};
const remote = (bytesReceived: number) => ({
  frameWidth: 1280,
  frameHeight: 720,
  framesDecoded: 60,
  bytesReceived,
  packetsLost: 2,
  packetsReceived: 300,
  mimeType: "video/VP8",
});

const layer = (fps: number) => ({
  framesPerSecond: fps,
  frameWidth: 1920,
  frameHeight: 1080,
  qualityLimitationReason: "cpu",
  encoderImplementation: "libvpx",
  active: true,
});

describe("NativeRoom stats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the stats poller reads ping, loss and jitter from the native reply", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const poller = createConnectionStatsPoller(() => room as never);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    const stats = poller.getStats();
    poller.stop();
    expect(stats.available).toBe(true);
    expect(stats.rtt).toBeCloseTo(42, 5);
    expect(stats.jitter).toBeCloseTo(4, 5);
    expect(stats.quality).toBe("excellent");
    expect(stats.totalUp).toBe(900);
  });

  it("one host call per tick is shared by the poller, a tile and the share", async () => {
    host.getStats = () =>
      Promise.resolve(
        sample({
          remoteVideo: {
            TR_v: {
              frameWidth: 640,
              frameHeight: 360,
              framesDecoded: 1,
              bytesReceived: 1,
              packetsLost: 0,
              packetsReceived: 1,
            },
          },
          localVideo: {
            screen_share: [
              { frameWidth: 1, frameHeight: 1, qualityLimitationReason: "none", active: true },
            ],
          },
        }),
      );
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const watched = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.track!;
    const screen = await share(room);
    await Promise.all([
      transports(room).publisher.getStats(),
      transports(room).subscriber.getStats(),
      watched.getReceiverStats(),
      screen.getSenderStats(),
    ]);
    expect(getStatsCalls()).toEqual([["getStats", [1]]]);
    await vi.advanceTimersByTimeAsync(1500);
    await transports(room).publisher.getStats();
    expect(getStatsCalls()).toHaveLength(2);
  });

  it("no host call and no report while not connected", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = createNativeRoom(audio);
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    await room.connect("u", "t");
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    emit({ session: 1, event: { type: "reconnected" } });
    expect(await transports(room).publisher.getStats()).toBeDefined();
    expect(getStatsCalls()).toHaveLength(1);
    await room.disconnect();
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    expect(getStatsCalls()).toHaveLength(1);
  });

  it("a reply that lands after disconnect is dropped", async () => {
    let land: ((s: NativeVoiceStats) => void) | undefined;
    host.getStats = () => new Promise((r) => (land = r));
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const pending = transports(room).publisher.getStats();
    await room.disconnect();
    land!(sample());
    expect(await pending).toBeUndefined();
  });

  it("a failed reply reads as no transports", async () => {
    host.getStats = () => Promise.resolve(null);
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const poller = createConnectionStatsPoller(() => room as never);
    const updates = vi.fn();
    poller.onUpdate(updates);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    poller.stop();
    expect(updates).not.toHaveBeenCalled();
    expect(poller.getStats().available).toBe(false);
    // A rejecting host is the same as a null one, and is not cached as a rejection.
    host.getStats = () => Promise.reject(new Error("boom"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await transports(room).publisher.getStats()).toBeUndefined();
  });

  it("an empty transport list is no report, not an empty one", async () => {
    host.getStats = () => Promise.resolve(sample({ publisher: [], subscriber: [] }));
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    expect(await transports(room).subscriber.getStats()).toBeUndefined();
  });

  it("serves each side's entries by id as a report", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const report = await transports(room).publisher.getStats();
    expect([...report!.keys()]).toEqual(["CP1", "OA1", "IA1"]);
    expect(await transports(room).subscriber.getStats()).toBeUndefined();
  });

  it("getReceiverStats maps the tile sample and bitrate comes from byte deltas", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const tileTrack = await tile(room);
    host.getStats = () => Promise.resolve(sample({ atMs: 1000, remoteVideo: { TR_v: remote(0) } }));
    const first = await tileTrack.getReceiverStats();
    expect(tileTrack.currentBitrate).toBeUndefined();
    expect(first).toEqual({
      frameWidth: 1280,
      frameHeight: 720,
      framesDecoded: 60,
      timestamp: 1000,
      mimeType: "video/VP8",
      packetsLost: 2,
      packetsReceived: 300,
    });
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () =>
      Promise.resolve(sample({ atMs: 3000, remoteVideo: { TR_v: remote(250_000) } }));
    await tileTrack.getReceiverStats();
    expect(tileTrack.currentBitrate).toBe(1_000_000);
  });

  it("getReceiverStats is undefined for a sid not in the reply and after dispose", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const tileTrack = await tile(room);
    host.getStats = () => Promise.resolve(sample({ remoteVideo: { TR_other: remote(1) } }));
    expect(await tileTrack.getReceiverStats()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () => Promise.resolve(sample({ remoteVideo: { TR_v: remote(1) } }));
    expect(await tileTrack.getReceiverStats()).toBeDefined();
    tileTrack.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await tileTrack.getReceiverStats()).toBeUndefined();
  });

  it("getSenderStats returns the share's layers and readSenderSample gives the sent fps", async () => {
    host.getStats = () =>
      Promise.resolve(sample({ localVideo: { screen_share: [layer(30), layer(15)] } }));
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    expect(await screen.getSenderStats()).toEqual([layer(30), layer(15)]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await readSenderSample(screen)).toMatchObject({ sentFps: 30, limitation: "cpu" });
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () => Promise.resolve(sample());
    await expect(screen.getSenderStats()).rejects.toThrow(/unavailable/);
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () => Promise.resolve(null);
    await expect(screen.getSenderStats()).rejects.toThrow(/unavailable/);
  });

  it("the ICE getters read unknown rather than throw", async () => {
    const room = createNativeRoom(audio);
    const pub = room.engine.pcManager.publisher;
    expect([
      pub.getICEConnectionState(),
      pub.getConnectionState(),
      pub.getSignallingState(),
    ]).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("NativeRoom screen-share audio", () => {
  beforeEach(() => {
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream =
      () => ({ getVideoTracks: () => [{ stop() {} }] });
  });
  afterEach(() => {
    delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
  });

  it("createScreenTracks adds a screen-audio track when the pick asks for it", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const none = await room.localParticipant.createScreenTracks();
    expect(none).toHaveLength(1);
    const { audioTrack } = await shareWithAudio(room);
    expect(audioTrack).toBeInstanceOf(NativeScreenAudioTrack);
    expect(audioTrack).toMatchObject({ kind: "audio", source: "screen_share_audio" });
  });

  it("publishing screen_share_audio calls the host and stores the publication", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    const pub = await room.localParticipant.publishTrack(audioTrack, audioOptions);
    expect(host.calls.at(-1)).toEqual(["publishScreenAudio", [1, 4]]);
    expect(pub).toMatchObject({
      trackSid: "TR_audio",
      source: "screen_share_audio",
      kind: "audio",
    });
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(audioTrack);
    // Unpublishing by the token unpublishes the sid and nothing else.
    await room.localParticipant.unpublishTrack(audioTrack.mediaStreamTrack);
    expect(host.calls.at(-1)).toEqual(["unpublishScreenAudio", [1, "TR_audio"]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeDefined();
  });

  it("a codec republish unpublishes only the video", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    host.calls.length = 0;
    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack, false);
    expect(host.calls).toEqual([["unpublishScreen", [1, 4]]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(audioTrack);
    await room.localParticipant.publishTrack(screen, screenOptions);
    expect(names()).toEqual(["unpublishScreen", "publishScreen"]);
  });

  it("stopping the audio track unpublishes its sid once, and a stop of the share ends it too", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    host.calls.length = 0;
    audioTrack.stop();
    audioTrack.stop();
    expect(host.calls).toEqual([["unpublishScreenAudio", [1, "TR_audio"]]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();

    // Stopping the video stops the audio that follows it.
    const second = await shareWithAudio(room);
    await room.localParticipant.publishTrack(second.audioTrack, audioOptions);
    host.calls.length = 0;
    second.screen.stop();
    expect(second.audioTrack.isStopped).toBe(true);
    expect(names()).toEqual(["unpublishScreenAudio", "stopScreen"]);
  });

  it("a_share_audio_stopped_mid_publish_is_unpublished_when_its_sid_lands", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let land!: (sid: string) => void;
    host.publishScreenAudio = () => new Promise<string>((resolve) => (land = resolve));
    const publishing = room.localParticipant.publishTrack(audioTrack, audioOptions);
    await vi.waitFor(() => expect(names()).toContain("publishScreenAudio"));
    audioTrack.stop();
    // Nothing to unpublish yet: the sid is unknown.
    expect(names()).not.toContain("unpublishScreenAudio");
    land("TR_late");
    await publishing;
    expect(host.calls.at(-1)).toEqual(["unpublishScreenAudio", [1, "TR_late"]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
  });

  it("a_share_audio_publish_after_disconnect_throws_and_keeps_nothing", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let land!: (sid: string) => void;
    host.publishScreenAudio = () => new Promise<string>((resolve) => (land = resolve));
    const publishing = room.localParticipant.publishTrack(audioTrack, audioOptions);
    await vi.waitFor(() => expect(names()).toContain("publishScreenAudio"));
    await room.disconnect();
    land("TR_late");
    await expect(publishing).rejects.toThrow(
      "native room disconnected during screen audio publish",
    );
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
    expect(names()).not.toContain("unpublishScreenAudio");
  });

  it("refuses a screen-audio publish while no share is running", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const orphan = new NativeScreenAudioTrack(() => {});
    await expect(room.localParticipant.publishTrack(orphan, audioOptions)).rejects.toThrow(
      "screen share is not running",
    );
    expect(names()).not.toContain("publishScreenAudio");
  });

  it("a stale screen track's late stop leaves the live share's audio", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await shareWithAudio(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    const second = await shareWithAudio(room);
    await room.localParticipant.publishTrack(second.screen, screenOptions);
    await room.localParticipant.publishTrack(second.audioTrack, audioOptions);
    first.screen.stop();
    expect(second.audioTrack.isStopped).toBe(false);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(
      second.audioTrack,
    );
  });

  it("refuses a stale audio track's publish so it cannot replace a newer share's", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await shareWithAudio(room);
    await shareWithAudio(room);
    host.calls.length = 0;
    await expect(
      room.localParticipant.publishTrack(first.audioTrack, audioOptions),
    ).rejects.toThrow("stale");
    expect(names()).not.toContain("publishScreenAudio");
  });

  it("disconnect stops the audio track", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    await room.disconnect();
    expect(audioTrack.isStopped).toBe(true);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
  });

  it("a Change source keeps the screen_share_audio publication", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    host.calls.length = 0;
    await screen.changeSource();
    expect(screen.capture).toBe(6);
    expect(names()).toEqual(["changeScreen"]);
    expect(audioTrack.isStopped).toBe(false);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(audioTrack);
  });
});

// --- Surface, command failures and publication bookkeeping ---

const nativeVoice = desktop.nativeVoice;
type GateCommand =
  | "setPttGated"
  | "setVoiceGate"
  | "setInputGain"
  | "setAudioProcessing"
  | "setSubscribed"
  | "setVideoView"
  | "setVolume"
  | "setScreenshareVolume";
const rejectOnce = (command: GateCommand, err: unknown) =>
  vi.spyOn(nativeVoice, command).mockRejectedValueOnce(err);
const connected = async () => {
  const room = createNativeRoom(audio);
  await room.connect("u", "t");
  host.calls.length = 0;
  return room;
};

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

describe("NativeRoom remote video bitrate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives the bitrate from the byte deltas of distinct, advancing samples only", async () => {
    const room = await connected();
    const tileTrack = await tile(room);
    const read = async (atMs: number, bytes: number) => {
      host.getStats = () => Promise.resolve(sample({ atMs, remoteVideo: { TR_v: remote(bytes) } }));
      await vi.advanceTimersByTimeAsync(2000);
      await tileTrack.getReceiverStats();
      return tileTrack.currentBitrate;
    };

    expect(await read(1000, 100_000)).toBeUndefined();
    expect(await read(3000, 350_000)).toBe(1_000_000);
    // The same tick served again, even with other numbers, changes nothing.
    expect(await read(3000, 999_999)).toBe(1_000_000);
    // A reply older than the last sample is ignored, not read as a negative span.
    expect(await read(2500, 400_000)).toBe(1_000_000);
    // The next delta is against the last accepted sample (3000 ms, 350000 B).
    expect(await read(5000, 475_000)).toBe(500_000);
    // A byte counter that went backwards (a restarted stream) has no rate.
    expect(await read(7000, 100)).toBeUndefined();
    // No new bytes over a later tick is a rate of zero, not an unknown one.
    expect(await read(9000, 100)).toBe(0);
  });

  it("shares a host reply read within 1.5 s of the first, wherever the clock stands", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = await connected();
    await vi.advanceTimersByTimeAsync(1000);
    await transports(room).publisher.getStats();
    await vi.advanceTimersByTimeAsync(1499);
    await transports(room).subscriber.getStats();
    expect(getStatsCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await transports(room).subscriber.getStats();
    expect(getStatsCalls()).toHaveLength(2);
  });
});

describe("NativeRoom camera capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("starts the saved camera device and treats picking it again as a no-op", async () => {
    savePref("videoInputDevice", "/dev/video4");
    const room = await connected();
    const cam = await startCamera(room);
    expect(host.calls.filter(([n]) => n === "startCamera")).toEqual([
      ["startCamera", [1, "/dev/video4", { fps: 30, maxWidth: 0, maxHeight: 0 }]],
    ]);
    expect(cam.device).toBe("/dev/video4");
  });

  it("ends a track whose capture ended before its start result arrived, and only that one", async () => {
    const room = await connected();
    host.startCamera = () => {
      emit({ session: 1, event: { type: "cameraCaptureEnded", capture: 5 } });
      return Promise.resolve({ capture: 5, width: 1280, height: 720 });
    };
    const first = await startCamera(room);
    expect(first.mediaStreamTrack.readyState).toBe("ended");
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual(["ended"]);
    host.startCamera = () => Promise.resolve({ capture: 6, width: 1280, height: 720 });
    const next = await startCamera(room);
    expect(next.mediaStreamTrack.readyState).toBe("live");
  });

  it("a capture that ended elsewhere does not end the camera switched onto a new one", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    emit({ session: 1, event: { type: "cameraCaptureEnded", capture: 99 } });
    resolve({ capture: 7, width: 960, height: 720 });
    await expect(switching).resolves.toBe(true);
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
  });

  it("refuses a device change once the camera was stopped", async () => {
    const { cam } = await publishedCamera();
    cam.stop();
    host.calls.length = 0;
    await expect(cam.setDeviceId("/dev/video2")).rejects.toThrow("camera is no longer live");
    expect(names()).not.toContain("changeCamera");
  });

  it("says the camera ended when a stop lands during a failing or succeeding switch", async () => {
    for (const outcome of ["fail", "succeed"]) {
      // oxlint-disable-next-line no-await-in-loop -- each round builds its own room
      const { room, cam } = await publishedCamera();
      let settleSwitch!: () => void;
      host.changeCamera = () =>
        new Promise((resolve, reject) => {
          settleSwitch = () =>
            outcome === "fail"
              ? reject(new Error("busy"))
              : resolve({ capture: 7, width: 960, height: 720 });
        });
      const switching = cam.setDeviceId("/dev/video2");
      // oxlint-disable-next-line no-await-in-loop -- the host call must be pending first
      await vi.waitFor(() => expect(names()).toContain("changeCamera"));
      cam.stop();
      settleSwitch();
      // oxlint-disable-next-line no-await-in-loop -- one outcome at a time
      await expect(switching).rejects.toThrow("camera ended during the device change");
      // oxlint-disable-next-line no-await-in-loop -- the next round needs the registry clear
      await room.disconnect();
    }
  });

  it("a room that left mid-switch does not stop the new capture on a session that is gone", async () => {
    const { room, cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    await room.disconnect();
    host.calls.length = 0;
    resolve({ capture: 7, width: 960, height: 720 });
    await expect(switching).rejects.toThrow("camera ended during the device change");
    expect(host.calls).toEqual([]);
  });

  it("logs a stop the host refused, for the capture it named", async () => {
    const { cam } = await publishedCamera();
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopCamera").mockRejectedValue(err);
    cam.stop();
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopCamera failed", { capture: 5, err });
  });

  it("logs the stop of a capture that finished switching after the camera was stopped", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopCamera").mockRejectedValue(err);
    cam.stop();
    resolve({ capture: 7, width: 960, height: 720 });
    await switching.catch(() => undefined);
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopCamera failed", { capture: 7, err });
  });
});

describe("NativeRoom camera publication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the refusals it makes", async () => {
    const room = createNativeRoom(audio);
    const browserTrack = { kind: "video", source: "camera", mediaStreamTrack: {} } as never;
    await expect(room.localParticipant.publishTrack(browserTrack, cameraOptions)).rejects.toThrow(
      "native room is not connected",
    );
    await room.connect("u", "t");
    await expect(room.localParticipant.publishTrack(browserTrack, cameraOptions)).rejects.toThrow(
      "publishing a browser camera track is not available on Linux yet",
    );
    await expect(room.localParticipant.setCameraEnabled(true)).rejects.toThrow(
      "setCameraEnabled(true) is not available on Linux yet",
    );
  });

  it("publishes a camera as unmuted video and defaults to a single layer", async () => {
    const room = await connected();
    const cam = await startCamera(room);
    const publication = await room.localParticipant.publishTrack(cam, {
      source: "camera",
      videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
    });
    expect(publication).toMatchObject({
      trackSid: "TR_cam",
      source: "camera",
      kind: "video",
      isMuted: false,
      track: cam,
    });
    expect(host.calls.find(([n]) => n === "publishCamera")![1][2]).toMatchObject({
      simulcast: false,
    });
  });

  it("stops the capture and the preview when the host refuses the publish", async () => {
    const room = await connected();
    const cam = await startCamera(room);
    host.calls.length = 0;
    host.publishCamera = () => Promise.reject(new Error("no encoder"));
    await expect(room.localParticipant.publishTrack(cam, cameraOptions)).rejects.toThrow(
      "no encoder",
    );
    // The failure path stops the capture itself, then the track's own stop reports it too.
    expect(names()).toEqual(["publishCamera", "stopCamera", "stopCamera"]);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("keeps nothing when the room left while the host published", async () => {
    const room = await connected();
    const cam = await startCamera(room);
    let finish!: () => void;
    host.publishCamera = () => new Promise((r) => (finish = () => r("TR_late")));
    const publishing = room.localParticipant.publishTrack(cam, cameraOptions);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await room.disconnect();
    finish();
    await expect(publishing).rejects.toThrow("native room disconnected during camera publish");
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("turning the camera off stops the capture and forgets the publication", async () => {
    const { room } = await publishedCamera();
    await room.localParticipant.setCameraEnabled(false);
    expect(names()).toEqual(["stopCamera"]);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("a stopped camera drops its publication and its host capture", async () => {
    const { room, cam } = await publishedCamera();
    cam.stop();
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
    expect(host.calls).toEqual([["stopCamera", [1, 5]]]);
  });

  it("a late stop of a camera from an earlier session leaves the current one alone", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const stale = await startCamera(room);
    await room.disconnect();
    host.connectResult = Promise.resolve({ session: 2, identity: "user-1", frames: "ws://h/tok" });
    await room.connect("u", "t");
    host.startCamera = () => Promise.resolve({ capture: 8, width: 1280, height: 720 });
    const current = await startCamera(room);
    await room.localParticipant.publishTrack(current, cameraOptions);
    host.calls.length = 0;

    stale.stop();

    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(current);
    expect(host.calls).toEqual([]);
    // The room still treats the current camera as live.
    await expect(current.setDeviceId("/dev/video2")).resolves.toBe(true);
  });
});

describe("NativeRoom screen publication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the refusals it makes", async () => {
    const room = createNativeRoom(audio);
    const browserTrack = { kind: "video", source: "screen_share", mediaStreamTrack: {} } as never;
    await expect(room.localParticipant.publishTrack(browserTrack, screenOptions)).rejects.toThrow(
      "native room is not connected",
    );
    await expect(
      room.localParticipant.publishTrack(
        { kind: "audio", source: "screen_share_audio", mediaStreamTrack: {} } as never,
        audioOptions,
      ),
    ).rejects.toThrow("native room is not connected");
    await room.connect("u", "t");
    await expect(room.localParticipant.publishTrack(browserTrack, screenOptions)).rejects.toThrow(
      "publishing a browser screen track is not available on Linux yet",
    );
    await expect(
      room.localParticipant.publishTrack(
        { kind: "audio", source: "screen_share_audio", mediaStreamTrack: {} } as never,
        audioOptions,
      ),
    ).rejects.toThrow("publishing a browser screen audio track is not available on Linux yet");
    await expect(room.localParticipant.setScreenShareEnabled(true)).rejects.toThrow(
      "setScreenShareEnabled(true) is not available on Linux yet",
    );
  });

  it("routes a publish by the option's source before the track's own", async () => {
    const room = await connected();
    const browserCamera = { kind: "video", source: "camera", mediaStreamTrack: {} } as never;
    await expect(
      room.localParticipant.publishTrack(browserCamera, { source: "screen_share" }),
    ).rejects.toThrow("browser screen track");
    await expect(
      room.localParticipant.publishTrack(browserCamera, { simulcast: false }),
    ).rejects.toThrow("browser camera track");
    const orphan = new NativeScreenAudioTrack(() => {});
    await expect(room.localParticipant.publishTrack(orphan, {})).rejects.toThrow(
      "screen share is not running",
    );
  });

  it("publishes a screen share as unmuted video", async () => {
    const room = await connected();
    const screen = await share(room);
    const publication = await room.localParticipant.publishTrack(screen, screenOptions);
    expect(publication).toMatchObject({
      trackSid: "TR_screen",
      source: "screen_share",
      kind: "video",
      isMuted: false,
      track: screen,
    });
  });

  it("keeps nothing when the room left while the host published the share", async () => {
    const room = await connected();
    const screen = await share(room);
    let finish!: () => void;
    vi.spyOn(nativeVoice, "publishScreen").mockImplementation(
      () => new Promise((r) => (finish = () => r("TR_late"))),
    );
    const publishing = room.localParticipant.publishTrack(screen, screenOptions);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await room.disconnect();
    finish();
    await expect(publishing).rejects.toThrow("native room disconnected during screen publish");
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
  });

  it("turning the share off stops its capture and forgets the publication", async () => {
    const room = await connected();
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    host.calls.length = 0;
    await room.localParticipant.setScreenShareEnabled(false);
    expect(host.calls).toEqual([["stopScreen", [1, 4]]]);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
  });

  it("drops a leftover publication of a replaced share when the room disconnects", async () => {
    const room = await connected();
    const old = await share(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    await share(room);
    await room.localParticipant.publishTrack(old, screenOptions);
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(old);
    await room.disconnect();
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
  });

  it("drops a leftover publication of a replaced camera when the room disconnects", async () => {
    const room = await connected();
    const old = await startCamera(room);
    host.startCamera = () => Promise.resolve({ capture: 6, width: 1280, height: 720 });
    await startCamera(room);
    await room.localParticipant.publishTrack(old, cameraOptions);
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(old);
    await room.disconnect();
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("logs a stop the host refused, for the capture it named", async () => {
    const room = await connected();
    const screen = await share(room);
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopScreen").mockRejectedValue(err);
    screen.stop();
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopScreen failed", { capture: 4, err });
  });
});

describe("NativeRoom screen capture", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts nothing when the room left during the pick", async () => {
    const room = await connected();
    let choose!: (pick: unknown) => void;
    host.pick = () => new Promise((r) => (choose = r));
    const sharing = share(room);
    await vi.waitFor(() => expect(choose).toBeDefined());
    await room.disconnect();
    choose({
      source: "screen:7",
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    });
    await expect(sharing).rejects.toThrow("native room disconnected during screen pick");
    expect(names()).not.toContain("startScreen");
  });

  it("ends a share with audio whose capture ended before its start result, and only that one", async () => {
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream =
      () => ({ getVideoTracks: () => [{ stop() {} }] });
    try {
      const room = await connected();
      host.startScreen = () => {
        emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
        return Promise.resolve({ capture: 4, width: 1280, height: 720 });
      };
      const { screen } = await shareWithAudio(room);
      expect(screen.mediaStreamTrack.readyState).toBe("ended");
      host.startScreen = () => Promise.resolve({ capture: 5, width: 1280, height: 720 });
      const next = await shareWithAudio(room);
      expect(next.screen.mediaStreamTrack.readyState).toBe("live");
    } finally {
      delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
    }
  });

  it("refuses a Change source once the share was stopped", async () => {
    const room = await connected();
    const screen = await share(room);
    screen.stop();
    host.calls.length = 0;
    await expect(screen.changeSource()).rejects.toThrow("screen share is no longer live");
    expect(names()).toEqual([]);
  });

  it("drops a Change source whose share was stopped during the pick", async () => {
    const room = await connected();
    const screen = await share(room);
    let choose!: (source: string) => void;
    host.pickChange = () => new Promise((r) => (choose = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(choose).toBeDefined());
    screen.stop();
    host.calls.length = 0;
    choose("window:9");
    await expect(changing).rejects.toThrow("screen share ended during the pick");
    expect(names()).toEqual([]);
  });

  it("a capture that ends during Change source ends the track only when it is the new one", async () => {
    for (const ended of [99, 6]) {
      // oxlint-disable-next-line no-await-in-loop -- each round builds its own room
      const room = await connected();
      // oxlint-disable-next-line no-await-in-loop -- the room must be up first
      const screen = await share(room);
      let resolve!: (v: unknown) => void;
      host.changeScreen = () => new Promise((r) => (resolve = r));
      const changing = screen.changeSource();
      // oxlint-disable-next-line no-await-in-loop -- the host call must be pending first
      await vi.waitFor(() => expect(names()).toContain("changeScreen"));
      emit({ session: 1, event: { type: "screenCaptureEnded", capture: ended } });
      resolve({ capture: 6, width: 800, height: 600 });
      // oxlint-disable-next-line no-await-in-loop -- one share at a time
      await changing;
      expect(host.renderers.at(-1)!.mediaStreamTrack!.events).toEqual(ended === 6 ? ["ended"] : []);
      // oxlint-disable-next-line no-await-in-loop -- the next round needs the registry clear
      await room.disconnect();
    }
  });

  it("leaves a share that was stopped by a room leaving mid-change without a stop on the old session", async () => {
    const room = await connected();
    const screen = await share(room);
    let resolve!: (v: unknown) => void;
    host.changeScreen = () => new Promise((r) => (resolve = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(names()).toContain("changeScreen"));
    await room.disconnect();
    host.calls.length = 0;
    resolve({ capture: 6, width: 800, height: 600 });
    await changing;
    expect(host.calls).toEqual([]);
  });

  it("logs the stop of a swapped-in capture the host refused", async () => {
    const room = await connected();
    const screen = await share(room);
    let resolve!: (v: unknown) => void;
    host.changeScreen = () => new Promise((r) => (resolve = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(names()).toContain("changeScreen"));
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopScreen").mockRejectedValue(err);
    screen.stop();
    resolve({ capture: 6, width: 800, height: 600 });
    await changing;
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopScreen failed", { capture: 6, err });
  });

  it("explains a quality change refused after a Stop, or one a Stop overtook", async () => {
    const room = await connected();
    const stopped = await share(room);
    stopped.stop();
    await expect(stopped.setQuality("high", 30, "vp8")).rejects.toMatchObject({
      stage: "refused",
      message: "screen share is no longer live",
    });

    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    const live = await share(room);
    let resolve!: (v: unknown) => void;
    host.setScreenQuality = () => new Promise((r) => (resolve = r));
    const changing = live.setQuality("high", 30, "vp8");
    await vi.waitFor(() => expect(names()).toContain("setScreenQuality"));
    live.stop();
    resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 });
    await expect(changing).rejects.toMatchObject({
      stage: "refused",
      message: "the share ended during the change",
    });
  });
});

describe("NativeRoom screen audio publication", () => {
  beforeEach(() => {
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream =
      () => ({ getVideoTracks: () => [{ stop() {} }] });
  });
  afterEach(() => {
    delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
    vi.restoreAllMocks();
  });

  it("publishes the share's audio as unmuted audio", async () => {
    const room = await connected();
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    const publication = await room.localParticipant.publishTrack(audioTrack, audioOptions);
    expect(publication).toMatchObject({
      trackSid: "TR_audio",
      source: "screen_share_audio",
      kind: "audio",
      isMuted: false,
      track: audioTrack,
    });
  });

  it("refuses an audio track that never belonged to the running share", async () => {
    const room = await connected();
    await share(room);
    host.calls.length = 0;
    const stranger = new NativeScreenAudioTrack(() => {});
    await expect(room.localParticipant.publishTrack(stranger, audioOptions)).rejects.toThrow(
      "screen audio is stale",
    );
    expect(names()).toEqual([]);
  });

  it("logs a sid the host would not unpublish after a stop mid-publish", async () => {
    const room = await connected();
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let land!: (sid: string) => void;
    host.publishScreenAudio = () => new Promise<string>((resolve) => (land = resolve));
    const publishing = room.localParticipant.publishTrack(audioTrack, audioOptions);
    await vi.waitFor(() => expect(names()).toContain("publishScreenAudio"));
    audioTrack.stop();
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "unpublishScreenAudio").mockRejectedValue(err);
    land("TR_late");
    await publishing;
    expect(log.warn).toHaveBeenCalledWith("native unpublishScreenAudio failed", {
      sid: "TR_late",
      err,
    });
  });

  it("logs a stop of the audio track the host would not unpublish", async () => {
    const room = await connected();
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "unpublishScreenAudio").mockRejectedValue(err);
    audioTrack.stop();
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native unpublishScreenAudio failed", {
      sid: "TR_audio",
      err,
    });
  });
});

const reportEncryption = (identity: string, encrypted: boolean): void =>
  emit({ session: 1, event: { type: "encryptionStatus", identity, encrypted } });

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
