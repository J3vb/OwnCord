import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks must be declared before imports ---

const mockVoiceState = vi.hoisted(() => ({
  localMuted: false,
  localDeafened: false,
}));

const mockRoom = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockReturnThis(),
  removeAllListeners: vi.fn(),
  localParticipant: {
    setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
    getTrackPublication: vi.fn().mockReturnValue(undefined),
    unpublishTrack: vi.fn().mockResolvedValue(undefined),
    trackPublications: new Map(),
    identity: "user-1",
  },
  remoteParticipants: new Map(),
  switchActiveDevice: vi.fn().mockResolvedValue(undefined),
  startAudio: vi.fn().mockResolvedValue(undefined),
  canPlaybackAudio: true,
  state: "connected" as string,
  name: "test-room",
}));

vi.mock("livekit-client", () => ({
  Room: vi.fn(() => mockRoom),
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    Disconnected: "disconnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
    LocalTrackPublished: "localTrackPublished",
  },
  Track: {
    Source: {
      Microphone: "microphone",
      Camera: "camera",
      ScreenShare: "screenShare",
      ScreenShareAudio: "screenShareAudio",
    },
    Kind: { Audio: "audio", Video: "video" },
  },
  VideoPresets: {
    h360: { resolution: { width: 640, height: 360 } },
    h720: { resolution: { width: 1280, height: 720 } },
    h1080: { resolution: { width: 1920, height: 1080 } },
  },
  ScreenSharePresets: {
    h720fps5: { resolution: { width: 1280, height: 720 } },
    h1080fps15: { resolution: { width: 1920, height: 1080 } },
    h1080fps30: { resolution: { width: 1920, height: 1080 } },
  },
  DisconnectReason: { CLIENT_INITIATED: 0 },
  ExternalE2EEKeyProvider: vi.fn(() => ({
    setKey: vi.fn(),
    getKeys: vi.fn().mockReturnValue([]),
    removeAllListeners: vi.fn(),
  })),
  createLocalVideoTrack: vi.fn(async () => ({
    kind: "video",
    mediaStreamTrack: new MediaStreamTrack(),
  })),
  createLocalScreenTracks: vi.fn(async () => [
    { kind: "video", mediaStreamTrack: new MediaStreamTrack() },
  ]),
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: vi.fn(() => mockVoiceState),
    get: vi.fn(() => ({})),
    set: vi.fn(),
    subscribe: vi.fn(),
  },
  setLocalMuted: vi.fn(),
  setLocalDeafened: vi.fn(),
  setLocalCamera: vi.fn(),
  setLocalScreenshare: vi.fn(),
  setSpeakers: vi.fn(),
  leaveVoiceChannel: vi.fn(),
  setListenOnly: vi.fn(),
  setVoiceStatus: vi.fn(),
  setPeerVerification: vi.fn(),
  clearPeerVerification: vi.fn(),
  clearPeerVerifications: vi.fn(),
}));

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, _payload?: unknown) => {
    if (cmd === "start_livekit_proxy") return Promise.resolve(7881);
    if (cmd === "stop_livekit_proxy") return Promise.resolve();
    return Promise.resolve();
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload?: unknown) => mockInvoke(cmd, payload),
}));

const { mockLoadPref, mockSavePref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
}));

vi.mock("@components/settings/helpers", () => ({
  loadPref: (key: string, defaultVal: unknown) => mockLoadPref(key, defaultVal),
  savePref: (key: string, val: unknown) => mockSavePref(key, val),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@lib/noise-suppression", () => ({
  createRNNoiseProcessor: vi.fn(),
}));

const mockKeyPair = vi.hoisted(() => ({
  publicKey: { type: "public" } as unknown as CryptoKey,
  privateKey: { type: "private" } as unknown as CryptoKey,
}));

const mockIdentityKeyPair = vi.hoisted(() => ({
  publicKey: { type: "id-public" } as unknown as CryptoKey,
  privateKey: { type: "id-private" } as unknown as CryptoKey,
}));

vi.mock("@lib/e2eeCrypto", () => ({
  generateECDHKeyPair: vi.fn(async () => mockKeyPair),
  exportPublicKey: vi.fn(async () => "bW9ja2VwaGVtZXJhbA=="),
  importPublicKey: vi.fn(async () => ({ type: "public" }) as unknown as CryptoKey),
  generateRoomKey: vi.fn(() => new Uint8Array(32)),
  roomKeyToBase64: vi.fn(() => "mock-room-key-base64"),
  wrapRoomKey: vi.fn(async () => ({ encryptedKey: "enc", iv: "iv" })),
  unwrapRoomKey: vi.fn(async () => new Uint8Array(32)),
  // F3 TOFU identity signing/verification
  signEphemeralKey: vi.fn(async () => "mock-signature"),
  verifyEphemeralKeySignature: vi.fn(async () => true),
  importIdentityPublicKey: vi.fn(
    async () => ({ type: "id-public-imported" }) as unknown as CryptoKey,
  ),
  computeKeyFingerprint: vi.fn(async () => "AB12 CD34 EF56 7890"),
}));

// F3 TOFU: identity keyring + peer pin store (Tauri-backed; mocked here).
vi.mock("@lib/identity", () => ({
  getOrCreateIdentityKeyPair: vi.fn(async () => mockIdentityKeyPair),
  getIdentityPin: vi.fn(async () => ({ status: "unpinned" })),
  storeIdentityPin: vi.fn(async () => true),
}));

// Stub Worker for E2EE web worker (not available in Node/vitest). Instances
// carry a terminate() mock so worker-lifecycle assertions can observe teardown.
globalThis.Worker = vi.fn(function (this: { terminate: () => void }) {
  this.terminate = vi.fn();
}) as unknown as typeof Worker;

// Now import
import { parseUserId, LiveKitSession, getRoomForStats } from "../../src/lib/livekitSession";
import {
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
  setListenOnly,
  leaveVoiceChannel,
  setVoiceStatus,
  setPeerVerification,
  clearPeerVerifications,
} from "@stores/voice.store";
import { getIdentityPin, storeIdentityPin } from "@lib/identity";
import { verifyEphemeralKeySignature } from "@lib/e2eeCrypto";
import { setMembers } from "@stores/members.store";
import type { ReadyMember } from "../../src/lib/types";
import {
  isVoiceConnected,
  leaveVoice as boundLeaveVoice,
  setMuted as boundSetMuted,
  setDeafened as boundSetDeafened,
  cleanupAll as boundCleanupAll,
} from "../../src/lib/livekitSession";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("getRoomForStats (pre-refactor lock)", () => {
  it("returns null when no session is active", () => {
    expect(getRoomForStats()).toBeNull();
  });
});

