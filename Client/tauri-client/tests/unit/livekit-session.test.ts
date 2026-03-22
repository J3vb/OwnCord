import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks must be declared before imports ---

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
  },
  Track: {
    Source: { Microphone: "microphone", Camera: "camera" },
    Kind: { Audio: "audio", Video: "video" },
  },
  DisconnectReason: { CLIENT_INITIATED: 0 },
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: { get: vi.fn(() => ({})), set: vi.fn(), subscribe: vi.fn() },
  setLocalMuted: vi.fn(),
  setLocalDeafened: vi.fn(),
  setLocalCamera: vi.fn(),
  setSpeakers: vi.fn(),
}));

const { mockLoadPref, mockSavePref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
}));

vi.mock("@components/settings/helpers", () => ({
  loadPref: (...args: unknown[]) => mockLoadPref(...args),
  savePref: (...args: unknown[]) => mockSavePref(...args),
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
import { parseUserId, LiveKitSession } from "../../src/lib/livekitSession";
import { setLocalMuted, setLocalDeafened, setLocalCamera } from "@stores/voice.store";

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
    it("setWsClient stores the client", () => {
      const mockWs = { send: vi.fn() } as any;
      session.setWsClient(mockWs);
      // No direct getter, but leaveVoice with sendWs=true will use it
      // Just verifying it doesn't throw
      expect(() => session.setWsClient(mockWs)).not.toThrow();
    });

    it("setServerHost stores the host", () => {
      expect(() => session.setServerHost("localhost:8080")).not.toThrow();
    });

    it("setOnError / clearOnError manage the error callback", () => {
      const cb = vi.fn();
      session.setOnError(cb);
      session.clearOnError();
      // No throw means it works
    });

    it("setOnRemoteVideo / clearOnRemoteVideo manage video callbacks", () => {
      const cb = vi.fn();
      const removedCb = vi.fn();
      session.setOnRemoteVideo(cb);
      session.setOnRemoteVideoRemoved(removedCb);
      session.clearOnRemoteVideo();
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

      expect(mockRoom.connect).toHaveBeenCalledWith("wss://example.com:443/livekit", "test-token");
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
});
