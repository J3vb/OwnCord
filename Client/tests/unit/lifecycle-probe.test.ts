// B7-11a: the soak's pass-bar arithmetic, tested without a browser.
//
// The soak itself needs a real server, LiveKit and Chromium; its bar evaluation
// is pure and is the part that decides pass/fail, so it gets a fast unit test.
// lifecycle-probe.ts imports only types from @playwright/test, so it loads
// under jsdom.
import { describe, expect, it } from "vitest";
import {
  evaluateBars,
  formatBars,
  type LifecycleSample,
} from "../e2e/support/lifecycle-probe";

function sample(cycle: number, overrides: Partial<LifecycleSample> = {}): LifecycleSample {
  return {
    cycle,
    cycleAt: cycle,
    documents: 1,
    nodes: 100,
    listeners: 50,
    abortControllers: 10,
    intervals: 1,
    timeouts: 1,
    sockets: 0,
    peerConnections: 0,
    tracks: 0,
    audioContexts: 0,
    heapUsed: 1_000_000,
    ...overrides,
  };
}

const bar = (bars: ReturnType<typeof evaluateBars>, metric: string) =>
  bars.find((b) => b.metric === metric)!;

describe("lifecycle soak pass bars", () => {
  it("passes a flat series", () => {
    const bars = evaluateBars([sample(5), sample(10), sample(15), sample(20)]);
    expect(bars.every((b) => b.pass)).toBe(true);
    expect(bar(bars, "listeners").pass).toBe(true);
  });

  it("fails a listener leak (growth per cycle)", () => {
    const bars = evaluateBars([
      sample(5),
      sample(10, { listeners: 60 }),
      sample(15, { listeners: 70 }),
      sample(20, { listeners: 80 }),
    ]);
    expect(bar(bars, "listeners").pass).toBe(false);
    expect(bar(bars, "listeners").slope).toBeGreaterThan(0.05);
  });

  it("fails a leak even when the final sample is below warm", () => {
    // Warm is noisy-high; the series still grows, so the slope bar catches it.
    const bars = evaluateBars([
      sample(5, { listeners: 100 }),
      sample(10, { listeners: 60 }),
      sample(15, { listeners: 70 }),
      sample(20, { listeners: 80 }),
    ]);
    expect(bar(bars, "listeners").pass).toBe(false);
  });

  it("requires documents and intervals to be exactly equal, not merely flat", () => {
    const bars = evaluateBars([
      sample(5),
      sample(10, { intervals: 2 }),
      sample(15, { intervals: 2 }),
      sample(20, { intervals: 2 }),
    ]);
    expect(bar(bars, "intervals").pass).toBe(false);
  });

  it("fails a heap breach over the 1.10 ratio", () => {
    const bars = evaluateBars([
      sample(5, { heapUsed: 1_000_000 }),
      sample(10, { heapUsed: 1_200_000 }),
      sample(15, { heapUsed: 1_200_000 }),
      sample(20, { heapUsed: 1_200_000 }),
    ]);
    expect(bar(bars, "heapUsed").pass).toBe(false);
  });

  it("returns nothing when there is no post-warm sample", () => {
    expect(evaluateBars([sample(0), sample(5)])).toEqual([]);
  });

  it("formats a report with one row per metric", () => {
    const report = formatBars(evaluateBars([sample(5), sample(10)]));
    expect(report.split("\n")[0]).toMatch(/metric \| warm \| final \| slope \| bar \| pass/);
    expect(report).toContain("listeners");
    expect(report).toContain("heapUsed");
  });
});
