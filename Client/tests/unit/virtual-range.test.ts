import { describe, it, expect } from "vitest";
import { buildOffsets, indexAt, rangeFor } from "../../src/lib/ui/virtualRange";

// 100 items of height 10: offsets 0, 10, ... 1000.
const offsets = buildOffsets(Array.from({ length: 100 }, () => 10));

describe("buildOffsets", () => {
  it("is a prefix sum one longer than the input", () => {
    expect(Array.from(buildOffsets([5, 20, 5]))).toEqual([0, 5, 25, 30]);
    expect(Array.from(buildOffsets([]))).toEqual([0]);
  });
});

describe("rangeFor", () => {
  it("covers the viewport at the top", () => {
    expect(rangeFor(offsets, 0, 100, 0)).toEqual({ start: 0, end: 10, pinned: [] });
  });

  it("covers a partially scrolled viewport in the middle", () => {
    expect(rangeFor(offsets, 455, 100, 0)).toEqual({ start: 45, end: 56, pinned: [] });
  });

  it("ends at the last item at the bottom", () => {
    expect(rangeFor(offsets, 900, 100, 0)).toEqual({ start: 90, end: 100, pinned: [] });
    expect(rangeFor(offsets, 5000, 100, 0)).toEqual({ start: 99, end: 100, pinned: [] });
  });

  it("clamps overscan to the list", () => {
    expect(rangeFor(offsets, 0, 100, 10)).toEqual({ start: 0, end: 20, pinned: [] });
    expect(rangeFor(offsets, 900, 100, 10)).toEqual({ start: 80, end: 100, pinned: [] });
    expect(rangeFor(offsets, 450, 100, 10)).toEqual({ start: 35, end: 65, pinned: [] });
  });

  it("includes pinned indices outside the window, sorted and deduplicated", () => {
    const range = rangeFor(offsets, 450, 100, 0, [90, 3, 3, 47, 200, -1]);
    expect(range).toEqual({ start: 45, end: 55, pinned: [3, 90] });
  });

  it("gives an empty range for a zero viewport, an empty list or bad numbers", () => {
    const empty = { start: 0, end: 0, pinned: [] };
    expect(rangeFor(offsets, 100, 0, 5, [3])).toEqual(empty);
    expect(rangeFor(offsets, 100, -5, 5)).toEqual(empty);
    expect(rangeFor(offsets, Number.NaN, 100, 5)).toEqual(empty);
    expect(rangeFor(offsets, 100, Number.POSITIVE_INFINITY, 5)).toEqual(empty);
    expect(rangeFor(buildOffsets([]), 0, 100, 5)).toEqual(empty);
  });
});

describe("indexAt", () => {
  it("returns the item whose top is at or below y, on boundaries", () => {
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 9.99)).toBe(0);
    expect(indexAt(offsets, 10)).toBe(1);
    expect(indexAt(offsets, 999)).toBe(99);
  });

  it("clamps outside the list", () => {
    expect(indexAt(offsets, -50)).toBe(0);
    expect(indexAt(offsets, 1000)).toBe(99);
    expect(indexAt(offsets, 1e9)).toBe(99);
    expect(indexAt(buildOffsets([]), 10)).toBe(0);
  });

  it("handles unequal heights", () => {
    const mixed = buildOffsets([24, 40, 24]);
    expect(indexAt(mixed, 23)).toBe(0);
    expect(indexAt(mixed, 24)).toBe(1);
    expect(indexAt(mixed, 64)).toBe(2);
  });
});
