import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attemptAutoReconnect, type ReconnectDeps } from "../../src/lib/livekitReconnect";
import { expectConsole } from "../helpers/console";

/** Each failed attempt logs one warning the console guard wants claimed. */
function claimFailedAttempts(n: number): void {
  for (let i = 0; i < n; i++) expectConsole("warn", /Auto-reconnect failed/);
}

// The slow retry phase (attempt 6+) refreshes the token before its delay. A
// loop superseded by an earlier failed attempt must not run that refresh: it
// would overwrite the shared token waiter and spend the live session's one
// refresh per 60 s.
describe("attemptAutoReconnect: superseded before the slow-phase token refresh", () => {
  const CHANNEL = 7;
  let state: { type: string; channelId: number; ac: AbortController | null };
  let ac: AbortController;
  let deps: ReconnectDeps;
  let refreshTokenAndWait: ReturnType<typeof vi.fn>;
  let createRoom: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    ac = new AbortController();
    state = { type: "reconnecting", channelId: CHANNEL, ac };
    refreshTokenAndWait = vi.fn().mockResolvedValue(undefined);
    createRoom = vi.fn().mockRejectedValue(new Error("sfu down"));
    deps = {
      getState: () => state,
      setState: vi.fn(),
      syncModuleRooms: vi.fn(),
      createRoom,
      refreshTokenAndWait,
      // Old enough that every slow attempt wants a fresh token.
      tokenAgeMs: () => 10 * 60_000,
      canKeepRetrying: () => true,
      serverMembership: async () => "held",
      leaveVoice: vi.fn(),
      onError: vi.fn(),
    } as unknown as ReconnectDeps;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs the five fast attempts, each failing, and stops once the fifth has failed. */
  async function failFastAttempts(onFifthFailed: () => void): Promise<{ loop: Promise<void> }> {
    createRoom.mockImplementation(() => {
      if (createRoom.mock.calls.length === 5) onFifthFailed();
      return Promise.reject(new Error("sfu down"));
    });
    const loop = attemptAutoReconnect("tok", "wss://x", CHANNEL, undefined, ac.signal, deps);
    await vi.advanceTimersByTimeAsync(5 * 6000);
    return { loop };
  }

  it("does not refresh the token when the user left during the fifth failed attempt", async () => {
    const { loop } = await failFastAttempts(() => ac.abort());
    await vi.advanceTimersByTimeAsync(60_000);
    await loop;

    expect(createRoom).toHaveBeenCalledTimes(5);
    expect(refreshTokenAndWait).not.toHaveBeenCalled();
    expect(deps.leaveVoice).not.toHaveBeenCalled();
    claimFailedAttempts(5);
  });

  it("does not refresh the token when a newer loop took over the shared state", async () => {
    const { loop } = await failFastAttempts(() => {
      state = { type: "reconnecting", channelId: CHANNEL, ac: new AbortController() };
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await loop;

    expect(refreshTokenAndWait).not.toHaveBeenCalled();
    expect(deps.leaveVoice).not.toHaveBeenCalled();
    claimFailedAttempts(5);
  });

  it("still refreshes the token for the live loop", async () => {
    const { loop } = await failFastAttempts(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshTokenAndWait).toHaveBeenCalledTimes(1);
    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    await loop;
    claimFailedAttempts(5);
  });
});
