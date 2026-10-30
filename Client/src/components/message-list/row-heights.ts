/**
 * Measured message-row heights that outlive one MessageList.
 *
 * Each list keeps its own measurements and drops them when it is destroyed, so
 * a channel opened again used to estimate every row afresh: a link card (about
 * 140 px once its preview has loaded) was estimated as text only, and the
 * spacer corrected itself while the reader scrolled up. Rows remembered here
 * seed the next list of the same channel with the height last drawn.
 *
 * A remembered height only seeds the estimate; the row is measured again when
 * it renders. It is used near the width it was measured at only (a scrollbar
 * appearing is within that), and an edit or a change of grouping is a
 * different key.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";

const MAX_ROWS = 4000;
/** An empty list has no scrollbar and a filled one does: rows measured either
 *  way still seed each other. */
const WIDTH_TOLERANCE = 20;

interface RowHeight {
  readonly width: number;
  readonly h: number;
}

const rows = new Map<string, RowHeight>();

export function clearRowHeights(): void {
  rows.clear();
}

void registerSessionReset("message-list:row-heights", clearRowHeights, { phase: "cache" }); // app-lifetime

export function rowHeightKey(
  id: number,
  isGrouped: boolean,
  editedAt: string | null | undefined,
): string {
  return `${id}|${isGrouped ? 1 : 0}|${editedAt ?? ""}`;
}

/** The height last measured for `key` at about `width`, if any. */
export function rememberedRowHeight(key: string, width: number): number | undefined {
  const hit = rows.get(key);
  if (hit === undefined || Math.abs(hit.width - width) > WIDTH_TOLERANCE) return undefined;
  return hit.h;
}

export function rememberRowHeight(key: string, width: number, h: number): void {
  rows.delete(key);
  rows.set(key, { width, h });
  if (rows.size > MAX_ROWS) {
    const oldest = rows.keys().next().value;
    if (oldest !== undefined) rows.delete(oldest);
  }
}
