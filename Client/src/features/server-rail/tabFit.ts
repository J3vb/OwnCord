/**
 * Which server tabs fit in the row. Pure: the renderer measures, this decides,
 * and the renderer writes `hidden` on the rest and the "+N" count.
 */

export interface TabFitInput {
  /** Each top-level item's tab at its natural width, in order. */
  readonly widths: readonly number[];
  /** The current item's index, or -1 when it is not in the layout. */
  readonly pinned: number;
  /** The width the track may take. */
  readonly room: number;
  /** "+N"'s width, measured. */
  readonly moreWidth: number;
  /** The gap between two tabs. */
  readonly gap: number;
}

export interface TabFit {
  readonly shown: readonly boolean[];
  readonly hidden: number;
}

/** The width of `count` tabs of total width `sum`, with their gaps. */
function rowWidth(sum: number, count: number, gap: number): number {
  return count === 0 ? 0 : sum + gap * (count - 1);
}

/**
 * Which of the row's items show, given their natural widths. The pinned item
 * always shows. When something is hidden, "+N" and its gap take room first; the
 * pinned item is counted next, then the others in layout order up to the first
 * that does not fit, so the row never skips an item.
 */
export function fitTabs(input: TabFitInput): TabFit {
  const { widths, pinned, room, moreWidth, gap } = input;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (rowWidth(total, widths.length, gap) <= room) {
    return { shown: widths.map(() => true), hidden: 0 };
  }
  const tabRoom = room - moreWidth - gap;
  const shown = widths.map((_, i) => i === pinned);
  let used = widths[pinned] ?? 0;
  let count = pinned >= 0 && pinned < widths.length ? 1 : 0;
  for (let i = 0; i < widths.length; i++) {
    if (i === pinned) continue;
    const next = used + (widths[i] ?? 0);
    if (rowWidth(next, count + 1, gap) > tabRoom) break;
    shown[i] = true;
    used = next;
    count++;
  }
  return { shown, hidden: shown.filter((s) => !s).length };
}
