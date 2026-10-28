import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Room } from "livekit-client";
import { expectConsole } from "../helpers/console";
import { captureLogs, type LogCapture } from "../helpers/log-capture";

const mocks = vi.hoisted(() => ({
  releaseRoom: vi.fn(),
  leaveVoiceChannel: vi.fn(),
  setJoinedVoiceStatus: vi.fn(),
  logIceConnectionInfo: vi.fn(),
}));

vi.mock("../../src/features/voice/releaseRoom", () => ({ releaseRoom: mocks.releaseRoom }));
vi.mock("@stores/voice.store", () => ({ leaveVoiceChannel: mocks.leaveVoiceChannel }));
vi.mock("@lib/roomEventHandlers", () => ({ setJoinedVoiceStatus: mocks.setJoinedVoiceStatus }));
vi.mock("@lib/livekitDiagnostics", () => ({ logIceConnectionInfo: mocks.logIceConnectionInfo }));

import { attemptAutoReconnect, type ReconnectDeps } from "../../src/lib/livekitReconnect";
import { savePref } from "../../src/lib/preferences";

const CHANNEL = 7;
const URL = "wss://sfu.example/livekit";
const RESOLVED = "wss://resolved.example/livekit";
const ABORTED = "Auto-reconnect aborted — user left or channel changed";
const CEILING_MS = 5 * 60_000;
const SLOW_DELAY_MS = 15_000;
const FAST_PHASE_MS = 27_000;
const TOKEN_REFRESH_AGE_MS = 4 * 60_000;

interface FakeState {
  type: string;
  channelId?: number;
  ac?: AbortController | null;
  latestToken?: string;
}

interface FakeRoom {
  connect: ReturnType<typeof vi.fn>;
  startAudio: ReturnType<typeof vi.fn>;
  switchActiveDevice: ReturnType<typeof vi.fn>;
}

function asRoom(room: FakeRoom): Room {
  return room as unknown as Room;
}

function claimFailures(n: number): void {
  for (let i = 0; i < n; i++) expectConsole("warn", "Auto-reconnect failed");
}

