import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import { Room } from "livekit-client";
import { LiveKitSession } from "../../../src/lib/voice/livekitSession";
import { leaveVoiceChannel } from "@stores/voice.store";
import { ensureLiveKitProxy } from "../../../src/platform/desktop/nativeProxies";
import {
  createDeferred,
  useLiveKitSessionHarness,
  enterConnected,
  stubPrefs,
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

    it("tunnels an IPv6 loopback directUrl when serverHost is bare ::1", async () => {
      session.setServerHost("::1");
      const url = await (session as any).resolveLiveKitUrl("/livekit", "ws://[::1]:7880/livekit");
      // Detected as local, but CSP host-sources cannot name an IPv6 literal,
      // so connect-src has no ws://[::1] entry: the direct URL would be
      // refused, and it goes through the loopback tunnel instead.
      expect(url).toBe("ws://127.0.0.1:7881/tun/livekit");
    });

    it("tunnels an IPv6 loopback directUrl when serverHost is bracketed [::1]:7880", async () => {
      session.setServerHost("[::1]:7880");
      const url = await (session as any).resolveLiveKitUrl("/livekit", "ws://[::1]:7880/livekit");
      // Bracketed IPv6 — host extracted as "::1", detected as local, and
      // tunnelled for the same connect-src reason as the bare form.
      expect(url).toBe("ws://127.0.0.1:7881/tun/livekit");
    });

    it("calls ensureLiveKitProxy and returns proxy URL for remote host with slash path", async () => {
      session.setServerHost("example.com:443");
      const url = await (session as any).resolveLiveKitUrl("/livekit");
      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", {
        remoteHost: "example.com:443",
      });
      expect(url).toBe("ws://127.0.0.1:7881/tun/livekit");
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
      expect(url).toBe("ws://127.0.0.1:7881/tun/livekit");
    });

    it("does not return directUrl for localhost when directUrl is undefined", async () => {
      session.setServerHost("localhost:7880");
      const url = await (session as any).resolveLiveKitUrl("/livekit");
      // No directUrl provided, isLocal but directUrl falsy -> falls to proxy
      expect(url).toBe("ws://127.0.0.1:7881/tun/livekit");
    });
  });

  // ensureLiveKitProxy moved into LiveKitUrlResolver, and then (B7-5) into
  // platform/desktop's nativeProxies, which LiveKitSession reaches through its
  // _urlResolver. These call it directly rather than through resolve(), because
  // the null-host guard is unreachable from resolve(): a null host takes the
  // passthrough branch and never calls the proxy at all.
  describe("ensureLiveKitProxy", () => {
    it("invokes start_livekit_proxy on every call so a re-pinned cert is picked up", async () => {
      session.setServerHost("example.com:443");
      const port1 = await ensureLiveKitProxy();
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
      const port2 = await ensureLiveKitProxy();
      expect(port2).toBe(7881);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it("appends :443 when serverHost has no port", async () => {
      session.setServerHost("example.com");
      await ensureLiveKitProxy();
      expect(mockInvoke).toHaveBeenCalledWith("start_livekit_proxy", {
        remoteHost: "example.com:443",
      });
    });

    it("throws when serverHost is null", async () => {
      await expect(ensureLiveKitProxy()).rejects.toThrow("no server host for LiveKit proxy");
    });
  });

  describe("connectAndSetup retry logic", () => {
    it("stays joining through two peer timeouts and connects on the final attempt", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      // The native fixture's signaling is local, but the SDK may spend its
      // full 15s peer-connection timeout on each attempt. A 30s UI assertion
      // would interrupt the second attempt before production gives up.
      const peerTimeout = () =>
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("peer connection timed out")), 15_000),
        );
      mockRoom.connect
        .mockImplementationOnce(peerTimeout)
        .mockImplementationOnce(peerTimeout)
        .mockImplementationOnce(() => new Promise<void>((resolve) => setTimeout(resolve, 15_000)));

      const resultPromise = (session as any).connectAndSetup(
        "token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockRoom.connect).toHaveBeenCalledTimes(2);
      expect((session as any)._state.type).toBe("connecting");
      await vi.advanceTimersByTimeAsync(19_000);
      expect(await resultPromise).toBe(true);
      expect(mockRoom.connect).toHaveBeenCalledTimes(3);
      expect((session as any)._state.type).toBe("connected");
    });

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

    it("sends voice_leave and leaves the voice channel when the E2EE key exchange fails", async () => {
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const keyExchangeSpy = vi
        .spyOn((session as any)._e2ee, "setupKeyExchange")
        .mockResolvedValue(false);
      const leaveSpy = vi.spyOn(session, "leaveVoice");

      const result = await (session as any).connectAndSetup(
        "token",
        "/livekit",
        1,
        "ws://localhost:7880",
        false,
      );

      expect(result).toBe(false);
      expect(errorCb).toHaveBeenCalledWith(
        "Couldn't secure the voice call — no encryption key arrived. Try joining again.",
      );
      // The exchange times out BEFORE room.connect(), so no SFU participant
      // exists and no LiveKit webhook can clean up. Without voice_leave the
      // server keeps the voice_states row forever; the ghost survives every
      // sweep and, once elected key holder, wedges the channel's E2EE for all
      // subsequent joiners. Mirror the reconnect-exhausted give-up path.
      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect(leaveSpy).toHaveBeenCalledWith(true, false);
      expect(leaveVoiceChannel).toHaveBeenCalled();

      keyExchangeSpy.mockRestore();
      leaveSpy.mockRestore();
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
      stubPrefs({ audioInputDevice: "nonexistent-device" });

      const result = await (session as any).connectAndSetup(
        "token",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      expect(result).toBe(true);
    });

    it("applies the saved input device before the mic is first captured", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      mockRoom.connect.mockResolvedValue(undefined);
      stubPrefs({ audioInputDevice: "usb-mic" });
      const order: string[] = [];
      mockRoom.switchActiveDevice.mockImplementation(async (kind: string) => {
        order.push(kind);
        return true;
      });
      mockRoom.localParticipant.setMicrophoneEnabled.mockImplementation(async (on: boolean) => {
        order.push(`mic:${on}`);
      });

      await (session as any).connectAndSetup("token", "/livekit", 1, "ws://localhost:7880", true);

      // Non-exact: a saved mic that was unplugged degrades to the default
      // instead of failing the publish into listen-only.
      expect(mockRoom.switchActiveDevice).toHaveBeenCalledWith("audioinput", "usb-mic", false);
      expect(order.indexOf("audioinput")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("audioinput")).toBeLessThan(order.indexOf("mic:true"));
      expect(order.filter((o) => o === "audioinput")).toHaveLength(1);
    });

    it("calls leaveVoice(false) when room is non-null at entry", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      mockRoom.connect.mockResolvedValue(undefined);
      await (session as any).connectAndSetup("token-1", "/livekit", 1, "ws://localhost:7880", true);
      expect((session as any)._state.type).toBe("connected");

      const leaveSpy = vi.spyOn(session, "leaveVoice");
      await (session as any).connectAndSetup("token-2", "/livekit", 2, "ws://localhost:7880", true);

      // Channel switch is an internal teardown: it keeps the viewer's watches.
      expect(leaveSpy).toHaveBeenCalledWith(false, true);
      leaveSpy.mockRestore();
    });
  });

  describe("connectAndSetup post-connect checkpoints (supersession)", () => {
    // Checkpoint 2 (right after room.connect()) already disconnects only its
    // OWN localRoom — checkpoints 3/4/5 (after restoreLocalVoiceState and each
    // saved-device switch) must do the same, not call the global leaveVoice().
    // A newer attempt can install its own "connected" state into the shared
    // _state while an older attempt is still awaiting one of these steps;
    // calling the global leaveVoice() at that point tears down whichever
    // session currently occupies _state — the NEWER one, not this attempt's.
    it("checkpoint 3 does not call the global leaveVoice, and leaves a newer attempt's state untouched", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      const micDeferred = createDeferred<void>();
      mockRoom.localParticipant.setMicrophoneEnabled.mockImplementationOnce(
        () => micDeferred.promise,
      );

      const resultPromise = (session as any).connectAndSetup(
        "token-A",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );

      // Let this attempt reach room.connect() -> restoreLocalVoiceState() ->
      // setMicrophoneEnabled(), which is now stalled on micDeferred.
      await vi.advanceTimersByTimeAsync(0);
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.channelId).toBe(1);

      const leaveSpy = vi.spyOn(session, "leaveVoice");

      // A newer attempt (channel 2) has already superseded this one and
      // installed its own connected state into the shared _state.
      enterConnected(session, 2, { latestToken: "token-B", lastUrl: "/livekit-b" });

      // Now let the stalled attempt's restoreLocalVoiceState resolve.
      micDeferred.resolve(undefined);
      const result = await resultPromise;

      expect(result).toBe("superseded");
      // Must never call the global leaveVoice() here — that would tear down
      // whatever the newer attempt just installed (worker, E2EE state, room).
      expect(leaveSpy).not.toHaveBeenCalled();
      // The newer attempt's state must be untouched.
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.channelId).toBe(2);

      leaveSpy.mockRestore();
    });
  });

  describe("voice_config audio bitrate applied to publishDefaults", () => {
    // OC-0438: the server computes an audio bitrate from the channel's voice
    // quality (qualityBitrate) and delivers it via voice_config, stored in
    // voiceStore.voiceConfigs. The Room's publishDefaults must apply it to
    // the published mic track — otherwise the quality preset changes nothing
    // a user hears.
    it("applies the channel's voice_config bitrate to the room's audio publishDefaults", async () => {
      mockVoiceState.voiceConfigs = new Map([[1, { bitrate: 32000 }]]);
      session.setServerHost("localhost:7880");
      mockRoom.connect.mockResolvedValue(undefined);

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      const RoomMock = Room as unknown as ReturnType<typeof vi.fn>;
      const lastOptions = RoomMock.mock.calls.at(-1)![0] as {
        publishDefaults: { audioPreset?: { maxBitrate: number } };
      };
      expect(lastOptions.publishDefaults.audioPreset).toEqual({ maxBitrate: 32000 });
    });

    it("omits audioPreset (LiveKit default applies) when no voice_config has arrived yet for the channel", async () => {
      mockVoiceState.voiceConfigs = new Map();
      session.setServerHost("localhost:7880");
      mockRoom.connect.mockResolvedValue(undefined);

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      const RoomMock = Room as unknown as ReturnType<typeof vi.fn>;
      const lastOptions = RoomMock.mock.calls.at(-1)![0] as {
        publishDefaults: { audioPreset?: { maxBitrate: number } };
      };
      expect(lastOptions.publishDefaults.audioPreset).toBeUndefined();
    });

    // OC-0441: publishDefaults alone is not enough on a channel's FIRST join.
    // The server sends voice_token before voice_config (an ordering frozen by
    // the epoch-1 golden transcripts), and createRoom runs synchronously from
    // the voice_token handler — so voiceConfigs is still empty when the Room
    // is built and the configured bitrate is silently lost until a rejoin.
    // The mic is published much later, after the LiveKit connect round-trip,
    // by which point voice_config has arrived: read the bitrate there and
    // pass it as explicit publish options.
    it("applies a voice_config that arrives after the Room is built to the mic publish", async () => {
      mockVoiceState.voiceConfigs = new Map();
      session.setServerHost("localhost:7880");
      // voice_config is processed while the LiveKit connect is in flight —
      // after createRoom read an empty map, before the mic is published.
      mockRoom.connect.mockImplementation(async () => {
        mockVoiceState.voiceConfigs = new Map([[1, { bitrate: 128000 }]]);
      });

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      const RoomMock = Room as unknown as ReturnType<typeof vi.fn>;
      const lastOptions = RoomMock.mock.calls.at(-1)![0] as {
        publishDefaults: { audioPreset?: { maxBitrate: number } };
      };
      // The Room really was built without it — this is the first join.
      expect(lastOptions.publishDefaults.audioPreset).toBeUndefined();
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, undefined, {
        audioPreset: { maxBitrate: 128000 },
      });
    });

    it("publishes the mic with no explicit encoding when no voice_config exists for the channel", async () => {
      mockVoiceState.voiceConfigs = new Map();
      session.setServerHost("localhost:7880");
      mockRoom.connect.mockResolvedValue(undefined);

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });
  });

  describe("mic mute stops the capture track, not just the publication", () => {
    // Muting has to stop the OS capture rather than only mute the LiveKit
    // publication, or the microphone stays open and the OS in-use indicator
    // stays lit for as long as the client is muted. LiveKit honours
    // stopMicTrackOnMute only through TrackPublishDefaults, so the Room has to
    // carry it in publishDefaults; a top-level RoomOptions key is silently
    // ignored, which would leave the capture running and nothing failing.
    it("builds the Room with publishDefaults.stopMicTrackOnMute", async () => {
      session.setServerHost("localhost:7880");
      mockRoom.connect.mockResolvedValue(undefined);

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      const RoomMock = Room as unknown as ReturnType<typeof vi.fn>;
      const lastOptions = RoomMock.mock.calls.at(-1)![0] as {
        publishDefaults: { stopMicTrackOnMute?: boolean };
      };
      expect(lastOptions.publishDefaults.stopMicTrackOnMute).toBe(true);
    });
  });

  describe("remote video is not paused by adaptiveStream", () => {
    // The video grid plays each remote camera from its own MediaStream and
    // never attach()es the track, so adaptiveStream sees no visible element.
    // LiveKit re-checks on every server stream-state update (an SFU bandwidth
    // pause and resume) and then pauses the camera for good: in CI a peer
    // decoded one frame of a rejoined camera and nothing after it.
    it("builds the Room with adaptiveStream off at the default quality", async () => {
      session.setServerHost("localhost:7880");
      mockRoom.connect.mockResolvedValue(undefined);

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      const RoomMock = Room as unknown as ReturnType<typeof vi.fn>;
      const lastOptions = RoomMock.mock.calls.at(-1)![0] as { adaptiveStream?: unknown };
      expect(lastOptions.adaptiveStream).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // bughunt-fix wave 2: OC-0001, OC-0006, OC-0009, OC-0010, OC-0015, OC-0029
  // -----------------------------------------------------------------------

  describe("pending-join drain re-enters connectAndSetup without E2EE teardown", () => {
    it("does not carry a stale key-holder promotion into a join drained while still 'connecting'", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      // Channel A: connect() stalls so we can queue a join for channel B
      // before A's attempt reaches its own supersession checkpoint.
      const connectA = createDeferred<void>();
      mockRoom.connect
        .mockImplementationOnce(() => connectA.promise)
        .mockResolvedValueOnce(undefined);

      const joinPromise = session.handleVoiceToken(
        "token-a",
        "/livekit",
        1,
        "ws://localhost:7880",
        true, // key holder for channel A
      );
      // Let E2EE key-exchange (key-holder path — no wait) and room.connect()
      // start; A's attempt is now stalled inside room.connect().
      await vi.advanceTimersByTimeAsync(0);
      expect((session as any)._e2ee["_isKeyHolder"]).toBe(true);

      // The user switches to channel B before A's connect() resolves. The
      // server elects a different key holder for B.
      mockVoiceState.currentChannelId = 2;
      await session.handleVoiceToken("token-b", "/livekit", 2, "ws://localhost:7880", false);
      expect((session as any)._state.type).toBe("connecting");
      expect((session as any)._state.pendingJoin?.channelId).toBe(2);

      // Observe _isKeyHolder at the exact moment channel B's own key exchange
      // begins — before any later leaveVoice()/timeout path could mask a
      // residual value left over from A by resetting it via a different route.
      let isKeyHolderAtBStart: boolean | undefined;
      const keyExchangeSpy = vi
        .spyOn((session as any)._e2ee, "setupKeyExchange")
        .mockImplementation(async () => {
          isKeyHolderAtBStart = (session as any)._e2ee["_isKeyHolder"];
          return true; // fast-path: pretend the room key is already available
        });

      // A's connect() now resolves — connectAndSetup(A) discards its own
      // room in favor of the queued B join (the queuedJoin branch) and
      // returns false, leaving state "connecting" with pendingJoin=B intact
      // so handleVoiceToken's drain loop runs it next.
      connectA.resolve(undefined);
      await joinPromise;

      // The residual key-holder promotion from channel A must not have
      // leaked into channel B's own (correctly non-holder) election.
      expect(isKeyHolderAtBStart).toBe(false);

      keyExchangeSpy.mockRestore();
    });
  });

  describe("connectAndSetup supersession checkpoints re-sync module room wiring", () => {
    it("unwires DeviceManager/AudioPipeline/AudioElements when checkpoint 1 fires after a concurrent leaveVoice that landed during room creation", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);

      // Stall createRoom()'s own `await newRoom.setE2EEEnabled(true)` — this
      // is BEFORE connectAndSetup's module-wiring lines (which run right
      // after createRoom() resolves) have executed at all.
      const e2eeDeferred = createDeferred<void>();
      mockRoom.setE2EEEnabled.mockImplementationOnce(() => e2eeDeferred.promise);

      const resultPromise = (session as any).connectAndSetup(
        "token-1",
        "/livekit",
        1,
        "ws://localhost:7880",
        true,
      );
      await vi.advanceTimersByTimeAsync(0);

      // A concurrent Disconnect click runs leaveVoice() here. `_room` reads
      // null (state is "connecting", no room installed yet), so there is
      // nothing to unwire — this only proves the leave itself ran cleanly.
      session.leaveVoice(false);
      expect((session as any)._deviceManager.room).toBeNull();

      // createRoom() now resolves. connectAndSetup's module-wiring lines run
      // UNCONDITIONALLY right after, re-wiring the modules to a room that
      // state ("idle", from the leave above) says nobody wants any more.
      // resolveLiveKitUrl resolves synchronously for a local host, so
      // checkpoint 1 fires immediately after — it must detect the leave and
      // leave the modules unwired rather than stranding them on a room that
      // will never connect.
      e2eeDeferred.resolve(undefined);
      const result = await resultPromise;

      expect(result).toBe("superseded");
      expect((session as any)._deviceManager.room).toBeNull();
    });
  });

  describe("handleVoiceToken ignores a voice_token for a channel already left", () => {
    it("does not connect when the token arrives after the user left before connectAndSetup ever started", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      // The user clicked Disconnect (leaveVoiceChannel nulls this) before the
      // voice_join/voice_token round trip for the earlier join returned.
      mockVoiceState.currentChannelId = null;

      await session.handleVoiceToken("stale-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect((session as any)._state.type).toBe("idle");
    });

    it("does not connect when the token is for a channel the user has since switched away from", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      mockVoiceState.currentChannelId = 2;

      await session.handleVoiceToken("stale-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect((session as any)._state.type).toBe("idle");
    });

    it("still connects when the token matches the channel the user currently wants", async () => {
      session.setServerHost("localhost:7880");
      session.setWsClient({ send: vi.fn() } as any);
      mockVoiceState.currentChannelId = 1;

      await session.handleVoiceToken("fresh-token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.connect).toHaveBeenCalledWith("ws://localhost:7880", "fresh-token", {
        autoSubscribe: false,
      });
      expect((session as any)._state.type).toBe("connected");
    });
  });

  describe("e2ee-timeout cleanup honors a queued pendingJoin", () => {
    it("does not send voice_leave / leaveVoiceChannel and preserves the queued join when the key exchange times out with a join queued", async () => {
      const ws = { send: vi.fn() };
      session.setServerHost("localhost:7880");
      session.setWsClient(ws as any);

      // Force setupKeyExchange to report a genuine timeout while a newer
      // join has ALREADY been queued — mirrors handleVoiceToken's queuing
      // branch, which preserves this attempt's type/joinGeneration.
      const keyExchangeSpy = vi
        .spyOn((session as any)._e2ee, "setupKeyExchange")
        .mockImplementation(async () => {
          (session as any)._state = {
            ...(session as any)._state,
            pendingJoin: {
              token: "token-b",
              url: "/livekit-b",
              channelId: 2,
              directUrl: undefined,
            },
          };
          return false;
        });

      const result = await (session as any).connectAndSetup(
        "token-a",
        "/livekit",
        1,
        "ws://localhost:7880",
        false,
      );

      expect(result).toBe(false);
      // Must NOT run the give-up cleanup — that would send a voice_leave
      // that carries no channel id (acting on whichever channel the queued
      // join is about to occupy) and would discard the queued join entirely.
      expect(ws.send).not.toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
      expect(leaveVoiceChannel).not.toHaveBeenCalled();
      // The queued join must survive so handleVoiceToken's drain loop can run it.
      expect((session as any)._state.type).toBe("connecting");
      expect((session as any)._state.pendingJoin?.channelId).toBe(2);

      keyExchangeSpy.mockRestore();
    });
  });
});
