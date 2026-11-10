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
vi.mock("@lib/voice/roomEventHandlers", () => ({
  setJoinedVoiceStatus: mocks.setJoinedVoiceStatus,
}));
vi.mock("@lib/voice/livekitDiagnostics", () => ({
  logIceConnectionInfo: mocks.logIceConnectionInfo,
}));

import { attemptAutoReconnect } from "../../src/lib/voice/livekitReconnect";
import type { ReconnectDeps } from "../../src/features/voice/reconnectDeps";
import { savePref } from "../../src/lib/prefs/preferences";

const CHANNEL = 7;
const URL = "wss://sfu.example/livekit";
const RESOLVED = "wss://resolved.example/livekit";
const ABORTED = "Auto-reconnect aborted — user left or channel changed";
const CEILING_MS = 5 * 60_000;
const SLOW_DELAY_MS = 15_000;
const FAST_PHASE_MS = 27_000;
const TOKEN_REFRESH_AGE_MS = 4 * 60_000;

interface FakeRoom {
  connect: ReturnType<typeof vi.fn>;
  startAudio: ReturnType<typeof vi.fn>;
  switchActiveDevice: ReturnType<typeof vi.fn>;
}

interface FakeState {
  type: string;
  channelId?: number;
  ac?: AbortController | null;
  latestToken?: string;
  room?: FakeRoom | Room;
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
      // As the session does: a write replaces the shared state, and the
      // connected check reads it.
      setState: vi.fn((next: FakeState) => {
        state = next;
      }),
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
      isStateConnected: vi.fn(
        (channelId: number, owned: Room) =>
          state.type === "connected" && state.channelId === channelId && state.room === owned,
      ),
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

    it("does not rejoin a released membership when a newer attempt took over during the read", async () => {
      const newer: FakeState = { type: "connecting" };
      fn.serverMembership.mockImplementation(async () => {
        state = newer;
        return "released";
      });
      await runFirstAttempt();
      expect(fn.rejoinVoice).not.toHaveBeenCalled();
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(state).toBe(newer);
      expect(logs.find(ABORTED)).toHaveLength(1);
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

  describe("steps without a dedicated case", () => {
    it("falls back to the token the loop was started with when the state carries none", async () => {
      await runFirstAttempt();
      expect(room.connect).toHaveBeenCalledWith(RESOLVED, "tok", expect.anything());
    });

    it("skips the attempt and tries again on the next delay while the membership is unknown", async () => {
      fn.serverMembership.mockResolvedValueOnce("unknown");
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(fn.rejoinVoice).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5999);
      expect(fn.createRoom).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await loop;
      expect(attemptsLogged()).toEqual([{ attempt: 1 }, { attempt: 2 }]);
      expect(fn.createRoom).toHaveBeenCalledTimes(1);
      expect(fn.setState).toHaveBeenCalledWith(expect.objectContaining({ type: "connected" }));
    });

    it("waits out each failed attempt with the doubling delay, capped at six seconds", async () => {
      fn.createRoom.mockRejectedValue(new Error("sfu down"));
      const loop = start();
      await vi.advanceTimersByTimeAsync(2999);
      expect(fn.createRoom).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fn.createRoom).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5999);
      expect(fn.createRoom).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn.createRoom).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(6000);
      expect(fn.createRoom).toHaveBeenCalledTimes(3);
      await finishWithAbort(loop);
      claimFailures(3);
    });

    it("does not read the roster for a refresh when retrying stopped being allowed in the slow phase", async () => {
      fn.tokenAgeMs.mockReturnValue(10 * 60_000);
      fn.canKeepRetrying.mockImplementation(() => fn.createRoom.mock.calls.length < 5);
      const { loop } = await reachSlowPhase();
      await loop;
      expect(attemptsLogged()).not.toContainEqual({ attempt: 6 });
      expect(fn.serverMembership).toHaveBeenCalledTimes(5);
      expect(fn.refreshTokenAndWait).not.toHaveBeenCalled();
      expect(fn.leaveVoice).toHaveBeenCalledTimes(1);
      claimFailures(5);
      expectConsole("error", "Auto-reconnect giving up");
    });

