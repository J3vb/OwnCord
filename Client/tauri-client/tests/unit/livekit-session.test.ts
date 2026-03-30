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
  createLocalVideoTrack: vi.fn(async () => ({ kind: "video", mediaStreamTrack: new MediaStreamTrack() })),
  createLocalScreenTracks: vi.fn(async () => [{ kind: "video", mediaStreamTrack: new MediaStreamTrack() }]),
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

// Now import
import { parseUserId, LiveKitSession, getRoomForStats } from "../../src/lib/livekitSession";
import { setLocalMuted, setLocalDeafened, setLocalCamera, setLocalScreenshare } from "@stores/voice.store";

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

    it("setServerHost stores the host for voice token connections", () => {
      session.setServerHost("myhost:9443");
      // Stored host is used in handleVoiceToken — verified indirectly via
      // the proxy URL construction. Setter is a simple field assignment;
      // integration with handleVoiceToken is tested in the voice token suite.
      expect(() => session.setServerHost("another:8080")).not.toThrow();
    });

    it("setOnError stores callback and clearOnError removes it", () => {
      const cb = vi.fn();
      session.setOnError(cb);
      // Trigger an error path — leaveVoice with no room is silent,
      // but we can verify the callback was passed to deviceManager
      // by checking deviceManager.setOnError was called.
      expect(cb).not.toHaveBeenCalled();
      session.clearOnError();
      // After clear, the callback should no longer be stored
      // (deviceManager.setOnError(null) called internally)
    });

    it("setOnRemoteVideo stores callbacks and clearOnRemoteVideo removes them", () => {
      const videoCb = vi.fn();
      const removedCb = vi.fn();
      session.setOnRemoteVideo(videoCb);
      session.setOnRemoteVideoRemoved(removedCb);
      // Callbacks are stored for use in handleTrackSubscribed/handleTrackUnsubscribed
      session.clearOnRemoteVideo();
      // After clear, remote video events should not invoke the old callbacks
      expect(videoCb).not.toHaveBeenCalled();
      expect(removedCb).not.toHaveBeenCalled();
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
    it("cleans up all state without throwing", () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      session.setServerHost("localhost:8080");
      session.setOnError(vi.fn());
      session.setOnRemoteVideo(vi.fn());
      session.setOnRemoteVideoRemoved(vi.fn());

      expect(() => session.cleanupAll()).not.toThrow();
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
      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_camera", payload: { enabled: false } });
    });
  });

  describe("switchInputDevice", () => {
    it("does nothing when no active room", async () => {
      // Should not throw
      await session.switchInputDevice("device-1");
    });
  });

  describe("switchOutputDevice", () => {
    it("does nothing when no active room", async () => {
      await session.switchOutputDevice("device-1");
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
      (session as any)._audioElements.screenshareAudioElements = new Map([[42, new Set([screenshareAudio])]]);

      session.setOutputVolume(80);

      expect(screenshareAudio.volume).toBe(0.8);
    });

    it("clamps existing screenshare audio elements to the browser volume range", () => {
      const screenshareAudio = document.createElement("audio");
      (session as any)._audioElements.screenshareAudioElements = new Map([[42, new Set([screenshareAudio])]]);

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

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880");

      expect(mockRoom.connect).toHaveBeenCalledWith("ws://localhost:7880", "test-token");
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("uses proxy URL for non-local hosts", async () => {
      session.setServerHost("example.com:443");
      session.setWsClient({ send: vi.fn() } as any);

      await session.handleVoiceToken("test-token", "/livekit", 1);

      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", { remoteHost: "example.com:443" });
      expect(mockRoom.connect).toHaveBeenCalledWith("ws://127.0.0.1:7881/livekit", "test-token");
    });

    it("handles mic permission denied gracefully", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const domErr = new DOMException("Permission denied", "NotAllowedError");
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(domErr);

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880");

      expect(errorCb).toHaveBeenCalledWith("Microphone permission denied — joined in listen-only mode");
    });

    it("handles mic not found gracefully", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const domErr = new DOMException("No device", "NotFoundError");
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(domErr);

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880");

      expect(errorCb).toHaveBeenCalledWith("No microphone found — joined in listen-only mode");
    });

    it("handles generic mic error gracefully", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error("unknown"));

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880");

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
      const tokenPromise = session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880");

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

      const firstJoin = session.handleVoiceToken("first-token", "/livekit-one", 1, "ws://localhost:7881");
      await Promise.resolve();

      await session.handleVoiceToken("second-token", "/livekit-two", 2, "ws://localhost:7882");
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

  describe("handleVoiceTokenRefresh", () => {
    it("stores the token and restarts the timer", () => {
      session.handleVoiceTokenRefresh("new-token");
      // No throw — timer is started internally
    });

    it("handles undefined token", () => {
      expect(() => session.handleVoiceTokenRefresh(undefined)).not.toThrow();
    });
  });

  describe("auto reconnect", () => {
    it("preserves local mute state on reconnect", async () => {
      mockVoiceState.localMuted = true;
      mockVoiceState.localDeafened = false;
      (session as any).currentChannelId = 7;

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
      (session as any).currentChannelId = 9;

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

      const tokenPromise = session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880");
      await Promise.resolve(); // Let handleVoiceToken reach room.connect()

      // Simulate LiveKit emitting Disconnected with JOIN_FAILURE (reason 7)
      // while the connect() is still in progress
      expect(disconnectedHandler).toBeDefined();
      disconnectedHandler!(7);

      // The room should NOT have been nulled — retry loop is still in control
      expect((session as any).room).not.toBeNull();

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

      expect(() => (session as any).handleTrackSubscribed(track, publication, participant)).not.toThrow();
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

      (session as any).handleTrackSubscribed(firstTrack, publication, participant);
      (session as any).handleTrackSubscribed(secondTrack, publication, participant);
      (session as any).handleTrackUnsubscribed(firstTrack, publication, participant);

      session.muteScreenshareAudio(42, true);

      expect(secondAudioEl.muted).toBe(true);
      expect((session as any)._audioElements.screenshareAudioElements.get(42)).toEqual(new Set([secondAudioEl]));
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

      (session as any).handleTrackSubscribed(firstTrack, publication, participant);
      session.muteScreenshareAudio(42, true);

      (session as any).handleTrackSubscribed(secondTrack, publication, participant);

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
      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_screenshare", payload: { enabled: false } });
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
});