describe("attemptAutoReconnect loop", () => {
  let state: FakeState;
  let ac: AbortController;
  let room: FakeRoom;
  let logs: LogCapture;
  let skew: number;
  let deps: ReconnectDeps;
  let fn: {
    setState: ReturnType<typeof vi.fn>;
    syncModuleRooms: ReturnType<typeof vi.fn>;
    setModuleRooms: ReturnType<typeof vi.fn>;
    createRoom: ReturnType<typeof vi.fn>;
    resolveUrl: ReturnType<typeof vi.fn>;
    reannounceE2EE: ReturnType<typeof vi.fn>;
    restoreLocalVoiceState: ReturnType<typeof vi.fn>;
    startTokenRefreshTimer: ReturnType<typeof vi.fn>;
    requestTokenRefresh: ReturnType<typeof vi.fn>;
    refreshTokenAndWait: ReturnType<typeof vi.fn>;
    tokenAgeMs: ReturnType<typeof vi.fn>;
    canKeepRetrying: ReturnType<typeof vi.fn>;
    serverMembership: ReturnType<typeof vi.fn>;
    rejoinVoice: ReturnType<typeof vi.fn>;
    leaveVoice: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    isStateConnected: ReturnType<typeof vi.fn>;
    disconnectSupersededLocalRoom: ReturnType<typeof vi.fn>;
    setupAudioPipeline: ReturnType<typeof vi.fn>;
    reapplyMuteGain: ReturnType<typeof vi.fn>;
    clearPendingReconnectFields: ReturnType<typeof vi.fn>;
    noticeLostMedia: ReturnType<typeof vi.fn>;
    sweepPublications: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    const realNow = Date.now.bind(Date);
    skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    localStorage.clear();
    mocks.releaseRoom.mockReset().mockResolvedValue(undefined);
    mocks.leaveVoiceChannel.mockReset();
    mocks.setJoinedVoiceStatus.mockReset();
    mocks.logIceConnectionInfo.mockReset();
    logs = captureLogs();
    ac = new AbortController();
    state = { type: "reconnecting", channelId: CHANNEL, ac };
    room = {
      connect: vi.fn().mockResolvedValue(undefined),
      startAudio: vi.fn().mockResolvedValue(undefined),
      switchActiveDevice: vi.fn().mockResolvedValue(undefined),
    };
    fn = {
      setState: vi.fn(),
      syncModuleRooms: vi.fn(),
      setModuleRooms: vi.fn(),
      createRoom: vi.fn().mockResolvedValue(asRoom(room)),
      resolveUrl: vi.fn().mockResolvedValue(RESOLVED),
      reannounceE2EE: vi.fn().mockResolvedValue(undefined),
      restoreLocalVoiceState: vi.fn().mockResolvedValue(undefined),
      startTokenRefreshTimer: vi.fn(),
      requestTokenRefresh: vi.fn(),
      refreshTokenAndWait: vi.fn().mockResolvedValue(undefined),
      tokenAgeMs: vi.fn().mockReturnValue(0),
      canKeepRetrying: vi.fn().mockReturnValue(true),
      serverMembership: vi.fn().mockResolvedValue("held"),
      rejoinVoice: vi.fn(),
      leaveVoice: vi.fn(),
      onError: vi.fn(),
      isStateConnected: vi.fn().mockReturnValue(true),
      disconnectSupersededLocalRoom: vi.fn(),
      setupAudioPipeline: vi.fn(),
      reapplyMuteGain: vi.fn(),
      clearPendingReconnectFields: vi.fn(),
      noticeLostMedia: vi.fn(),
      sweepPublications: vi.fn(),
    };
    deps = { getState: () => state, ...fn } as unknown as ReconnectDeps;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function start(): Promise<void> {
    return attemptAutoReconnect("tok", URL, CHANNEL, undefined, ac.signal, deps);
  }

  /** Runs the loop through its first delay and lets the attempt finish. */
  async function runFirstAttempt(): Promise<void> {
    const loop = start();
    await vi.advanceTimersByTimeAsync(3000);
    await loop;
  }

  /** Starts the loop with five failing fast attempts so attempt 6 is next. */
  async function reachSlowPhase(
    onFifthFailure: () => void = () => {},
  ): Promise<{ loop: Promise<void> }> {
    fn.createRoom.mockImplementation(() => {
      if (fn.createRoom.mock.calls.length === 5) onFifthFailure();
      return Promise.reject(new Error("sfu down"));
    });
    const loop = start();
    await vi.advanceTimersByTimeAsync(FAST_PHASE_MS);
    return { loop };
  }

  async function finishWithAbort(loop: Promise<void>): Promise<void> {
    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    await loop;
  }

  function attemptsLogged(): unknown[] {
    return logs.find("Auto-reconnect attempt").map((e) => e.data);
  }

  describe("stops when a newer attempt or the user takes over", () => {
    it("stops after the delay when the channel changed", async () => {
      const loop = start();
      state = { type: "reconnecting", channelId: CHANNEL + 1, ac };
      await vi.advanceTimersByTimeAsync(3000);
      await loop;
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(logs.find(ABORTED)).toHaveLength(1);
    });

    it("stops after the delay when another loop owns the reconnecting state", async () => {
      const loop = start();
      state = { type: "reconnecting", channelId: CHANNEL, ac: new AbortController() };
      await vi.advanceTimersByTimeAsync(3000);
      await loop;
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(logs.find(ABORTED)).toHaveLength(1);
    });

    it("stops after the delay when the state is no longer reconnecting", async () => {
      const loop = start();
      state = { type: "idle" };
      await vi.advanceTimersByTimeAsync(3000);
      await loop;
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(logs.find(ABORTED)).toHaveLength(1);
    });

    it("stops after the delay when the user aborted", async () => {
      const loop = start();
      ac.abort();
      await vi.advanceTimersByTimeAsync(3000);
      await loop;
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(logs.find(ABORTED)).toHaveLength(1);
    });

    it("keeps going when a reconnecting state without a controller replaces a loop that started with none", async () => {
      state = { type: "idle" };
      const loop = start();
      state = { type: "reconnecting", channelId: CHANNEL, ac: null };
      await vi.advanceTimersByTimeAsync(3000);
      await finishWithAbort(loop);
      expect(fn.createRoom).toHaveBeenCalledTimes(1);
      expect(logs.find(ABORTED).length).toBeLessThanOrEqual(1);
    });

    it("stops when the user left while the membership was being read", async () => {
      fn.serverMembership.mockImplementation(async () => {
        ac.abort();
        return "held";
      });
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      await loop;
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(logs.find(ABORTED)).toHaveLength(1);
      expect(fn.rejoinVoice).not.toHaveBeenCalled();
    });

    it("logs the attempt number before waiting", async () => {
      await runFirstAttempt();
      expect(attemptsLogged()).toEqual([{ attempt: 1 }]);
    });
  });

  describe("slow phase", () => {
    it("starts the sixth attempt when the ceiling is reached exactly", async () => {
      const { loop } = await reachSlowPhase(() => {
        skew = CEILING_MS - SLOW_DELAY_MS - FAST_PHASE_MS;
      });
      expect(attemptsLogged()).toContainEqual({ attempt: 6 });
      expect(fn.leaveVoice).not.toHaveBeenCalled();
      await finishWithAbort(loop);
      claimFailures(5);
    });

    it("gives up when the next attempt would pass the ceiling", async () => {
      const { loop } = await reachSlowPhase(() => {
        skew = CEILING_MS - SLOW_DELAY_MS - FAST_PHASE_MS + 1;
      });
      await loop;
      expect(attemptsLogged()).not.toContainEqual({ attempt: 6 });
      expect(fn.leaveVoice).toHaveBeenCalledTimes(1);
      claimFailures(5);
      expectConsole("error", "Auto-reconnect giving up");
    });

    it("does not refresh the token when its age plus the delay equals the limit", async () => {
      fn.tokenAgeMs.mockReturnValue(TOKEN_REFRESH_AGE_MS - SLOW_DELAY_MS);
      const { loop } = await reachSlowPhase();
      expect(attemptsLogged()).toContainEqual({ attempt: 6 });
      expect(fn.refreshTokenAndWait).not.toHaveBeenCalled();
      await finishWithAbort(loop);
      claimFailures(5);
    });

    it("refreshes the token when its age plus the delay passes the limit", async () => {
      fn.tokenAgeMs.mockReturnValue(TOKEN_REFRESH_AGE_MS - SLOW_DELAY_MS + 1);
      const { loop } = await reachSlowPhase();
      expect(fn.refreshTokenAndWait).toHaveBeenCalledTimes(1);
      await finishWithAbort(loop);
      claimFailures(5);
    });

    it("stops before the slow wait when the user left during the fifth failure", async () => {
      fn.tokenAgeMs.mockReturnValue(10 * 60_000);
      const { loop } = await reachSlowPhase(() => ac.abort());
      await vi.advanceTimersByTimeAsync(60_000);
      await loop;
      expect(logs.find(ABORTED)).toHaveLength(1);
      expect(fn.createRoom).toHaveBeenCalledTimes(5);
      expect(fn.serverMembership).toHaveBeenCalledTimes(5);
      expect(attemptsLogged()).not.toContainEqual({ attempt: 6 });
      claimFailures(5);
    });

    it("stops without refreshing when the user left while the membership was read for the refresh", async () => {
      fn.tokenAgeMs.mockReturnValue(10 * 60_000);
      fn.serverMembership.mockImplementation(async () => {
        if (fn.createRoom.mock.calls.length >= 5) ac.abort();
        return "held";
      });
      const { loop } = await reachSlowPhase();
      await vi.advanceTimersByTimeAsync(60_000);
      await loop;
      expect(fn.refreshTokenAndWait).not.toHaveBeenCalled();
      expect(logs.find(ABORTED)).toHaveLength(1);
      expect(attemptsLogged()).not.toContainEqual({ attempt: 6 });
      claimFailures(5);
    });
  });

  describe("server membership", () => {
    it("rejoins instead of reconnecting when the server released the membership", async () => {
      fn.serverMembership.mockResolvedValue("released");
      await runFirstAttempt();
      expect(fn.rejoinVoice).toHaveBeenCalledTimes(1);
      expect(fn.createRoom).not.toHaveBeenCalled();
      const entries = logs.find("Auto-reconnect: server membership gone — rejoining");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toEqual({ channelId: CHANNEL });
    });
  });

  describe("giving up", () => {
    it("leaves voice and reports the loss when retrying is no longer allowed", async () => {
      fn.canKeepRetrying.mockReturnValue(false);
      await runFirstAttempt();
      expect(fn.leaveVoice).toHaveBeenCalledTimes(1);
      expect(mocks.leaveVoiceChannel).toHaveBeenCalledTimes(1);
      expect(fn.onError).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      expect(fn.createRoom).not.toHaveBeenCalled();
      expectConsole("error", "Auto-reconnect giving up");
    });

    it("leaves the live session alone when a newer attempt took over before giving up", async () => {
      fn.canKeepRetrying.mockImplementation(() => {
        state = { type: "reconnecting", channelId: CHANNEL, ac: new AbortController() };
        return false;
      });
      await runFirstAttempt();
      expect(fn.leaveVoice).not.toHaveBeenCalled();
      expect(mocks.leaveVoiceChannel).not.toHaveBeenCalled();
      expect(fn.onError).not.toHaveBeenCalled();
      expect(logs.find("Auto-reconnect give-up skipped — superseded")).toHaveLength(1);
    });

    it("leaves the live session alone when the state went idle before giving up", async () => {
      fn.canKeepRetrying.mockImplementation(() => {
        state = { type: "idle" };
        return false;
      });
      await runFirstAttempt();
      expect(fn.leaveVoice).not.toHaveBeenCalled();
      expect(logs.find("Auto-reconnect give-up skipped — superseded")).toHaveLength(1);
    });
  });

  describe("an attempt that is superseded part way", () => {
    it("stops after the room is created and releases that room", async () => {
      fn.createRoom.mockImplementation(async () => {
        ac.abort();
        return asRoom(room);
      });
      await runFirstAttempt();
      expect(logs.find("Auto-reconnect aborted after room creation")).toHaveLength(1);
      expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
      expect(fn.resolveUrl).not.toHaveBeenCalled();
      expect(fn.setModuleRooms).not.toHaveBeenCalled();
    });

    it("stops after the URL is resolved and releases the room", async () => {
      fn.resolveUrl.mockImplementation(async () => {
        ac.abort();
        return RESOLVED;
      });
      await runFirstAttempt();
      expect(logs.find("Auto-reconnect aborted before room connect")).toHaveLength(1);
      expect(fn.reannounceE2EE).not.toHaveBeenCalled();
      expect(room.connect).not.toHaveBeenCalled();
      expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
    });

    it("stops after the E2EE announce without connecting", async () => {
      fn.reannounceE2EE.mockImplementation(async () => {
        ac.abort();
      });
      await runFirstAttempt();
      expect(room.connect).not.toHaveBeenCalled();
      expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
    });

    it("stops after connecting and does not install the connected state", async () => {
      room.connect.mockImplementation(async () => {
        ac.abort();
      });
      await runFirstAttempt();
      expect(logs.find("Auto-reconnect aborted after room connect")).toHaveLength(1);
      expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
      expect(fn.restoreLocalVoiceState).not.toHaveBeenCalled();
      expect(fn.setState).not.toHaveBeenCalledWith(expect.objectContaining({ type: "connected" }));
    });

    it("logs when releasing the aborted room fails and still syncs the modules", async () => {
      fn.createRoom.mockImplementation(async () => {
        ac.abort();
        state = { type: "idle" };
        return asRoom(room);
      });
      mocks.releaseRoom.mockRejectedValue(new Error("close failed"));
      await runFirstAttempt();
      const entries = logs.find("Failed to disconnect room after reconnect abort");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.level).toBe("warn");
      expect(fn.syncModuleRooms).toHaveBeenCalledTimes(1);
      expectConsole("warn", "Failed to disconnect room after reconnect abort");
    });

    const abortedCases: Array<[string, () => FakeState, number]> = [
      ["the state went idle", () => ({ type: "idle" }), 1],
      ["the state is connected", () => ({ type: "connected" }), 1],
      [
        "a newer attempt owns the state",
        () => ({ type: "reconnecting", channelId: CHANNEL, ac: new AbortController() }),
        0,
      ],
    ];

    it.each(abortedCases)(
      "after room creation, re-syncs the modules only when it is safe: %s",
      async (_name, next, syncs) => {
        fn.createRoom.mockImplementation(async () => {
          state = next();
          return asRoom(room);
        });
        await runFirstAttempt();
        expect(fn.syncModuleRooms).toHaveBeenCalledTimes(syncs);
      },
    );

    it("after room creation, leaves the modules when only the user aborted a still-current state", async () => {
      fn.createRoom.mockImplementation(async () => {
        ac.abort();
        return asRoom(room);
      });
      await runFirstAttempt();
      expect(fn.syncModuleRooms).not.toHaveBeenCalled();
    });
  });

  describe("a successful attempt", () => {
    it("marks the state as reconnecting before pointing the modules at the new room", async () => {
      const order: string[] = [];
      fn.setState.mockImplementation((s: FakeState) => order.push(`set:${s.type}`));
      fn.setModuleRooms.mockImplementation(() => order.push("modules"));
      await runFirstAttempt();
      expect(order.slice(0, 3)).toEqual(["set:reconnecting", "modules", "set:connected"]);
      expect(fn.setState).toHaveBeenNthCalledWith(1, {
        type: "reconnecting",
        channelId: CHANNEL,
        ac,
      });
      expect(fn.setModuleRooms).toHaveBeenCalledWith(room);
    });

    it("installs the connected state with the token the state carries", async () => {
      state = { type: "reconnecting", channelId: CHANNEL, ac, latestToken: "fresh" };
      await runFirstAttempt();
      expect(room.connect).toHaveBeenCalledWith(RESOLVED, "fresh", expect.anything());
      expect(fn.setState).toHaveBeenCalledWith({
        type: "connected",
        room,
        channelId: CHANNEL,
        latestToken: "fresh",
        lastUrl: URL,
        lastDirectUrl: undefined,
      });
    });

    it("logs the success with the attempt, channel and redacted URL", async () => {
      fn.resolveUrl.mockResolvedValue(`wss://127.0.0.1:7881/${"a".repeat(64)}/rtc`);
      await runFirstAttempt();
      const entries = logs.find("Auto-reconnect succeeded");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toEqual({
        attempt: 1,
        channelId: CHANNEL,
        url: "wss://127.0.0.1:7881/…/rtc",
      });
    });

    it("sweeps publications and logs the ICE details for the new room", async () => {
      await runFirstAttempt();
      expect(mocks.setJoinedVoiceStatus).toHaveBeenCalledWith(room);
      expect(fn.sweepPublications).toHaveBeenCalledWith(room);
      expect(mocks.logIceConnectionInfo).toHaveBeenCalledTimes(1);
      expect(mocks.logIceConnectionInfo).toHaveBeenCalledWith(room);
    });

    it("logs and carries on when audio cannot start", async () => {
      room.startAudio.mockRejectedValue(new Error("autoplay blocked"));
      await runFirstAttempt();
      const entries = logs.find("Failed to start audio after reconnect");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toMatchObject({ error: "autoplay blocked" });
      expect(fn.noticeLostMedia).toHaveBeenCalledTimes(1);
    });

    it("finishes the tail: audio pipeline, mute gain, timers, pending fields and notice", async () => {
      await runFirstAttempt();
      expect(fn.restoreLocalVoiceState).toHaveBeenCalledWith("reconnect");
      expect(fn.setupAudioPipeline).toHaveBeenCalledTimes(1);
      expect(fn.reapplyMuteGain).toHaveBeenCalledTimes(1);
      expect(fn.startTokenRefreshTimer).toHaveBeenCalledTimes(1);
      expect(fn.clearPendingReconnectFields).toHaveBeenCalledTimes(1);
      expect(fn.requestTokenRefresh).toHaveBeenCalledTimes(1);
      expect(fn.noticeLostMedia).toHaveBeenCalledTimes(1);
      expect(fn.leaveVoice).not.toHaveBeenCalled();
    });

    it("switches to the saved input device before restoring local voice state", async () => {
      savePref("audioInputDevice", "mic-1");
      const order: string[] = [];
      room.switchActiveDevice.mockImplementation(async (kind: string) => {
        order.push(kind);
      });
      fn.restoreLocalVoiceState.mockImplementation(async () => {
        order.push("restore");
      });
      await runFirstAttempt();
      expect(room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-1", false);
      expect(order).toEqual(["audioinput", "restore"]);
    });

    it("switches to the saved output device after restoring local voice state", async () => {
      savePref("audioOutputDevice", "spk-1");
      await runFirstAttempt();
      expect(room.switchActiveDevice).toHaveBeenCalledTimes(1);
      expect(room.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "spk-1");
    });

    it("leaves devices alone when none are saved", async () => {
      await runFirstAttempt();
      expect(room.switchActiveDevice).not.toHaveBeenCalled();
    });

    it("keeps going when the saved input device is unavailable", async () => {
      savePref("audioInputDevice", "mic-1");
      room.switchActiveDevice.mockRejectedValue(new Error("gone"));
      await runFirstAttempt();
      expect(logs.find("Reconnect: saved input device unavailable, using default")).toHaveLength(1);
      expect(fn.setupAudioPipeline).toHaveBeenCalledTimes(1);
      expectConsole("warn", "saved input device unavailable");
    });

    it("keeps going when the saved output device is unavailable", async () => {
      savePref("audioOutputDevice", "spk-1");
      room.switchActiveDevice.mockRejectedValue(new Error("gone"));
      await runFirstAttempt();
      expect(logs.find("Reconnect: saved output device unavailable, using default")).toHaveLength(
        1,
      );
      expect(fn.setupAudioPipeline).toHaveBeenCalledTimes(1);
      expectConsole("warn", "saved output device unavailable");
    });
  });

  describe("an attempt superseded after the connected state was installed", () => {
    function expectTailStopped(message: string): void {
      const entries = logs.find(message);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toEqual({ channelId: CHANNEL });
      expect(fn.disconnectSupersededLocalRoom).toHaveBeenCalledTimes(1);
      expect(fn.disconnectSupersededLocalRoom).toHaveBeenCalledWith(room);
      expect(fn.setupAudioPipeline).not.toHaveBeenCalled();
      expect(fn.reapplyMuteGain).not.toHaveBeenCalled();
      expect(fn.startTokenRefreshTimer).not.toHaveBeenCalled();
      expect(fn.clearPendingReconnectFields).not.toHaveBeenCalled();
      expect(fn.requestTokenRefresh).not.toHaveBeenCalled();
      expect(fn.noticeLostMedia).not.toHaveBeenCalled();
    }

    it("stops after the input device switch", async () => {
      fn.isStateConnected.mockReturnValueOnce(false);
      await runFirstAttempt();
      expectTailStopped("Auto-reconnect: superseded after audioinput switch — aborting tail");
      expect(fn.restoreLocalVoiceState).not.toHaveBeenCalled();
    });

    it("stops after restoring local voice state, before the output device switch", async () => {
      savePref("audioOutputDevice", "spk-1");
      fn.isStateConnected.mockReturnValueOnce(true).mockReturnValueOnce(false);
      await runFirstAttempt();
      expectTailStopped("Auto-reconnect: superseded after restoreLocalVoiceState — aborting tail");
      expect(fn.restoreLocalVoiceState).toHaveBeenCalledTimes(1);
      expect(room.switchActiveDevice).not.toHaveBeenCalled();
    });

    it("stops after the output device switch", async () => {
      savePref("audioOutputDevice", "spk-1");
      fn.isStateConnected
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      await runFirstAttempt();
      expectTailStopped("Auto-reconnect: superseded after audiooutput switch — aborting tail");
      expect(room.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "spk-1");
    });
  });

  describe("a failed attempt", () => {
    it("logs the attempt, URL and error", async () => {
      room.connect.mockRejectedValue(new Error("handshake failed"));
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      const entries = logs.find("Auto-reconnect failed");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toMatchObject({
        attempt: 1,
        url: URL,
        error: { error: "handshake failed" },
      });
      await finishWithAbort(loop);
      claimFailures(1);
    });

    it("releases the room it created and logs when that release fails", async () => {
      room.connect.mockRejectedValue(new Error("handshake failed"));
      mocks.releaseRoom.mockRejectedValue(new Error("close failed"));
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
      expect(logs.find("Failed to disconnect room after reconnect failure")).toHaveLength(1);
      await finishWithAbort(loop);
      claimFailures(1);
      expectConsole("warn", "Failed to disconnect room after reconnect failure");
    });

    it("does not release a room when none was created", async () => {
      fn.createRoom.mockRejectedValue(new Error("no room"));
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(mocks.releaseRoom).not.toHaveBeenCalled();
      await finishWithAbort(loop);
      claimFailures(1);
    });

    it("keeps the reconnecting state and re-syncs the modules when still current", async () => {
      fn.createRoom.mockRejectedValue(new Error("sfu down"));
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fn.setState).toHaveBeenCalledTimes(1);
      expect(fn.setState).toHaveBeenCalledWith({ type: "reconnecting", channelId: CHANNEL, ac });
      expect(fn.syncModuleRooms).toHaveBeenCalledTimes(1);
      await finishWithAbort(loop);
      claimFailures(1);
    });

    const failedCases: Array<[string, () => FakeState, number]> = [
      ["the state went idle", () => ({ type: "idle" }), 1],
      ["the state is connected", () => ({ type: "connected" }), 1],
      [
        "a newer attempt owns the state",
        () => ({ type: "reconnecting", channelId: CHANNEL, ac: new AbortController() }),
        0,
      ],
    ];

    it.each(failedCases)(
      "re-syncs the modules only when it is safe: %s",
      async (_name, next, syncs) => {
        fn.createRoom.mockImplementation(() => {
          state = next();
          return Promise.reject(new Error("sfu down"));
        });
        const loop = start();
        await vi.advanceTimersByTimeAsync(3000);
        expect(fn.syncModuleRooms).toHaveBeenCalledTimes(syncs);
        if (next().type !== "reconnecting") {
          expect(fn.setState).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(60_000);
        await loop;
        claimFailures(1);
      },
    );

    it("does not re-sync the modules for a failure after the user left a still-current state", async () => {
      fn.createRoom.mockImplementation(() => {
        ac.abort();
        return Promise.reject(new Error("sfu down"));
      });
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fn.syncModuleRooms).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      await loop;
      claimFailures(1);
    });
  });
});
