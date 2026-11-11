import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { packTiles, type PackRect, type PackTile, type TileSize } from "./packLayout";
import { GRID_GAP, GRID_PAD, computeGridLayout } from "./gridShared";

const WIDE = 16 / 9;
const PROPERTY_TIMEOUT = 20_000;

function tile(id: number, aspect: number, size: TileSize, pinned = false): PackTile {
  return { id, aspect, size, pinned };
}

function areaOf(r: PackRect): number {
  return r.w * r.h;
}

function totalArea(rects: readonly PackRect[]): number {
  return rects.reduce((sum, r) => sum + areaOf(r), 0);
}

function rectOf(rects: readonly PackRect[], id: number): PackRect {
  const found = rects.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rect for ${id}`);
  return found;
}

function rank(t: PackTile): number {
  if (t.pinned === true || t.size === "large") return 2;
  return t.size === "medium" ? 1 : 0;
}

/** The larger of the gaps between two rects along x and along y. */
function separation(a: PackRect, b: PackRect): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(dx, dy);
}

function overlaps(a: PackRect, b: PackRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("packTiles", () => {
  it("fills a 1080p window with one 16:9 tile", () => {
    const [r] = packTiles(1920, 1080, [tile(1, WIDE, "large")]);
    expect(r?.w).toBeGreaterThanOrEqual(1880);
    expect(r?.h).toBeGreaterThanOrEqual(1060);
    expect((r?.w ?? 0) / (r?.h ?? 1)).toBeCloseTo(WIDE, 1);
  });

  it("limits one 16:9 tile on an ultrawide window by its height", () => {
    const [r] = packTiles(5120, 1440, [tile(1, WIDE, "large")]);
    expect(r?.h).toBeGreaterThanOrEqual(1420);
    expect(r?.w).toBeLessThan(2600);
    expect(r?.x).toBeGreaterThan(1000);
  });

  it("shows a 32:9 share and two cameras bigger than equal 16:9 boxes", () => {
    const rects = packTiles(5120, 1440, [
      tile(1, 32 / 9, "large"),
      tile(2, WIDE, "medium"),
      tile(3, WIDE, "medium"),
    ]);
    const old = computeGridLayout(5120, 1440, 3);
    expect(totalArea(rects)).toBeGreaterThan(3 * old.tileW * old.tileH);
    expect(areaOf(rectOf(rects, 1))).toBeGreaterThan(areaOf(rectOf(rects, 2)));
  });

  it("puts the medium tiles beside a large one on a 21:9 window", () => {
    const rects = packTiles(3440, 1440, [
      tile(1, WIDE, "large"),
      tile(2, WIDE, "medium"),
      tile(3, WIDE, "medium"),
      tile(4, WIDE, "medium"),
    ]);
    const big = rectOf(rects, 1);
    for (const id of [2, 3, 4]) expect(rectOf(rects, id).x).toBeGreaterThanOrEqual(big.x + big.w);
  });

  it("keeps a portrait tile tall", () => {
    const [r] = packTiles(1920, 1080, [tile(1, 9 / 16, "large")]);
    expect(r?.h).toBeGreaterThanOrEqual(1060);
    expect(r?.w).toBeLessThan((r?.h ?? 0) / 1.7);
  });

  it("treats a pinned small tile as large", () => {
    const rects = packTiles(1920, 1080, [tile(1, WIDE, "medium"), tile(2, WIDE, "small", true)]);
    expect(areaOf(rectOf(rects, 2))).toBeGreaterThan(areaOf(rectOf(rects, 1)));
  });

  it("puts a small tile below a medium one in the rest band", () => {
    const rects = packTiles(1920, 1080, [
      tile(1, WIDE, "large"),
      tile(2, WIDE, "small"),
      tile(3, WIDE, "medium"),
    ]);
    const medium = rectOf(rects, 3);
    const small = rectOf(rects, 2);
    expect(areaOf(medium)).toBeGreaterThan(areaOf(small));
    expect(medium.w).toBeGreaterThan(small.w);
    expect(small.y + small.h > medium.y + medium.h || small.x >= medium.x + medium.w).toBe(true);
  });

  it("draws small tiles smaller than medium ones when a large exists", () => {
    const rects = packTiles(5120, 1440, [
      tile(1, WIDE, "large"),
      tile(2, WIDE, "medium"),
      tile(3, WIDE, "medium"),
      tile(4, WIDE, "small"),
      tile(5, WIDE, "small"),
    ]);
    const medium = rectOf(rects, 2);
    const small = rectOf(rects, 4);
    expect(small.w).toBeLessThan(medium.w * 0.8);
    expect(areaOf(small)).toBeLessThan(areaOf(medium) * 0.6);
  });

  it("gives equal tiles of one size equal rectangles", () => {
    const rects = packTiles(1920, 1080, [
      tile(1, WIDE, "medium"),
      tile(2, WIDE, "medium"),
      tile(3, WIDE, "medium"),
      tile(4, WIDE, "medium"),
    ]);
    expect(new Set(rects.map((r) => `${r.w}x${r.h}`)).size).toBe(1);
    expect(rects[0]?.w).toBeGreaterThan(800);
  });

  it("returns nothing for empty or non-positive inputs", () => {
    expect(packTiles(1920, 1080, [])).toEqual([]);
    expect(packTiles(0, 1080, [tile(1, WIDE, "large")])).toEqual([]);
    expect(packTiles(1920, -5, [tile(1, WIDE, "large")])).toEqual([]);
    expect(packTiles(Number.NaN, 1080, [tile(1, WIDE, "large")])).toEqual([]);
    expect(packTiles(Infinity, 1080, [tile(1, WIDE, "large")])).toEqual([]);
    expect(packTiles(1920, Infinity, [tile(1, WIDE, "large")])).toEqual([]);
  });

  it("gives tiles that share an id their own rects, by position", () => {
    const rects = packTiles(1920, 1080, [tile(7, WIDE, "medium"), tile(7, WIDE, "medium")]);
    expect(rects).toHaveLength(2);
    expect(rects[0]?.id).toBe(7);
    expect(rects[1]?.id).toBe(7);
    expect(rects[0]?.x).not.toBe(rects[1]?.x);
    expect(overlaps(rects[0] as PackRect, rects[1] as PackRect)).toBe(false);
    expect(rects[0]?.w).toBeGreaterThan(0);
    expect(rects[1]?.w).toBeGreaterThan(0);
  });

  it("falls back to one band, tiers ignored, when the tiers do not fit", () => {
    const rects = packTiles(20, 60, [tile(1, WIDE, "large"), tile(2, WIDE, "small")]);
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.x + r.w).toBeLessThanOrEqual(20 - GRID_PAD);
      expect(r.y + r.h).toBeLessThanOrEqual(60 - GRID_PAD);
    }
    expect(areaOf(rects[0] as PackRect)).toBe(areaOf(rects[1] as PackRect));
  });

  it("gives empty rects when there is no room at all", () => {
    const tiles = [tile(1, WIDE, "large"), tile(2, WIDE, "small")];
    for (const [w, h] of [
      [20, 20],
      [16, 400],
    ] as const) {
      const rects = packTiles(w, h, tiles);
      expect(rects).toHaveLength(2);
      for (const r of rects) expect(r.w).toBe(0);
    }
  });

  it("keeps tier order on the pixels after rounding", () => {
    const rects = packTiles(1043, 474, [
      tile(1, 5.24, "medium"),
      tile(2, 0.33, "small"),
      tile(3, 1.5, "large"),
    ]);
    expect(areaOf(rectOf(rects, 2))).toBeLessThanOrEqual(areaOf(rectOf(rects, 1)));
    expect(areaOf(rectOf(rects, 1))).toBeLessThanOrEqual(areaOf(rectOf(rects, 3)));
  });

  it("replaces bad aspect values and clamps extreme ones", () => {
    const rects = packTiles(1600, 900, [
      tile(1, Number.NaN, "medium"),
      tile(2, -3, "medium"),
      tile(3, Number.POSITIVE_INFINITY, "medium"),
      tile(4, 100, "medium"),
      tile(5, 0.001, "medium"),
    ]);
    expect(rects).toHaveLength(5);
    for (const id of [1, 2, 3]) {
      const r = rectOf(rects, id);
      expect(Math.abs(r.w / r.h - WIDE)).toBeLessThan(0.1);
    }
    expect(rectOf(rects, 4).w / rectOf(rects, 4).h).toBeLessThanOrEqual(8.5);
    expect(rectOf(rects, 5).w / rectOf(rects, 5).h).toBeGreaterThanOrEqual(0.24);
  });

  it("is stable: the same input gives the same output", () => {
    const tiles = [tile(1, WIDE, "large"), tile(2, 1, "medium"), tile(3, 1.3, "small")];
    expect(packTiles(2560, 1440, tiles)).toEqual(packTiles(2560, 1440, tiles));
  });

  it("packs 25 tiles in a few milliseconds", () => {
    const sizes: TileSize[] = ["large", "medium", "small"];
    const tiles = Array.from({ length: 25 }, (_, i) =>
      tile(i, 1 + (i % 5) * 0.4, sizes[i % 3] ?? "small"),
    );
    packTiles(3440, 1440, tiles);
    // Best of several batches, so a busy CI machine does not fail it.
    let best = Infinity;
    for (let batch = 0; batch < 5; batch++) {
      const start = performance.now();
      for (let i = 0; i < 10; i++) packTiles(3440, 1440, tiles);
      best = Math.min(best, (performance.now() - start) / 10);
    }
    expect(best).toBeLessThan(5);
  });
});

describe("packTiles properties", () => {
  const tileArb = fc.record({
    aspect: fc.double({ min: 0.25, max: 8, noNaN: true }),
    size: fc.constantFrom<TileSize>("large", "medium", "small"),
    pinned: fc.boolean(),
  });
  const caseArb = fc.record({
    width: fc.integer({ min: 200, max: 6000 }),
    height: fc.integer({ min: 200, max: 3000 }),
    specs: fc.array(tileArb, { minLength: 1, maxLength: 20 }),
  });

  it(
    "gives every tile one rect that is inside the window, apart from every other",
    () => {
      fc.assert(
        fc.property(caseArb, ({ width, height, specs }) => {
          const tiles = specs.map((s, i) => ({ id: i + 10, ...s }));
          const rects = packTiles(width, height, tiles);
          expect(rects.map((r) => r.id)).toEqual(tiles.map((t) => t.id));
          for (const r of rects) {
            expect(r.w).toBeGreaterThanOrEqual(0);
            expect(r.h).toBeGreaterThanOrEqual(0);
            expect(r.x).toBeGreaterThanOrEqual(GRID_PAD);
            expect(r.y).toBeGreaterThanOrEqual(GRID_PAD);
            expect(r.x + r.w).toBeLessThanOrEqual(width - GRID_PAD);
            expect(r.y + r.h).toBeLessThanOrEqual(height - GRID_PAD);
            expect(Number.isInteger(r.x + r.y + r.w + r.h)).toBe(true);
          }
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i] as PackRect;
              const b = rects[j] as PackRect;
              expect(overlaps(a, b)).toBe(false);
              if (a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0) {
                expect(separation(a, b)).toBeGreaterThanOrEqual(GRID_GAP);
              }
            }
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "keeps each tile's aspect and never shrinks a higher tier below a lower one",
    () => {
      fc.assert(
        fc.property(caseArb, ({ width, height, specs }) => {
          const tiles = specs.map((s, i) => ({ id: i, ...s }));
          const rects = packTiles(width, height, tiles);
          for (const t of tiles) {
            const r = rectOf(rects, t.id);
            expect(Math.abs(r.h - r.w / t.aspect)).toBeLessThanOrEqual(
              Math.max(1, 1 / t.aspect) + r.h * 0.01,
            );
          }
          for (const hi of tiles) {
            for (const lo of tiles) {
              if (rank(hi) <= rank(lo)) continue;
              const a = rectOf(rects, hi.id);
              const b = rectOf(rects, lo.id);
              expect(areaOf(b)).toBeLessThanOrEqual(areaOf(a));
            }
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );
});