    it("does not refresh the token when the roster does not show the membership as held", async () => {
      fn.tokenAgeMs.mockReturnValue(10 * 60_000);
      fn.serverMembership.mockImplementation(async () =>
        fn.createRoom.mock.calls.length >= 5 ? "unknown" : "held",
      );
      const { loop } = await reachSlowPhase();
      expect(fn.refreshTokenAndWait).not.toHaveBeenCalled();
      expect(attemptsLogged()).toContainEqual({ attempt: 6 });
      await finishWithAbort(loop);
      claimFailures(5);
    });

    it("keeps the current token and starts the attempt when the token refresh fails", async () => {
      fn.tokenAgeMs.mockReturnValue(10 * 60_000);
      fn.refreshTokenAndWait.mockRejectedValue(new Error("refresh failed"));
      const { loop } = await reachSlowPhase();
      expect(fn.refreshTokenAndWait).toHaveBeenCalledTimes(1);
      expect(attemptsLogged()).toContainEqual({ attempt: 6 });
      await vi.advanceTimersByTimeAsync(SLOW_DELAY_MS);
      expect(fn.createRoom).toHaveBeenCalledTimes(6);
      expect(fn.leaveVoice).not.toHaveBeenCalled();
      await finishWithAbort(loop);
      claimFailures(6);
      // Attempts 6 and 7 each asked for a token before their wait.
      expectConsole("warn", "token refresh failed — keeping the current token");
      expectConsole("warn", "token refresh failed — keeping the current token");
    });

    it("stops without an attempt when the user left during a token refresh that failed", async () => {
      fn.tokenAgeMs.mockReturnValue(10 * 60_000);
      fn.refreshTokenAndWait.mockImplementation(() => {
        ac.abort();
        return Promise.reject(new Error("refresh failed"));
      });
      const { loop } = await reachSlowPhase();
      await vi.advanceTimersByTimeAsync(60_000);
      await loop;
      expect(fn.createRoom).toHaveBeenCalledTimes(5);
      expect(fn.leaveVoice).not.toHaveBeenCalled();
      expect(logs.find(ABORTED)).toHaveLength(1);
      claimFailures(5);
      expectConsole("warn", "token refresh failed — keeping the current token");
    });

    const failedReads: Array<[string, () => Promise<string>]> = [
      ["rejects", () => Promise.reject(new Error("roster failed"))],
      [
        "throws at once",
        () => {
          throw new Error("roster failed");
        },
      ],
    ];

    it.each(failedReads)(
      "skips the attempt and tries again on the next delay when the membership read %s",
      async (_name, failedRead) => {
        fn.serverMembership.mockImplementationOnce(failedRead);
        const loop = start();
        await vi.advanceTimersByTimeAsync(3000);
        expect(fn.createRoom).not.toHaveBeenCalled();
        expect(fn.rejoinVoice).not.toHaveBeenCalled();
        expect(fn.leaveVoice).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(6000);
        await loop;
        expect(attemptsLogged()).toEqual([{ attempt: 1 }, { attempt: 2 }]);
        expect(fn.createRoom).toHaveBeenCalledTimes(1);
        expect(state.type).toBe("connected");
        expectConsole("warn", "membership read failed — treating it as unknown");
      },
    );

    it("does not refresh the token when the membership read for the refresh fails", async () => {
      fn.tokenAgeMs.mockReturnValue(10 * 60_000);
      fn.serverMembership.mockImplementation(async () => {
        if (fn.createRoom.mock.calls.length >= 5) throw new Error("roster failed");
        return "held";
      });
      const { loop } = await reachSlowPhase();
      expect(fn.refreshTokenAndWait).not.toHaveBeenCalled();
      expect(attemptsLogged()).toContainEqual({ attempt: 6 });
      await finishWithAbort(loop);
      expect(fn.createRoom).toHaveBeenCalledTimes(5);
      claimFailures(5);
      expectConsole("warn", "membership read failed — treating it as unknown");
    });

