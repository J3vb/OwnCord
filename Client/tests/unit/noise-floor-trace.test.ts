/**
 * NoiseFloorTracker.push over fixed pseudo-random level sequences: every
 * report that moved the threshold, with the value it moved to, so a change in
 * how push orders its window, speech and threshold steps shows up as a
 * different trace.
 */
import { describe, expect, it } from "vitest";
import { NoiseFloorTracker } from "../../src/lib/voice/noiseFloor";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Move = readonly [number, number];

function trace(
  seed: number,
  level: (i: number, r: number) => number,
  opts: { start?: number; tracker?: NoiseFloorTracker; resetAt?: number } = {},
): Move[] {
  const rand = lcg(seed);
  const tracker = opts.tracker ?? new NoiseFloorTracker();
  const moves: Move[] = [];
  for (let i = 0; i < 600; i++) {
    const t = (opts.start ?? 0) + i * 50;
    if (i === opts.resetAt) tracker.reset(t);
    const out = tracker.push(level(i, rand()), t);
    if (out !== null) moves.push([i, Number(out.toPrecision(10))]);
  }
  return moves;
}

const rmsAt = (dbfs: number): number => 10 ** (dbfs / 20);

describe("NoiseFloorTracker.push traces", () => {
  it("steady jittery room noise", () => {
    expect(trace(1, (_i, r) => rmsAt(-60 + r * 6))).toEqual(EXPECTED.room);
  });

  it("speech bursts over a room, with pauses that decay the voice estimate", () => {
    const speech = (i: number, r: number): number =>
      i % 120 < 50 ? rmsAt(-22 + r * 6) : rmsAt(-62 + r * 4);
    expect(trace(2, speech)).toEqual(EXPECTED.speech);
  });

  it("digital silence, a rising floor and a seeded start", () => {
    const level = (i: number, r: number): number =>
      i < 40 ? 0 : rmsAt(-70 + Math.floor(i / 150) * 12 + r * 3);
    expect(trace(3, level, { tracker: new NoiseFloorTracker(0.02) })).toEqual(EXPECTED.rising);
  });

  it("a reset in the middle of speech settles, then relearns", () => {
    const level = (i: number, r: number): number =>
      i % 60 < 30 ? rmsAt(-24 + r * 4) : rmsAt(-58 + r * 2);
    expect(trace(4, level, { resetAt: 300, start: 10_000 })).toEqual(EXPECTED.reset);
  });
});

const EXPECTED: Record<"room" | "speech" | "rising" | "reset", Move[]> = {
  room: [[20, 0.003198511899]],
  speech: [
    [50, 0.008853787335],
    [52, 0.007852061769],
    [115, 0.006987660343],
    [160, 0.05],
    [170, 0.008422044365],
    [176, 0.007258568467],
    [235, 0.006462860275],
    [280, 0.05],
    [290, 0.008503773843],
    [292, 0.007490256828],
    [343, 0.006655742376],
    [400, 0.05],
    [410, 0.007594866955],
    [467, 0.006762214782],
    [520, 0.05],
    [530, 0.007521931182],
    [580, 0.006675051737],
  ],
  rising: [
    [60, 0.00177827941],
    [200, 0.004040160455],
    [340, 0.01602940075],
    [500, 0.05],
  ],
  reset: [
    [30, 0.004670369277],
    [36, 0.004014066098],
    [69, 0.007789265515],
    [324, 0.05],
    [330, 0.004493589753],
    [334, 0.003995176045],
    [368, 0.008008212872],
  ],
};
