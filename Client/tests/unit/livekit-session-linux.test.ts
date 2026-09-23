// The facade on the Linux native backend. `livekit-session.test.ts` is the
// contract for LiveKitSession's state machine against the web Room; this
// file runs the same facade with `isLinuxDesktop()` true, so the joins,
// mute/deafen, teardown and reconnect below are served by the NativeRoom
// adapter over the `NativeVoice` host contract. What it pins:
//   - the room key reaches the native provider before the native connect,
//     as the exact base64 text (and the web key provider is never written);
//   - connect/microphone/disconnect are issued against the native session
//     and released in the facade's own teardown;
//   - a native-reported drop reconnects through the shared reconnect loop;
//   - native resource counts are visible through getSessionDebugInfo.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NativeVoiceEnvelope } from "../../src/platform/contracts/nativeVoice";

const mockVoiceState = vi.hoisted(() => ({
  localMuted: false,
  localDeafened: false,
  localServerMuted: false,
  localServerDeafened: false,
  localCamera: false,
  localScreenshare: false,
  pttGated: false,
  listenOnly: false,
  currentChannelId: 1 as number | null,
  voiceConfigs: new Map<number, { bitrate: number }>(),
}));

vi.mock("../../src/features/voice/native/platform", () => ({ isLinuxDesktop: () => true }));

const webKeyProvider = vi.hoisted(() => ({ setKey: vi.fn(), removeAllListeners: vi.fn() }));
vi.mock("livekit-client", () => ({
  Room: vi.fn(function () {
    throw new Error("the web Room must not be built on Linux");
  }),
  RoomEvent: {
    Connected: "connected",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    Disconnected: "disconnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
    EncryptionError: "encryptionError",
    LocalTrackPublished: "localTrackPublished",
    ParticipantPermissionsChanged: "participantPermissionsChanged",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    SignalReconnecting: "signalReconnecting",
    MediaDevicesError: "mediaDevicesError",
    ConnectionQualityChanged: "connectionQualityChanged",
  },
  Track: {
    sourceToProto: (source: string) => (source === "microphone" ? 2 : 0),
    Source: {
      Microphone: "microphone",
      Camera: "camera",
      ScreenShare: "screen_share",
      ScreenShareAudio: "screen_share_audio",
    },
    Kind: { Audio: "audio", Video: "video" },
  },
  VideoPresets: { h360: {}, h720: {}, h1080: {} },
  ScreenSharePresets: { h720fps5: {}, h1080fps15: {}, h1080fps30: {} },
  DisconnectReason: { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1 },
  ExternalE2EEKeyProvider: vi.fn(function () {
    return webKeyProvider;
  }),
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: vi.fn(() => mockVoiceState),
    get: vi.fn(),
    set: vi.fn(),
    subscribe: vi.fn(),
  },
  setLocalMuted: vi.fn(),
  setLocalDeafened: vi.fn(),
  setLocalCamera: vi.fn(),
  setLocalScreenshare: vi.fn(),
  setPttGated: vi.fn(),
  setPttPollingLive: vi.fn(),
  isPttPollingLive: vi.fn(() => false),
  setSpeakers: vi.fn(),
  leaveVoiceChannel: vi.fn(),
  setListenOnly: vi.fn(),
  setVoiceStatus: vi.fn(),
  setPeerVerification: vi.fn(),
  clearPeerVerification: vi.fn(),
  clearPeerVerifications: vi.fn(),
  setLocalSessionFingerprint: vi.fn(),
  setEncryptionDegraded: vi.fn(),
}));

const host = vi.hoisted(() => ({
  commands: [] as Array<[string, unknown[]]>,
  handlers: new Set<(e: NativeVoiceEnvelope) => void>(),
  nextSession: 1,
  connectFails: false,
}));

vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    nativeProxies: {
      setLiveKitServerHost: vi.fn(),
      resolveLiveKitUrl: vi.fn(async (path: string) => `ws://127.0.0.1:7881${path}`),
      stopLiveKitProxy: vi.fn(),
    },
    nativeVoice: {
      setRoomKey: (key: string) => {
        host.commands.push(["setRoomKey", [key]]);
        return Promise.resolve();
      },
      clearRoomKey: () => {
        host.commands.push(["clearRoomKey", []]);
        return Promise.resolve();
      },
      connect: (...args: unknown[]) => {
        host.commands.push(["connect", args]);
        if (host.connectFails) return Promise.reject(new Error("native connect failed"));
        return Promise.resolve({ session: host.nextSession++, identity: "user-1" });
      },
      disconnect: (session: number) => {
        host.commands.push(["disconnect", [session]]);
        return Promise.resolve({ rooms: 0, localTracks: 0, admRefs: 0, threads: 40 });
      },
      setMicrophone: (...args: unknown[]) => {
        host.commands.push(["setMicrophone", args]);
        return Promise.resolve();
      },
      setSubscribed: (...args: unknown[]) => {
        host.commands.push(["setSubscribed", args]);
        return Promise.resolve();
      },
      setVolume: (...args: unknown[]) => {
        host.commands.push(["setVolume", args]);
        return Promise.resolve();
      },
      setDevice: (...args: unknown[]) => {
        host.commands.push(["setDevice", args]);
        return Promise.resolve();
      },
      debugInfo: () => {
        host.commands.push(["debugInfo", []]);
        return Promise.resolve({ rooms: 1, localTracks: 1, admRefs: 1, threads: 41 });
      },
      onEvent: (handler: (e: NativeVoiceEnvelope) => void) => {
        host.handlers.add(handler);
        return () => host.handlers.delete(handler);
      },
    },
  },
}));

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@components/settings/helpers", () => ({
  loadPref: (key: string, defaultVal: unknown) => (prefs.has(key) ? prefs.get(key) : defaultVal),
  savePref: (key: string, value: unknown) => prefs.set(key, value),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/noise-suppression", () => ({ createRNNoiseProcessor: vi.fn() }));
vi.mock("@lib/e2eeCrypto", () => ({
  generateECDHKeyPair: vi.fn(async () => ({ publicKey: {}, privateKey: {} })),
  exportPublicKey: vi.fn(async () => "bW9ja2VwaGVtZXJhbA=="),
  importPublicKey: vi.fn(async () => ({})),
  generateRoomKey: vi.fn(() => new Uint8Array(32)),
  roomKeyToBase64: vi.fn(() => "mock-room-key-base64"),
  wrapRoomKey: vi.fn(async () => ({ encryptedKey: "enc", iv: "iv" })),
  unwrapRoomKey: vi.fn(async () => ({ roomKey: new Uint8Array(32), epoch: 0 })),
  signEphemeralKey: vi.fn(async () => "sig"),
  verifyEphemeralKeySignature: vi.fn(async () => true),
  importIdentityPublicKey: vi.fn(async () => ({})),
  computeKeyFingerprint: vi.fn(async () => "AB12"),
  computeRawKeyFingerprint: vi.fn(async () => "5E55"),
}));
vi.mock("@lib/identity", () => ({
  getOrCreateIdentityKeyPair: vi.fn(async () => ({ publicKey: {}, privateKey: {} })),
  getIdentityPin: vi.fn(async () => ({ status: "unpinned" })),
  storeIdentityPin: vi.fn(async () => true),
}));
globalThis.Worker = vi.fn(function () {
  throw new Error("no E2EE web worker on Linux");
}) as unknown as typeof Worker;

import { LiveKitSession } from "../../src/lib/livekitSession";
import { setVoiceStatus, setListenOnly } from "@stores/voice.store";
import { nativeCounters } from "../../src/features/voice/native/counters";

