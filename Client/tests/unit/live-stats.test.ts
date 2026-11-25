// The live stats store: the voice widget's latest connection sample, and the
// gates every reader applies before showing it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  liveStatsStore,
  shownPing,
  shownStats,
  writeLiveStats,
  type LiveStats,
} from "../../src/lib/voice/liveStats";
import { statsSample } from "../helpers/connectionStatsSample";

const sample = statsSample;

const entry = (at: number, connected = true, stats = sample()): LiveStats => ({
  stats,
  at,
  connected,
});

beforeEach(() => {
  liveStatsStore.setState(() => ({ stats: null, at: 0, connected: false }));
  liveStatsStore.flush();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("writeLiveStats", () => {
  it("starts with no sample", () => {
    expect(liveStatsStore.getState()).toEqual({ stats: null, at: 0, connected: false });
  });

  it("stores the sample with Date.now() and the passed connected flag", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const s = sample({ rtt: 42 });
    writeLiveStats(s, true);
    expect(liveStatsStore.getState()).toEqual({ stats: s, at: 5_000, connected: true });

    vi.setSystemTime(7_000);
    writeLiveStats(s, false);
    expect(liveStatsStore.getState()).toEqual({ stats: s, at: 7_000, connected: false });
  });

  it("tells subscribers once per write", () => {
    const seen: LiveStats[] = [];
    const unsub = liveStatsStore.subscribe((s) => seen.push(s));
    writeLiveStats(sample(), true);
    liveStatsStore.flush();
    unsub();
    expect(seen).toHaveLength(1);
  });
});

describe("shownStats", () => {
  it("is null while the call is not connected", () => {
    expect(shownStats(entry(100), false, 50)).toBeNull();
  });

  it("is null for a sample written while not connected (joining or reconnecting), even once connected", () => {
    expect(shownStats(entry(100, false), true, 50)).toBeNull();
  });

  it("is null for an unavailable sample", () => {
    expect(shownStats(entry(100, true, sample({ available: false })), true, 50)).toBeNull();
  });

  it("is null with no sample at all", () => {
    expect(shownStats({ stats: null, at: 0, connected: false }, true, 0)).toBeNull();
  });

  it("is null with no joinedAt", () => {
    expect(shownStats(entry(100), true, null)).toBeNull();
  });

  it("is null for a sample written before joinedAt", () => {
    expect(shownStats(entry(99), true, 100)).toBeNull();
  });

  it("is null for a sample written in the same millisecond as the join", () => {
    expect(shownStats(entry(100), true, 100)).toBeNull();
  });

  it("is the sample when written after joinedAt", () => {
    const e = entry(101);
    expect(shownStats(e, true, 100)).toBe(e.stats);
    expect(shownStats(entry(150), true, 100)).not.toBeNull();
  });

  it("room A, then B, then A again: each earlier sample stays hidden", () => {
    const inA = entry(1_000);
    const inB = entry(2_000);
    // Joined B at 1 500: A's sample is older.
    expect(shownStats(inA, true, 1_500)).toBeNull();
    expect(shownStats(inB, true, 1_500)).toBe(inB.stats);
    // Back in A at 2 500: B's sample is older too.
    expect(shownStats(inB, true, 2_500)).toBeNull();
    expect(shownStats(inA, true, 2_500)).toBeNull();
    expect(shownStats(entry(2_600), true, 2_500)).not.toBeNull();
  });

  it("leave and rejoin hides the sample from the first call", () => {
    const first = entry(1_000);
    // Left (joinedAt null), then joined again at 3 000.
    expect(shownStats(first, false, null)).toBeNull();
    expect(shownStats(first, true, 3_000)).toBeNull();
  });
});

describe("shownPing", () => {
  it("is null for no sample", () => {
    expect(shownPing(null)).toBeNull();
  });

  it("is null for an rtt of 0", () => {
    expect(shownPing(sample({ rtt: 0 }))).toBeNull();
  });

  it("is the rounded rtt otherwise", () => {
    expect(shownPing(sample({ rtt: 18.4 }))).toBe(18);
    expect(shownPing(sample({ rtt: 18.5 }))).toBe(19);
    expect(shownPing(sample({ rtt: 0.6 }))).toBe(1);
  });
});
