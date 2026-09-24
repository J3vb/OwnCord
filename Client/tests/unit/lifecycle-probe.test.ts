// B7-11a: the soak's pass-bar arithmetic, tested without a browser.
//
// The soak itself needs a real server, LiveKit and Chromium; its bar evaluation
// is pure and is the part that decides pass/fail, so it gets a fast unit test.
// lifecycle-probe.ts imports only types from @playwright/test, so it loads
// under jsdom.
//
// The bars compare like-for-like inside a 10-cycle login generation (the plan
// logs out every 10 cycles), so the sample helpers below use the real phase
// layout: cycles 5/15/25 are the mid-session series, cycles 10/20/30 the
// post-logout series.
import { describe, expect, it } from "vitest";
import {
  evaluateBars,
  formatBars,
  idleHeapSlope,
  IDLE_HEAP_BAR_SLOPE,
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
  });

  it("fails a mid-session leak (the cycle-5/15 series grows)", () => {
    const bars = evaluateBars([
      sample(5, { listeners: 50 }),
      sample(10, { listeners: 50 }),
      sample(15, { listeners: 70 }),
      sample(20, { listeners: 50 }),
    ]);
    expect(bar(bars, "listeners").pass).toBe(false);
    expect(bar(bars, "listeners").slope).toBeGreaterThan(0.05);
  });

  it("fails a leak that only shows across logouts (the cycle-10/20 series)", () => {
    const bars = evaluateBars([
      sample(5, { listeners: 50 }),
      sample(10, { listeners: 60 }),
      sample(15, { listeners: 50 }),
      sample(20, { listeners: 80 }),
    ]);
    expect(bar(bars, "listeners").pass).toBe(false);
  });

  it("fails a leak even when the last sample is below the first of the other series", () => {
    // A pooled slope over 50, 60, 50, 80 would be small; the phase split still
    // catches the cycle-10/20 growth.
    const bars = evaluateBars([
      sample(5, { listeners: 100 }),
      sample(10, { listeners: 60 }),
      sample(15, { listeners: 100 }),
      sample(20, { listeners: 80 }),
    ]);
    expect(bar(bars, "listeners").pass).toBe(false);
  });

  it("requires documents and intervals to be exactly flat in every series", () => {
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

  it("ratchets a known leak at its ceiling but still fails on further growth", () => {
    // The real logout leak: the post-logout series climbs ~1 listener per
    // sample, i.e. ~0.1 per cycle (samples are 10 cycles apart in this series),
    // while the mid-session series is flat.
    const known = [
      sample(5, { listeners: 211 }),
      sample(10, { listeners: 192 }),
      sample(15, { listeners: 211 }),
      sample(20, { listeners: 193 }),
      sample(25, { listeners: 211 }),
      sample(30, { listeners: 194 }),
    ];
    const knownSlope = bar(evaluateBars(known), "listeners").slope;
    expect(knownSlope).toBeCloseTo(0.1, 5);
    // Passes under a ceiling above the measured 0.1/cycle...
    expect(bar(evaluateBars(known, { listeners: 0.2 }), "listeners").pass).toBe(true);
    // ...and fails under the plan's default 0.05.
    expect(bar(evaluateBars(known), "listeners").pass).toBe(false);

    // Growth past the ceiling fails even with the ceiling raised: the gate is
    // still a gate.
    const worse = [
      sample(5, { listeners: 211 }),
      sample(10, { listeners: 180 }),
      sample(15, { listeners: 211 }),
      sample(20, { listeners: 200 }),
      sample(25, { listeners: 211 }),
      sample(30, { listeners: 220 }),
    ];
    expect(bar(evaluateBars(worse, { listeners: 0.2 }), "listeners").pass).toBe(false);
  });

  it("fails a leak confined to one page (B7-11c's within-page pair)", () => {
    // Every page grows the same way and the re-login releases it, so each
    // phase series is flat; only the page-6/9 pair sees it.
    const perPage = [
      sample(5),
      sample(6, { listeners: 50 }),
      sample(9, { listeners: 53 }),
      sample(10),
      sample(15),
      sample(16, { listeners: 50 }),
      sample(19, { listeners: 53 }),
      sample(20),
    ];
    const listeners = bar(evaluateBars(perPage), "listeners");
    expect(listeners.pass).toBe(false);
    expect(listeners.bar).toContain("page 0: 50→53");
    // A phase-series ceiling never loosens the within-page bar.
    expect(bar(evaluateBars(perPage, { listeners: 2 }), "listeners").pass).toBe(false);
  });

  it("tolerates a 1-2 node detached-node wobble in a within-page pair", () => {
    // The CI flake: run 35986328302 read page-0 nodes 2858→2859 (slope 1/3,
    // far past 0.05/cycle) between cycles 6 and 9 with an identical attached
    // DOM — one retained, detached node in flux. It is not a leak.
    const wobble = [
      sample(5, { nodes: 2858 }),
      sample(6, { nodes: 2858 }),
      sample(9, { nodes: 2859 }),
      sample(10, { nodes: 2858 }),
      sample(15, { nodes: 2858 }),
      sample(16, { nodes: 2858 }),
      sample(19, { nodes: 2859 }),
      sample(20, { nodes: 2858 }),
    ];
    expect(bar(evaluateBars(wobble), "nodes").pass).toBe(true);
    // The worst slope is still recorded, even though the tolerance passes it.
    expect(bar(evaluateBars(wobble), "nodes").slope).toBeCloseTo(1 / 3, 5);
  });

  it("still fails a real nodes leak past the 2-node tolerance", () => {
    const leaking = [
      sample(5, { nodes: 2858 }),
      sample(6, { nodes: 2858 }),
      sample(9, { nodes: 2861 }),
      sample(10, { nodes: 2858 }),
      sample(15, { nodes: 2858 }),
      sample(16, { nodes: 2858 }),
      sample(19, { nodes: 2861 }),
      sample(20, { nodes: 2858 }),
    ];
    const nodes = bar(evaluateBars(leaking), "nodes");
    expect(nodes.pass).toBe(false);
    expect(nodes.bar).toContain("page 0: 2858→2861");
  });

  it("keeps the tolerance to nodes: a 1-unit wobble in another metric still fails", () => {
    const listeners = [
      sample(5),
      sample(6, { listeners: 100 }),
      sample(9, { listeners: 101 }),
      sample(10),
      sample(15),
      sample(16, { listeners: 100 }),
      sample(19, { listeners: 101 }),
      sample(20),
    ];
    expect(bar(evaluateBars(listeners), "listeners").pass).toBe(false);
  });

  it("leaves the samples at the 5-cycle marks (reconnect, logout) out of the page pair", () => {
    const bars = evaluateBars([
      sample(5, { nodes: 101 }),
      sample(6),
      sample(9),
      sample(10, { nodes: 90 }),
      sample(15, { nodes: 101 }),
      sample(16),
      sample(19),
      sample(20, { nodes: 90 }),
    ]);
    expect(bar(bars, "nodes").pass).toBe(true);
  });

  it("compares heap only at the post-reconnect and post-logout phases", () => {
    const bars = evaluateBars([
      sample(5),
      sample(9, { heapUsed: 1_000_000 }),
      sample(10),
      sample(15),
      sample(19, { heapUsed: 1_500_000 }),
      sample(20),
    ]);
    expect(bar(bars, "heapUsed").pass).toBe(true);
    const grown = evaluateBars([
      sample(5, { heapUsed: 1_000_000 }),
      sample(10),
      sample(15, { heapUsed: 1_500_000 }),
      sample(20),
    ]);
    expect(bar(grown, "heapUsed").pass).toBe(false);
  });

  it("returns nothing when there is no sample", () => {
    expect(evaluateBars([])).toEqual([]);
    expect(evaluateBars([sample(5)])).toEqual([]);
  });

  it("formats a report with one row per metric", () => {
    const report = formatBars(evaluateBars([sample(5), sample(10)]));
    expect(report.split("\n")[0]).toMatch(/metric \| warm \| final \| slope \| bar \| pass/);
    expect(report).toContain("listeners");
    expect(report).toContain("heapUsed");
  });
});

describe("idle heap bar", () => {
  const idle = (minute: number, heapUsed: number, cycle = -1) =>
    sample(cycle, { cycleAt: minute * 60_000, heapUsed });

  it("measures the heap slope per minute over the settled idle samples only", () => {
    const samples = [
      sample(200, { heapUsed: 50_000_000 }),
      idle(5, 40_000_000, -2),
      idle(15, 1_000_000),
      idle(20, 1_500_000),
      idle(25, 2_000_000),
    ];
    expect(idleHeapSlope(samples)).toBeCloseTo(100_000);
  });

  it("fails a poller that retains 1 MB a minute and passes a flat idle heap", () => {
    const leaking = [idle(15, 0), idle(20, 5_000_000), idle(25, 10_000_000)];
    expect(idleHeapSlope(leaking)).toBeGreaterThan(IDLE_HEAP_BAR_SLOPE);
    const flat = [idle(15, 4_330_328), idle(20, 4_330_400), idle(25, 4_330_416)];
    expect(idleHeapSlope(flat)).toBeLessThanOrEqual(IDLE_HEAP_BAR_SLOPE);
  });
});
