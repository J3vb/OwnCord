import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import { createLocalVideoTrack } from "livekit-client";
import { LiveKitSession } from "../../../src/lib/voice/livekitSession";
import { setLocalCamera, setLocalScreenshare } from "@stores/voice.store";
import { channelsStore, resetChannelsStore } from "@stores/channels.store";
import { keepDmForCall, resetKeptCallDms } from "../../../src/features/direct-messages/keptCallDms";
import { createDeferred, useLiveKitSessionHarness } from "../../helpers/livekitSessionHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

const { mockVoiceState, mockRoom, mockShowActionToast } = mocks;

describe("LiveKitSession", () => {
  let session: LiveKitSession;

  useLiveKitSessionHarness({
    wired: (s) => {
      session = s;
    },
    currentSession: () => session,
  });

  it("a camera's Stop watching survives a channel switch and ends on leave", () => {
    session.setRemoteVideoWatched(7, "camera", false);
    session.leaveVoice(false, true);
    expect((session as any)._remoteTracks.isWatched(7, "camera")).toBe(false);
    session.leaveVoice(false);
    expect((session as any)._remoteTracks.isWatched(7, "camera")).toBe(true);
  });

  describe("teardownForReconnect video track cleanup", () => {
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

    // Without this, a successful auto-reconnect leaves the server's
    // voice_states row with camera=1/screenshare=1 forever (the reconnected
    // participant is not "rogue" so no webhook clears it), occupying a
    // max_video slot the user can never free even by re-toggling.
    it("sends voice_camera/voice_screenshare OFF frames before tearing down local tracks", async () => {
      session.setServerHost("localhost:7880");
      const sendSpy = vi.fn();
      session.setWsClient({ send: sendSpy } as any);

      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      expect(disconnectedHandler).toBeDefined();

      mockVoiceState.localCamera = true;
      mockVoiceState.localScreenshare = true;
      sendSpy.mockClear();

      disconnectedHandler!(/* SERVER_SHUTDOWN */ 1);

      expect(sendSpy).toHaveBeenCalledWith({ type: "voice_camera", payload: { enabled: false } });
      expect(sendSpy).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      });
    });

    it("does not send camera/screenshare OFF frames when neither was active", async () => {
      session.setServerHost("localhost:7880");
      const sendSpy = vi.fn();
      session.setWsClient({ send: sendSpy } as any);

      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      expect(disconnectedHandler).toBeDefined();

      sendSpy.mockClear();
      disconnectedHandler!(/* SERVER_SHUTDOWN */ 1);

      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_camera" }));
      expect(sendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_screenshare" }),
      );
    });
  });

  describe("leaveVoice camera/screenshare generation guard", () => {
    it("discards a camera track whose device-acquisition await resolves after leaveVoice() ran", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      let resolveTrack!: (t: { kind: string; mediaStreamTrack: unknown; stop: () => void }) => void;
      (createLocalVideoTrack as any).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveTrack = resolve;
        }),
      );

      // enableCamera() captures room + the pre-bump generation, then blocks
      // on the camera permission prompt (createLocalVideoTrack).
      const enabling = session.enableCamera();
      await vi.advanceTimersByTimeAsync(0);

      // The user leaves voice while that prompt is still pending.
      session.leaveVoice(false);

      // Permission is granted after the leave.
      resolveTrack({ kind: "video", mediaStreamTrack: {}, stop: vi.fn() });
      await enabling;

      // Without a generation bump in leaveVoice(), the stale enable would
      // still publish onto the room leaveVoice() already disconnected.
      expect(mockRoom.localParticipant.publishTrack).not.toHaveBeenCalled();
    });
  });

  describe("teardownForReconnect camera/screenshare generation guard", () => {
    it("discards a camera track whose device-acquisition await resolves after an unexpected disconnect", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      expect(disconnectedHandler).toBeDefined();

      let resolveTrack!: (t: { kind: string; mediaStreamTrack: unknown; stop: () => void }) => void;
      (createLocalVideoTrack as any).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveTrack = resolve;
        }),
      );

      const enabling = session.enableCamera();
      await vi.advanceTimersByTimeAsync(0);

      // An unexpected disconnect fires teardownForReconnect while the camera
      // permission prompt is still pending.
      disconnectedHandler!(/* SERVER_SHUTDOWN */ 1);

      resolveTrack({ kind: "video", mediaStreamTrack: {}, stop: vi.fn() });
      await enabling;

      // Without a generation bump in teardownForReconnect, the stale enable
      // would publish onto the room being torn down for auto-reconnect.
      expect(mockRoom.localParticipant.publishTrack).not.toHaveBeenCalled();
    });
  });

  describe("camera/screen share restored after a reconnect", () => {
    let wsState: string;
    let secondDrop: ((reason?: number) => void) | undefined;

    beforeEach(() => {
      wsState = "connected";
      mockShowActionToast.mockClear();
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([[1, { id: 1, type: "voice" } as any]]),
      }));
    });

    afterEach(() => {
      resetChannelsStore();
    });

    async function dropWhile(media: { camera: boolean; screenshare: boolean }): Promise<void> {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn(), getState: () => wsState, ping: async () => {} } as any);
      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      mockVoiceState.localCamera = media.camera;
      mockVoiceState.localScreenshare = media.screenshare;
      disconnectedHandler!(/* SERVER_SHUTDOWN */ 1);
      secondDrop = disconnectedHandler;
    }

    it("turns the camera back on by itself once a camera-on call reconnects, with no toast", async () => {
      const enableCamera = vi.spyOn(session, "enableCamera").mockResolvedValue();
      await dropWhile({ camera: true, screenshare: false });
      mockVoiceState.localCamera = false; // teardownForReconnect turned it off

      await vi.advanceTimersByTimeAsync(3100);

      expect((session as any)._state.type).toBe("connected");
      expect(enableCamera).toHaveBeenCalledOnce();
      expect(mockShowActionToast).not.toHaveBeenCalled();
    });

    it("offers Share again for a web share, which needs the OS picker", async () => {
      const enableScreenshare = vi.spyOn(session, "enableScreenshare").mockResolvedValue();
      await dropWhile({ camera: false, screenshare: true });
      mockVoiceState.localScreenshare = false;
      expect(mockShowActionToast).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3100);

      expect((session as any)._state.type).toBe("connected");
      expect(enableScreenshare).not.toHaveBeenCalled();
      expect(mockShowActionToast).toHaveBeenCalledOnce();
      const [message, type, action] = mockShowActionToast.mock.calls[0]!;
      expect(message).toBe("Your screen share stopped when the connection dropped");
      expect(type).toBe("warning");
      expect(action.label).toBe("Share again");
      action.run();
      expect(enableScreenshare).toHaveBeenCalledOnce();
    });

    it("restores the camera and names only the share when both were on", async () => {
      const enableCamera = vi.spyOn(session, "enableCamera").mockResolvedValue();
      await dropWhile({ camera: true, screenshare: true });
      mockVoiceState.localCamera = false;
      mockVoiceState.localScreenshare = false;

      await vi.advanceTimersByTimeAsync(3100);

      expect(enableCamera).toHaveBeenCalledOnce();
      expect(mockShowActionToast).toHaveBeenCalledOnce();
      expect(mockShowActionToast.mock.calls[0]![0]).toBe(
        "Your screen share stopped when the connection dropped",
      );
    });

    it("leaves a camera the user already turned back on alone", async () => {
      const enableCamera = vi.spyOn(session, "enableCamera").mockResolvedValue();
      await dropWhile({ camera: true, screenshare: false });
      // Still on: the user pressed Camera again before the restore ran.
      mockVoiceState.localCamera = true;

      await vi.advanceTimersByTimeAsync(3100);

      expect(enableCamera).not.toHaveBeenCalled();
      expect(mockShowActionToast).not.toHaveBeenCalled();
    });

    it("shows no share toast when the user leaves while the camera is coming back", async () => {
      let finishCamera!: () => void;
      vi.spyOn(session, "enableCamera").mockImplementation(
        () => new Promise<void>((resolve) => (finishCamera = resolve)),
      );
      await dropWhile({ camera: true, screenshare: true });
      mockVoiceState.localCamera = false;
      mockVoiceState.localScreenshare = false;
      await vi.advanceTimersByTimeAsync(3100);

      session.leaveVoice(false);
      finishCamera();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockShowActionToast).not.toHaveBeenCalled();
    });

    it("a second drop while the camera is coming back still restores both after it", async () => {
      let finishCamera!: () => void;
      const enableCamera = vi
        .spyOn(session, "enableCamera")
        .mockImplementationOnce(() => new Promise<void>((resolve) => (finishCamera = resolve)))
        .mockResolvedValue();
      await dropWhile({ camera: true, screenshare: true });
      mockVoiceState.localCamera = false;
      mockVoiceState.localScreenshare = false;
      await vi.advanceTimersByTimeAsync(3100);
      expect(enableCamera).toHaveBeenCalledOnce();

      // Both are still off in the store when the second drop lands.
      secondDrop!(/* SERVER_SHUTDOWN */ 1);
      finishCamera();
      await vi.advanceTimersByTimeAsync(3100);

      expect((session as any)._state.type).toBe("connected");
      expect(enableCamera).toHaveBeenCalledTimes(2);
      expect(mockShowActionToast).toHaveBeenCalledOnce();
      expect(mockShowActionToast.mock.calls[0]![0]).toBe(
        "Your screen share stopped when the connection dropped",
      );
    });

    it("leaving voice removes the Share again toast", async () => {
      const dismiss = vi.fn();
      mockShowActionToast.mockReturnValueOnce(dismiss);
      await dropWhile({ camera: false, screenshare: true });
      mockVoiceState.localScreenshare = false;
      await vi.advanceTimersByTimeAsync(3100);
      expect(mockShowActionToast).toHaveBeenCalledOnce();

      session.leaveVoice(true);

      expect(dismiss).toHaveBeenCalledOnce();
    });

    it("keeps what the first drop stopped when a second drop lands before the notice", async () => {
      await dropWhile({ camera: false, screenshare: true });
      // The reconnect lands, then the new room drops again before its tail
      // reaches the notice: the camera is already off by then.
      const reconnecting = (session as any)._state;
      (session as any)._state = {
        type: "connected",
        room: mockRoom,
        channelId: 1,
        latestToken: reconnecting.latestToken,
        lastUrl: reconnecting.lastUrl,
        lastDirectUrl: reconnecting.lastDirectUrl,
      };
      reconnecting.ac.abort();
      mockVoiceState.localScreenshare = false;
      secondDrop!(/* SERVER_SHUTDOWN */ 1);
      await vi.advanceTimersByTimeAsync(3100);

      expect((session as any)._state.type).toBe("connected");
      expect(mockShowActionToast).toHaveBeenCalledOnce();
      expect(mockShowActionToast.mock.calls[0]![0]).toBe(
        "Your screen share stopped when the connection dropped",
      );
    });

    it("shows no toast after a reconnect when neither was on", async () => {
      await dropWhile({ camera: false, screenshare: false });
      await vi.advanceTimersByTimeAsync(3100);

      expect((session as any)._state.type).toBe("connected");
      expect(mockShowActionToast).not.toHaveBeenCalled();
    });

    it("shows no toast when the reconnect gives up", async () => {
      const enableCamera = vi.spyOn(session, "enableCamera").mockResolvedValue();
      await dropWhile({ camera: true, screenshare: true });
      // The chat socket closed for good: the loop gives up instead of resuming.
      wsState = "disconnected";
      await vi.advanceTimersByTimeAsync(3100);

      expect((session as any)._state.type).toBe("idle");
      expect(mockShowActionToast).not.toHaveBeenCalled();
      expect(enableCamera).not.toHaveBeenCalled();
    });
  });

  describe("a closed 1:1 kept for its call", () => {
    // Channel 100 is neither a server channel nor an open DM, as after a local close.
    async function drop(): Promise<void> {
      mockVoiceState.currentChannelId = 100;
      session.setServerHost("localhost:7880");
      session.setWsClient({
        send: vi.fn(),
        getState: () => "connected",
        ping: async () => {},
      } as any);
      let handler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, h: any) => {
        if (event === "disconnected") handler = h;
        return mockRoom;
      });
      await session.handleVoiceToken("test-token", "/livekit", 100, "ws://localhost:7880", true);
      handler!(/* SERVER_SHUTDOWN */ 1);
    }

    afterEach(() => {
      resetKeptCallDms();
    });

    it("keeps retrying the reconnect after the DM was closed", async () => {
      mockVoiceState.currentChannelId = 100;
      keepDmForCall(100);
      await drop();
      await vi.advanceTimersByTimeAsync(3100);
      expect((session as any)._state.type).toBe("connected");
    });

    it("gives up on a channel that is neither listed nor kept (a group leave)", async () => {
      await drop();
      await vi.advanceTimersByTimeAsync(3100);
      expect((session as any)._state.type).toBe("idle");
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
      const publication = { source: "screenShareAudio", setSubscribed: vi.fn() };
      (session as any)._remoteTracks.watch(42, "screenshare", true);
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
      const publication = { source: "screenShareAudio", setSubscribed: vi.fn() };
      (session as any)._remoteTracks.watch(42, "screenshare", true);
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
      const publication = { source: "screenShareAudio", setSubscribed: vi.fn() };
      (session as any)._remoteTracks.watch(42, "screenshare", true);
      const participant = { identity: "user-42" };

      (session as any)._eventHandlers.handleTrackSubscribed(firstTrack, publication, participant);
      session.muteScreenshareAudio(42, true);

      (session as any)._eventHandlers.handleTrackSubscribed(secondTrack, publication, participant);

      expect(secondAudioEl.muted).toBe(true);
      expect(session.getScreenshareAudioMuted(42)).toBe(true);
    });
  });
});
