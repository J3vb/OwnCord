import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import { LiveKitSession } from "../../../src/lib/voice/livekitSession";
import { leaveVoiceChannel, setVoiceStatus } from "@stores/voice.store";
import { channelsStore, resetChannelsStore } from "@stores/channels.store";
import { takeJoinRefusal } from "../../../src/features/voice/joinRequest";
import {
  useLiveKitSessionHarness,
  enterReconnecting,
  startReconnect,
  enterConnected,
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

const { mockVoiceState, mockRoom } = mocks;

describe("LiveKitSession", () => {
  let session: LiveKitSession;

  useLiveKitSessionHarness({
    wired: (s) => {
      session = s;
    },
    currentSession: () => session,
  });

  // P2-T5 / DP-39: after the five fast attempts the loop keeps retrying every
  // 15 s while the chat socket is up and the channel exists, until the D-4
  // five-minute ceiling — an SFU restart or a long Wi-Fi drop resumes the
  // call instead of ejecting the user after about 27 s.
  describe("attemptAutoReconnect slow phase", () => {
    let wsState: string;
    let sendSpy: ReturnType<typeof vi.fn<(msg: { type: string }) => string | undefined>>;
    let errorCb: ReturnType<typeof vi.fn<(message: string) => void>>;
    let ac: AbortController;

    beforeEach(() => {
      wsState = "connected";
      sendSpy = vi.fn<(msg: { type: string }) => string | undefined>();
      errorCb = vi.fn<(message: string) => void>();
      ac = new AbortController();
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: sendSpy, getState: () => wsState, ping: async () => {} } as any);
      session.setOnError(errorCb);
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([[5, { id: 5, type: "voice" } as any]]),
      }));
      // Through setState so the session stamps when this token arrived.
      (session as any).setState({
        type: "reconnecting",
        channelId: 5,
        latestToken: "old-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac,
      });
    });

    afterEach(() => {
      resetChannelsStore();
    });

    function startLoop(): Promise<void> {
      return (session as any).attemptAutoReconnect(
        "old-token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );
    }

    it("keeps retrying after five failed connects and resumes on attempt 7", async () => {
      const leaveVoiceSpy = vi.spyOn(session, "leaveVoice");
      let connects = 0;
      mockRoom.connect.mockImplementation(async () => {
        connects++;
        if (connects < 7) throw new Error("SFU down");
      });

      const loop = startLoop();
      // 27 s of fast attempts, then 15 s gaps: attempt 7 lands at about 57 s.
      await vi.advanceTimersByTimeAsync(60_000);
      await loop;

      expect(connects).toBe(7);
      expect(leaveVoiceSpy).not.toHaveBeenCalled();
      expect(leaveVoiceChannel).not.toHaveBeenCalled();
      expect((session as any)._state.type).toBe("connected");
      expect(setVoiceStatus).toHaveBeenLastCalledWith("connected");
    });

    it("refreshes the token before an attempt more than 4 minutes after the last one", async () => {
      // The server answers voice_token_refresh with an ordinary voice_token
      // for the channel we are still reconnecting to.
      sendSpy.mockImplementation((msg: { type: string }) => {
        if (msg.type === "voice_token_refresh") {
          queueMicrotask(() => {
            void session.handleVoiceToken("fresh-token", "/livekit", 5, "ws://localhost:7880");
          });
        }
      });
      const tokensAfterFourMinutes: string[] = [];
      const start = Date.now();
      mockRoom.connect.mockImplementation(async (_url: string, token: string) => {
        if (Date.now() - start > 4 * 60_000) tokensAfterFourMinutes.push(token);
        if (token !== "fresh-token") throw new Error("SFU down");
      });

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
      await loop;

      expect(sendSpy).toHaveBeenCalledWith({ type: "voice_token_refresh", payload: {} });
      expect(tokensAfterFourMinutes.length).toBeGreaterThan(0);
      expect(tokensAfterFourMinutes).not.toContain("old-token");
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.latestToken).toBe("fresh-token");
    });

    it("stops with no further connects when the user leaves during the slow phase", async () => {
      mockRoom.connect.mockRejectedValue(new Error("SFU down"));

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(45_000); // attempt 6 (42 s) has failed
      const connectsBeforeLeave = mockRoom.connect.mock.calls.length;
      expect(connectsBeforeLeave).toBe(6);

      session.leaveVoice(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await loop;

      expect(mockRoom.connect).toHaveBeenCalledTimes(connectsBeforeLeave);
      expect(errorCb).not.toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
    });

    it("ends the loop when the chat socket closes for good", async () => {
      mockRoom.connect.mockRejectedValue(new Error("SFU down"));

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(30_000); // the five fast attempts have failed
      wsState = "disconnected";
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await loop;

      expect(mockRoom.connect).toHaveBeenCalledTimes(5);
      expect(leaveVoiceChannel).toHaveBeenCalled();
      expect((session as any)._state.type).toBe("idle");
      expect(sendSpy.mock.calls.filter(([m]) => m.type === "voice_leave")).toHaveLength(0);
    });

    it("resumes through the loop when the chat socket returns inside the server's grace window", async () => {
      const leaveVoiceSpy = vi.spyOn(session, "leaveVoice");
      mockRoom.connect.mockImplementation(async () => {
        if (wsState !== "connected") throw new Error("network down");
      });

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(1_000);
      wsState = "reconnecting"; // the Wi-Fi drop takes the chat socket down too
      await vi.advanceTimersByTimeAsync(9_000);
      wsState = "connected"; // RT-8: the resume inherits the parked membership
      // Attempts at 3 and 9 s wait out the socket; the one at 15 s resumes.
      await vi.advanceTimersByTimeAsync(6_000);
      await loop;

      expect(mockRoom.connect).toHaveBeenCalledTimes(1);
      expect(leaveVoiceSpy).not.toHaveBeenCalled();
      expect(sendSpy.mock.calls.some(([m]) => m.type === "voice_join")).toBe(false);
      expect((session as any)._state.type).toBe("connected");
    });

    it("rejoins with voice_join when the server released the membership during a long drop", async () => {
      sendSpy.mockImplementation((msg) => (msg.type === "voice_join" ? "rejoin-1" : undefined));
      // The media path is back before the chat socket, and the stale roster
      // still lists us: nothing can tell yet whether the server kept the
      // membership, so the loop must not connect on the old token.
      mockRoom.connect.mockResolvedValue(undefined);

      (session as any)._remoteTracks.watch(7, "screenshare", true);
      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(1_000);
      wsState = "reconnecting";
      await vi.advanceTimersByTimeAsync(90_000);
      // The socket resumes past the RT-8 grace window: the replayed self
      // voice_leave (or a full ready) no longer lists us in the channel.
      wsState = "connected";
      mockVoiceState.voiceUsers = new Map();
      await vi.advanceTimersByTimeAsync(15_000);
      await loop;

      expect((session as any)._remoteTracks.isWatched(7, "screenshare")).toBe(true);
      // Never connects on the old token with no membership behind it.
      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledWith({ type: "voice_join", payload: { channel_id: 5 } });
      expect(sendSpy.mock.calls.some(([m]) => m.type === "voice_leave")).toBe(false);
      // The rejoin's own refusal is the one that may end it.
      expect(takeJoinRefusal("FORBIDDEN", "rejoin-1")).toBe(true);
      expect(errorCb).not.toHaveBeenCalled();
      expect(leaveVoiceChannel).not.toHaveBeenCalled();
      expect(setVoiceStatus).toHaveBeenLastCalledWith("joining");

      // The server answers the join and the ordinary join path resumes the call.
      mockVoiceState.currentChannelId = 5;
      await session.handleVoiceToken("rejoin-token", "/livekit", 5, "ws://localhost:7880", true);

      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.latestToken).toBe("rejoin-token");
      expect(leaveVoiceChannel).not.toHaveBeenCalled();
      // The answered rejoin is no longer pending: a later, unrelated refusal
      // is not reported as a lost call.
      session.failPendingRejoin();
      expect(errorCb).not.toHaveBeenCalled();
    });

    it("reads the roster only after the returned socket's replay, not from its auth_ok", async () => {
      sendSpy.mockImplementation((msg) => (msg.type === "voice_join" ? "rejoin-1" : undefined));
      mockRoom.connect.mockResolvedValue(undefined);
      // auth_ok has flipped the socket to "connected", but the roster still
      // lists us from before the drop. The server writes the replayed self
      // voice_leave before it answers a ping.
      mockVoiceState.voiceUsers = new Map([[5, new Set([0])]]);
      const ping = vi.fn(async () => {
        mockVoiceState.voiceUsers = new Map();
      });
      session.setWsClient({ send: sendSpy, getState: () => wsState, ping } as any);

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(1_000);
      wsState = "reconnecting";
      await vi.advanceTimersByTimeAsync(90_000);
      wsState = "connected";
      await vi.advanceTimersByTimeAsync(15_000);
      await loop;

      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledWith({ type: "voice_join", payload: { channel_id: 5 } });
      expect(ping).toHaveBeenCalled();
    });

    it("waits for the next attempt when the returned socket does not answer the ping", async () => {
      mockRoom.connect.mockResolvedValue(undefined);
      mockVoiceState.voiceUsers = new Map([[5, new Set([0])]]);
      const ping = vi.fn(async () => {
        throw new Error("No heartbeat response arrived.");
      });
      session.setWsClient({ send: sendSpy, getState: () => wsState, ping } as any);

      void startLoop();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect(ping).toHaveBeenCalled();
      expect(sendSpy.mock.calls.some(([m]) => m.type === "voice_join")).toBe(false);
      ac.abort();
      await vi.advanceTimersByTimeAsync(20_000);
    });

    it("turns the camera back on once a rejoin after a long drop connects", async () => {
      const enableCamera = vi.spyOn(session, "enableCamera").mockResolvedValue();
      mockVoiceState.localCamera = false;
      (session as any)._lostOnReconnect = { camera: true, screenshare: false };
      mockRoom.connect.mockResolvedValue(undefined);
      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(1_000);
      wsState = "reconnecting";
      await vi.advanceTimersByTimeAsync(90_000);
      wsState = "connected";
      mockVoiceState.voiceUsers = new Map();
      await vi.advanceTimersByTimeAsync(15_000);
      await loop;
      expect(enableCamera).not.toHaveBeenCalled();

      mockVoiceState.currentChannelId = 5;
      await session.handleVoiceToken("rejoin-token", "/livekit", 5, "ws://localhost:7880", true);
      await vi.advanceTimersByTimeAsync(0);

      expect((session as any)._state.type).toBe("connected");
      expect(enableCamera).toHaveBeenCalledOnce();
    });

    it("ends the call without retrying when the server refuses the rejoin after a kick", async () => {
      mockRoom.connect.mockRejectedValue(new Error("network down"));

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(1_000);
      wsState = "reconnecting";
      await vi.advanceTimersByTimeAsync(40_000);
      // A moderator kicked the reconnecting user: its voice_leave replays when
      // the socket resumes, and its voice_disconnected was lost with the socket.
      wsState = "connected";
      mockVoiceState.voiceUsers = new Map();
      await vi.advanceTimersByTimeAsync(15_000);
      await loop;
      const joins = () => sendSpy.mock.calls.filter(([m]) => m.type === "voice_join").length;
      expect(joins()).toBe(1);

      // The server refuses the rejoin; the dispatcher's join rollback reports it.
      session.failPendingRejoin();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(errorCb).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      expect(joins()).toBe(1);
      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect((session as any)._state.type).toBe("idle");
    });

    it("gives up instead of rejoining when the channel is deleted during the fast attempts", async () => {
      mockRoom.connect.mockRejectedValue(new Error("SFU down"));

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(1_000);
      // The deletion evicts us (a self voice_leave), then removes the channel.
      mockVoiceState.voiceUsers = new Map();
      resetChannelsStore();
      await vi.advanceTimersByTimeAsync(5_000);
      await loop;

      expect(sendSpy.mock.calls.some(([m]) => m.type === "voice_join")).toBe(false);
      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect(leaveVoiceChannel).toHaveBeenCalled();
      expect(errorCb).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      expect((session as any)._state.type).toBe("idle");
    });

    it("gives up at the ceiling without sending while the chat socket is still reconnecting", async () => {
      const leaveVoiceSpy = vi.spyOn(session, "leaveVoice");
      mockRoom.connect.mockRejectedValue(new Error("network down"));

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(1_000);
      wsState = "reconnecting";
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
      await loop;

      expect(leaveVoiceSpy).toHaveBeenCalledWith(false);
      expect(errorCb).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      expect((session as any)._state.type).toBe("idle");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("ends the loop when the channel is deleted", async () => {
      mockRoom.connect.mockRejectedValue(new Error("SFU down"));

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(30_000);
      resetChannelsStore();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await loop;

      expect(mockRoom.connect).toHaveBeenCalledTimes(5);
      expect(leaveVoiceChannel).toHaveBeenCalled();
      expect((session as any)._state.type).toBe("idle");
    });

    it("gives up with the voice-lost toast once the ceiling passes", async () => {
      const leaveVoiceSpy = vi.spyOn(session, "leaveVoice");
      mockRoom.connect.mockRejectedValue(new Error("SFU down"));

      const loop = startLoop();
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
      expect(leaveVoiceSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await loop;

      expect(leaveVoiceSpy).toHaveBeenCalledWith(true);
      expect(leaveVoiceChannel).toHaveBeenCalled();
      expect(errorCb).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      expect((session as any)._state.type).toBe("idle");
      expect(sendSpy.mock.calls.filter(([m]) => m.type === "voice_leave")).toHaveLength(1);
    });
  });

  describe("attemptAutoReconnect tail supersession guard", () => {
    // reconnectSuperseded() is only checked up through room.connect(); once
    // the success branch sets state to "connected" it stops being usable
    // (state is legitimately no longer "reconnecting" for a still-current
    // attempt too). The tail must instead recheck via isStateConnected(),
    // the same helper connectAndSetup's post-connect checkpoints use.
    it("does not touch a newer session's timer or send a stale token refresh when superseded mid-tail", async () => {
      enterReconnecting(session, 5);
      session.setServerHost("localhost:7880");
      const sendSpy = vi.fn();
      session.setWsClient({
        send: sendSpy,
        getState: () => "connected",
        ping: async () => {},
      } as any);

      let resolveMic!: () => void;
      mockRoom.localParticipant.setMicrophoneEnabled.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveMic = resolve;
          }),
      );
      const startTimerSpy = vi.spyOn(session as any, "startTokenRefreshTimer");

      const ac = new AbortController();
      const reconnectPromise = startReconnect(session, 5, { signal: ac.signal });

      // Pass the reconnect delay and let the attempt reach "connected" for
      // channel 5, where it stalls inside restoreLocalVoiceState's mic-permission await.
      await vi.advanceTimersByTimeAsync(3100);
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.channelId).toBe(5);

      // A newer join supersedes it: the user switched to channel 9 while
      // channel 5's reconnect tail was still stalled.
      enterConnected(session, 9, { latestToken: "token-9", lastDirectUrl: "ws://localhost:7880" });
      sendSpy.mockClear();

      resolveMic();
      await reconnectPromise;

      // The stale channel-5 tail must not re-arm the shared timer or send a
      // token-refresh request against channel 9's live session.
      expect(startTimerSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalledWith({ type: "voice_token_refresh", payload: {} });

      startTimerSpy.mockRestore();
    });
  });
});
