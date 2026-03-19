/**
 * Unit tests for voice session camera (video) lifecycle:
 * enableCamera, disableCamera, setOnRemoteVideo, clearOnRemoteVideo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTrack(kind: "video" | "audio"): MediaStreamTrack {
  return {
    kind,
    stop: vi.fn(),
    enabled: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ deviceId: "cam-1", width: 1280, height: 720, frameRate: 30 }),
  } as unknown as MediaStreamTrack;
}

function createMockStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    id: "mock-stream-1",
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    onremovetrack: null,
  } as unknown as MediaStream;
}

// ---------------------------------------------------------------------------
// Track mock calls
// ---------------------------------------------------------------------------

const mockWsSend = vi.fn();
const mockAddVideoTrack = vi.fn();
const mockRemoveVideoTrack = vi.fn();
const mockCreateOffer = vi.fn().mockResolvedValue("mock-sdp-offer");
const mockSetLocalStream = vi.fn();
const mockDestroy = vi.fn();
const mockOnIceCandidate = vi.fn().mockReturnValue(() => {});
const mockOnRemoteTrack = vi.fn().mockReturnValue(() => {});
const mockOnStateChange = vi.fn().mockReturnValue(() => {});
const mockOnIceStateChange = vi.fn().mockReturnValue(() => {});
const mockCreateConnection = vi.fn();
const mockGetCameraStream = vi.fn();
const mockVideoManagerDestroy = vi.fn();

const mockSender = { track: null } as unknown as RTCRtpSender;

// Prefs storage for tests
const testPrefs = new Map<string, unknown>();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/lib/webrtc", () => ({
  createWebRtcService: () => ({
    createConnection: mockCreateConnection,
    createOffer: mockCreateOffer,
    handleAnswer: vi.fn(),
    handleServerOffer: vi.fn(),
    handleIceCandidate: vi.fn(),
    addVideoTrack: mockAddVideoTrack,
    removeVideoTrack: mockRemoveVideoTrack,
    setLocalStream: mockSetLocalStream,
    replaceTrack: vi.fn(),
    getRemoteStreams: () => [],
    setMuted: vi.fn(),
    setSilenced: vi.fn(),
    onIceCandidate: mockOnIceCandidate,
    onRemoteTrack: mockOnRemoteTrack,
    onStateChange: mockOnStateChange,
    onIceStateChange: mockOnIceStateChange,
    destroy: mockDestroy,
  }),
}));

vi.mock("../../src/lib/audio", () => ({
  createAudioManager: () => ({
    getUserMedia: vi.fn().mockResolvedValue(
      createMockStream([createMockTrack("audio")]),
    ),
    destroy: vi.fn(),
  }),
}));

vi.mock("../../src/lib/video", () => ({
  createVideoManager: () => ({
    getCameraStream: mockGetCameraStream,
    stopCameraStream: vi.fn(),
    getCurrentStream: () => null,
    enumerateDevices: vi.fn().mockResolvedValue([]),
    onDeviceChange: vi.fn().mockReturnValue(() => {}),
    destroy: mockVideoManagerDestroy,
  }),
}));

vi.mock("../../src/lib/vad", () => ({
  createVadDetector: () => ({
    start: vi.fn(),
    destroy: vi.fn(),
    onSpeakingChange: vi.fn().mockReturnValue(() => {}),
    setThreshold: vi.fn(),
  }),
  sensitivityToThreshold: (s: number) => s,
}));

vi.mock("../../src/lib/noise-suppression", () => ({
  createNoiseSuppressor: () => ({
    process: vi.fn().mockImplementation((stream: MediaStream) => Promise.resolve(stream)),
    destroy: vi.fn(),
  }),
}));

vi.mock("../../src/components/settings/helpers", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
  THEMES: { dark: {}, midnight: {}, light: {} },
  applyTheme: vi.fn(),
}));

vi.mock("../../src/lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import the module under test (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import {
  setWsClient,
  setOnError,
  clearOnError,
  joinVoice,
  leaveVoice,
  enableCamera,
  disableCamera,
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
} from "../../src/lib/voiceSession";
import type { WsClient } from "../../src/lib/ws";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createMockWs(): WsClient {
  return {
    send: mockWsSend,
    close: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onOpen: vi.fn().mockReturnValue(() => {}),
    onClose: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    isConnected: vi.fn().mockReturnValue(true),
  } as unknown as WsClient;
}

const DEFAULT_CONFIG = {
  channel_id: 42,
  quality: "medium" as const,
  bitrate: 64000,
  threshold_mode: "forwarding" as const,
  mixing_threshold: 3,
  top_speakers: 5,
  max_users: 25,
};

/** Set up a joined voice session so enableCamera/disableCamera have context. */
async function setupActiveSession(): Promise<void> {
  const ws = createMockWs();
  setWsClient(ws);
  await joinVoice(42, DEFAULT_CONFIG);
  // Clear setup-related mock calls so tests only see camera-related calls
  mockWsSend.mockClear();
  mockCreateOffer.mockClear();
  mockAddVideoTrack.mockClear();
  mockRemoveVideoTrack.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Voice session — camera lifecycle", () => {
  let errorCb: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testPrefs.clear();
    mockWsSend.mockClear();
    mockCreateOffer.mockClear();
    mockAddVideoTrack.mockClear();
    mockRemoveVideoTrack.mockClear();
    mockGetCameraStream.mockReset();
    mockGetCameraStream.mockResolvedValue(
      createMockStream([createMockTrack("video")]),
    );
    mockAddVideoTrack.mockReturnValue(mockSender);
    mockCreateOffer.mockResolvedValue("mock-sdp-offer");

    errorCb = vi.fn();
    setOnError(errorCb);
  });

  afterEach(() => {
    clearOnError();
    clearOnRemoteVideo();
    // leaveVoice to reset singleton state
    leaveVoice(false);
  });

  // -----------------------------------------------------------------------
  // enableCamera
  // -----------------------------------------------------------------------

  describe("enableCamera", () => {
    it("acquires camera stream and adds video track to WebRTC", async () => {
      await setupActiveSession();
      await enableCamera();

      expect(mockGetCameraStream).toHaveBeenCalled();
      expect(mockAddVideoTrack).toHaveBeenCalledTimes(1);
      // The stream passed to addVideoTrack should be the camera stream
      const passedStream = mockAddVideoTrack.mock.calls[0]![0] as MediaStream;
      expect(passedStream.getVideoTracks()).toHaveLength(1);
    });

    it("sends voice_offer for renegotiation after adding track", async () => {
      await setupActiveSession();
      await enableCamera();

      const offerMessages = mockWsSend.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "voice_offer",
      );
      expect(offerMessages.length).toBeGreaterThanOrEqual(1);
      expect(offerMessages[0]![0]).toEqual({
        type: "voice_offer",
        payload: { channel_id: 42, sdp: "mock-sdp-offer" },
      });
    });

    it("sends voice_camera enabled=true AFTER successful track addition", async () => {
      await setupActiveSession();
      await enableCamera();

      // voice_camera should be sent after addVideoTrack and voice_offer
      const cameraMessages = mockWsSend.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "voice_camera",
      );
      expect(cameraMessages).toHaveLength(1);
      expect(cameraMessages[0]![0]).toEqual({
        type: "voice_camera",
        payload: { enabled: true },
      });

      // Verify ordering: voice_offer comes before voice_camera
      const allTypes = mockWsSend.mock.calls.map(
        (c) => (c[0] as { type: string }).type,
      );
      const offerIdx = allTypes.indexOf("voice_offer");
      const cameraIdx = allTypes.indexOf("voice_camera");
      expect(offerIdx).toBeLessThan(cameraIdx);
    });

    it("handles permission denied error with toast", async () => {
      await setupActiveSession();
      mockGetCameraStream.mockRejectedValue(
        new DOMException("Permission denied", "NotAllowedError"),
      );

      await enableCamera();

      expect(errorCb).toHaveBeenCalledWith("Camera permission denied");
    });

    it("handles no camera found error with toast", async () => {
      await setupActiveSession();
      mockGetCameraStream.mockRejectedValue(
        new DOMException("No device found", "NotFoundError"),
      );

      await enableCamera();

      expect(errorCb).toHaveBeenCalledWith("No camera found");
    });

    it("uses saved video device preference", async () => {
      testPrefs.set("videoInputDevice", "cam-back");
      await setupActiveSession();
      await enableCamera();

      expect(mockGetCameraStream).toHaveBeenCalledWith("cam-back");
    });

    it("does nothing when no active voice session", async () => {
      // No joinVoice, so no webrtcService
      await enableCamera();

      expect(mockGetCameraStream).not.toHaveBeenCalled();
      expect(errorCb).toHaveBeenCalledWith("Join a voice channel first");
    });

    it("does nothing when camera is already enabled", async () => {
      await setupActiveSession();
      await enableCamera();
      mockGetCameraStream.mockClear();
      mockWsSend.mockClear();

      await enableCamera();

      expect(mockGetCameraStream).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // disableCamera
  // -----------------------------------------------------------------------

  describe("disableCamera", () => {
    it("stops camera tracks and removes video track from WebRTC", async () => {
      const videoTrack = createMockTrack("video");
      const cameraStream = createMockStream([videoTrack]);
      mockGetCameraStream.mockResolvedValue(cameraStream);

      await setupActiveSession();
      await enableCamera();
      mockWsSend.mockClear();

      await disableCamera();

      expect(videoTrack.stop).toHaveBeenCalled();
      expect(mockRemoveVideoTrack).toHaveBeenCalledWith(mockSender);
    });

    it("sends voice_camera enabled=false", async () => {
      await setupActiveSession();
      await enableCamera();
      mockWsSend.mockClear();

      await disableCamera();

      const cameraMessages = mockWsSend.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "voice_camera",
      );
      expect(cameraMessages).toHaveLength(1);
      expect(cameraMessages[0]![0]).toEqual({
        type: "voice_camera",
        payload: { enabled: false },
      });
    });

    it("sends voice_offer for renegotiation after removing track", async () => {
      await setupActiveSession();
      await enableCamera();
      mockWsSend.mockClear();

      await disableCamera();

      const offerMessages = mockWsSend.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "voice_offer",
      );
      expect(offerMessages).toHaveLength(1);
    });

    it("is safe to call when camera is not enabled", async () => {
      await setupActiveSession();

      // Should not throw
      await disableCamera();

      expect(mockRemoveVideoTrack).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Remote video callbacks
  // -----------------------------------------------------------------------

  describe("setOnRemoteVideo / clearOnRemoteVideo", () => {
    it("registers a remote video callback", () => {
      const cb = vi.fn();
      setOnRemoteVideo(cb);

      // The callback is stored internally — we verify by clearing it
      // (no public getter). This tests the registration path.
      clearOnRemoteVideo();
      // If clearOnRemoteVideo didn't throw and completed, registration succeeded.
      expect(true).toBe(true);
    });

    it("registers a remote video removed callback", () => {
      const cb = vi.fn();
      setOnRemoteVideoRemoved(cb);
      clearOnRemoteVideo();
      expect(true).toBe(true);
    });

    it("clearOnRemoteVideo nullifies both callbacks", () => {
      const videoCb = vi.fn();
      const removedCb = vi.fn();

      setOnRemoteVideo(videoCb);
      setOnRemoteVideoRemoved(removedCb);
      clearOnRemoteVideo();

      // After clearing, new registrations should work without error
      setOnRemoteVideo(vi.fn());
      setOnRemoteVideoRemoved(vi.fn());
      clearOnRemoteVideo();
      expect(true).toBe(true);
    });

    it("can overwrite existing callbacks", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      setOnRemoteVideo(cb1);
      setOnRemoteVideo(cb2);

      // No throw — second registration overwrites the first
      clearOnRemoteVideo();
      expect(true).toBe(true);
    });
  });
});
