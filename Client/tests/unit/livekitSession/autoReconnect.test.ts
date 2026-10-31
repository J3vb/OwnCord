import { describe, it, expect, vi, onTestFinished } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import { LiveKitSession } from "../../../src/lib/voice/livekitSession";
import { leaveVoiceChannel, setVoiceStatus } from "@stores/voice.store";
import { useLiveKitSessionHarness } from "../../helpers/livekitSessionHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

const { mockVoiceState, mockRoom, mockLoadPref } = mocks;

describe("LiveKitSession", () => {
  let session: LiveKitSession;

  useLiveKitSessionHarness({
    wired: (s) => {
      session = s;
    },
    currentSession: () => session,
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

    it("applies the saved input device before the reconnect re-captures the mic", async () => {
      mockVoiceState.localMuted = false;
      mockVoiceState.localDeafened = false;
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioInputDevice") return "usb-mic";
        return defaultVal;
      });
      const order: string[] = [];
      mockRoom.switchActiveDevice.mockImplementation(async (kind: string) => {
        order.push(kind);
        return true;
      });
      mockRoom.localParticipant.setMicrophoneEnabled.mockImplementation(async (on: boolean) => {
        order.push(`mic:${on}`);
      });
      (session as any)._state = {
        type: "reconnecting",
        channelId: 7,
        latestToken: "reconnect-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/livekit",
        7,
        "ws://localhost:7880",
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(mockRoom.switchActiveDevice).toHaveBeenCalledWith("audioinput", "usb-mic", false);
      expect(order.indexOf("audioinput")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("audioinput")).toBeLessThan(order.indexOf("mic:true"));
      expect(order.filter((o) => o === "audioinput")).toHaveLength(1);
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
            trackPublications: new Map(),
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

    it("sweeps the existing participants' publications into the new room on reconnect", async () => {
      // Cameras opt-in, as before WP 1B-3.
      onTestFinished(() => {
        mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
      });
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) =>
        key === "autoPlayCameras" ? false : defaultVal,
      );
      mockVoiceState.localMuted = false;
      mockVoiceState.localDeafened = false;
      (session as any)._state = {
        type: "reconnecting",
        channelId: 9,
        latestToken: "reconnect-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };

      const setSubscribed = vi.fn();
      const publication = { kind: "audio", source: "microphone", setSubscribed };
      const setCameraSubscribed = vi.fn();
      const camera = { kind: "video", source: "camera", setSubscribed: setCameraSubscribed };
      const onRemoteVideo = vi.fn();
      session.setOnRemoteVideo(onRemoteVideo);
      mockRoom.remoteParticipants = new Map([
        [
          "user-7:tok",
          {
            identity: "user-7:tok",
            audioTrackPublications: new Map(),
            trackPublications: new Map<string, unknown>([
              ["TR_a", publication],
              ["TR_v", camera],
            ]),
            getTrackPublication: (source: string) => (source === "camera" ? camera : undefined),
          },
        ],
      ]);

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/livekit",
        9,
        "ws://localhost:7880",
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(setSubscribed).toHaveBeenCalledWith(true);
      expect(setCameraSubscribed).toHaveBeenCalledWith(false);
      expect(onRemoteVideo).toHaveBeenCalledWith(7, null, false);
    });

    it("sweeps an auto-played camera into the new room subscribed, with no Watch card", async () => {
      mockVoiceState.localMuted = false;
      mockVoiceState.localDeafened = false;
      (session as any)._state = {
        type: "reconnecting",
        channelId: 9,
        latestToken: "reconnect-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };

      const setSubscribed = vi.fn();
      const publication = { kind: "audio", source: "microphone", setSubscribed };
      const setCameraSubscribed = vi.fn();
      const camera = { kind: "video", source: "camera", setSubscribed: setCameraSubscribed };
      const onRemoteVideo = vi.fn();
      session.setOnRemoteVideo(onRemoteVideo);
      mockRoom.remoteParticipants = new Map([
        [
          "user-7:tok",
          {
            identity: "user-7:tok",
            audioTrackPublications: new Map(),
            trackPublications: new Map<string, unknown>([
              ["TR_a", publication],
              ["TR_v", camera],
            ]),
            getTrackPublication: (source: string) => (source === "camera" ? camera : undefined),
          },
        ],
      ]);

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/livekit",
        9,
        "ws://localhost:7880",
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect(setSubscribed).toHaveBeenCalledWith(true);
      expect(setCameraSubscribed).toHaveBeenCalledWith(true);
      expect(onRemoteVideo).not.toHaveBeenCalledWith(7, null, false);
    });

    // Pre-refactor parity: the reconnect success path re-installed both
    // DeviceManager callbacks right after setVoiceStatus("connected"). The
    // extraction's mid-attempt wiring set only room + audio pipeline, so the
    // device-error and toast routes were never re-established on the path that
    // replaces the room.
    it("re-installs the device-manager error and toast callbacks on a successful reconnect", async () => {
      (session as any)._state = {
        type: "reconnecting",
        channelId: 11,
        latestToken: "reconnect-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
        ac: new AbortController(),
      };
      const errorCb = vi.fn();
      session.setOnError(errorCb);

      // Spy AFTER setOnError, which installs the callback itself — we want only
      // the calls the reconnect makes.
      const deviceManager = (session as any)._deviceManager;
      const setOnErrorSpy = vi.spyOn(deviceManager, "setOnError");
      const setOnToastSpy = vi.spyOn(deviceManager, "setOnToast");

      const ac = new AbortController();
      const reconnectPromise = (session as any).attemptAutoReconnect(
        "reconnect-token",
        "/livekit",
        11,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      expect((session as any)._state.type).toBe("connected");
      expect(setOnErrorSpy).toHaveBeenCalledWith(errorCb);
      expect(setOnToastSpy).toHaveBeenCalledWith(errorCb);
    });
  });

  describe("attemptAutoReconnect (lifecycle)", () => {
    // RT-9: a companion LiveKit restart backs off from 3 s and doubles, plus
    // its own start-up, so the old 2 tries 3 s apart (about 6 s) gave up
    // before the SFU was back and ejected every call. The loop must keep
    // retrying with backoff, so an SFU that returns on the third attempt
    // still resumes the call.
    it("keeps retrying with backoff so a companion LiveKit restart can land", async () => {
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

      mockRoom.connect
        .mockRejectedValueOnce(new Error("sfu restarting"))
        .mockRejectedValueOnce(new Error("sfu restarting"))
        .mockResolvedValueOnce(undefined);

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      await vi.advanceTimersByTimeAsync(3000); // attempt 1 fails
      await vi.advanceTimersByTimeAsync(6000); // attempt 2 fails — the old budget gave up here
      await vi.advanceTimersByTimeAsync(6000); // attempt 3 succeeds
      await reconnectPromise;

      expect(mockRoom.connect).toHaveBeenCalledTimes(3);
      expect(errorCb).not.toHaveBeenCalled();
      expect(setVoiceStatus).toHaveBeenCalledWith("connected");
    });

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

      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(6000);
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

      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(6000);
      await reconnectPromise;

      // The room whose connect failed must be torn down — in "reconnecting"
      // state this._room is null, so the cleanup must target the attempt's
      // own room. A leaked room keeps its listeners and its synchronous
      // Disconnected event spawns a second, uncancellable reconnect loop.
      const onDisconnected = mockRoom.on.mock.calls.findLast(([e]) => e === "disconnected")![1];
      expect(mockRoom.off).toHaveBeenCalledWith("disconnected", onDisconnected);
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
      const sendSpy = vi.fn();
      // The chat socket is closed for good, so the D-4 slow phase does not run
      // and the loop gives up once the fast attempts are spent.
      session.setWsClient({ send: sendSpy, getState: () => "disconnected" } as any);
      const errorCb = vi.fn();
      session.setOnError(errorCb);
      const leaveVoiceSpy = vi.spyOn(session, "leaveVoice");
      const ac = new AbortController();

      mockRoom.connect.mockRejectedValue(new Error("always fails"));

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      // Exhaust the whole RT-9 budget: 3 s, then 6 s per attempt.
      await vi.advanceTimersByTimeAsync(27_000);
      await reconnectPromise;

      expect(leaveVoiceChannel).toHaveBeenCalled();
      expect(errorCb).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      // The non-superseded give-up path must route through the session's FULL
      // leave cleanup, not just a voice_leave frame. Sending the frame alone
      // leaves the session internally "reconnecting" with the E2EE worker and
      // its room key still resident, and only the reconnect-flavoured audio
      // cleanup having run — so per-call screenshare mute/volume state survives
      // until some later explicit leave or join.
      expect(leaveVoiceSpy).toHaveBeenCalledWith(false);
      expect((session as any)._state.type).toBe("idle");
      // ...and no voice_leave goes out over a socket that is not connected.
      expect(sendSpy.mock.calls.filter(([m]) => m.type === "voice_leave")).toHaveLength(0);
    });

    // v004 regression: if the user leaves/switches channels while the FINAL
    // reconnect attempt is in flight, the post-loop give-up cleanup must not
    // fire — calling the global leaveVoice(true) there would tear down
    // whatever live session replaced this stale reconnect loop (CLAUDE.md:
    // voice sessions are superseded, not cancelled).
    it("skips give-up cleanup when superseded before the final attempt resolves", async () => {
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

      // Every attempt fails, and on the LAST attempt's failure the session
      // has already moved on to a different (live) channel — simulating the
      // user joining channel 9 while the final attempt
      // (MAX_RECONNECT_ATTEMPTS) was still connecting.
      let connectCalls = 0;
      mockRoom.connect.mockImplementation(() => {
        connectCalls++;
        if (connectCalls >= 5) {
          (session as any)._state = {
            type: "connected",
            room: mockRoom,
            channelId: 9,
            latestToken: "other-token",
            lastUrl: "/livekit",
            lastDirectUrl: "ws://localhost:7880",
          };
          // ...and the chat socket closes for good, so the loop breaks straight
          // into the post-loop give-up check instead of an in-loop checkpoint.
          session.setWsClient({ send: vi.fn(), getState: () => "disconnected" } as any);
        }
        return Promise.reject(new Error("always fails"));
      });

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      // Exhaust the fast attempts so the loop reaches the post-loop check.
      await vi.advanceTimersByTimeAsync(27_000);
      await reconnectPromise;

      // The give-up path must not have run: no error toast, no leaveVoiceChannel,
      // and channel 9's "connected" state must still be intact.
      expect(errorCb).not.toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      expect(leaveVoiceChannel).not.toHaveBeenCalled();
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.channelId).toBe(9);
    });

    // v004, same-channel variant: re-joining the channel we are reconnecting
    // to leaves `signal.aborted` false (connectAndSetup's entry-point
    // leaveVoice(false) is skipped — the `_room` getter is null while
    // "reconnecting") AND `_currentChannelId` equal to ours, so only the
    // state-type check can tell the stale loop it no longer owns the session.
    it("skips give-up cleanup when the same channel was re-joined by a newer session", async () => {
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

      let connectCalls = 0;
      mockRoom.connect.mockImplementation(() => {
        connectCalls++;
        if (connectCalls >= 5) {
          // A fresh join for the SAME channel completed while the final
          // reconnect attempt was in flight.
          (session as any)._state = {
            type: "connected",
            room: mockRoom,
            channelId: 5,
            latestToken: "fresh-token",
            lastUrl: "/livekit",
            lastDirectUrl: "ws://localhost:7880",
          };
          // ...and the chat socket closes for good, so the loop breaks straight
          // into the post-loop give-up check instead of an in-loop checkpoint.
          session.setWsClient({ send: vi.fn(), getState: () => "disconnected" } as any);
        }
        return Promise.reject(new Error("always fails"));
      });

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      // Exhaust the fast attempts so the loop reaches the post-loop check.
      await vi.advanceTimersByTimeAsync(27_000);
      await reconnectPromise;

      expect(errorCb).not.toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      expect(leaveVoiceChannel).not.toHaveBeenCalled();
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.channelId).toBe(5);
      expect((session as any)._state.latestToken).toBe("fresh-token");
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

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000); // to the D-4 ceiling
      await reconnectPromise;

      expect(leaveVoiceChannel).toHaveBeenCalled();
    });

    // B1_voice_mic-3: the in-loop supersession checks (unlike the post-loop
    // give-up check) did not test `_state.type`, so a same-channel rejoin
    // that lands DURING the retry delay — before the loop's own in-flight
    // check runs — was not caught until the give-up path at the very end.
    // This exercises the very first in-loop checkpoint, right after the
    // delay, which the give-up-only tests above never reach.
    it("aborts before creating a room when a same-channel rejoin lands during the retry delay (zombie reconnect)", async () => {
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

      const reconnectPromise = (session as any).attemptAutoReconnect(
        "token",
        "/livekit",
        5,
        "ws://localhost:7880",
        ac.signal,
      );

      // A fresh, same-channel join completes DURING the retry delay, before
      // the loop's first in-flight guard has a chance to run.
      (session as any)._state = {
        type: "connected",
        room: mockRoom,
        channelId: 5,
        latestToken: "fresh-token",
        lastUrl: "/livekit",
        lastDirectUrl: "ws://localhost:7880",
      };

      await vi.advanceTimersByTimeAsync(3100);
      await reconnectPromise;

      // The zombie loop must never touch the live session: no second
      // connect(), and the live room/state must survive untouched.
      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect((session as any)._state.type).toBe("connected");
      expect((session as any)._state.latestToken).toBe("fresh-token");
    });

    it("cleans up reconnect room when signal aborts after connect resolves", async () => {
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
});
