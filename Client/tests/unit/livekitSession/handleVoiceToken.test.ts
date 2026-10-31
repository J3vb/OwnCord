import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import { LiveKitSession } from "../../../src/lib/voice/livekitSession";
import {
  setLocalMuted,
  setListenOnly,
  leaveVoiceChannel,
  setVoiceStatus,
} from "@stores/voice.store";
import {
  createDeferred,
  useLiveKitSessionHarness,
  enterReconnecting,
  runReconnect,
  joinWithWs,
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

const { mockVoiceState, mockRoom, mockInvoke } = mocks;

describe("LiveKitSession", () => {
  let session: LiveKitSession;

  useLiveKitSessionHarness({
    wired: (s) => {
      session = s;
    },
    currentSession: () => session,
  });

  describe("handleVoiceToken", () => {
    it("connects to LiveKit and sets up voice session", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.connect).toHaveBeenCalledWith("ws://localhost:7880", "test-token", {
        autoSubscribe: false,
      });
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("publishes no microphone in the AFK channel and keeps the session up", async () => {
      mockVoiceState.inAfkChannel = true;
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
      expect(mockRoom.disconnect).not.toHaveBeenCalled();
      // Not a failed microphone: no listen-only notice, nothing to retry.
      expect(setListenOnly).not.toHaveBeenCalledWith(true);
    });

    it("refuses to unmute in the AFK channel", async () => {
      mockVoiceState.inAfkChannel = true;
      mockVoiceState.localMuted = true;
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      vi.mocked(setLocalMuted).mockClear();

      session.setMuted(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(setLocalMuted).not.toHaveBeenCalled();
      expect(mockRoom.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
    });

    it("uses proxy URL for non-local hosts", async () => {
      session.setServerHost("example.com:443");
      session.setWsClient({ send: vi.fn() } as any);

      await session.handleVoiceToken("test-token", "/livekit", 1, undefined, true);

      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", {
        remoteHost: "example.com:443",
      });
      expect(mockRoom.connect).toHaveBeenCalledWith(
        "ws://127.0.0.1:7881/tun/livekit",
        "test-token",
        {
          autoSubscribe: false,
        },
      );
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
      expect(mockRoom.connect).toHaveBeenNthCalledWith(1, "ws://localhost:7881", "first-token", {
        autoSubscribe: false,
      });
      expect(mockRoom.connect).toHaveBeenNthCalledWith(2, "ws://localhost:7882", "second-token", {
        autoSubscribe: false,
      });
      expect(mockRoom.startAudio).toHaveBeenCalledTimes(1);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    });

    describe("a channel switch while a join is still connecting", () => {
      const B_PEER = 42;
      const C_PEER = 43;
      const A_PEER = 41;
      const connectedChannel = () => {
        const st = (session as any)._state;
        return st.type === "connected" ? st.channelId : st.type;
      };

      /** Start a key-holder join of channel 1 and park it inside room.connect(). */
      async function startConnectingJoinOfOne() {
        session.setServerHost("localhost:7880");
        session.setWsClient({ send: vi.fn() } as any);
        const firstConnect = createDeferred<void>();
        mockRoom.connect
          .mockImplementationOnce(() => firstConnect.promise)
          .mockResolvedValue(undefined);
        const firstJoin = session.handleVoiceToken(
          "token-1",
          "/livekit-one",
          1,
          "ws://localhost:7881",
          true,
        );
        // Flush the E2EE async steps so the join is parked inside room.connect().
        await vi.advanceTimersByTimeAsync(0);
        expect(mockRoom.connect).toHaveBeenCalledTimes(1);
        return { firstConnect, firstJoin };
      }

      it("keeps the new channel's key announcements, so its holder's offer is accepted", async () => {
        const { firstConnect, firstJoin } = await startConnectingJoinOfOne();

        // The user clicks channel 2 (not a key holder there): the server moves
        // them, sends the token, then relays channel 2's peer keys.
        mockVoiceState.currentChannelId = 2;
        await session.handleVoiceToken("token-2", "/livekit-two", 2, "ws://localhost:7882", false);
        await session.handleE2EEAnnounce(B_PEER, "cGVlcg==", "sig");

        firstConnect.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        // Channel 2's exchange is running: its holder answers our announce
        // with an offer, which is dropped unless the holder's key survived.
        await session.handleE2EEOffer(B_PEER, "enc", "iv");
        // Past the securing timeout: a dropped offer would eject the join here.
        await vi.advanceTimersByTimeAsync(20_000);
        await firstJoin;

        expect(mockRoom.connect).toHaveBeenCalledTimes(2);
        expect(mockRoom.connect).toHaveBeenNthCalledWith(2, "ws://localhost:7882", "token-2", {
          autoSubscribe: false,
        });
        expect(connectedChannel()).toBe(2);
        expect((session as any)._peerPublicKeys.has(B_PEER)).toBe(true);
      });

      it("does not apply the old channel's announcements to the new channel", async () => {
        const { firstConnect, firstJoin } = await startConnectingJoinOfOne();

        // Channel 1's own peer announces before the switch is requested.
        await session.handleE2EEAnnounce(A_PEER, "b2xkcGVlcg==", "sig");
        expect((session as any)._peerPublicKeys.has(A_PEER)).toBe(true);

        mockVoiceState.currentChannelId = 2;
        await session.handleVoiceToken("token-2", "/livekit-two", 2, "ws://localhost:7882", false);
        await session.handleE2EEAnnounce(B_PEER, "cGVlcg==", "sig");

        firstConnect.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        await session.handleE2EEOffer(B_PEER, "enc", "iv");
        // Past the securing timeout: a dropped offer would eject the join here.
        await vi.advanceTimersByTimeAsync(20_000);
        await firstJoin;

        expect(connectedChannel()).toBe(2);
        expect((session as any)._peerPublicKeys.has(B_PEER)).toBe(true);
        expect((session as any)._peerPublicKeys.has(A_PEER)).toBe(false);
      });

      it("keeps a newer queued channel's announcements when the join before it starts its exchange", async () => {
        let resolveCalls = 0;
        const parkedResolve = createDeferred<string>();
        vi.spyOn(session as any, "resolveLiveKitUrl").mockImplementation(
          async (...args: unknown[]) =>
            resolveCalls++ === 1 ? parkedResolve.promise : String(args[1] ?? args[0]),
        );
        const { firstConnect, firstJoin } = await startConnectingJoinOfOne();

        mockVoiceState.currentChannelId = 2;
        await session.handleVoiceToken("token-2", "/livekit-two", 2, "ws://localhost:7882", true);
        firstConnect.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        // Channel 2's attempt is parked in URL resolution, before its key exchange.
        expect(resolveCalls).toBe(2);

        mockVoiceState.currentChannelId = 3;
        await session.handleVoiceToken(
          "token-3",
          "/livekit-three",
          3,
          "ws://localhost:7883",
          false,
        );
        await session.handleE2EEAnnounce(C_PEER, "Y3BlZXI=", "sig");

        parkedResolve.resolve("ws://localhost:7882");
        await vi.advanceTimersByTimeAsync(0);
        await session.handleE2EEOffer(C_PEER, "enc", "iv");
        await vi.advanceTimersByTimeAsync(20_000);
        await firstJoin;

        expect(connectedChannel()).toBe(3);
        expect((session as any)._peerPublicKeys.has(C_PEER)).toBe(true);
      });

      it("keeps only the last channel's announcements across a rapid A to B to C switch", async () => {
        const { firstConnect, firstJoin } = await startConnectingJoinOfOne();

        mockVoiceState.currentChannelId = 2;
        await session.handleVoiceToken("token-2", "/livekit-two", 2, "ws://localhost:7882", false);
        await session.handleE2EEAnnounce(B_PEER, "cGVlcg==", "sig");
        mockVoiceState.currentChannelId = 3;
        await session.handleVoiceToken(
          "token-3",
          "/livekit-three",
          3,
          "ws://localhost:7883",
          false,
        );
        await session.handleE2EEAnnounce(C_PEER, "Y3BlZXI=", "sig");

        firstConnect.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        await session.handleE2EEOffer(C_PEER, "enc", "iv");
        // Past the securing timeout: a dropped offer would eject the join here.
        await vi.advanceTimersByTimeAsync(20_000);
        await firstJoin;

        // Channel 2 was never joined: one connect for 1, one for 3.
        expect(mockRoom.connect).toHaveBeenCalledTimes(2);
        expect(mockRoom.connect).toHaveBeenNthCalledWith(2, "ws://localhost:7883", "token-3", {
          autoSubscribe: false,
        });
        expect(connectedChannel()).toBe(3);
        expect((session as any)._peerPublicKeys.has(C_PEER)).toBe(true);
        expect((session as any)._peerPublicKeys.has(B_PEER)).toBe(false);
      });
    });

    // v001 regression: join generations must stay monotonic across a
    // mid-attempt reset to "idle" (e.g. leaveVoice() from a VOICE_MOVED /
    // manual-leave-then-rejoin sequence), even when a stale attempt's
    // room.connect() happens to resolve BEFORE the newer attempt's. Before
    // the fix, the generation was re-derived from `_state` and restarted at
    // 1 after "idle", so the stale and newer attempts collided on the same
    // generation and the stale one could win the race and overwrite the
    // shared session state with the channel the user was just moved away
    // from.
    it("keeps a stale attempt from winning after a mid-attempt idle reset (v001)", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const connect1 = createDeferred<void>();
      const connect2 = createDeferred<void>();
      mockRoom.connect
        .mockImplementationOnce(() => connect1.promise)
        .mockImplementationOnce(() => connect2.promise);

      // Attempt 1 (channel 1) stalls inside room.connect().
      const attempt1 = (session as any).connectAndSetup(
        "token-1",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );
      await vi.advanceTimersByTimeAsync(0);

      // Superseding event: resets to idle WITHOUT tearing down attempt 1's
      // room (leaveVoice's `_room` getter is null while "connecting").
      session.leaveVoice(false);

      // Attempt 2 (channel 2) starts from idle and also stalls in connect().
      const attempt2 = (session as any).connectAndSetup(
        "token-2",
        "/livekit",
        2,
        "ws://localhost:7880",
        true,
      );
      await vi.advanceTimersByTimeAsync(0);

      // Attempt 1's connect resolves FIRST even though it is the stale one.
      connect1.resolve(undefined);
      const result1 = await attempt1;
      expect(result1).toBe("superseded");

      // Attempt 2 must still own the shared state — attempt 1 must not have
      // installed channel 1 as "connected" over it.
      expect((session as any)._state.type).toBe("connecting");

      connect2.resolve(undefined);
      const result2 = await attempt2;
      expect(result2).toBe(true);
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.channelId).toBe(2);
    });

    // v003 + v010 + v004 all rely on connectAndSetup's outer catch only
    // touching shared state when the attempt is still current. This locks
    // the "not superseded" half: on a genuine connect failure the client
    // must send voice_leave so the server doesn't keep a ghost voice_states
    // row for a join that never reached the SFU.
    it("sends voice_leave and leaves the voice channel on a genuine connect failure (v003)", async () => {
      const ws = { send: vi.fn() };
      session.setServerHost("localhost:7880");
      session.setWsClient(ws as any);

      mockRoom.connect.mockRejectedValue(new Error("connection refused"));

      const resultPromise = session.handleVoiceToken(
        "test-token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(2100);
      }
      await resultPromise;

      expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
      expect(leaveVoiceChannel).toHaveBeenCalled();
    });

    // v010: setupKeyExchange() returns false both for a genuine timeout AND
    // for an aborted wait (clearState() ran because a newer attempt
    // superseded this one). The failure block must not fire the spurious
    // "e2ee_timeout" toast / voice_leave / leaveVoiceChannel() for the
    // aborted case, or it corrupts the newer attempt's just-established
    // server-side membership.
    it("does not fire e2ee_timeout cleanup when superseded during key exchange (v010)", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      const ws = { send: vi.fn() };
      session.setWsClient(ws as any);

      const keyExchangeSpy = vi
        .spyOn((session as any)._e2ee, "setupKeyExchange")
        .mockImplementation(async () => {
          // Simulate a newer attempt superseding this one WHILE this attempt
          // is blocked waiting on the key exchange (mirrors leaveVoice()
          // bumping the generation via a fresh connectAndSetup call).
          (session as any)._state = {
            type: "connecting",
            pendingJoin: null,
            joinGeneration: 999,
          };
          return false;
        });

      const result = await (session as any).connectAndSetup(
        "token",
        "/livekit",
        1,
        "ws://localhost:7880",
        false,
      );

      expect(result).toBe("superseded");
      expect(errorCb).not.toHaveBeenCalledWith(
        "Couldn't secure the voice call — no encryption key arrived. Try joining again.",
      );
      expect(ws.send).not.toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
      expect(leaveVoiceChannel).not.toHaveBeenCalled();

      keyExchangeSpy.mockRestore();
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

    // RT-9: livekit-client (and the native room) retry a dropped signal
    // socket on their own before any Disconnected, so the SDK's reconnecting
    // phase must reach the widget too.
    it.each(["reconnecting", "signalReconnecting"])(
      "writes reconnecting while the SDK retries (%s), then connected once it recovers",
      async (event) => {
        session.setServerHost("localhost:7880");
        session.setWsClient({ send: vi.fn() } as any);
        const handlers = new Map<string, Array<() => void>>();
        mockRoom.on.mockImplementation((name: string, handler: () => void) => {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
          return mockRoom;
        });
        await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
        mockVoiceState.voiceStatus = "connected";
        (setVoiceStatus as any).mockClear();

        for (const h of handlers.get(event) ?? []) h();
        expect(statusCalls()).toEqual(["reconnecting"]);

        mockVoiceState.voiceStatus = "reconnecting";
        for (const h of handlers.get("reconnected") ?? []) h();
        expect(statusCalls()).toEqual(["reconnecting", "connected"]);
        expect((session as any)._state.type).toBe("connected");
      },
    );

    // RT-9: the key can arrive over WS while the SFU is already gone and the
    // SDK is retrying on its own; the join must not then claim "connected".
    it.each(["reconnecting", "signalReconnecting"])(
      "writes reconnecting, not connected, when the joined room is already SDK-%s",
      async (roomState) => {
        session.setServerHost("localhost:7880");
        session.setWsClient({ send: vi.fn() } as any);
        mockRoom.state = roomState;
        (setVoiceStatus as any).mockClear();

        await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);

        expect(statusCalls()).not.toContain("connected");
        expect(statusCalls().at(-1)).toBe("reconnecting");
      },
    );

    it("writes reconnecting, not connected, when the auto-reconnected room is already SDK-reconnecting", async () => {
      enterReconnecting(session, 7);
      mockRoom.state = "signalReconnecting";
      (setVoiceStatus as any).mockClear();

      await runReconnect(session, 7);

      expect(statusCalls()).not.toContain("connected");
      expect(statusCalls().at(-1)).toBe("reconnecting");
    });

    it("writes connected after a successful auto-reconnect", async () => {
      enterReconnecting(session, 7);
      (setVoiceStatus as any).mockClear();

      const ac = new AbortController();
      await runReconnect(session, 7, { signal: ac.signal });

      expect(setVoiceStatus).toHaveBeenCalledWith("connected");
    });

    it("does not carry a stale key-holder promotion into a channel switch made while reconnecting", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      let disconnectedHandler: ((reason?: number) => void) | undefined;
      mockRoom.on.mockImplementation((event: string, handler: any) => {
        if (event === "disconnected") disconnectedHandler = handler;
        return mockRoom;
      });

      // Join channel 1 as key holder.
      await session.handleVoiceToken("test-token", "/livekit", 1, "ws://localhost:7880", true);
      expect((session as any)._e2ee["_isKeyHolder"]).toBe(true);

      // The SFU connection drops — auto-reconnect starts, but the WS socket
      // (and thus the sidebar) is unaffected, so the user can still switch
      // voice channels while this is in flight.
      disconnectedHandler!(/* SERVER_SHUTDOWN */ 1);
      expect((session as any)._state.type).toBe("reconnecting");

      // The user switches to channel 2, which already has a lower-uid
      // participant — the server elects someone else and sends
      // is_key_holder=false. joinVoiceChannel(2) always runs before this
      // token's round trip in the real app (OC-0009's guard reads it back).
      mockVoiceState.currentChannelId = 2;
      const joinPromise = session.handleVoiceToken(
        "token-2",
        "/livekit",
        2,
        "ws://localhost:7880",
        false,
      );
      // Let the synchronous prefix of setupKeyExchange (keypair generation +
      // announce signing — mocked async fns, no real delay) run without
      // needing to fast-forward the non-holder wait-for-offer timers.
      await vi.advanceTimersByTimeAsync(0);

      // The stale promotion from channel 1 must not leak into channel 2's
      // election: connectAndSetup only tore down E2EE state via `_room !==
      // null`, which reads null while "reconnecting", so clearState() never
      // ran and the residual _isKeyHolder=true survived into this call.
      expect((session as any)._e2ee["_isKeyHolder"]).toBe(false);

      // Let the (correctly non-holder) wait time out and the join settle so
      // nothing is left dangling for later tests.
      await vi.advanceTimersByTimeAsync(20_000);
      await joinPromise;
    });
  });

  describe("handleVoiceTokenRefresh", () => {
    it("stores the token and restarts the timer", () => {
      enterConnected(session, 7, {
        latestToken: "old-token",
        lastDirectUrl: "ws://localhost:7880",
      });

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      session.handleVoiceTokenRefresh("new-token");

      expect((session as any)._state.latestToken).toBe("new-token");
      // Timer restarted: the refresh timer is re-armed on every refresh.
      // OC-0014: must stay under the server's 5-minute token TTL.
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4 * 60 * 1000);
    });

    it("handles undefined token", () => {
      expect(() => session.handleVoiceTokenRefresh(undefined)).not.toThrow();
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

  describe("token refresh timer", () => {
    // OC-0014: the server mints LiveKit tokens with a 5-minute TTL
    // (Server/ws/livekit.go tokenTTL). If the client's only periodic
    // refresh fires later than that, any reconnect attempt after the first
    // 5 minutes of a call presents an already-expired token and fails.
    it("refreshes the token before the server's 5-minute TTL expires", async () => {
      const mockWs = await joinWithWs(session);

      mockWs.send.mockClear();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(mockWs.send).toHaveBeenCalledWith({
        type: "voice_token_refresh",
        payload: {},
      });
    });

    it("fires after TOKEN_REFRESH_MS and sends voice_token_refresh WS message", async () => {
      const mockWs = await joinWithWs(session);

      mockWs.send.mockClear();

      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

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
      enterConnected(session, 1, { latestToken: "old-token", lastUrl: "/lk" });
      session.handleVoiceTokenRefresh("fresh-token");
      expect((session as any)._state.latestToken).toBe("fresh-token");
      // Timer lives on VoiceTokenManager since the refactor. Asserting on the
      // old `session.tokenRefreshTimer` read `undefined` and passed vacuously,
      // so the "restarts timer" half of this test guarded nothing.
      expect((session as any)._tokenManager._refreshTimer).not.toBeNull();
    });

    it("clearTokenRefreshTimer prevents pending refresh from firing", async () => {
      const mockWs = await joinWithWs(session);

      mockWs.send.mockClear();
      (session as any).clearTokenRefreshTimer();

      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

      expect(mockWs.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_token_refresh" }),
      );
    });

    // OC-0429: a single unanswered voice_token_refresh must not re-arm the
    // full 4-minute periodic interval — that leaves _state.latestToken
    // expired (server TTL is 5 minutes; the refresh fired at minute 4) for
    // up to another 4 minutes, so any LiveKit disconnect in that window
    // hands attemptAutoReconnect a dead token and every reconnect attempt
    // fails (the exact OC-0014 failure mode the 4-minute cadence exists to
    // avoid). The post-timeout retry must use the server's rate-limit
    // cadence (60s), not the periodic one (240s).
    it("re-arms at the 60s retry cadence, not the full 4-minute interval, after an unanswered refresh", async () => {
      const mockWs = await joinWithWs(session);

      mockWs.send.mockClear();

      // t=240s: the periodic timer fires the first refresh attempt. No
      // response is ever delivered (handleVoiceTokenRefresh is never called),
      // simulating a dropped frame / silently-closed WS proxy.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_token_refresh", payload: {} });
      mockWs.send.mockClear();

      // t=300s: the 60s response-deadline timer fires (BUG-146) and
      // reschedules the next attempt. Nothing sent exactly at this instant.
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(mockWs.send).not.toHaveBeenCalled();

      // t=360s: the retry must fire 60s after the timeout (the server's
      // rate-limit budget), not a further 240s later at t=540s.
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_token_refresh", payload: {} });
    });
  });

  describe("token refresh survives livekit-client's own internal reconnect", () => {
    it("takes the refresh fast path when Room.state is mid-internal-reconnect instead of tearing down the session", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      mockRoom.connect.mockResolvedValue(undefined);
      await session.handleVoiceToken("token-1", "/livekit", 1, "ws://localhost:7880", true);
      expect((session as any)._state.type).toBe("connected");

      // livekit-client's own internal reconnect (a signal-socket blip) —
      // RoomEvent.Disconnected is NOT emitted for this, so `_state` stays
      // "connected", but Room.state moves off "connected".
      mockRoom.state = "signalReconnecting";
      mockRoom.connect.mockClear();

      const refreshSpy = vi.spyOn(session, "handleVoiceTokenRefresh");
      await session.handleVoiceToken("token-2", "/livekit", 1, "ws://localhost:7880", true);

      expect(refreshSpy).toHaveBeenCalledWith("token-2");
      // Must NOT re-run the full teardown+rejoin — that would drop the E2EE
      // session and could eject the user if no offer arrives in time.
      expect(mockRoom.connect).not.toHaveBeenCalled();

      refreshSpy.mockRestore();
    });
  });

  describe("requestTokenRefresh throttles to the server's 1-per-60s budget", () => {
    it("does not resend voice_token_refresh within 60s of the previous one", async () => {
      const mockWs = await joinWithWs(session);

      mockWs.send.mockClear();
      (session as any).requestTokenRefresh();
      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_token_refresh", payload: {} });

      mockWs.send.mockClear();
      // Mirrors OC-0029's repro: auto-reconnect's unconditional post-recovery
      // refresh landing ~13s after the 4-minute timer's own refresh.
      await vi.advanceTimersByTimeAsync(13_000);
      (session as any).requestTokenRefresh();

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it("allows a refresh again once the 60s budget window has passed", async () => {
      const mockWs = await joinWithWs(session);

      mockWs.send.mockClear();
      (session as any).requestTokenRefresh();
      expect(mockWs.send).toHaveBeenCalledTimes(1);

      mockWs.send.mockClear();
      await vi.advanceTimersByTimeAsync(60_100);
      (session as any).requestTokenRefresh();

      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_token_refresh", payload: {} });
    });

    it("does not throttle a fresh join shortly after leaveVoice resets the budget", async () => {
      const mockWs = await joinWithWs(session);

      (session as any).requestTokenRefresh();
      session.leaveVoice(false);

      mockVoiceState.currentChannelId = 1;
      await session.handleVoiceToken("token-2", "/livekit", 1, "ws://localhost:7880", true);
      mockWs.send.mockClear();

      (session as any).requestTokenRefresh();

      expect(mockWs.send).toHaveBeenCalledWith({ type: "voice_token_refresh", payload: {} });
    });
  });
});