describe("parseUserId", () => {
  it("parses a valid user identity", () => {
    expect(parseUserId("user-42")).toBe(42);
  });

  it("parses user-0", () => {
    expect(parseUserId("user-0")).toBe(0);
  });

  it("parses large user IDs", () => {
    expect(parseUserId("user-999999")).toBe(999999);
  });

  it("returns 0 for empty string", () => {
    expect(parseUserId("")).toBe(0);
  });

  it("returns 0 for missing prefix", () => {
    expect(parseUserId("42")).toBe(0);
  });

  it("returns 0 for wrong prefix", () => {
    expect(parseUserId("bot-42")).toBe(0);
  });

  it("returns 0 for non-numeric suffix", () => {
    expect(parseUserId("user-abc")).toBe(0);
  });

  it("returns 0 for partial match with trailing characters", () => {
    expect(parseUserId("user-42-extra")).toBe(0);
  });

  it("returns 0 for user- with no number", () => {
    expect(parseUserId("user-")).toBe(0);
  });

  it("returns 0 for negative numbers", () => {
    expect(parseUserId("user--1")).toBe(0);
  });

  it("returns 0 for floating point numbers", () => {
    expect(parseUserId("user-3.14")).toBe(0);
  });

  it("parses single digit user IDs", () => {
    expect(parseUserId("user-1")).toBe(1);
  });

  it("parses identity with voiceJoinToken suffix", () => {
    expect(parseUserId("user-42:abc123def")).toBe(42);
  });

  it("parses identity with long token suffix", () => {
    expect(parseUserId("user-999:a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(999);
  });

  it("returns 0 for colon with no token", () => {
    expect(parseUserId("user-:token")).toBe(0);
  });
});

describe("LiveKitSession", () => {
  let session: LiveKitSession;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockVoiceState.localMuted = false;
    mockVoiceState.localDeafened = false;
    session = new LiveKitSession();
    // Reset mockRoom state
    mockRoom.state = "connected";
    mockRoom.remoteParticipants = new Map();
    mockRoom.localParticipant.getTrackPublication.mockReturnValue(undefined);
    mockRoom.localParticipant.trackPublications = new Map();
    mockRoom.connect.mockResolvedValue(undefined);
    mockRoom.localParticipant.setMicrophoneEnabled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    session.cleanupAll();
    vi.useRealTimers();
  });

  describe("setters and getters", () => {
    it("setWsClient stores the client used by leaveVoice", () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.leaveVoice(true);
      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    });

    it("setServerHost stores the host and session remains functional", () => {
      session.setServerHost("myhost:9443");
      // Overwriting with a new host should succeed
      session.setServerHost("another:8080");
      // Verify the session is still in a valid disconnected state after setting host
      expect(isVoiceConnected()).toBe(false);
      // leaveVoice should still work (no room to disconnect from)
      session.leaveVoice(false);
      expect(setLocalCamera).toHaveBeenCalledWith(false);
    });

    it("setOnError stores callback and clearOnError removes it", () => {
      const cb = vi.fn();
      session.setOnError(cb);
      // Callback should not be invoked by the setter itself
      expect(cb).not.toHaveBeenCalled();
      session.clearOnError();
      // After clear, leaveVoice (which touches error paths) should not invoke cb
      session.leaveVoice(false);
      expect(cb).not.toHaveBeenCalled();
      // Verify the session is still usable after clearing error callback
      expect(isVoiceConnected()).toBe(false);
    });

    it("setOnRemoteVideo stores callbacks and clearOnRemoteVideo removes them", () => {
      const videoCb = vi.fn();
      const removedCb = vi.fn();
      session.setOnRemoteVideo(videoCb);
      session.setOnRemoteVideoRemoved(removedCb);
      session.clearOnRemoteVideo();
      // After clear, leaving voice (which cleans up tracks) should not invoke old callbacks
      session.leaveVoice(false);
      expect(videoCb).not.toHaveBeenCalled();
      expect(removedCb).not.toHaveBeenCalled();
      // Verify the session state is consistent after clearing callbacks
      expect(isVoiceConnected()).toBe(false);
    });
  });

  describe("leaveVoice", () => {
    it("sends voice_leave when sendWs is true and ws is set", () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.leaveVoice(true);
      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    });

    it("does not send voice_leave when sendWs is false", () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.leaveVoice(false);
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it("calls setLocalCamera(false)", () => {
      session.leaveVoice(false);
      expect(setLocalCamera).toHaveBeenCalledWith(false);
    });

    it("calls setLocalScreenshare(false)", () => {
      session.leaveVoice(false);
      expect(setLocalScreenshare).toHaveBeenCalledWith(false);
    });
  });

  describe("cleanupAll", () => {
    it("resets session to disconnected state after cleanup", () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.setServerHost("localhost:8080");
      session.setOnError(vi.fn());
      session.setOnRemoteVideo(vi.fn());
      session.setOnRemoteVideoRemoved(vi.fn());

      session.cleanupAll();

      // After cleanup, voice should be disconnected
      expect(isVoiceConnected()).toBe(false);
      // Camera and screenshare state should be reset
      expect(setLocalCamera).toHaveBeenCalledWith(false);
      expect(setLocalScreenshare).toHaveBeenCalledWith(false);
    });
  });

  describe("setMuted", () => {
    it("calls setLocalMuted with the given value", () => {
      session.setMuted(true);
      expect(setLocalMuted).toHaveBeenCalledWith(true);
    });

    it("calls setLocalMuted(false) when unmuting", () => {
      session.setMuted(false);
      expect(setLocalMuted).toHaveBeenCalledWith(false);
    });
  });

  describe("setDeafened", () => {
    it("calls setLocalDeafened with the given value", () => {
      session.setDeafened(true);
      expect(setLocalDeafened).toHaveBeenCalledWith(true);
    });

    it("calls setLocalDeafened(false) when undeafening", () => {
      session.setDeafened(false);
      expect(setLocalDeafened).toHaveBeenCalledWith(false);
    });
  });

  describe("enableCamera", () => {
    it("shows error when no active voice session", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      await session.enableCamera();
      expect(errorCb).toHaveBeenCalledWith("Join a voice channel first");
    });

    it("calls setLocalCamera(false) when no room or ws", async () => {
      await session.enableCamera();
      // setLocalCamera should not have been called with true (no ws)
      // Actually it warns and returns early
      expect(setLocalCamera).not.toHaveBeenCalledWith(true);
    });
  });

  describe("disableCamera", () => {
    it("calls setLocalCamera(false) even without a room", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      await session.disableCamera();
      expect(setLocalCamera).toHaveBeenCalledWith(false);
    });

    it("sends voice_camera disabled message when ws is set", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      await session.disableCamera();
      expect(mockWs.send).toHaveBeenCalledWith({
        type: "voice_camera",
        payload: { enabled: false },
      });
    });
  });

  describe("switchInputDevice", () => {
    it("does nothing when no active room", async () => {
      // Should not throw
      await session.switchInputDevice("device-1");
      expect(mockRoom.switchActiveDevice).not.toHaveBeenCalled();
    });
  });

  describe("switchOutputDevice", () => {
    it("does nothing when no active room", async () => {
      await session.switchOutputDevice("device-1");
      expect(mockRoom.switchActiveDevice).not.toHaveBeenCalled();
    });
  });

  describe("setUserVolume", () => {
    it("saves clamped volume to preferences", () => {
      session.setUserVolume(42, 150);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 150);
    });

    it("clamps volume to 0-200 range", () => {
      session.setUserVolume(42, -10);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 0);

      session.setUserVolume(42, 300);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 200);
    });
  });

  describe("getUserVolume", () => {
    it("returns default volume of 100", () => {
      expect(session.getUserVolume(42)).toBe(100);
    });
  });

  describe("setInputVolume", () => {
    it("saves clamped input volume to preferences", () => {
      session.setInputVolume(150);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 150);
    });

    it("clamps to 0-200 range", () => {
      session.setInputVolume(-50);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 0);

      session.setInputVolume(999);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 200);
    });
  });

  describe("setOutputVolume", () => {
    it("saves clamped output volume to preferences", () => {
      session.setOutputVolume(80);
      expect(mockSavePref).toHaveBeenCalledWith("outputVolume", 80);
    });

    it("clamps to 0-200 range", () => {
      session.setOutputVolume(-10);
      expect(mockSavePref).toHaveBeenCalledWith("outputVolume", 0);
    });

    it("updates existing screenshare audio elements when master output changes", () => {
      const screenshareAudio = document.createElement("audio");
      (session as any)._audioElements.screenshareAudioElements = new Map([
        [42, new Set([screenshareAudio])],
      ]);

      session.setOutputVolume(80);

      expect(screenshareAudio.volume).toBe(0.8);
    });

    it("clamps existing screenshare audio elements to the browser volume range", () => {
      const screenshareAudio = document.createElement("audio");
      (session as any)._audioElements.screenshareAudioElements = new Map([
        [42, new Set([screenshareAudio])],
      ]);

      session.setOutputVolume(150);

      expect(screenshareAudio.volume).toBe(1);
    });
  });

  describe("setVoiceSensitivity", () => {
    it("does not throw (no-op, handled by LiveKit VAD)", () => {
      expect(() => session.setVoiceSensitivity(50)).not.toThrow();
    });
  });

  describe("getLocalCameraStream", () => {
    it("returns null when no room", () => {
      expect(session.getLocalCameraStream()).toBeNull();
    });
  });

  describe("getSessionDebugInfo", () => {
    it("returns basic info when no room is active", () => {
      const info = session.getSessionDebugInfo();
      expect(info.hasRoom).toBe(false);
      expect(info.hasRNNoiseProcessor).toBe(false);
      expect(info.currentChannelId).toBeNull();
    });
  });

  describe("handleVoiceToken", () => {
    it("connects to LiveKit and sets up voice session", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.connect).toHaveBeenCalledWith("ws://localhost:7880", "test-token");
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("uses proxy URL for non-local hosts", async () => {
      session.setServerHost("example.com:443");
      session.setWsClient({ send: vi.fn() } as any);

      await session.handleVoiceToken("test-token", "/livekit", 1, undefined, true);

      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", {
        remoteHost: "example.com:443",
      });
      expect(mockRoom.connect).toHaveBeenCalledWith("ws://127.0.0.1:7881/livekit", "test-token");
    });

    it("handles mic permission denied gracefully", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const domErr = new DOMException("Permission denied", "NotAllowedError");
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(domErr);

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(errorCb).toHaveBeenCalledWith(
        "Microphone permission denied — joined in listen-only mode",
      );
    });

    it("handles mic not found gracefully", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const domErr = new DOMException("No device", "NotFoundError");
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(domErr);

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(errorCb).toHaveBeenCalledWith("No microphone found — joined in listen-only mode");
    });

    it("handles generic mic error gracefully", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error("unknown"));

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(errorCb).toHaveBeenCalledWith("Microphone unavailable — joined in listen-only mode");
    });

    it("handles connection failure", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.connect.mockRejectedValue(new Error("connection refused"));

      // handleVoiceToken has retry logic with setTimeout delays.
      // We need to advance fake timers to let the retries proceed.
      const tokenPromise = session.handleVoiceToken(
        "test-token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      // Advance through all retry delays (3 retries x 2000ms each)
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(2100);
      }

      await tokenPromise;

      expect(errorCb).toHaveBeenCalledWith("Failed to join voice — connection error");
    });

    it("queues the latest join request that arrives while connecting", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const firstConnect = createDeferred<void>();
      mockRoom.connect
        .mockImplementationOnce(() => firstConnect.promise)
        .mockResolvedValueOnce(undefined);

      const firstJoin = session.handleVoiceToken(
        "first-token",
        "/livekit-one",
        1,
        "ws://localhost:7881",
        true,
      );
      // Flush microtasks so E2EE async steps resolve before connect
      await vi.advanceTimersByTimeAsync(0);

      await session.handleVoiceToken(
        "second-token",
        "/livekit-two",
        2,
        "ws://localhost:7882",
        true,
      );
      expect(mockRoom.connect).toHaveBeenCalledTimes(1);

      firstConnect.resolve(undefined);
      await firstJoin;

      expect(mockRoom.connect).toHaveBeenCalledTimes(2);
      expect(mockRoom.connect).toHaveBeenNthCalledWith(1, "ws://localhost:7881", "first-token");
      expect(mockRoom.connect).toHaveBeenNthCalledWith(2, "ws://localhost:7882", "second-token");
      expect(mockRoom.startAudio).toHaveBeenCalledTimes(1);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    });
  });

  describe("voiceStatus transitions (voice-and-e2ee.md §1–2)", () => {
    function statusCalls(): string[] {
      return (setVoiceStatus as any).mock.calls.map((c: unknown[]) => c[0] as string);
    }

    it("writes joining → securing → connected on a successful join", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      (setVoiceStatus as any).mockClear();

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      const calls = statusCalls();
      expect(calls).toContain("joining");
      expect(calls).toContain("securing");
      expect(calls).toContain("connected");
      // Ordering: joining before securing before connected.
      expect(calls.indexOf("joining")).toBeLessThan(calls.indexOf("securing"));
      expect(calls.indexOf("securing")).toBeLessThan(calls.indexOf("connected"));
    });

    it("writes idle on leaveVoice", () => {
      (setVoiceStatus as any).mockClear();
      session.leaveVoice(false);
      expect(setVoiceStatus).toHaveBeenCalledWith("idle");
    });

    it("writes reconnecting when the room drops unexpectedly", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      // Capture the Disconnected handler registered during room creation.
      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      expect(disconnectedHandler).toBeDefined();
      expect((session as any)._state.type).toBe("connected");

      // Isolate the write triggered purely by the unexpected room drop.
      (setVoiceStatus as any).mockClear();

      // Fire an unexpected disconnect (non-CLIENT_INITIATED) — this is the primary
      // reconnecting write, from setReconnectAc via handleDisconnected.
      disconnectedHandler!(/* SERVER_SHUTDOWN */ 1);

      expect((session as any)._state.type).toBe("reconnecting");
      expect(setVoiceStatus).toHaveBeenCalledWith("reconnecting");
    });

    it("writes connected after a successful auto-reconnect", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 7,
        latestToken: "reconnect-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      (setVoiceStatus as any).mockClear();

      const ac = new AbortController();
      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/livekit",
        7,
        "ws://localhost:7880",
        ac.signal,
      );
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(setVoiceStatus).toHaveBeenCalledWith("connected");
    });
  });

  describe("handleVoiceTokenRefresh", () => {
    it("stores the token and restarts the timer", () => {
      (session as any)._state = {
        type: "connected",
        room: mockRoom,
        channelId: 7,
        latestToken: "old-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
      };

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      session.handleVoiceTokenRefresh("new-token");

      expect((session as any)._state.latestToken).toBe("new-token");
      // Timer restarted: the 23h refresh timer is re-armed on every refresh.
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 23 * 60 * 60 * 1000);
    });

    it("handles undefined token", () => {
      expect(() => session.handleVoiceTokenRefresh(undefined)).not.toThrow();
    });
  });

  describe("auto reconnect", () => {
    it("preserves local mute state on reconnect", async () => {
      mockVoiceState.localMuted = true;
      mockVoiceState.localDeafened = false;
      (session as any)._state = {
        type: "reconnecting",
        channelId: 7,
        latestToken: "reconnect-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };

      const ac = new AbortController();
      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/livekit",
        7,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    it("re-applies deafened remote subscriptions on reconnect", async () => {
      mockVoiceState.localMuted = true;
      mockVoiceState.localDeafened = true;
      (session as any)._state = {
        type: "reconnecting",
        channelId: 9,
        latestToken: "reconnect-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };

      const setSubscribed = vi.fn();
      mockRoom.remoteParticipants = new Map([
        [
          "remote-user",
          {
            audioTrackPublications: new Map([["audio", { setSubscribed }]]),
          },
        ],
      ]);

      const ac = new AbortController();
      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/livekit",
        9,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(setSubscribed).toHaveBeenCalledWith(false);
    });
  });

  describe("teardownForReconnect video track cleanup (BUG-098)", () => {
    it("stops manual camera and screen tracks on unexpected disconnect", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      mockRoom.localParticipant.unpublishTrack = vi.fn();

      // Capture the Disconnected handler during room creation
      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });

      // Connect to create the room and register handlers
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      expect(disconnectedHandler).toBeDefined();

      // Inject fake manual tracks as if camera/screen were enabled
      const mockCamTrack = { stop: vi.fn(), mediaStreamTrack: { id: "cam" } };
      const mockScreenTrack = { stop: vi.fn(), mediaStreamTrack: { id: "screen" } };
      (session as any)._cameraState.manualCameraTrack = mockCamTrack;
      (session as any)._screenState.manualScreenTracks = [mockScreenTrack];

      // Clear mocks so we can assert only the teardown calls
      (setLocalCamera as any).mockClear();
      (setLocalScreenshare as any).mockClear();

      // Fire unexpected disconnect (non-CLIENT_INITIATED triggers reconnect path)
      disconnectedHandler!(/* SERVER_SHUTDOWN */ 1);

      // Camera track stopped and state reset
      expect(mockCamTrack.stop).toHaveBeenCalled();
      expect((session as any)._cameraState.manualCameraTrack).toBeNull();
      expect(setLocalCamera).toHaveBeenCalledWith(false);

      // Screen track stopped and state reset
      expect(mockScreenTrack.stop).toHaveBeenCalled();
      expect((session as any)._screenState.manualScreenTracks).toEqual([]);
      expect(setLocalScreenshare).toHaveBeenCalledWith(false);
    });
  });

  describe("handleDisconnected during initial connect", () => {
    it("does not null the room when connecting flag is true", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      // Make connect hang so we can trigger Disconnected mid-connect
      const connectDeferred = createDeferred<void>();
      mockRoom.connect.mockImplementation(() => connectDeferred.promise);

      // Capture the Disconnected handler registered via room.on()
      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });

      const tokenPromise = session.handleVoiceToken(
        "test-token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );
      await Promise.resolve(); // Let handleVoiceToken reach room.connect()

      // Simulate LiveKit emitting Disconnected with JOIN_FAILURE (reason 7)
      // while the connect() is still in progress
      expect(disconnectedHandler).toBeDefined();
      disconnectedHandler!(7);

      // The session should NOT have been reset to idle — retry loop is still in control
      expect((session as any)._state.type).not.toBe("idle");

      // Resolve connect to let the flow complete normally
      connectDeferred.resolve(undefined);
      await tokenPromise;
    });
  });

  // -----------------------------------------------------------------------
  // Screenshare audio controls (Spec 1)
  // -----------------------------------------------------------------------

  describe("setScreenshareAudioVolume", () => {
    it("silently skips when no audio element exists for userId", () => {
      // Should return early without error — no element to set volume on
      session.setScreenshareAudioVolume(999, 0.5);
      // Verify no screenshare state was created for the unknown user
      expect(session.getScreenshareAudioMuted(999)).toBe(false);
    });
  });

  describe("screenshare audio subscription", () => {
    it("clamps screenshare audio element volume when output is boosted", () => {
      session.setOutputVolume(150);

      const audioEl = document.createElement("audio");
      const track = {
        kind: "audio",
        sid: "track-1",
        detach: vi.fn(() => []),
        attach: vi.fn(() => audioEl),
      };
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42" };

      expect(() =>
        (session as any)._eventHandlers.handleTrackSubscribed(track, publication, participant),
      ).not.toThrow();
      expect(audioEl.volume).toBe(1);
    });

    it("keeps a replacement screenshare audio element tracked when an older track unsubscribes", () => {
      const firstAudioEl = document.createElement("audio");
      const secondAudioEl = document.createElement("audio");
      const firstTrack = {
        kind: "audio",
        sid: "track-1",
        detach: vi.fn(() => [firstAudioEl]),
        attach: vi.fn(() => firstAudioEl),
      };
      const secondTrack = {
        kind: "audio",
        sid: "track-2",
        detach: vi.fn(() => [secondAudioEl]),
        attach: vi.fn(() => secondAudioEl),
      };
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42" };

      (session as any)._eventHandlers.handleTrackSubscribed(firstTrack, publication, participant);
      (session as any)._eventHandlers.handleTrackSubscribed(secondTrack, publication, participant);
      (session as any)._eventHandlers.handleTrackUnsubscribed(firstTrack, publication, participant);

      session.muteScreenshareAudio(42, true);

      expect(secondAudioEl.muted).toBe(true);
      expect((session as any)._audioElements.screenshareAudioElements.get(42)).toEqual(
        new Set([secondAudioEl]),
      );
    });

    it("applies the stored mute state to replacement screenshare audio tracks", () => {
      const firstAudioEl = document.createElement("audio");
      const secondAudioEl = document.createElement("audio");
      const firstTrack = {
        kind: "audio",
        sid: "track-1",
        detach: vi.fn(() => [firstAudioEl]),
        attach: vi.fn(() => firstAudioEl),
      };
      const secondTrack = {
        kind: "audio",
        sid: "track-2",
        detach: vi.fn(() => [secondAudioEl]),
        attach: vi.fn(() => secondAudioEl),
      };
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42" };

      (session as any)._eventHandlers.handleTrackSubscribed(firstTrack, publication, participant);
      session.muteScreenshareAudio(42, true);

      (session as any)._eventHandlers.handleTrackSubscribed(secondTrack, publication, participant);

      expect(secondAudioEl.muted).toBe(true);
      expect(session.getScreenshareAudioMuted(42)).toBe(true);
    });
  });

  describe("muteScreenshareAudio", () => {
    it("stores mute state even when no audio element exists for userId", () => {
      session.muteScreenshareAudio(999, true);
      // Mute state is persisted so late-arriving audio elements inherit it
      expect(session.getScreenshareAudioMuted(999)).toBe(true);
    });
  });

  describe("getScreenshareAudioMuted", () => {
    it("returns false when no audio element exists for userId", () => {
      expect(session.getScreenshareAudioMuted(999)).toBe(false);
    });
  });

  // === PRE-REFACTOR BEHAVIORAL SNAPSHOT TESTS ===
  // These lock the public API behavior before the 4-module split.
  // Every test here must still pass after the refactor.

  describe("enableScreenshare (pre-refactor lock)", () => {
    it("shows error when no active voice session", async () => {
      const onError = vi.fn();
      session.setOnError(onError);
      await session.enableScreenshare();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("voice"));
    });

    it("does not enable screenshare when no room available", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      await session.enableScreenshare();
      // Should not send WS message without an active room
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe("disableScreenshare (pre-refactor lock)", () => {
    it("calls setLocalScreenshare(false) even without a room", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      await session.disableScreenshare();
      expect(setLocalScreenshare).toHaveBeenCalledWith(false);
    });

    it("sends voice_screenshare disabled message when ws is set", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      await session.disableScreenshare();
      expect(mockWs.send).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      });
    });
  });

  describe("reapplyAudioProcessing (pre-refactor lock)", () => {
    it("does not throw when no room is active", () => {
      expect(() => session.reapplyAudioProcessing()).not.toThrow();
    });
  });

  describe("getLocalScreenshareStream (pre-refactor lock)", () => {
    it("returns null when no room", () => {
      expect(session.getLocalScreenshareStream()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: leaveVoice (deep assertions)
  // -----------------------------------------------------------------------

  describe("leaveVoice (state management)", () => {
    it("aborts reconnectAc when reconnect is in progress", () => {
      const ac = new AbortController();
      const abortSpy = vi.spyOn(ac, "abort");
      (session as any)._state = {
        type: "reconnecting",
        channelId: 1,
        latestToken: "t",
        lastUrl: "/lk",
        lastDirectUrl: undefined,
        ac,
      };

      session.leaveVoice(false);

      expect(abortSpy).toHaveBeenCalled();
      expect((session as any)._state.type).toBe("idle");
    });

    it("clears the token refresh timer so it does not fire after leave", () => {
      // Set up a timer that would fail if it fires
      (session as any).tokenRefreshTimer = setTimeout(() => {
        throw new Error("Timer should have been cleared");
      }, 100);

      session.leaveVoice(false);

      expect((session as any).tokenRefreshTimer).toBeNull();
      // Advance past when it would have fired — should not throw
      vi.advanceTimersByTime(200);
    });

    it("calls teardownAudioPipeline on _audioPipeline", () => {
      const teardownSpy = vi.spyOn((session as any)._audioPipeline, "teardownAudioPipeline");

      session.leaveVoice(false);

      expect(teardownSpy).toHaveBeenCalled();
      teardownSpy.mockRestore();
    });

    it("nulls pendingJoin", () => {
      (session as any)._state = {
        type: "connecting",
        pendingJoin: { token: "t", url: "/lk", channelId: 1 },
        joinGeneration: 1,
      };

      session.leaveVoice(false);

      expect((session as any)._state.type).toBe("idle");
    });

    it("calls cleanupAllAudioElementsFull on _audioElements", () => {
      const cleanupSpy = vi.spyOn((session as any)._audioElements, "cleanupAllAudioElementsFull");

      session.leaveVoice(false);

      expect(cleanupSpy).toHaveBeenCalled();
      cleanupSpy.mockRestore();
    });

    it("calls room.removeAllListeners before disconnect when room exists", async () => {
      // Set up a room via handleVoiceToken
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      expect((session as any)._state.type).toBe("connected");
      const room = (session as any)._state.room;

      session.leaveVoice(false);

      expect(mockRoom.removeAllListeners).toHaveBeenCalled();
      expect(mockRoom.disconnect).toHaveBeenCalled();
    });

    it("sets currentChannelId to null after leave", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 5, "ws://localhost:7880", true);

      expect((session as any)._state.channelId).toBe(5);

      session.leaveVoice(false);

      expect((session as any)._state.type).toBe("idle");
    });

    it("sets latestToken to null after leave", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("my-token", "/lk", 1, "ws://localhost:7880", true);

      expect((session as any)._state.latestToken).toBe("my-token");

      session.leaveVoice(false);

      expect((session as any)._state.type).toBe("idle");
    });

    it("sets lastUrl to null and lastDirectUrl to undefined after leave", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      session.leaveVoice(false);

      expect((session as any)._state.type).toBe("idle");
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: cleanupAll
  // -----------------------------------------------------------------------

  describe("cleanupAll (deep assertions)", () => {
    it("invokes stop_livekit_proxy", () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.setServerHost("localhost:8080");

      session.cleanupAll();

      expect(mockInvoke).toHaveBeenCalledWith("stop_livekit_proxy", undefined);
    });

    it("nulls ws, serverHost, and callbacks", () => {
      session.setWsClient({ send: vi.fn() } as any);
      session.setServerHost("localhost:8080");
      session.setOnError(vi.fn());
      session.setOnRemoteVideo(vi.fn());
      session.setOnRemoteVideoRemoved(vi.fn());

      session.cleanupAll();

      expect((session as any).ws).toBeNull();
      expect((session as any).serverHost).toBeNull();
      expect((session as any).onErrorCallback).toBeNull();
      expect((session as any).onRemoteVideoCallback).toBeNull();
      expect((session as any).onRemoteVideoRemovedCallback).toBeNull();
    });

    it("nulls liveKitProxyPort", () => {
      (session as any).liveKitProxyPort = 7881;

      session.cleanupAll();

      expect((session as any).liveKitProxyPort).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: setMuted / setDeafened with active room
  // -----------------------------------------------------------------------

  describe("setMuted (with active room)", () => {
    beforeEach(async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();
    });

    it("muting calls setMicrophoneEnabled(false) on the room", async () => {
      session.setMuted(true);
      // applyMicMuteState is async fire-and-forget, flush microtasks
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    it("unmuting calls setMicrophoneEnabled(true) and rebuilds pipeline", async () => {
      const setupSpy = vi.spyOn((session as any)._audioPipeline, "setupAudioPipeline");

      session.setMuted(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(setupSpy).toHaveBeenCalled();
      setupSpy.mockRestore();
    });
  });

  describe("setDeafened (with active room)", () => {
    beforeEach(async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();
    });

    it("deafening when already muted keeps mic disabled", async () => {
      mockVoiceState.localMuted = true;

      session.setDeafened(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(setLocalDeafened).toHaveBeenCalledWith(true);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    it("undeafening when localMuted is true keeps mic muted", async () => {
      mockVoiceState.localMuted = true;
      mockVoiceState.localDeafened = false;

      session.setDeafened(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(setLocalDeafened).toHaveBeenCalledWith(false);
      // shouldMute = deafened(false) || localMuted(true) = true
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    it("calls applyRemoteAudioSubscriptionState with deafened value", () => {
      const subSpy = vi.spyOn((session as any)._audioElements, "applyRemoteAudioSubscriptionState");

      session.setDeafened(true);

      expect(subSpy).toHaveBeenCalledWith(true);
      subSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: retryMicPermission
  // -----------------------------------------------------------------------

  describe("retryMicPermission", () => {
    it("returns immediately (no-op) when no room exists", async () => {
      vi.clearAllMocks();
      await session.retryMicPermission();

      // No calls should have been made to setMicrophoneEnabled
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(setListenOnly).not.toHaveBeenCalled();
    });

    it("enables mic and exits listen-only on success", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();

      await session.retryMicPermission();

      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(setListenOnly).toHaveBeenCalledWith(false);
      expect(setLocalMuted).toHaveBeenCalledWith(false);
    });

    it("applies noise suppressor when enhancedNoiseSuppression pref is true", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "enhancedNoiseSuppression") return true;
        return defaultVal;
      });

      const noiseSpy = vi
        .spyOn((session as any)._audioPipeline, "applyNoiseSuppressor")
        .mockResolvedValue(undefined);

      await session.retryMicPermission();

      expect(noiseSpy).toHaveBeenCalled();
      noiseSpy.mockRestore();
      mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
    });

    it("calls error callback and remains listen-only when mic fails", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();

      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(
        new Error("permission denied"),
      );

      await session.retryMicPermission();

      expect(errorCb).toHaveBeenCalledWith(
        "Microphone still unavailable — check your browser permissions",
      );
      // setListenOnly(false) should NOT have been called on failure
      expect(setListenOnly).not.toHaveBeenCalled();
    });

    it("sets up audio pipeline on success", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();

      const setupSpy = vi.spyOn((session as any)._audioPipeline, "setupAudioPipeline");

      await session.retryMicPermission();

      expect(setupSpy).toHaveBeenCalled();
      setupSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: restoreLocalVoiceState
  // -----------------------------------------------------------------------

  describe("restoreLocalVoiceState", () => {
    beforeEach(async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
    });

    it("applies noise suppressor when enhancedNoiseSuppression pref is true on join", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "enhancedNoiseSuppression") return true;
        return defaultVal;
      });

      const noiseSpy = vi
        .spyOn((session as any)._audioPipeline, "applyNoiseSuppressor")
        .mockResolvedValue(undefined);

      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      expect(noiseSpy).toHaveBeenCalled();
      noiseSpy.mockRestore();
      mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
    });

    it("mode reconnect with mic error logs warn but does NOT call error callback", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      mockVoiceState.localMuted = false;
      mockVoiceState.localDeafened = false;

      await session.handleVoiceToken("tok", "/lk", 7, "ws://localhost:7880", true);
      vi.clearAllMocks();

      // Session is already in "connected" state with channelId=7 after handleVoiceToken
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error("mic gone"));

      const ac = new AbortController();
      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/lk",
        7,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      // On reconnect mic failure, error callback should NOT be called
      expect(errorCb).not.toHaveBeenCalledWith(
        expect.stringContaining("Microphone permission denied"),
      );
      expect(errorCb).not.toHaveBeenCalledWith(expect.stringContaining("Microphone unavailable"));
    });

    it("mode join with generic mic error calls error callback", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error("some error"));

      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      expect(errorCb).toHaveBeenCalledWith("Microphone unavailable — joined in listen-only mode");
    });

    it("localDeafened true calls applyRemoteAudioSubscriptionState(true)", async () => {
      mockVoiceState.localDeafened = true;
      mockVoiceState.localMuted = false;

      const subSpy = vi.spyOn((session as any)._audioElements, "applyRemoteAudioSubscriptionState");

      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      // Should be called with the deafened state
      expect(subSpy).toHaveBeenCalledWith(true);
      subSpy.mockRestore();
    });

    it("localMuted true but not deafened disables mic and calls applyMicMuteState", async () => {
      mockVoiceState.localMuted = true;
      mockVoiceState.localDeafened = false;

      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      // setMicrophoneEnabled(false) should have been called (shouldEnableMicrophone = false when muted)
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    it("sets listenOnly(false) on successful mic acquisition", async () => {
      mockVoiceState.localMuted = false;
      mockVoiceState.localDeafened = false;

      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      expect(setListenOnly).toHaveBeenCalledWith(false);
    });

    it("sets listenOnly(true) when mic fails", async () => {
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error("fail"));

      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      expect(setListenOnly).toHaveBeenCalledWith(true);
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: delegation methods
  // -----------------------------------------------------------------------

  describe("delegation methods (video)", () => {
    it("getRemoteVideoStream returns null with no room", () => {
      expect(session.getRemoteVideoStream(42, "camera")).toBeNull();
    });

    it("getRemoteVideoStream returns null with no room for screenshare", () => {
      expect(session.getRemoteVideoStream(42, "screenshare")).toBeNull();
    });

    it("getLocalCameraStream returns null with no room", () => {
      expect(session.getLocalCameraStream()).toBeNull();
    });

    it("enableCamera delegates to doEnableCamera and shows error without ws", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      await session.enableCamera();
      expect(errorCb).toHaveBeenCalledWith("Join a voice channel first");
    });

    it("disableCamera sends voice_camera disabled when ws is set", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      await session.disableCamera();
      expect(mockWs.send).toHaveBeenCalledWith({
        type: "voice_camera",
        payload: { enabled: false },
      });
    });

    it("enableScreenshare shows error without active voice session", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      await session.enableScreenshare();
      expect(errorCb).toHaveBeenCalledWith(expect.stringContaining("voice"));
    });

    it("disableScreenshare sends voice_screenshare disabled when ws is set", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      await session.disableScreenshare();
      expect(mockWs.send).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      });
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: singleton exports
  // -----------------------------------------------------------------------

  describe("singleton exports", () => {
    it("isVoiceConnected returns false when no session is active", () => {
      expect(isVoiceConnected()).toBe(false);
    });

    it("bound leaveVoice is callable without throwing", () => {
      expect(() => boundLeaveVoice(false)).not.toThrow();
    });

    it("bound setMuted is callable and calls setLocalMuted", () => {
      boundSetMuted(true);
      expect(setLocalMuted).toHaveBeenCalledWith(true);
    });

    it("bound setDeafened is callable and calls setLocalDeafened", () => {
      boundSetDeafened(true);
      expect(setLocalDeafened).toHaveBeenCalledWith(true);
    });

    it("bound cleanupAll is callable without throwing", () => {
      expect(() => boundCleanupAll()).not.toThrow();
    });
  });

  // =================================================================
  // Mutant-killing tests — connection lifecycle methods
  // =================================================================

  describe("resolveLiveKitUrl", () => {
    it("returns proxyPath unchanged when serverHost is null", async () => {
      const url = await (session as any).resolveLiveKitUrl("/livekit");
      expect(url).toBe("/livekit");
    });

    it("returns directUrl when serverHost is localhost", async () => {
      session.setServerHost("localhost:7880");
      const url = await (session as any).resolveLiveKitUrl(
        "/livekit",
        "ws://localhost:7880/livekit",
      );
      expect(url).toBe("ws://localhost:7880/livekit");
    });

    it("returns directUrl when serverHost is 127.0.0.1", async () => {
      session.setServerHost("127.0.0.1:7880");
      const url = await (session as any).resolveLiveKitUrl(
        "/livekit",
        "ws://127.0.0.1:7880/livekit",
      );
      expect(url).toBe("ws://127.0.0.1:7880/livekit");
    });

    it("returns directUrl when serverHost is bare ::1", async () => {
      session.setServerHost("::1");
      const url = await (session as any).resolveLiveKitUrl("/livekit", "ws://[::1]:7880/livekit");
      // Bare IPv6 with multiple colons — detected as local, returns directUrl
      expect(url).toBe("ws://[::1]:7880/livekit");
    });

    it("returns directUrl when serverHost is bracketed [::1]:7880", async () => {
      session.setServerHost("[::1]:7880");
      const url = await (session as any).resolveLiveKitUrl("/livekit", "ws://[::1]:7880/livekit");
      // Bracketed IPv6 — host extracted as "::1", detected as local
      expect(url).toBe("ws://[::1]:7880/livekit");
    });

    it("calls ensureLiveKitProxy and returns proxy URL for remote host with slash path", async () => {
      session.setServerHost("example.com:443");
      const url = await (session as any).resolveLiveKitUrl("/livekit");
      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", {
        remoteHost: "example.com:443",
      });
      expect(url).toBe("ws://127.0.0.1:7881/livekit");
    });

    it("passes through proxyPath that does not start with / for remote host", async () => {
      session.setServerHost("example.com:443");
      const url = await (session as any).resolveLiveKitUrl("wss://example.com/livekit");
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(url).toBe("wss://example.com/livekit");
    });

    it("does not return directUrl when serverHost is remote even if directUrl is provided", async () => {
      session.setServerHost("example.com:443");
      const url = await (session as any).resolveLiveKitUrl(
        "/livekit",
        "ws://example.com:7880/livekit",
      );
      expect(url).toBe("ws://127.0.0.1:7881/livekit");
    });

    it("does not return directUrl for localhost when directUrl is undefined", async () => {
      session.setServerHost("localhost:7880");
      const url = await (session as any).resolveLiveKitUrl("/livekit");
      // No directUrl provided, isLocal but directUrl falsy -> falls to proxy
      expect(url).toBe("ws://127.0.0.1:7881/livekit");
    });
  });

  describe("ensureLiveKitProxy", () => {
    it("invokes start_livekit_proxy on every call so a re-pinned cert is picked up", async () => {
      session.setServerHost("example.com:443");
      const port1 = await (session as any).ensureLiveKitProxy();
      expect(port1).toBe(7881);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", {
        remoteHost: "example.com:443",
      });

      // A later join must invoke again: only the Rust side can compare the
      // running proxy's pin against certs.json after the user accepts a
      // rotated cert. A JS port cache would keep every voice rejoin tunneling
      // into the stale pin until logout. The Rust reuse branch dedups, so the
      // repeat call is cheap.
      mockInvoke.mockClear();
      const port2 = await (session as any).ensureLiveKitProxy();
      expect(port2).toBe(7881);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it("appends :443 when serverHost has no port", async () => {
      session.setServerHost("example.com");
      await (session as any).ensureLiveKitProxy();
      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", {
        remoteHost: "example.com:443",
      });
    });

    it("throws when serverHost is null", async () => {
      await expect((session as any).ensureLiveKitProxy()).rejects.toThrow(
        "no server host for LiveKit proxy",
      );
    });
  });

  describe("connectAndSetup retry logic", () => {
    it("retries on first failure and succeeds on second attempt", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.connect
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce(undefined);

      const resultPromise = (session as any).connectAndSetup(
        "token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      await vi.advanceTimersByTimeAsync(2100);
      const result = await resultPromise;

      expect(mockRoom.connect).toHaveBeenCalledTimes(2);
      expect(result).toBe(true);
    });

    it("fails after all 3 attempts and calls error callback + leaveVoice", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.connect.mockRejectedValue(new Error("persistent failure"));

      const resultPromise = (session as any).connectAndSetup(
        "token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(2100);
      }

      const result = await resultPromise;

      expect(result).toBe(false);
      expect(errorCb).toHaveBeenCalledWith("Failed to join voice — connection error");
    });

    it("discards stale join when pendingJoin arrives during connect", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const connectDeferred = createDeferred<void>();
      mockRoom.connect.mockImplementationOnce(() => connectDeferred.promise);

      const resultPromise = (session as any).connectAndSetup(
        "token-1",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      // Inject a pendingJoin into the current "connecting" state
      const currentState = (session as any)._state;
      (session as any)._state = {
        ...currentState,
        pendingJoin: {
          token: "token-2",
          url: "/livekit-2",
          channelId: 2,
          directUrl: "ws://localhost:7882",
        },
      };

      connectDeferred.resolve(undefined);
      const result = await resultPromise;

      expect(result).toBe(false);
    });

    it("continues when saved input device is unavailable", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.connect.mockResolvedValue(undefined);
      mockRoom.switchActiveDevice.mockRejectedValueOnce(new Error("device not found"));
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioInputDevice") return "nonexistent-device";
        return defaultVal;
      });

      const result = await (session as any).connectAndSetup(
        "token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      expect(result).toBe(true);
    });

    it("calls leaveVoice(false) when room is non-null at entry", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.connect.mockResolvedValue(undefined);
      await (session as any).connectAndSetup("token-1", "/livekit", 1, "ws://localhost:7880", true);
      expect((session as any)._state.type).toBe("connected");

      const leaveSpy = vi.spyOn(session, "leaveVoice");
      await (session as any).connectAndSetup("token-2", "/livekit", 2, "ws://localhost:7880", true);

      expect(leaveSpy).toHaveBeenCalledWith(false);
      leaveSpy.mockRestore();
    });
  });

  describe("handleVoiceToken pending join drain", () => {
    it("calls handleVoiceTokenRefresh when already connected to same channel", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.connect.mockResolvedValue(undefined);
      await session.handleVoiceToken("token-1", "/livekit", 1, "ws://localhost:7880", true);

      mockRoom.state = "connected";
      const refreshSpy = vi.spyOn(session, "handleVoiceTokenRefresh");

      await session.handleVoiceToken("token-2", "/livekit", 1, "ws://localhost:7880", true);

      expect(refreshSpy).toHaveBeenCalledWith("token-2");
      expect(mockRoom.connect).toHaveBeenCalledTimes(1);
      refreshSpy.mockRestore();
    });

    it("executes only the latest pending join when two are queued", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const firstConnect = createDeferred<void>();
      mockRoom.connect
        .mockImplementationOnce(() => firstConnect.promise)
        .mockResolvedValue(undefined);

      const firstJoin = session.handleVoiceToken(
        "token-1",
        "/livekit-1",
        1,
        "ws://localhost:7881",
        true,
      );
      // Flush microtasks so E2EE async steps resolve before connect
      await vi.advanceTimersByTimeAsync(0);

      await session.handleVoiceToken("token-2", "/livekit-2", 2, "ws://localhost:7882", true);
      await session.handleVoiceToken("token-3", "/livekit-3", 3, "ws://localhost:7883", true);

      const s = (session as any)._state;
      expect(s.type).toBe("connecting");
      expect(s.pendingJoin.token).toBe("token-3");
      expect(s.pendingJoin.channelId).toBe(3);

      firstConnect.resolve(undefined);
      await firstJoin;

      const lastCall = mockRoom.connect.mock.calls[mockRoom.connect.mock.calls.length - 1]!;
      expect(lastCall[1]).toBe("token-3");
    });
  });

  describe("E2EE worker lifecycle", () => {
    // The key provider lives for the whole process while livekit registers a
    // new SetKey listener on it per Room — with no matching removal — and the
    // per-room E2EE Worker is never terminated. Without explicit teardown,
    // every join/switch/reconnect-attempt leaks a running worker that keeps
    // receiving every future room key via setKey fan-out.
    it("clears stale provider listeners and terminates the previous worker on createRoom", () => {
      (session as any).createRoom();
      const workerMock = globalThis.Worker as unknown as ReturnType<typeof vi.fn>;
      const worker1 = workerMock.mock.instances.at(-1) as unknown as { terminate: () => void };

      (session as any).createRoom();

      expect(worker1.terminate).toHaveBeenCalled();
      const provider = (session as any)._e2ee.keyProvider;
      expect(provider.removeAllListeners).toHaveBeenCalled();
    });

    it("terminates the current worker on leaveVoice so the last room key does not stay resident", () => {
      (session as any).createRoom();
      const workerMock = globalThis.Worker as unknown as ReturnType<typeof vi.fn>;
      const worker = workerMock.mock.instances.at(-1) as unknown as { terminate: () => void };

      session.leaveVoice(false);

      expect(worker.terminate).toHaveBeenCalled();
    });
  });

  describe("attemptAutoReconnect (lifecycle)", () => {
    it("returns without reconnecting when signal is aborted during delay", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 5,
        latestToken: "token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      const ac = new AbortController();

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      ac.abort();
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(mockRoom.connect).not.toHaveBeenCalled();
    });

    it("aborts when currentChannelId changes during delay", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 5,
        latestToken: "token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      const ac = new AbortController();

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      (session as any)._state = { type: "idle" };
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(mockRoom.connect).not.toHaveBeenCalled();
    });

    it("succeeds on second attempt after first fails", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 5,
        latestToken: "token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      session.setServerHost("localhost:7880");
      const ac = new AbortController();

      mockRoom.connect
        .mockRejectedValueOnce(new Error("first attempt failed"))
        .mockResolvedValueOnce(undefined);

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(mockRoom.connect).toHaveBeenCalledTimes(2);
    });

    it("disconnects the failed attempt's room instead of leaking it", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 5,
        latestToken: "token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      session.setServerHost("localhost:7880");
      const ac = new AbortController();

      mockRoom.connect
        .mockRejectedValueOnce(new Error("first attempt failed"))
        .mockResolvedValueOnce(undefined);

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      // The room whose connect failed must be torn down — in "reconnecting"
      // state this._room is null, so the cleanup must target the attempt's
      // own room. A leaked room keeps its listeners and its synchronous
      // Disconnected event spawns a second, uncancellable reconnect loop.
      expect(mockRoom.removeAllListeners).toHaveBeenCalled();
      expect(mockRoom.disconnect).toHaveBeenCalledTimes(1);
    });

    it("calls leaveVoice, leaveVoiceChannel, and error callback after all attempts fail", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 5,
        latestToken: "token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      session.setServerHost("localhost:7880");
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      const ac = new AbortController();

      mockRoom.connect.mockRejectedValue(new Error("always fails"));

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(leaveVoiceChannel).toHaveBeenCalled();
      expect(errorCb).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
    });

    it("catches room disconnect failure during cleanup without throwing", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 5,
        latestToken: "token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      session.setServerHost("localhost:7880");
      const ac = new AbortController();

      mockRoom.connect.mockRejectedValue(new Error("connect failed"));
      mockRoom.disconnect.mockRejectedValueOnce(new Error("disconnect also failed"));

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(leaveVoiceChannel).toHaveBeenCalled();
    });

    it("cleans up reconnect room when signal aborts after connect resolves (BUG-070)", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 5,
        latestToken: "token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      session.setServerHost("localhost:7880");
      const ac = new AbortController();

      mockRoom.connect.mockImplementationOnce(async () => {
        ac.abort();
      });

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(mockRoom.disconnect).toHaveBeenCalled();
      expect((session as any)._state.type).not.toBe("connected");
    });
  });

  describe("token refresh timer", () => {
    it("fires after TOKEN_REFRESH_MS and sends voice_token_refresh WS message", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.setServerHost("localhost:7880");

      mockRoom.connect.mockResolvedValue(undefined);
      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      mockWs.send.mockClear();

      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 100);

      expect(mockWs.send).toHaveBeenCalledWith({
        type: "voice_token_refresh",
        payload: {},
      });
    });

    it("requestTokenRefresh skips silently when ws is null", () => {
      // ws is null (not set) — requestTokenRefresh should skip without throwing
      expect(() => (session as any).requestTokenRefresh()).not.toThrow();
    });

    it("requestTokenRefresh skips silently when room is null", () => {
      session.setWsClient({ send: vi.fn() } as any);
      expect(() => (session as any).requestTokenRefresh()).not.toThrow();
    });

    it("handleVoiceTokenRefresh stores valid token and restarts timer", () => {
      (session as any)._state = {
        type: "connected",
        room: mockRoom,
        channelId: 1,
        latestToken: "old-token",
        lastUrl: "/lk",
        lastDirectUrl: undefined,
      };
      session.handleVoiceTokenRefresh("fresh-token");
      expect((session as any)._state.latestToken).toBe("fresh-token");
      expect((session as any).tokenRefreshTimer).not.toBeNull();
    });

    it("clearTokenRefreshTimer prevents pending refresh from firing", async () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.setServerHost("localhost:7880");

      mockRoom.connect.mockResolvedValue(undefined);
      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      mockWs.send.mockClear();
      (session as any).clearTokenRefreshTimer();

      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 100);

      expect(mockWs.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_token_refresh" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // F3: Voice E2EE identity-key signing + TOFU verification (receive path)
  // -----------------------------------------------------------------------

  describe("E2EE announce verification (F3 TOFU)", () => {
    const HOST = "localhost:7880";
    const PEER_ID = 42;

    function seedPeer(identityPublicKey: string | null): void {
      const peer: ReadyMember = {
        id: PEER_ID,
        username: "peer",
        avatar: null,
        role: "member",
        status: "online",
        identity_public_key: identityPublicKey,
      };
      setMembers([peer]);
    }

    async function joinAsKeyHolder(ws: { send: ReturnType<typeof vi.fn> }): Promise<void> {
      session.setServerHost(HOST);
      session.setWsClient(ws as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
    }

    function offerSends(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
      return ws.send.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === "voice_e2ee_offer");
    }

    beforeEach(() => {
      // Restore TOFU mock defaults — persistent overrides survive clearAllMocks.
      (getIdentityPin as any).mockResolvedValue({ status: "unpinned" });
      (storeIdentityPin as any).mockResolvedValue(true);
      (verifyEphemeralKeySignature as any).mockResolvedValue(true);
    });

    it("signs the ephemeral announce sent on join", async () => {
      seedPeer("peer-identity-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);

      const announce = ws.send.mock.calls
        .map((c) => c[0])
        .find((m: any) => m?.type === "voice_e2ee_announce");
      expect(announce).toBeDefined();
      expect((announce as any).payload.signature).toBe("mock-signature");
    });

    it("rejects a server-substituted peer ephemeral key (signature verify fails)", async () => {
      seedPeer("peer-identity-b64");
      (verifyEphemeralKeySignature as any).mockResolvedValue(false);
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      // No room-key offer wrapped for an unverifiable peer, key not stored.
      expect(offerSends(ws)).toHaveLength(0);
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
      );
      expect(storeIdentityPin).not.toHaveBeenCalled();
    });

    it("pins the peer identity key on first sight and marks it verified", async () => {
      seedPeer("peer-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "unpinned" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(storeIdentityPin).toHaveBeenCalledWith(HOST, String(PEER_ID), "peer-identity-b64");
      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: PEER_ID,
          status: "verified",
          safetyNumber: "AB12 CD34 EF56 7890",
        }),
      );
      // Verified peer is stored and (we are key holder) receives a room-key offer.
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(true);
      expect(offerSends(ws)).toHaveLength(1);
    });

    it("blocks and emits identity-tofu when the pinned identity key changed", async () => {
      seedPeer("new-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "old-identity-b64" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
      );
      // Blocked before verify — no pin overwrite, no signature check, no offer.
      expect(storeIdentityPin).not.toHaveBeenCalled();
      expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
      expect(offerSends(ws)).toHaveLength(0);
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
    });

    it("fails closed when the pin store cannot be read (DC-08): rejects, never re-pins", async () => {
      // A transient keyring error used to read as "no pin stored", sending the
      // peer down the first-sight path — verifying against and RE-PINNING the
      // server-delivered key. With the pin unknown, no trust decision is
      // possible: reject the announce and surface the distinct "unknown" state.
      seedPeer("peer-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "unavailable" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();
      (storeIdentityPin as any).mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "unknown", safetyNumber: null }),
      );
      // Not treated as first sight: no signature check, no pin write, no key
      // stored, no room-key offer.
      expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
      expect(storeIdentityPin).not.toHaveBeenCalled();
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(offerSends(ws)).toHaveLength(0);
    });

    it("blocks a pinned peer when the server strips its published identity key", async () => {
      // Peer was pinned before; the server now omits identity_public_key to
      // shove the peer onto the legacy accept path (finding #2). A pinned peer
      // must never fall back to legacy — this is an identity mismatch.
      seedPeer(null);
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "old-identity-b64" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
      );
      // Blocked: not accepted as legacy/unverified, key not stored, no offer.
      expect(setPeerVerification).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "unverified" }),
      );
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(offerSends(ws)).toHaveLength(0);
      expect(storeIdentityPin).not.toHaveBeenCalled();
      expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
    });

    it("accepts a legacy peer with no identity key but marks it unverified", async () => {
      seedPeer(null);
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", undefined);

      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "unverified", safetyNumber: null }),
      );
      // Legacy peer still works: stored + wrapped, without verify or pin.
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(true);
      expect(offerSends(ws)).toHaveLength(1);
      expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
      expect(storeIdentityPin).not.toHaveBeenCalled();
    });

    it("re-pin recovers a mismatched peer so a later valid announce verifies", async () => {
      // Peer legitimately rotated its identity key (reinstall / new device).
      // Its pinned key mismatches the new published one → blocked.
      seedPeer("new-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "old-identity-b64" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");
      expect(setPeerVerification).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
      );

      // User accepts the new key (analogous to accepting a changed TLS cert):
      // re-pin overwrites the stored pin with the verified key and clears the
      // mismatch block.
      const recovered = await session.rePinPeerIdentity(PEER_ID, "new-identity-b64");
      expect(recovered).toBe(true);
      expect(storeIdentityPin).toHaveBeenCalledWith(HOST, String(PEER_ID), "new-identity-b64");

      // Store now holds the new pin; a fresh valid announce verifies.
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "new-identity-b64" });
      (storeIdentityPin as any).mockClear();
      ws.send.mockClear();
      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(setPeerVerification).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "verified" }),
      );
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(true);
      expect(offerSends(ws)).toHaveLength(1);
    });

    it("re-pins the verified key, not a store re-read a malicious server mutated (TOCTOU)", async () => {
      // The store holds whatever the server most recently pushed. If re-pin
      // re-read the store it would pin the attacker's swapped-in key; it must
      // instead pin the exact key it was handed — the one whose fingerprint the
      // user verified out-of-band.
      seedPeer("attacker-swapped-key-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);

      const pinned = await session.rePinPeerIdentity(PEER_ID, "verified-key-b64");

      expect(pinned).toBe(true);
      expect(storeIdentityPin).toHaveBeenCalledWith(HOST, String(PEER_ID), "verified-key-b64");
      expect(storeIdentityPin).not.toHaveBeenCalledWith(
        HOST,
        String(PEER_ID),
        "attacker-swapped-key-b64",
      );
    });

    it("rotates the room key when a keyed peer leaves while I stay key holder (forward secrecy)", async () => {
      seedPeer("peer-identity-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws); // I hold the key for channel 1
      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig"); // peer now holds the room key
      // A participant remains, so the leave handler proceeds past the empty check.
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      const epochBefore = (session as any)._e2eeEpoch;

      await session.handleParticipantLeft(PEER_ID);

      // Room key rotated (epoch advanced) so the departed peer's copy is dead.
      expect((session as any)._e2eeEpoch).toBe(epochBefore + 1);
    });

    it("does not rotate the room key when the leaver never held it", async () => {
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      const epochBefore = (session as any)._e2eeEpoch;

      await session.handleParticipantLeft(999); // 999 never announced → held no key

      expect((session as any)._e2eeEpoch).toBe(epochBefore);
    });

    it("defers a keyed-peer leave rotation instead of dropping it when one is in flight", async () => {
      seedPeer("peer-identity-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig"); // peer holds the room key
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      // A rotation is already in flight (e.g. an earlier peer's leave).
      (session as any)._rotatingKey = true;
      const epochBefore = (session as any)._e2eeEpoch;

      await session.handleParticipantLeft(PEER_ID);

      // Not dropped by the _rotatingKey guard: the rekey is queued and no second
      // rotation ran underneath the in-flight one.
      expect((session as any)._rotationPending).toBe(true);
      expect((session as any)._e2eeEpoch).toBe(epochBefore);
    });

    it("runs the deferred rotation once the in-flight one completes", async () => {
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      // A keyed-peer leave was deferred while a rotation was in flight.
      (session as any)._rotationPending = true;
      const epochBefore = (session as any)._e2eeEpoch;

      // The completing rotation must drain the pending one (excludes the leaver).
      await (session as any).rotateKeyPeriodically();

      expect((session as any)._e2eeEpoch).toBe(epochBefore + 2);
      expect((session as any)._rotationPending).toBe(false);
    });

    it("verifies a server-substituted key when drained from the pending queue", async () => {
      seedPeer("peer-identity-b64");
      (verifyEphemeralKeySignature as any).mockResolvedValue(false);
      const ws = { send: vi.fn() };
      // Announce arrives BEFORE the keypair is ready → queued, drained on join.
      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");
      expect((session as any)._pendingAnnounces).toHaveLength(1);

      await joinAsKeyHolder(ws);

      // Drain ran through the verifying path → substituted key rejected.
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(offerSends(ws)).toHaveLength(0);
    });
  });
});