    it("gives up at the ceiling when the membership read never works", async () => {
      fn.serverMembership.mockRejectedValue(new Error("roster failed"));
      const loop = start();
      await vi.advanceTimersByTimeAsync(CEILING_MS);
      await loop;
      expect(fn.createRoom).not.toHaveBeenCalled();
      expect(fn.leaveVoice).toHaveBeenCalledTimes(1);
      expect(fn.onError).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
      const reads = fn.serverMembership.mock.calls.length;
      expect(reads).toBeGreaterThan(5);
      for (let i = 0; i < reads; i++) expectConsole("warn", "membership read failed");
      expectConsole("error", "Auto-reconnect giving up");
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

  describe("a failure after the connected state was installed", () => {
    const LATE = "Auto-reconnect failed after connecting — leaving voice";
    const lateFailures: Array<[string, () => void]> = [
      [
        "sweeping the publications",
        () =>
          fn.sweepPublications.mockImplementation(() => {
            throw new Error("sweep broke");
          }),
      ],
      [
        "restoring local voice state",
        () => fn.restoreLocalVoiceState.mockRejectedValue(new Error("restore broke")),
      ],
      [
        "building the audio pipeline",
        () =>
          fn.setupAudioPipeline.mockImplementation(() => {
            throw new Error("pipeline broke");
          }),
      ],
      [
        "the last step of the tail",
        () =>
          fn.noticeLostMedia.mockImplementation(() => {
            throw new Error("notice broke");
          }),
      ],
    ];

    it.each(lateFailures)(
      "ends the call instead of keeping a connected state on a dead room: %s",
      async (_name, arm) => {
        arm();
        fn.leaveVoice.mockImplementation(() => {
          state = { type: "idle" };
        });
        await runFirstAttempt();
        expect(fn.leaveVoice).toHaveBeenCalledTimes(1);
        expect(mocks.leaveVoiceChannel).toHaveBeenCalledTimes(1);
        expect(fn.onError).toHaveBeenCalledTimes(1);
        expect(fn.onError).toHaveBeenCalledWith("Voice connection lost — failed to reconnect");
        expect(state).toEqual({ type: "idle" });
        // The session's own leave tears the room down; the attempt does not
        // release it a second time, restate "reconnecting" or try again.
        expect(mocks.releaseRoom).not.toHaveBeenCalled();
        expect(fn.setState.mock.calls.at(-1)?.[0]).toMatchObject({ type: "connected" });
        expect(logs.find("Auto-reconnect failed")).toHaveLength(0);
        const entries = logs.find(LATE);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.data).toMatchObject({ attempt: 1 });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fn.createRoom).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expectConsole("error", LATE);
      },
    );

    it("counts a connected write that fails as an ordinary failed attempt and tries again", async () => {
      // The state is still this loop's "reconnecting": there is no session to end.
      fn.setState.mockImplementationOnce((next: FakeState) => {
        state = next;
      });
      fn.setState.mockImplementationOnce(() => {
        throw new Error("write broke");
      });
      const loop = start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fn.leaveVoice).not.toHaveBeenCalled();
      expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
      expect(logs.find("Auto-reconnect failed")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(6000);
      await loop;
      expect(fn.createRoom).toHaveBeenCalledTimes(2);
      expect(state.type).toBe("connected");
      expect(fn.noticeLostMedia).toHaveBeenCalledTimes(1);
      claimFailures(1);
    });

    const newerOwners: Array<[string, () => FakeState, number]> = [
      [
        "a session on another channel",
        () => ({ type: "connected", channelId: CHANNEL + 1, room: asRoom({ ...room }) }),
        1,
      ],
      [
        "a new session on the same channel",
        () => ({ type: "connected", channelId: CHANNEL, room: asRoom({ ...room }) }),
        1,
      ],
      [
        "a newer reconnect loop",
        () => ({ type: "reconnecting", channelId: CHANNEL, ac: new AbortController() }),
        0,
      ],
      ["a join in progress", () => ({ type: "connecting" }), 0],
      ["a leave", () => ({ type: "idle" }), 1],
    ];

    it.each(newerOwners)(
      "releases only its own room when the failure comes after %s took the state",
      async (_name, next, syncs) => {
        const newer = next();
        fn.restoreLocalVoiceState.mockImplementation(async () => {
          state = newer;
          throw new Error("restore broke");
        });
        const loop = start();
        await vi.advanceTimersByTimeAsync(3000);
        expect(fn.leaveVoice).not.toHaveBeenCalled();
        expect(mocks.leaveVoiceChannel).not.toHaveBeenCalled();
        expect(fn.onError).not.toHaveBeenCalled();
        expect(mocks.releaseRoom).toHaveBeenCalledTimes(1);
        expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
        expect(fn.syncModuleRooms).toHaveBeenCalledTimes(syncs);
        expect(logs.find(LATE)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(60_000);
        await loop;
        expect(fn.createRoom).toHaveBeenCalledTimes(1);
        // Not one write after the takeover: the state is the newer owner's.
        expect(state).toBe(newer);
        expect(fn.setState.mock.calls.at(-1)?.[0]).toMatchObject({ type: "connected" });
        claimFailures(1);
      },
    );
  });

  describe("a newer attempt takes the shared state inside an attempt's await", () => {
    type Step = keyof typeof fn | "connect";

    /** Each await of an attempt, with the steps that must not run after it. */
    const awaits: Array<[string, Step, Step[]]> = [
      [
        "creating the room",
        "createRoom",
        ["setModuleRooms", "resolveUrl", "reannounceE2EE", "connect"],
      ],
      ["resolving the URL", "resolveUrl", ["reannounceE2EE", "connect"]],
      ["announcing the E2EE key", "reannounceE2EE", ["connect"]],
      [
        "connecting the room",
        "connect",
        ["sweepPublications", "restoreLocalVoiceState", "setupAudioPipeline"],
      ],
    ];

    /** Who took the state, and whether the modules are re-synced to it. */
    const takeovers: Array<[string, () => FakeState, number]> = [
      [
        "a newer reconnect loop",
        () => ({ type: "reconnecting", channelId: CHANNEL, ac: new AbortController() }),
        0,
      ],
      ["a join to another channel", () => ({ type: "connecting" }), 0],
      [
        "a new session on the same channel",
        () => ({ type: "connected", channelId: CHANNEL, room: asRoom({ ...room }) }),
        1,
      ],
    ];

    function step(name: Step): ReturnType<typeof vi.fn> {
      return name === "connect" ? room.connect : fn[name];
    }

    const results: Record<string, unknown> = { createRoom: undefined, resolveUrl: RESOLVED };

    describe.each(awaits)("while %s", (_awaitName, during, never) => {
      it.each(takeovers)(
        "stops, releases only its own room and leaves the state to %s",
        async (_name, next, syncs) => {
          const newer = next();
          let writesBefore = -1;
          step(during).mockImplementation(async () => {
            writesBefore = fn.setState.mock.calls.length;
            state = newer;
            return during === "createRoom" ? asRoom(room) : results[during];
          });
          await runFirstAttempt();

          // Not one write after the takeover: the state is the newer owner's.
          expect(state).toBe(newer);
          expect(fn.setState).toHaveBeenCalledTimes(writesBefore);
          expect(fn.setState).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "connected" }),
          );
          for (const later of never) expect(step(later)).not.toHaveBeenCalled();
          // Its own room only, and never the session-wide teardown.
          expect(mocks.releaseRoom).toHaveBeenCalledTimes(1);
          expect(mocks.releaseRoom).toHaveBeenCalledWith(room);
          expect(fn.disconnectSupersededLocalRoom).not.toHaveBeenCalled();
          expect(fn.leaveVoice).not.toHaveBeenCalled();
          expect(mocks.leaveVoiceChannel).not.toHaveBeenCalled();
          expect(fn.rejoinVoice).not.toHaveBeenCalled();
          expect(fn.onError).not.toHaveBeenCalled();
          expect(fn.startTokenRefreshTimer).not.toHaveBeenCalled();
          expect(fn.requestTokenRefresh).not.toHaveBeenCalled();
          expect(fn.syncModuleRooms).toHaveBeenCalledTimes(syncs);
          // The loop is over: no wait is pending and nothing tries again.
          expect(vi.getTimerCount()).toBe(0);
          expect(fn.createRoom).toHaveBeenCalledTimes(1);
          expect(logs.find("Auto-reconnect failed")).toHaveLength(0);
        },
      );
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
        // A superseded attempt writes nothing, a newer loop's state included.
        expect(fn.setState).not.toHaveBeenCalled();
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
