import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import { LiveKitSession, setPttPollingLive } from "../../../src/lib/voice/livekitSession";
import { setTalkButton } from "../../../src/lib/ui/inputMode";
import { setLocalMuted, setLocalDeafened, setPttGated, setListenOnly } from "@stores/voice.store";
import { getLiveKitProxyPort } from "../../../src/platform/desktop/nativeProxies";
import { takeWatchRefusal } from "../../../src/lib/voice/watchRequest";
import {
  createDeferred,
  useLiveKitSessionHarness,
  enterReconnecting,
  runReconnect,
  startReconnect,
  enterConnected,
  stubPrefs,
  joinSession,
} from "../../helpers/livekitSessionHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

const { mockVoiceState, pttPollingListeners, mockRoom, mockInvoke } = mocks;

describe("LiveKitSession", () => {
  let session: LiveKitSession;

  useLiveKitSessionHarness({
    wired: (s) => {
      session = s;
    },
    currentSession: () => session,
  });

  describe("async room ownership", () => {
    function makeRoom() {
      return {
        ...mockRoom,
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        off: vi.fn(),
        localParticipant: {
          ...mockRoom.localParticipant,
          setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
        },
      };
    }

    function installRoom(room: ReturnType<typeof makeRoom>, channelId = 1): void {
      (session as any)._state = {
        type: "connected",
        room,
        channelId,
        latestToken: "current-token",
        lastUrl: "/livekit",
        lastDirectUrl: undefined,
      };
      (session as any).syncModuleRooms();
    }

    it.each(["resolve", "reject"] as const)(
      "ignores a stale microphone restore %s before changing listen-only state",
      async (outcome) => {
        const roomA = makeRoom();
        const mic = createDeferred<void>();
        roomA.localParticipant.setMicrophoneEnabled.mockImplementationOnce(() => mic.promise);
        installRoom(roomA);
        const restoring = (session as any).restoreLocalVoiceState("join");
        const roomB = makeRoom();
        installRoom(roomB, 2);
        vi.mocked(setListenOnly).mockClear();
        if (outcome === "resolve") mic.resolve(undefined);
        else mic.reject(new DOMException("Denied", "NotAllowedError"));
        await restoring;
        expect(setListenOnly).not.toHaveBeenCalled();
        expect(roomB.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
      },
    );

    it("does not apply a stale permission retry to the replacement room", async () => {
      const roomA = makeRoom();
      const mic = createDeferred<void>();
      roomA.localParticipant.setMicrophoneEnabled.mockImplementationOnce(() => mic.promise);
      installRoom(roomA);
      const retry = session.retryMicPermission();
      const roomB = makeRoom();
      installRoom(roomB, 2);
      mockVoiceState.localMuted = true;
      vi.mocked(setListenOnly).mockClear();
      mic.resolve(undefined);
      await retry;
      expect(roomB.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(setListenOnly).not.toHaveBeenCalled();
    });

    it("does not mark the new session muted when an old room's unmute fails", async () => {
      const roomA = makeRoom();
      const mic = createDeferred<void>();
      roomA.localParticipant.setMicrophoneEnabled.mockImplementationOnce(() => mic.promise);
      installRoom(roomA);
      const unmuting = (session as any).applyMicMuteState(false);
      installRoom(makeRoom(), 2);
      vi.mocked(setListenOnly).mockClear();
      vi.mocked(setLocalMuted).mockClear();
      mic.reject(new DOMException("Old device unavailable", "NotFoundError"));
      await unmuting;
      expect(setListenOnly).not.toHaveBeenCalled();
      expect(setLocalMuted).not.toHaveBeenCalled();
    });

    it("does not replace current module wiring when stale room creation finishes", async () => {
      session.setServerHost("localhost:7880");
      const roomA = makeRoom();
      const roomReady = createDeferred<any>();
      vi.spyOn(session as any, "createRoom").mockImplementationOnce(() => roomReady.promise);
      const connecting = (session as any).connectAndSetup("old-token", "/livekit", 1);
      const roomB = makeRoom();
      installRoom(roomB, 2);
      roomReady.resolve(roomA);
      expect(await connecting).toBe("superseded");
      expect((session as any)._audioPipeline.room).toBe(roomB);
      expect((session as any)._deviceManager.room).toBe(roomB);
      expect(roomA.connect).not.toHaveBeenCalled();
    });

    it.each(["join", "reconnect"] as const)(
      "recognizes a replacement room in the same channel after %s microphone setup",
      async (mode) => {
        session.setServerHost("localhost:7880");
        const roomA = makeRoom();
        const mic = createDeferred<void>();
        roomA.localParticipant.setMicrophoneEnabled.mockImplementationOnce(() => mic.promise);
        vi.spyOn(session as any, "createRoom").mockResolvedValueOnce(roomA);
        vi.spyOn((session as any)._e2ee, "setupKeyExchange").mockResolvedValueOnce(true);
        let connecting: Promise<unknown>;
        if (mode === "join") {
          connecting = (session as any).connectAndSetup("old-token", "/livekit", 1);
        } else {
          const ac = new AbortController();
          (session as any)._state = {
            type: "reconnecting",
            channelId: 1,
            latestToken: "old-token",
            lastUrl: "/livekit",
            lastDirectUrl: undefined,
            ac,
          };
          vi.spyOn((session as any)._e2ee, "reannounceForReconnect").mockResolvedValueOnce(
            undefined,
          );
          connecting = (session as any).attemptAutoReconnect(
            "old-token",
            "/livekit",
            1,
            undefined,
            ac.signal,
          );
        }
        await vi.advanceTimersByTimeAsync(mode === "join" ? 0 : 3000);
        expect(roomA.localParticipant.setMicrophoneEnabled).toHaveBeenCalled();
        installRoom(makeRoom(), 1);
        const setup = vi.spyOn((session as any)._audioPipeline, "setupAudioPipeline");
        mic.resolve(undefined);
        expect(await connecting).toBe(mode === "join" ? "superseded" : undefined);
        expect(setup).not.toHaveBeenCalled();
        // Timer lives on VoiceTokenManager since the refactor. A superseded
        // attempt must not have armed it.
        expect((session as any)._tokenManager._refreshTimer).toBeNull();
      },
    );

    it("does not connect a stale retry room after its creation await", async () => {
      session.setServerHost("localhost:7880");
      const roomA = makeRoom();
      roomA.connect.mockRejectedValueOnce(new Error("initial connection failed"));
      const retryRoom = makeRoom();
      const retryReady = createDeferred<any>();
      vi.spyOn(session as any, "createRoom")
        .mockResolvedValueOnce(roomA)
        .mockImplementationOnce(() => retryReady.promise);
      vi.spyOn((session as any)._e2ee, "setupKeyExchange").mockResolvedValueOnce(true);
      const connecting = (session as any).connectAndSetup("old-token", "/livekit", 1);
      await vi.advanceTimersByTimeAsync(2000);
      const roomB = makeRoom();
      installRoom(roomB, 2);
      retryReady.resolve(retryRoom);
      expect(await connecting).toBe("superseded");
      expect(retryRoom.connect).not.toHaveBeenCalled();
      expect((session as any)._deviceManager.room).toBe(roomB);
    });

    it.each(["connecting", "reconnecting"] as const)(
      "preserves a newer %s room when stale reconnect creation completes",
      async (replacement) => {
        session.setServerHost("localhost:7880");
        const ac = new AbortController();
        (session as any)._state = {
          type: "reconnecting",
          channelId: 1,
          latestToken: "old-token",
          lastUrl: "/livekit",
          lastDirectUrl: undefined,
          ac,
        };
        const roomReady = createDeferred<any>();
        vi.spyOn(session as any, "createRoom").mockImplementationOnce(() => roomReady.promise);
        const reconnect = startReconnect(session, 1, {
          token: "old-token",
          directUrl: undefined,
          signal: ac.signal,
        });
        await vi.advanceTimersByTimeAsync(3000);
        const roomB = makeRoom();
        installRoom(roomB, 2);
        (session as any)._state =
          replacement === "connecting"
            ? { type: "connecting", joinGeneration: 2, pendingJoin: null }
            : {
                type: "reconnecting",
                channelId: 1,
                latestToken: "new-token",
                lastUrl: "/livekit",
                lastDirectUrl: undefined,
                ac: new AbortController(),
              };
        const staleRoom = makeRoom();
        roomReady.resolve(staleRoom);
        await reconnect;
        expect(staleRoom.connect).not.toHaveBeenCalled();
        expect((session as any)._audioPipeline.room).toBe(roomB);
        expect((session as any)._deviceManager.room).toBe(roomB);
      },
    );
  });

  describe("microphone grant restoration", () => {
    let permissions: { canPublish: boolean; canPublishSources: number[] };
    let onPermissions: (previous: unknown, participant: unknown) => void;

    beforeEach(async () => {
      permissions = { canPublish: true, canPublishSources: [1] };
      (mockRoom.localParticipant as any).permissions = permissions;
      await (session as any).createRoom();
      onPermissions =
        mockRoom.on.mock.calls.find(([event]) => event === "participantPermissionsChanged")?.[1] ??
        (() => {});
      enterConnected(session);
      (session as any).syncModuleRooms();
      vi.mocked(setListenOnly).mockClear();
    });

    afterEach(() => {
      delete (mockRoom.localParticipant as any).permissions;
    });

    it("waits for the SFU grant when moderator unmute arrives on chat first", async () => {
      await (session as any).applyMicMuteState(false);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(setListenOnly).not.toHaveBeenCalled();

      permissions.canPublishSources = [1, 2];
      onPermissions(undefined, mockRoom.localParticipant);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it.each(["localMuted", "localDeafened", "localServerMuted"] as const)(
      "does not restore a pending microphone over %s",
      async (gate) => {
        await (session as any).applyMicMuteState(false);
        mockRoom.localParticipant.setMicrophoneEnabled.mockClear();
        mockVoiceState[gate] = true;
        permissions.canPublishSources = [1, 2];
        onPermissions(undefined, mockRoom.localParticipant);
        await vi.advanceTimersByTimeAsync(0);
        expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
      },
    );

    it("restores a pending microphone with pttGated set (PTT no longer gates via mute)", async () => {
      await (session as any).applyMicMuteState(false);
      mockRoom.localParticipant.setMicrophoneEnabled.mockClear();
      mockVoiceState.pttGated = true;
      permissions.canPublishSources = [1, 2];
      onPermissions(undefined, mockRoom.localParticipant);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("does not capture on unrelated permission events or after leaving", async () => {
      permissions.canPublishSources = [1, 2];
      onPermissions(undefined, mockRoom.localParticipant);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();

      permissions.canPublishSources = [1];
      await (session as any).applyMicMuteState(false);
      session.leaveVoice(false);
      permissions.canPublishSources = [1, 2];
      onPermissions(undefined, mockRoom.localParticipant);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });
  });

  // WP 1C-8: a permission removed mid-call narrows the SFU grant; the camera or
  // share it no longer allows is turned off here and the server is told.
  describe("media the grant no longer allows", () => {
    let permissions: { canPublish: boolean; canPublishSources: number[] };
    let onPermissions: (previous: unknown, participant: unknown) => void;
    let ws: { send: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      permissions = { canPublish: true, canPublishSources: [] };
      (mockRoom.localParticipant as any).permissions = permissions;
      ws = { send: vi.fn() };
      session.setWsClient(ws as any);
      await (session as any).createRoom();
      onPermissions =
        mockRoom.on.mock.calls.find(([event]) => event === "participantPermissionsChanged")?.[1] ??
        (() => {});
      enterConnected(session);
      mockVoiceState.localCamera = true;
      mockVoiceState.localScreenshare = true;
    });

    afterEach(() => {
      delete (mockRoom.localParticipant as any).permissions;
      mockVoiceState.localCamera = false;
      mockVoiceState.localScreenshare = false;
    });

    it("turns the camera off when the grant drops it, and leaves the share", async () => {
      permissions.canPublishSources = [2, 3, 4];
      onPermissions(undefined, mockRoom.localParticipant);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_camera", payload: { enabled: false } });
      expect(ws.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_screenshare" }),
      );
    });

    it("stops the share when the grant drops it", async () => {
      permissions.canPublishSources = [1, 2];
      onPermissions(undefined, mockRoom.localParticipant);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      });
      expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_camera" }));
    });

    it("leaves media alone while the grant still allows it, or when it is already off", async () => {
      onPermissions(undefined, mockRoom.localParticipant);
      mockVoiceState.localCamera = false;
      mockVoiceState.localScreenshare = false;
      permissions.canPublishSources = [2];
      onPermissions(undefined, mockRoom.localParticipant);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe("voice_watch", () => {
    const watchFrames = (ws: { send: ReturnType<typeof vi.fn> }) =>
      ws.send.mock.calls.filter(([m]) => m.type === "voice_watch").map(([m]) => m.payload.user_ids);

    it("sends the watched screen-share set when it changes, in a channel", () => {
      const ws = { send: vi.fn(), getState: () => "connected", ping: async () => {} } as any;
      session.setWsClient(ws);
      (session as any)._remoteTracks.watch(9, "screenshare", true);
      (session as any)._remoteTracks.watch(4, "screenshare", true);
      (session as any)._remoteTracks.watch(9, "screenshare", false);
      expect(watchFrames(ws)).toEqual([[9], [4, 9], [4]]);
    });

    it("sends nothing for a camera, or when the socket is down or no channel is joined", () => {
      const ws = { send: vi.fn(), getState: () => "connected", ping: async () => {} } as any;
      session.setWsClient(ws);
      (session as any)._remoteTracks.watch(9, "camera", true);
      expect(watchFrames(ws)).toEqual([]);
      const down = { send: vi.fn(), getState: () => "reconnecting" } as any;
      session.setWsClient(down);
      (session as any)._remoteTracks.watch(9, "screenshare", true);
      expect(watchFrames(down)).toEqual([]);
      session.setWsClient(ws);
      mockVoiceState.currentChannelId = null as any;
      (session as any)._remoteTracks.watch(8, "screenshare", true);
      expect(watchFrames(ws)).toEqual([]);
    });

    it("sends nothing when leaving clears the set (the server clears on leave)", () => {
      const ws = { send: vi.fn(), getState: () => "connected", ping: async () => {} } as any;
      session.setWsClient(ws);
      (session as any)._remoteTracks.watch(9, "screenshare", true);
      ws.send.mockClear();
      session.leaveVoice(true);
      expect(watchFrames(ws)).toEqual([]);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    });

    it("re-sends the current set on a resume, an empty one included", () => {
      const ws = { send: vi.fn(), getState: () => "connected", ping: async () => {} } as any;
      session.setWsClient(ws);
      // The server keeps the old set across a resume, so empty must be said.
      session.resendWatching();
      expect(watchFrames(ws)).toEqual([[]]);
      (session as any)._remoteTracks.watch(9, "screenshare", true);
      ws.send.mockClear();
      session.resendWatching();
      expect(watchFrames(ws)).toEqual([[9]]);
    });

    it("retries once after a second when rate limited, and leaving cancels it", () => {
      vi.useFakeTimers();
      const ws = { send: vi.fn(), getState: () => "connected", ping: async () => {} } as any;
      session.setWsClient(ws);
      session.retryWatching();
      session.retryWatching();
      expect(watchFrames(ws)).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(watchFrames(ws)).toEqual([[]]);
      session.retryWatching();
      session.leaveVoice(false);
      vi.advanceTimersByTime(2000);
      expect(watchFrames(ws)).toEqual([[]]);
    });

    it("an error reply to a voice_watch is recognised and dropped", () => {
      const ws = {
        send: vi.fn(() => "env-1"),
        getState: () => "connected",
        ping: async () => {},
      } as any;
      session.setWsClient(ws);
      (session as any)._remoteTracks.watch(9, "screenshare", true);
      expect(takeWatchRefusal("env-1")).toBe(true);
    });
  });

  describe("restoreLocalVoiceState PTT gating (v007)", () => {
    afterEach(() => {
      // setPttPollingLive is a module-level flag shared across tests.
      setPttPollingLive(false);
      stubPrefs();
    });

    it("publishes the mic and closes the pipeline's PTT gate at join when a PTT key is bound and the poller is confirmed live", async () => {
      stubPrefs({ pttVk: 0x41 });
      setPttPollingLive(true);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      const gateSpy = vi.spyOn((session as any)._audioPipeline, "setPttGated");

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      // PTT no longer rides mute: the mic is published, the gate is closed.
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(false);
      expect(gateSpy).toHaveBeenCalledWith(true);
      expect(setPttGated).toHaveBeenCalledWith(true);
      // The gate must NOT be recorded as a self-mute.
      expect(setLocalMuted).not.toHaveBeenCalledWith(true);
    });

    // Gating on the stored key alone (without confirming the poller is
    // actually live) would close the mic permanently on macOS (is_key_down
    // stub always returns false) and pure-Wayland Linux (DeviceState::
    // checked_new() returns None) — neither platform can ever emit a
    // ptt-state event to lift the mute.
    it("does not mute at join when a PTT key is bound but the poller is not confirmed live", async () => {
      stubPrefs({ pttVk: 0x41 });
      // setPttPollingLive intentionally not called — defaults to false.
      await joinSession(session, "token");

      expect(setLocalMuted).not.toHaveBeenCalledWith(true);
      expect(setPttGated).toHaveBeenCalledWith(false);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("re-runs the sensitivity gate whenever the PTT poller goes live or stops", () => {
      expect(pttPollingListeners).toHaveLength(1);
      const listener = pttPollingListeners[0]!;
      // The listener drives the app's session, not this test's instance.
      const applySpy = vi.spyOn(
        Object.getPrototypeOf((session as any)._audioPipeline),
        "applyInputMode",
      );

      listener();

      expect(applySpy).toHaveBeenCalledTimes(1);
      applySpy.mockRestore();
    });

    it("does not close the gate at join for a key bound in Voice Activity mode", async () => {
      stubPrefs({ pttVk: 0x41, inputMode: "vad" });
      setPttPollingLive(true);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      const gateSpy = vi.spyOn((session as any)._audioPipeline, "setPttGated");

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      expect(gateSpy).toHaveBeenCalledWith(false);
      expect(gateSpy).not.toHaveBeenCalledWith(true);
      expect(setPttGated).toHaveBeenCalledWith(false);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("closes the gate at join when the talk button is the trigger, with no key bound", async () => {
      stubPrefs({ inputMode: "ptt" });
      setTalkButton(true);
      setPttPollingLive(true);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      const gateSpy = vi.spyOn((session as any)._audioPipeline, "setPttGated");

      try {
        await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);
      } finally {
        setTalkButton(false);
      }

      expect(gateSpy).toHaveBeenCalledWith(true);
      expect(setPttGated).toHaveBeenCalledWith(true);
      expect(setLocalMuted).not.toHaveBeenCalledWith(true);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("does not close the gate at join for the talk button in Voice Activity mode", async () => {
      stubPrefs({ inputMode: "vad" });
      setTalkButton(true);
      setPttPollingLive(true);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      try {
        await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);
      } finally {
        setTalkButton(false);
      }

      expect(setPttGated).toHaveBeenCalledWith(false);
      expect(setPttGated).not.toHaveBeenCalledWith(true);
    });

    it("does not mute at join when the poller is live but no PTT key is bound", async () => {
      setPttPollingLive(true); // pttVk defaults to 0 (disabled) via mockLoadPref
      await joinSession(session, "token");

      expect(setLocalMuted).not.toHaveBeenCalledWith(true);
      expect(setPttGated).toHaveBeenCalledWith(false);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
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
      // The timer moved onto VoiceTokenManager; leaveVoice must still clear it
      // through clearTimers(), or a token refresh fires against a session the
      // user has already left.
      const tokenManager = (session as any)._tokenManager;
      tokenManager._refreshTimer = setTimeout(() => {
        throw new Error("Timer should have been cleared");
      }, 100);

      session.leaveVoice(false);

      expect(tokenManager._refreshTimer).toBeNull();
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

    it("detaches the app's room listeners before disconnect when room exists", async () => {
      // Set up a room via handleVoiceToken
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);

      expect((session as any)._state.type).toBe("connected");

      const onDisconnected = mockRoom.on.mock.calls.findLast(([e]) => e === "disconnected")![1];
      session.leaveVoice(false);

      // Only the app's own listeners: livekit's once(Disconnected) cleanups
      // must still run when disconnect() fires the event.
      expect(mockRoom.off).toHaveBeenCalledWith("disconnected", onDisconnected);
      expect(mockRoom.off.mock.invocationCallOrder.at(-1)).toBeLessThan(
        mockRoom.disconnect.mock.invocationCallOrder.at(-1)!,
      );
    });

    it("sets currentChannelId to null after leave", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      mockVoiceState.currentChannelId = 5;
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

    it("nulls the LiveKit proxy port", async () => {
      // The port moved with the rest of proxy handling, onto LiveKitUrlResolver
      // and then (B7-5) into platform/desktop's nativeProxies; cleanupAll must
      // still clear it, or a logout leaves a port recorded for a proxy that is
      // no longer running.
      session.setServerHost("example.com:443");
      await (session as any)._urlResolver.resolve("/livekit");
      expect(getLiveKitProxyPort()).toBe(7881);

      session.cleanupAll();

      expect(getLiveKitProxyPort()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: setMuted / setDeafened with active room
  // -----------------------------------------------------------------------

  describe("setMuted (with active room)", () => {
    beforeEach(async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({
        send: vi.fn(),
        getState: () => "connected",
        ping: async () => {},
      } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();
    });

    it("muting calls setMicrophoneEnabled(false) on the room", async () => {
      session.setMuted(true);
      // applyMicMuteState is async fire-and-forget, flush microtasks
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    it("unmuting calls setMicrophoneEnabled(true) and does not tear down or rebuild the pipeline", async () => {
      const setupSpy = vi.spyOn((session as any)._audioPipeline, "setupAudioPipeline");
      const teardownSpy = vi.spyOn((session as any)._audioPipeline, "teardownAudioPipeline");

      session.setMuted(true);
      await vi.advanceTimersByTimeAsync(0);
      session.setMuted(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      // The processor stays on the track across mute/unmute.
      expect(setupSpy).not.toHaveBeenCalled();
      expect(teardownSpy).not.toHaveBeenCalled();
      setupSpy.mockRestore();
      teardownSpy.mockRestore();
    });

    it("setPttGated records the store flag and forwards to the pipeline gate", () => {
      const gateSpy = vi.spyOn((session as any)._audioPipeline, "setPttGated");

      session.setPttGated(false);
      session.setPttGated(true);

      expect(setPttGated).toHaveBeenNthCalledWith(1, false);
      expect(setPttGated).toHaveBeenNthCalledWith(2, true);
      expect(gateSpy).toHaveBeenNthCalledWith(1, false);
      expect(gateSpy).toHaveBeenNthCalledWith(2, true);
      // Never a mute: PTT does not touch setMicrophoneEnabled.
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
      gateSpy.mockRestore();
    });

    // A moderator's server-mute must not be liftable by the client. The server
    // only mutes track SIDs that exist at mute time and the LiveKit grant still
    // carries the microphone publish source, so re-publishing a fresh track
    // (which unmuting does) is accepted by the SFU: the refusal has to happen
    // here, in the one entry point every caller shares. PTT reaches this
    // directly, bypassing the widget's own guard.
    it("refuses to unmute while server-muted, but still allows muting", async () => {
      mockVoiceState.localServerMuted = true;
      try {
        session.setMuted(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
        expect(setLocalMuted).not.toHaveBeenCalledWith(false);

        // Muting is always allowed — a server-muted user may still mute themselves.
        session.setMuted(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
      } finally {
        mockVoiceState.localServerMuted = false;
      }
    });

    // OC-0287: applyMicMuteState's re-enable branch used to await
    // setMicrophoneEnabled(true) with no try/catch. Every caller (setMuted,
    // setDeafened, ptt.ts) fires it forgetfully with only a `.catch(e =>
    // log.warn(...))`, so a rejection (mic revoked/unplugged) never reached
    // setListenOnly/setLocalMuted or onErrorCallback — yet setLocalMuted(false)
    // and the outbound voice_mute{muted:false} frame had already gone out.
    // The user was left reporting "unmuted" everywhere while publishing no
    // audio, with no error and no Grant-Microphone affordance (that button is
    // gated on listenOnly, which stayed false). This pins the fix: a failed
    // re-enable must flip back into listen-only + muted and surface an error.
    it("unmuting when the mic cannot be acquired enters listen-only, re-mutes, and reports an error", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      const domErr = new DOMException("Permission denied", "NotAllowedError");
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(domErr);

      session.setMuted(false);
      await vi.advanceTimersByTimeAsync(0);

      // Must not silently swallow the failure: listen-only mode has to come
      // back on (this is what reveals the existing Grant Microphone button)
      // and the local mute flag has to reflect that no audio is publishing.
      expect(setListenOnly).toHaveBeenCalledWith(true);
      expect(setLocalMuted).toHaveBeenCalledWith(true);
      expect(errorCb).toHaveBeenCalled();
      expect(errorCb.mock.calls[0]?.[0]).toEqual(expect.stringMatching(/microphone/i));
    });

    // The toggle sent voice_mute{muted:false} before the re-enable failed, so
    // the fallback has to restate the mute or peers keep seeing it unmuted.
    it("a failed unmute tells the server the member is muted again", async () => {
      const ws = { send: vi.fn(), getState: () => "connected", ping: async () => {} };
      session.setWsClient(ws as any);
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(
        new DOMException("Permission denied", "NotAllowedError"),
      );

      session.setMuted(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    });

    it("a failed unmute sends nothing while the chat socket is down", async () => {
      const ws = { send: vi.fn(), getState: () => "reconnecting" };
      session.setWsClient(ws as any);
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(
        new DOMException("Permission denied", "NotAllowedError"),
      );

      session.setMuted(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(setLocalMuted).toHaveBeenCalledWith(true);
      expect(ws.send).not.toHaveBeenCalled();
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

    // v028: mirrors setMuted's server-mute guard. Without it, a moderator
    // deafen followed by a moderator "server unmute" leaves
    // (localServerDeafened=true, localServerMuted=false) reachable, and a
    // client-side undeafen click would resubscribe remote audio and unmute
    // the mic even though the server still considers the user deafened.
    it("refuses to undeafen while server-deafened, but still allows deafening", async () => {
      mockVoiceState.localServerDeafened = true;
      try {
        session.setDeafened(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(setLocalDeafened).not.toHaveBeenCalledWith(false);
        expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);

        // Deafening is always allowed — a server-deafened user may still deafen themselves.
        session.setDeafened(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(setLocalDeafened).toHaveBeenCalledWith(true);
      } finally {
        mockVoiceState.localServerDeafened = false;
      }
    });

    // Rewritten (was B1_voice_mic-6): PTT no longer unpublishes the mic, so
    // undeafening with the gate closed republishes normally; the processor
    // gate, not mute, keeps it silent until the first press.
    it("undeafening while the push-to-talk gate is closed still re-enables the mic", async () => {
      mockVoiceState.pttGated = true;

      try {
        session.setDeafened(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(setLocalDeafened).toHaveBeenCalledWith(false);
        expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      } finally {
        mockVoiceState.pttGated = false;
      }
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

    it("does not rebuild the audio pipeline on success (the processor attaches at track creation)", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();

      const setupSpy = vi.spyOn((session as any)._audioPipeline, "setupAudioPipeline");

      await session.retryMicPermission();

      expect(setupSpy).not.toHaveBeenCalled();
      setupSpy.mockRestore();
    });

    // Same root cause as the PTT server-mute guard: a listen-only join
    // publishes no audio track, so a moderator's server-mute persists but has
    // nothing to act on at the SFU. Clicking "Grant Microphone" must not
    // publish a fresh, unmuted track the whole channel can hear.
    it("keeps the mic muted when server-muted, mirroring the deafened branch", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();
      mockVoiceState.localServerMuted = true;

      try {
        await session.retryMicPermission();

        expect(setListenOnly).toHaveBeenCalledWith(false);
        // applyMicMuteState(true) re-disables the mic it just enabled.
        expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
        expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
        expect(setLocalMuted).not.toHaveBeenCalledWith(false);
      } finally {
        mockVoiceState.localServerMuted = false;
      }
    });

    // B1_voice_mic-5: a listen-only user who self-muted before losing mic
    // access must not come back live just because they regained the device.
    it("keeps the mic muted when the user self-muted before going listen-only", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
      vi.clearAllMocks();
      mockVoiceState.localMuted = true;

      try {
        await session.retryMicPermission();

        expect(setListenOnly).toHaveBeenCalledWith(false);
        // applyMicMuteState(true) re-disables the mic it just enabled — the
        // user's own mute must survive regaining mic access.
        expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
        expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
        expect(setLocalMuted).not.toHaveBeenCalledWith(false);
      } finally {
        mockVoiceState.localMuted = false;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Mutant-killing tests: restoreLocalVoiceState
  // -----------------------------------------------------------------------

  describe("restoreLocalVoiceState", () => {
    beforeEach(async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({
        send: vi.fn(),
        getState: () => "connected",
        ping: async () => {},
      } as any);
    });

    it("enables the microphone on the first unmute after a muted join", async () => {
      mockVoiceState.localMuted = true;
      try {
        await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
        expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);

        mockVoiceState.localMuted = false;
        session.setMuted(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      } finally {
        mockVoiceState.localMuted = false;
      }
    });

    it("mode reconnect with mic error logs warn but does NOT call error callback", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      mockVoiceState.localMuted = false;
      mockVoiceState.localDeafened = false;
      mockVoiceState.currentChannelId = 7;

      await session.handleVoiceToken("tok", "/lk", 7, "ws://localhost:7880", true);
      vi.clearAllMocks();

      // Session is already in "connected" state with channelId=7 after handleVoiceToken
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error("mic gone"));

      const ac = new AbortController();
      await runReconnect(session, 7, { url: "/lk", signal: ac.signal });

      // On reconnect mic failure, error callback should NOT be called
      expect(errorCb).not.toHaveBeenCalledWith(
        expect.stringContaining("Microphone permission denied"),
      );
      expect(errorCb).not.toHaveBeenCalledWith(expect.stringContaining("Microphone unavailable"));
    });

    // B1_voice_mic-4: mode "reconnect" must read the PTT gate the store is
    // still carrying from before the disconnect instead of recomputing
    // pttArmed from scratch (which is always false for mode !== "join") —
    // otherwise a reconnect during the "joined with PTT armed, key never
    // pressed yet" window republishes a hot mic.
    it("mode reconnect republishes the mic and re-closes the pipeline's PTT gate when pttGated survived from before the disconnect", async () => {
      const gateSpy = vi.spyOn((session as any)._audioPipeline, "setPttGated");
      mockVoiceState.localMuted = false;
      mockVoiceState.localDeafened = false;
      mockVoiceState.pttGated = true;

      // Mirrors the real caller (handleDisconnected via setReconnectAc),
      // which always sets "reconnecting" before starting this loop.
      enterReconnecting(session, 7, { latestToken: "token", lastUrl: "/lk" });

      const ac = new AbortController();
      await runReconnect(session, 7, { url: "/lk", signal: ac.signal });

      expect(gateSpy).toHaveBeenCalledWith(true);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(false);
      gateSpy.mockRestore();
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

  describe("restoreLocalVoiceState supersession guard", () => {
    it("does not apply a stale mute decision to a newer session's room", async () => {
      mockVoiceState.localMuted = true;
      mockVoiceState.localDeafened = false;

      let resolveMic!: () => void;
      const roomA = {
        localParticipant: {
          setMicrophoneEnabled: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                resolveMic = resolve;
              }),
          ),
        },
        off: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as any;
      const roomB = {
        localParticipant: {
          setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
        },
        off: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as any;

      (session as any)._state = {
        type: "connected",
        room: roomA,
        channelId: 1,
        latestToken: "token-a",
        lastUrl: "/livekit",
        lastDirectUrl: undefined,
      };

      const restoring = (session as any).restoreLocalVoiceState("join");

      await vi.advanceTimersByTimeAsync(0);
      expect(roomA.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);

      // A newer session takes over with a DIFFERENT room (e.g. the user
      // switched channels while channel A's mic-permission call was pending).
      (session as any)._state = {
        type: "connected",
        room: roomB,
        channelId: 2,
        latestToken: "token-b",
        lastUrl: "/livekit",
        lastDirectUrl: undefined,
      };

      resolveMic();
      await restoring;

      // Channel A's stale muted=true decision must not touch room B — that
      // is exactly what applyMicMuteState(true) would do by re-reading
      // `this._room` fresh instead of the room this call captured.
      expect(roomB.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });
  });
});
