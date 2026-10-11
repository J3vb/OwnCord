import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCheckForUpdate } = vi.hoisted(() => ({ mockCheckForUpdate: vi.fn() }));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@lib/updater", () => ({ checkForUpdate: mockCheckForUpdate }));

import {
  createUpdateChecker,
  getActiveUpdateChecker,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_JITTER,
  MIN_BACKGROUND_GAP_MS,
  type UpdateChecker,
  type UpdateOutcome,
} from "../../src/lib/updateChecker";

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

  it("jitters each interval so clients do not all hit the feed together", async () => {
    for (const [random, expected] of [
      [0, UPDATE_CHECK_INTERVAL_MS * (1 - UPDATE_CHECK_JITTER)],
      [1, UPDATE_CHECK_INTERVAL_MS * (1 + UPDATE_CHECK_JITTER)],
    ] as const) {
      mockCheckForUpdate.mockClear();
      const c = createUpdateChecker({ serverUrl: "https://s.example", random: () => random });
      c.start();
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(mockCheckForUpdate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
      c.stop();
    }
  });

  it("stops checking after stop()", async () => {
    checker.start();
    checker.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it("checks again after a reconnect, so a server that updated is noticed", async () => {
    checker.start();
    await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_GAP_MS);
    mockCheckForUpdate.mockResolvedValue(V2);

    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    expect(outcomes.at(-1)).toEqual({
      outcome: { kind: "available", version: "2.0.0", body: "notes" },
      reason: "reconnect",
    });
  });

  it("does not hammer the feed when the socket flaps", async () => {
    checker.start();
    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(0);
    checker.notifyReconnected();
    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_GAP_MS);
    checker.notifyReconnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(2);
  });

  it("reports a manual check that joins a background check as manual", async () => {
    let resolve!: (v: typeof V2) => void;
    mockCheckForUpdate.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    checker.start();
    checker.notifyReconnected();
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
