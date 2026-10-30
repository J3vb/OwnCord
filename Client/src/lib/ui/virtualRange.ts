/**
 * Pure range math for a windowed list over fixed-per-item heights. `offsets`
 * is a prefix sum: `offsets[i]` is the top of item `i` and `offsets[count]`
 * the total height. No DOM, no state.
 */

export interface VirtualRange {
  /** First rendered index of the window. */
  readonly start: number;
  /** One past the last rendered index of the window. */
  readonly end: number;
  /** Indices outside `[start, end)` that must stay rendered, ascending. */
  readonly pinned: readonly number[];
}

const EMPTY: VirtualRange = { start: 0, end: 0, pinned: [] };

/** Prefix sums of `heights`, one longer than the input. */
export function buildOffsets(heights: ArrayLike<number>): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  for (let i = 0; i < heights.length; i++) offsets[i + 1] = offsets[i]! + heights[i]!;
  return offsets;
}

function countOf(offsets: Float64Array): number {
  return Math.max(0, offsets.length - 1);
}

/** The item containing `y`, clamped to `[0, count - 1]` (0 when empty). */
export function indexAt(offsets: Float64Array, y: number): number {
  const count = countOf(offsets);
  if (count === 0 || !(y > 0)) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The window for a viewport `[top, top + viewport)`, widened by `overscan`
 * items each way and clamped to the list. `pinned` indices that fall outside
 * the window are returned separately. A zero, negative or non-finite viewport
 * gives an empty range with nothing pinned: a host with no height renders no
 * rows.
 */
export function rangeFor(
  offsets: Float64Array,
  top: number,
  viewport: number,
  overscan: number,
  pinned: readonly number[] = [],
): VirtualRange {
  const count = countOf(offsets);
  if (count === 0 || !(viewport > 0) || !Number.isFinite(viewport) || !Number.isFinite(top))
    return EMPTY;
  const bottom = top + viewport;
  const pad = Math.max(0, Math.floor(overscan));
  const first = indexAt(offsets, top);
  let last = first + 1;
  while (last < count && offsets[last]! < bottom) last++;
  const start = Math.max(0, first - pad);
  const end = Math.min(count, last + pad);
  const outside = [...new Set(pinned)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < count && (i < start || i >= end))
    .toSorted((a, b) => a - b);
  return { start, end, pinned: outside };
}
