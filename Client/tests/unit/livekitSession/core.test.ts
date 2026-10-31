import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import {
  parseUserId,
  LiveKitSession,
  getRoomForStats,
} from "../../../src/lib/voice/livekitSession";
import {
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
} from "@stores/voice.store";
import {
  leaveVoice as boundLeaveVoice,
  setMuted as boundSetMuted,
  setDeafened as boundSetDeafened,
  cleanupAll as boundCleanupAll,
} from "../../../src/lib/voice/livekitSession";
import { useLiveKitSessionHarness, stubPrefs } from "../../helpers/livekitSessionHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

const { mockRoom, mockSavePref } = mocks;

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

  useLiveKitSessionHarness({
    wired: (s) => {
      session = s;
    },
    currentSession: () => session,
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
      session.setUserVolume(42, 70);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 70);
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

    it("reflects a setOutputVolume change instead of the app-startup value", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      session.setOutputVolume(40);

      const info = session.getSessionDebugInfo();
      expect(info.outputVolumeMultiplier).toBe(0.4);
    });

    it("carries your share's sender stats while you share, and none after", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      expect(session.getSessionDebugInfo().screenShareSender).toBeNull();

      const sample = { sentFps: 61, limitation: "cpu", encoder: "libvpx" };
      const sharePublication = {
        track: {
          mediaStreamTrack: {},
          getSenderStats: async () => [
            {
              framesPerSecond: 61,
              qualityLimitationReason: "cpu",
              encoderImplementation: "libvpx",
            },
          ],
        },
      };
      mockRoom.localParticipant.getTrackPublication.mockImplementation((source: string) =>
        source === "screenShare" ? sharePublication : undefined,
      );
      // The share's tile polls; the bundle reports what the last poll read.
      await session.getLocalScreenshareStats();
      expect(session.getSessionDebugInfo().screenShareSender).toMatchObject(sample);

      mockRoom.localParticipant.getTrackPublication.mockReturnValue(undefined);
      expect(session.getSessionDebugInfo().screenShareSender).toBeNull();
    });

    it("records the share timeline while enabled and keeps it after leaving (plan 2b)", async () => {
      stubPrefs({ shareDiagnosticsV2: true });
      try {
        session.setServerHost("localhost:7880");
        session.setWsClient({ send: vi.fn() } as any);
        await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
        const sharePublication = {
          track: {
            mediaStreamTrack: {},
            getSenderStats: async () => [{ framesPerSecond: 30, frameWidth: 1280 }],
          },
        };
        mockRoom.localParticipant.getTrackPublication.mockImplementation((source: string) =>
          source === "screenShare" ? sharePublication : undefined,
        );
        expect(session.getShareDiagnostics()).toBeNull();
        await vi.advanceTimersByTimeAsync(1000);
        const recorded = session.getShareDiagnostics();
        expect(recorded?.samples).toHaveLength(1);
        expect(recorded?.samples[0]?.sender).toMatchObject({ sentFps: 30, width: 1280 });
        expect(session.getSessionDebugInfo().screenShareTimeline).toMatchObject({ samples: 1 });

        session.leaveVoice(false);
        await vi.advanceTimersByTimeAsync(3000);
        // Polling stopped, but the timeline is still there for the bundle.
        expect(session.getShareDiagnostics()?.samples).toHaveLength(1);
      } finally {
        stubPrefs();
      }
    });

    it("drops a sender stats read that outlived its share", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      let resolveStats: (layers: unknown[]) => void = () => {};
      const oldShare = {
        track: {
          mediaStreamTrack: {},
          getSenderStats: () =>
            new Promise<unknown[]>((resolve) => {
              resolveStats = resolve;
            }),
        },
      };
      const newShare = { track: { mediaStreamTrack: {}, getSenderStats: async () => [] } };
      let current = oldShare;
      mockRoom.localParticipant.getTrackPublication.mockImplementation((source: string) =>
        source === "screenShare" ? current : undefined,
      );
      const pending = session.getLocalScreenshareStats();
      // The share stops and a new one starts while the old read is in flight.
      current = newShare;
      resolveStats([{ framesPerSecond: 5, frameWidth: 1920, active: true }]);
      await expect(pending).resolves.toBeNull();
      expect(session.getSessionDebugInfo().screenShareSender).toBeNull();
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
  // Mutant-killing tests: delegation methods
  // -----------------------------------------------------------------------

  describe("delegation methods (video)", () => {
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
});
