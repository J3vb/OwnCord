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
    EncryptionError: "encryptionError",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
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
  setDevice: (): Promise<void> => Promise.resolve(),
  pick: (): Promise<unknown> =>
    Promise.resolve({
      source: "screen:7",
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    }),
  startScreen: (): Promise<unknown> => Promise.resolve({ capture: 4, width: 1280, height: 720 }),
  unsubscribed: 0,
  renderers: [] as FakeMedia[],
  uplinks: [] as FakeMedia[],
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
vi.mock("./cameraUplink", () => ({
  CameraUplink: class {
    disposed = false;
    constructor(
      readonly url: string,
      readonly track: unknown,
      readonly maxFramerate: number,
    ) {
      host.uplinks.push(this);
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock("./screenPicker", () => ({ pickScreenSource: () => host.pick() }));
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
      setSubscribed: (...args: unknown[]) => {
        host.calls.push(["setSubscribed", args]);
        return Promise.resolve();
      },
      setVideoView: (...args: unknown[]) => {
        host.calls.push(["setVideoView", args]);
        return Promise.resolve();
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
  host.pick = () =>
    Promise.resolve({
      source: "screen:7",
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    });
  host.startScreen = () => Promise.resolve({ capture: 4, width: 1280, height: 720 });
  nativeCounters.screenTracks = 0;
  host.renderers.length = 0;
  host.uplinks.length = 0;
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
            tracks: [{ sid: "TR_a", kind: "audio", source: "microphone", muted: false }],
          },
        ],
      },
    });
    resolveConnect({ session: 3, identity: "user-1", frames: "" });
    await connecting;
    expect([...room.remoteParticipants.keys()]).toEqual(["user-2"]);
    expect(room.remoteParticipants.get("user-2")?.audioTrackPublications.size).toBe(1);
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

  it("deafen unsubscribes remote audio publications through the session", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: {
        type: "trackPublished",
        identity: "user-2",
        track: { sid: "TR_a", kind: "audio", source: "microphone", muted: false },
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
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(room.state).toBe("reconnecting");
    emit({ session: 1, event: { type: "reconnected" } });
    expect(room.state).toBe("connected");
    emit({ session: 1, event: { type: "encryptionStatus", identity: "user-1", encrypted: false } });
    expect(encryptionError).toHaveBeenCalledTimes(1);
    emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    expect(room.remoteParticipants.size).toBe(0);
    emit({ session: 1, event: { type: "disconnected", reason: "ServerShutdown" } });
    expect(disconnected).toHaveBeenCalledWith(0);
    expect(room.state).toBe("disconnected");
    room.removeAllListeners();
    emit({ session: 1, event: { type: "disconnected", reason: "ClientInitiated" } });
    expect(disconnected).toHaveBeenCalledTimes(1);
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
});

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
    // screenShare.getRemoteVideoStream looks the track up by source.
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
    const views = () => host.calls.filter(([n]) => n === "setVideoView").map(([, a]) => a);
    expect(pub.isEnabled).toBe(true);

    // Hidden: the stream stops.
    pub.setEnabled(false);
    expect(pub.isEnabled).toBe(false);
    // Shown in a 160-px tile: the lowest layer, then enabled.
    pub.setVideoDimensions({ width: 160, height: 90 });
    pub.setEnabled(true);
    expect(pub.isEnabled).toBe(true);
    // Resized to 480 px, then focused (the top layer); a repeat sends nothing.
    pub.setVideoDimensions({ width: 480, height: 270 });
    pub.setEnabled(true);
    pub.setVideoQuality(2);
    pub.setEnabled(true);
    expect(views()).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", false, "low"],
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
    expect(views().slice(-2)).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", false, "high"],
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

const cameraTrack = () => {
  const mediaStreamTrack = { getSettings: () => ({ width: 1280, height: 720 }) };
  return { kind: "video", source: "camera", mediaStreamTrack } as unknown as {
    kind: string;
    source: string;
    mediaStreamTrack: MediaStreamTrack;
  };
};
const cameraOptions = {
  source: "camera",
  simulcast: true,
  videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
};

describe("NativeRoom camera", () => {
  it("publishes the webview camera natively and pumps it up the frame socket", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = cameraTrack();
    await room.localParticipant.publishTrack(cam, cameraOptions);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toEqual([
      [
        "publishCamera",
        [1, { width: 1280, height: 720, maxBitrate: 1_700_000, maxFramerate: 30, simulcast: true }],
      ],
    ]);
    expect(host.uplinks).toMatchObject([
      { url: "ws://127.0.0.1:9/tok/camera", track: cam.mediaStreamTrack, maxFramerate: 30 },
    ]);
    // getLocalCameraStream reads the preview from here: the webview's own track.
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("unpublishes by its mediaStreamTrack and ignores other tracks", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = cameraTrack();
    await room.localParticipant.publishTrack(cam, cameraOptions);
    await room.localParticipant.unpublishTrack({} as MediaStreamTrack);
    expect(host.uplinks[0]!.disposed).toBe(false);
    await room.localParticipant.unpublishTrack(cam.mediaStreamTrack);
    expect(host.uplinks[0]!.disposed).toBe(true);
    expect(host.calls.at(-1)).toEqual(["unpublishCamera", [1, "TR_cam"]]);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
    await room.localParticipant.publishTrack(cam, cameraOptions);
    await room.localParticipant.setCameraEnabled(false);
    expect(host.uplinks[1]!.disposed).toBe(true);
    expect(host.calls.filter(([n]) => n === "unpublishCamera")).toHaveLength(2);
  });

  it("refuses a browser screen track and a publish without a session", async () => {
    const room = createNativeRoom(audio);
    await expect(room.localParticipant.publishTrack(cameraTrack(), cameraOptions)).rejects.toThrow(
      /not connected/,
    );
    await room.connect("u", "t");
    await expect(
      room.localParticipant.publishTrack(cameraTrack(), {
        ...cameraOptions,
        source: "screen_share",
      }),
    ).rejects.toThrow(/Linux/);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toHaveLength(0);
  });

  it("starts no pump when the room disconnected during the publish", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    let finish!: () => void;
    host.publishCamera = () => new Promise<string>((r) => (finish = () => r("TR_cam")));
    const publishing = room.localParticipant.publishTrack(cameraTrack(), cameraOptions);
    await Promise.resolve();
    await room.disconnect();
    finish();
    await expect(publishing).rejects.toThrow(/disconnected/);
    expect(host.uplinks).toHaveLength(0);
  });

  it("refuses a publish that names no encoding rather than inventing one", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await expect(
      room.localParticipant.publishTrack(cameraTrack(), { source: "camera" }),
    ).rejects.toThrow(/videoEncoding/);
    await expect(
      room.localParticipant.publishTrack(cameraTrack(), {
        source: "camera",
        videoEncoding: { maxBitrate: 1_700_000 },
      }),
    ).rejects.toThrow(/maxFramerate/);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toHaveLength(0);
  });

  it("scopes a stale unpublish to its own publication, not the camera replacing it", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const finish: Array<() => void> = [];
    let next = 0;
    host.publishCamera = () => {
      const sid = `TR_cam${++next}`;
      return new Promise<string>((r) => finish.push(() => r(sid)));
    };
    const [first, second] = [cameraTrack(), cameraTrack()];
    const publishingFirst = room.localParticipant.publishTrack(first, cameraOptions);
    const publishingSecond = room.localParticipant.publishTrack(second, cameraOptions);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    finish[0]!();
    await publishingFirst;
    // The superseded enable tears down its own track after the backend has
    // already started (and will finish) the replacing publish.
    await room.localParticipant.unpublishTrack(first.mediaStreamTrack);
    finish[1]!();
    await publishingSecond;
    expect(host.calls.filter(([n]) => n === "unpublishCamera")).toEqual([
      ["unpublishCamera", [1, "TR_cam1"]],
    ]);
    expect(room.localParticipant.getTrackPublication("camera")).toMatchObject({
      trackSid: "TR_cam2",
      track: second,
    });
    expect(host.uplinks.map((u) => u.disposed)).toEqual([true, false]);
  });

  it("disposes the pump of a publish the backend already replaced", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const finish: Array<() => void> = [];
    let next = 0;
    host.publishCamera = () => {
      const sid = `TR_cam${++next}`;
      return new Promise<string>((r) => finish.push(() => r(sid)));
    };
    const publishingFirst = room.localParticipant.publishTrack(cameraTrack(), cameraOptions);
    const publishingSecond = room.localParticipant.publishTrack(cameraTrack(), cameraOptions);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    finish[0]!();
    await publishingFirst;
    finish[1]!();
    await publishingSecond;
    expect(host.uplinks.map((u) => u.disposed)).toEqual([true, false]);
    expect(room.localParticipant.getTrackPublication("camera")!.trackSid).toBe("TR_cam2");
  });

  it("disposes the camera pump on disconnect", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await room.localParticipant.publishTrack(cameraTrack(), cameraOptions);
    await room.disconnect();
    expect(host.uplinks[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
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
      [1, 4, { width: 1280, height: 720, maxBitrate: 1_500_000, maxFramerate: 5 }],
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
