// The connection card's ping history: a ring of the current call's last RTT
// samples, emptied when the call changes (widget/pingHistory.ts).
import { describe, expect, it } from "vitest";
import {
  createPingHistory,
  PING_HISTORY_SIZE,
  sparklinePoints,
} from "../../src/features/voice/widget/pingHistory";

describe("ping history", () => {
  it("keeps the samples in order, oldest first", () => {
    const history = createPingHistory();
    history.push(30);
    history.push(42);
    history.push(35);
    expect(history.values()).toEqual([30, 42, 35]);
  });

  it("skips a poll with no ping", () => {
    const history = createPingHistory();
    history.push(0);
    history.push(-5);
    history.push(Number.NaN);
    history.push(Number.POSITIVE_INFINITY);
    history.push(12);
    expect(history.values()).toEqual([12]);
  });

  it("holds the last 60 samples, dropping the oldest as new ones come", () => {
    expect(PING_HISTORY_SIZE).toBe(60);
    const history = createPingHistory();
    for (let i = 1; i <= 75; i++) history.push(i);
    const values = history.values();
    expect(values).toHaveLength(60);
    expect(values[0]).toBe(16);
    expect(values[59]).toBe(75);
  });

  it("wraps a small ring at every size", () => {
    const history = createPingHistory(3);
    for (const v of [1, 2, 3, 4]) history.push(v);
    expect(history.values()).toEqual([2, 3, 4]);
    history.push(5);
    history.push(6);
    expect(history.values()).toEqual([4, 5, 6]);
  });

  it("starts over empty after a reset, full or not", () => {
    const history = createPingHistory(3);
    for (const v of [1, 2, 3, 4]) history.push(v);
    history.reset();
    expect(history.values()).toEqual([]);
    history.push(9);
    history.push(8);
    expect(history.values()).toEqual([9, 8]);
  });

  it("hands out a copy, not its own ring", () => {
    const history = createPingHistory();
    history.push(10);
    const copy = history.values() as number[];
    copy.push(99);
    expect(history.values()).toEqual([10]);
  });
});

describe("sparklinePoints", () => {
  it("draws nothing without samples", () => {
    expect(sparklinePoints([], 300, 46)).toEqual([]);
  });

  it("spreads the samples across the width, oldest at the left", () => {
    const points = sparklinePoints([10, 20, 30], 300, 46);
    expect(points.map(([x]) => x)).toEqual([0, 150, 300]);
  });

  it("draws a higher ping higher, with headroom above the worst", () => {
    const points = sparklinePoints([10, 30], 300, 45);
    const [low, high] = points.map(([, y]) => y);
    // The top of the scale is 1.5x the worst sample (45 ms here).
    expect(high).toBeCloseTo(15, 1);
    expect(low).toBeCloseTo(35, 1);
    expect(high!).toBeLessThan(low!);
  });

  it("puts a single sample at the right edge, the newest end", () => {
    expect(sparklinePoints([20], 300, 46)).toEqual([[300, 15.3]]);
  });
});
