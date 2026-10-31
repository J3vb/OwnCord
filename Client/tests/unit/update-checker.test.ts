import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";

const { mockCheckForUpdate } = vi.hoisted(() => ({ mockCheckForUpdate: vi.fn() }));

vi.mock("@lib/logger", () => loggerMock());

vi.mock("@lib/net/updater", () => ({ checkForUpdate: mockCheckForUpdate }));

import {
  createUpdateChecker,
  getActiveUpdateChecker,
  UPDATE_CHECK_INTERVAL_MS,
  MIN_BACKGROUND_GAP_MS,
  RECONNECT_SPREAD_MS,
  RETRY_MIN_MS,
  RETRY_SPREAD_MS,
  MAX_RETRIES,
  type UpdateChecker,
  type UpdateOutcome,
} from "../../src/features/updates/updateChecker";

const NONE = { available: false, version: null, body: null, manual_upgrade: false };
const V2 = { available: true, version: "2.0.0", body: "notes", manual_upgrade: false };

describe("createUpdateChecker", () => {
  let checker: UpdateChecker;
  let outcomes: Array<{ outcome: UpdateOutcome; reason: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCheckForUpdate.mockReset();
    mockCheckForUpdate.mockResolvedValue(NONE);
    outcomes = [];
    checker = createUpdateChecker({ serverUrl: "https://s.example", random: () => 0.5 });
    checker.onOutcome((outcome, reason) => outcomes.push({ outcome, reason }));
  });

  afterEach(() => {
    checker.stop();
    vi.useRealTimers();
  });

  it("re-checks on the interval while the app keeps running", async () => {
    checker.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    expect(mockCheckForUpdate).toHaveBeenCalledWith("https://s.example");
    expect(outcomes.at(-1)?.reason).toBe("interval");

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);
  });

  it("stops checking after stop()", async () => {
    checker.start();
    checker.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it("checks again after a reconnect, so a server that updated is noticed", async () => {
    checker.start();
    mockCheckForUpdate.mockResolvedValue(V2);

    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS / 2);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    expect(outcomes.at(-1)).toEqual({
      outcome: { kind: "available", version: "2.0.0", body: "notes" },
      reason: "reconnect",
    });
  });

  it("spreads the reconnect check over a random delay, so a shared IP does not burst", async () => {
    for (const [random, delay] of [
      [0, 0],
      [0.999, RECONNECT_SPREAD_MS * 0.999],
    ] as const) {
      mockCheckForUpdate.mockClear();
      const c = createUpdateChecker({ serverUrl: "https://s.example", random: () => random });
      c.start();
      c.notifyReconnected();
      if (delay > 0) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(mockCheckForUpdate).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
      c.stop();
    }
  });

  it("does not hammer the feed when the socket flaps", async () => {
    checker.start();
    checker.notifyReconnected();
    checker.notifyReconnected();
    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_GAP_MS);
    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);
  });

  it("drops a reconnect check still waiting when the checker stops", async () => {
    checker.start();
    checker.notifyReconnected();
    checker.stop();
    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS * 2);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  describe("a failed background check (a rate limit looks like one)", () => {
    const FAILED = { ...NONE, failed: true };

    it("is retried after a random delay instead of waiting for the next interval", async () => {
      checker.start();
      mockCheckForUpdate.mockResolvedValueOnce(FAILED).mockResolvedValue(V2);
      void checker.checkNow("reconnect");
      await vi.advanceTimersByTimeAsync(0);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);

      const delay = RETRY_MIN_MS + RETRY_SPREAD_MS * 0.5;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);
      expect(outcomes.at(-1)?.outcome.kind).toBe("available");
    });

    it("gives up after MAX_RETRIES and leaves the rest to the interval", async () => {
      checker.start();
      mockCheckForUpdate.mockResolvedValue(FAILED);
      void checker.checkNow("reconnect");
      await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + RETRY_SPREAD_MS);
      await vi.advanceTimersByTimeAsync((RETRY_MIN_MS + RETRY_SPREAD_MS) * MAX_RETRIES);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    });

    it("gives a fresh trigger its own retry budget after an earlier chain ran out", async () => {
      checker.start();
      mockCheckForUpdate.mockResolvedValue(FAILED);
      void checker.checkNow("reconnect");
      await vi.advanceTimersByTimeAsync((RETRY_MIN_MS + RETRY_SPREAD_MS) * (MAX_RETRIES + 1));
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1 + MAX_RETRIES);

      await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_GAP_MS);
      void checker.checkNow("reconnect");
      await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + RETRY_SPREAD_MS);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1 + MAX_RETRIES + 2);
    });

    it("still runs a pending retry when another check failed just before it", async () => {
      checker.start();
      mockCheckForUpdate.mockResolvedValue(FAILED);
      void checker.checkNow("reconnect");
      await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + RETRY_SPREAD_MS * 0.5 - 30_000);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
      void checker.checkNow("interval");
      await vi.advanceTimersByTimeAsync(0);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(3);
    });

    it("re-arms the retry when it lands on a manual check that then fails", async () => {
      checker.start();
      let resolveManual!: (v: typeof FAILED) => void;
      mockCheckForUpdate
        .mockResolvedValueOnce(FAILED)
        .mockReturnValueOnce(new Promise((r) => (resolveManual = r)))
        .mockResolvedValue(FAILED);
      void checker.checkNow("reconnect");
      await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + RETRY_SPREAD_MS * 0.5 - 30_000);
      void checker.checkNow("manual");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);

      resolveManual(FAILED);
      await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + RETRY_SPREAD_MS);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(3);
    });

    it("is not retried for a manual check, which answers the user directly", async () => {
      checker.start();
      mockCheckForUpdate.mockResolvedValue(FAILED);
      expect(await checker.checkNow("manual")).toEqual({ kind: "failed" });
      await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + RETRY_SPREAD_MS);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    });

    it("stops retrying once the checker stops", async () => {
      checker.start();
      mockCheckForUpdate.mockResolvedValue(FAILED);
      void checker.checkNow("reconnect");
      await vi.advanceTimersByTimeAsync(0);
      checker.stop();
      await vi.advanceTimersByTimeAsync(RETRY_MIN_MS + RETRY_SPREAD_MS);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("postpones a reconnect check that lands inside the gap after a manual check", async () => {
    checker.start();
    await checker.checkNow("manual");
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS);
    await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_GAP_MS);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);
    expect(outcomes.at(-1)?.reason).toBe("reconnect");
  });

  it("reports a manual check that joins a background check as manual", async () => {
    let resolve!: (v: typeof V2) => void;
    mockCheckForUpdate.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    checker.start();
    void checker.checkNow("reconnect");
    const manual = checker.checkNow("manual");
    resolve(V2);
    await manual;
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.reason).toBe("manual");
  });

  it("maps every result shape to an outcome", async () => {
    mockCheckForUpdate.mockResolvedValueOnce(NONE);
    expect(await checker.checkNow("manual")).toEqual({ kind: "up-to-date" });

    mockCheckForUpdate.mockResolvedValueOnce(V2);
    expect(await checker.checkNow("manual")).toEqual({
      kind: "available",
      version: "2.0.0",
      body: "notes",
    });

    mockCheckForUpdate.mockResolvedValueOnce({ ...NONE, manual_upgrade: true });
    expect(await checker.checkNow("manual")).toEqual({ kind: "manual-upgrade" });

    mockCheckForUpdate.mockResolvedValueOnce({ ...NONE, failed: true });
    expect(await checker.checkNow("manual")).toEqual({ kind: "failed" });

    mockCheckForUpdate.mockRejectedValueOnce(new Error("boom"));
    expect(await checker.checkNow("manual")).toEqual({ kind: "failed" });
  });

  it("a manual check always runs, even right after a background one", async () => {
    await checker.checkNow("interval");
    await checker.checkNow("manual");
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);
  });

  it("joins a check already in flight instead of starting a second one", async () => {
    let release: (v: typeof NONE) => void = () => undefined;
    mockCheckForUpdate.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = checker.checkNow("manual");
    const second = checker.checkNow("manual");
    release(NONE);
    await Promise.all([first, second]);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
  });

  it("drops the outcome of a check that finishes after stop()", async () => {
    let release: (v: typeof V2) => void = () => undefined;
    mockCheckForUpdate.mockReturnValueOnce(new Promise((r) => (release = r)));
    checker.start();
    void checker.checkNow("interval");
    checker.stop();
    release(V2);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([]);
  });

  it("registers itself as the active checker while started", () => {
    expect(getActiveUpdateChecker()).toBeNull();
    checker.start();
    expect(getActiveUpdateChecker()).toBe(checker);
    checker.stop();
    expect(getActiveUpdateChecker()).toBeNull();
  });
});