const names = () => host.commands.map(([n]) => n);
const emit = (envelope: NativeVoiceEnvelope) => {
  for (const h of host.handlers) h(envelope);
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("LiveKitSession on the Linux native backend", () => {
  let session: LiveKitSession;
  beforeEach(() => {
    vi.clearAllMocks();
    host.commands.length = 0;
    host.handlers.clear();
    host.nextSession = 1;
    host.connectFails = false;
    prefs.clear();
    mockVoiceState.localMuted = false;
    mockVoiceState.localDeafened = false;
    mockVoiceState.currentChannelId = 1;
    nativeCounters.openRooms = 0;
    nativeCounters.listeners = 0;
    nativeCounters.rust = null;
    session = new LiveKitSession();
    session.setWsClient({ send: vi.fn(), on: vi.fn() } as never);
    session.setServerHost("chat.example");
  });
  afterEach(() => {
    session.cleanupAll();
  });

  it("installs the room key natively before connecting, then publishes the mic", async () => {
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    expect(names()).toEqual(["setRoomKey", "connect", "setMicrophone"]);
    expect(host.commands[0]).toEqual(["setRoomKey", ["mock-room-key-base64"]]);
    expect(host.commands[1]).toEqual([
      "connect",
      [
        "ws://127.0.0.1:7881/livekit",
        "tok",
        { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      ],
    ]);
    expect(host.commands[2]).toEqual(["setMicrophone", [1, true]]);
    expect(webKeyProvider.setKey).not.toHaveBeenCalled();
    expect(setVoiceStatus).toHaveBeenLastCalledWith("connected");
    expect(setListenOnly).toHaveBeenCalledWith(false);
    expect(session.getSessionDebugInfo()).toMatchObject({
      hasRoom: true,
      native: { openRooms: 1, listeners: 1, rust: null },
    });
    // The read requested a live snapshot from the backend; the next read has it.
    await flush();
    expect(session.getSessionDebugInfo()).toMatchObject({
      native: { rust: { rooms: 1, localTracks: 1, threads: 41 } },
    });
  });

  it("honours the saved input and output devices at join through the native session", async () => {
    prefs.set("audioInputDevice", "guid-mic");
    prefs.set("audioOutputDevice", "guid-spk");
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    expect(host.commands.filter(([n]) => n === "setDevice")).toEqual([
      ["setDevice", [1, "audioinput", "guid-mic"]],
      ["setDevice", [1, "audiooutput", "guid-spk"]],
    ]);
    expect(setVoiceStatus).toHaveBeenLastCalledWith("connected");
  });

  it("joins listen-only when the native microphone is unavailable", async () => {
    const onError = vi.fn();
    session.setOnError(onError);
    const mic = vi.fn(() => Promise.reject(new Error("no audio device module")));
    host.commands.length = 0;
    const { desktop } = await import("../../src/platform/desktop");
    const real = desktop.nativeVoice.setMicrophone;
    desktop.nativeVoice.setMicrophone = mic;
    try {
      await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    } finally {
      desktop.nativeVoice.setMicrophone = real;
    }
    expect(setListenOnly).toHaveBeenCalledWith(true);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/listen-only/));
    expect(setVoiceStatus).toHaveBeenLastCalledWith("connected");
  });

  it("mute and deafen go to the native session", async () => {
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    emit({
      session: 1,
      event: {
        type: "trackPublished",
        identity: "user-2",
        track: { sid: "TR_a", kind: "audio", source: "microphone", muted: false },
      },
    });
    host.commands.length = 0;
    session.setMuted(true);
    await flush();
    expect(host.commands).toEqual([["setMicrophone", [1, false]]]);
    host.commands.length = 0;
    mockVoiceState.localMuted = true;
    session.setDeafened(true);
    await flush();
    // Deafen unsubscribes remote audio and re-asserts the mic mute, as on the web path.
    expect(host.commands).toEqual([
      ["setSubscribed", [1, "user-2", "TR_a", false]],
      ["setMicrophone", [1, false]],
    ]);
  });

  it("a voice track published after deafen stays unsubscribed", async () => {
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    mockVoiceState.localMuted = true;
    mockVoiceState.localDeafened = true;
    session.setDeafened(true);
    await flush();
    host.commands.length = 0;
    emit({ session: 1, event: { type: "participantConnected", identity: "user-3" } });
    emit({
      session: 1,
      event: {
        type: "trackPublished",
        identity: "user-3",
        track: { sid: "TR_b", kind: "audio", source: "microphone", muted: false },
      },
    });
    await flush();
    expect(host.commands).toEqual([
      ["setVolume", [1, "user-3", 1]],
      ["setSubscribed", [1, "user-3", "TR_b", false]],
    ]);
  });

  it("per-user and output volume reach the native playout mixer", async () => {
    prefs.set("userVolume_3", 50);
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    host.commands.length = 0;
    // A participant starts at their saved volume: the web path applies it on
    // the audio TrackSubscribed, which the native room never raises.
    emit({ session: 1, event: { type: "participantConnected", identity: "user-3" } });
    emit({ session: 1, event: { type: "participantConnected", identity: "user-4" } });
    expect(host.commands).toEqual([
      ["setVolume", [1, "user-3", 0.5]],
      ["setVolume", [1, "user-4", 1]],
    ]);
    host.commands.length = 0;
    // The volume menu, then the master output volume scaling everyone.
    session.setUserVolume(4, 150);
    session.setOutputVolume(50);
    expect(host.commands).toEqual([
      ["setVolume", [1, "user-4", 1.5]],
      ["setVolume", [1, "user-3", 0.25]],
      ["setVolume", [1, "user-4", 0.75]],
    ]);
  });

  it("leaveVoice closes the native session and forgets the native key", async () => {
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    host.commands.length = 0;
    session.leaveVoice(false);
    await flush();
    expect(names()).toEqual(["disconnect", "clearRoomKey"]);
    expect(host.commands[0]).toEqual(["disconnect", [1]]);
    expect(host.handlers.size).toBe(0);
    expect(session.getSessionDebugInfo()).toMatchObject({
      hasRoom: false,
      native: { openRooms: 0, listeners: 0, rust: { threads: 40 } },
    });
  });

  it("a native drop reconnects through the shared loop onto a new native session", async () => {
    vi.useFakeTimers();
    try {
      await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
      host.commands.length = 0;
      emit({ session: 1, event: { type: "disconnected", reason: "ServerShutdown" } });
      // The reconnect loop backs off with timers; the token refresh timer is
      // periodic, so advance in steps rather than draining every timer.
      for (let i = 0; i < 30 && !names().includes("setMicrophone"); i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(names()).toEqual(["disconnect", "setRoomKey", "connect", "setMicrophone"]);
      expect(host.commands[0]).toEqual(["disconnect", [1]]);
      expect(host.commands[3]).toEqual(["setMicrophone", [2, true]]);
      expect(setVoiceStatus).toHaveBeenLastCalledWith("connected");
      // The old session's subscription is gone; only the new room listens.
      expect(host.handlers.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a superseding join tears down only its own native session", async () => {
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    host.commands.length = 0;
    mockVoiceState.currentChannelId = 2;
    await session.handleVoiceToken("tok2", "/livekit", 2, undefined, true);
    expect(names()).toEqual([
      "disconnect",
      "clearRoomKey",
      "setRoomKey",
      "connect",
      "setMicrophone",
    ]);
    expect(host.commands[0]).toEqual(["disconnect", [1]]);
    expect(host.commands[4]).toEqual(["setMicrophone", [2, true]]);
  });

  it("a failed native connect leaves voice cleanly", async () => {
    host.connectFails = true;
    const onError = vi.fn();
    session.setOnError(onError);
    await session.handleVoiceToken("tok", "/livekit", 1, undefined, true);
    expect(names().filter((n) => n === "connect")).toHaveLength(3);
    expect(names()).not.toContain("disconnect");
    expect(onError).toHaveBeenCalledWith("Failed to join voice — connection error");
    expect(session.getRoom()).toBeNull();
    expect(nativeCounters).toMatchObject({ openRooms: 0, listeners: 0 });
  });
});
