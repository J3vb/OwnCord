/** Constants and small helpers the message list modules share. */
import { createLogger } from "@lib/logger";
import { blocksStore } from "@stores/blocks.store";
import { ROW_FOCUSABLE_SELECTOR } from "./messageActions";

/** How often rendered `<t:…:R>` timestamps are rewritten. */
export const RELATIVE_TIMESTAMP_REFRESH_MS = 60_000;

export const log = createLogger("message-list");

export const SCROLL_TOP_THRESHOLD = 50;
/** Older history starts loading this many viewport heights before the top,
 *  so the next page is usually in before the reader gets there. */
export const SCROLL_TOP_VIEWPORTS = 2;
/** Newer history (below a detached window) starts loading this many viewport
 *  heights before the bottom, mirroring SCROLL_TOP_VIEWPORTS. */
export const SCROLL_BOTTOM_VIEWPORTS = 2;
/** After a failed older-page fetch, scrolling inside the trigger zone waits
 *  this long before retrying, unless the reader leaves the zone first. */
export const OLDER_RETRY_COOLDOWN_MS = 5000;
/** How long a send waits for a detached window's tail reload before it stops
 *  pulling the reader to the bottom. */
export const FOLLOW_OWN_SEND_MS = 10_000;
export const SCROLL_BOTTOM_THRESHOLD = 100;
export const JUMP_RECENTRE_MS = 3000;

export const blockedUsers = (): ReadonlySet<number> => blocksStore.getState().blockedByMe;

/** The hover bar's "..." button the event came from, if any. */
export function moreButtonOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(".msg-actions-bar [data-testid^='msg-more-']")
    : null;
}

/** Headroom above the NEW divider on open: the unread bar overlays the top of the viewport. */
export const UNREAD_BAR_CLEARANCE = 40;

/** Most items rendered beyond the visible range in each direction. Also the
 *  buffer when the viewport has no height yet (first paint, hidden tab). */
export const OVERSCAN_MAX_ROWS = 20;
/** Fewest items kept beyond the visible range, so a list of tall rows still has
 *  something to scroll into. */
export const OVERSCAN_MIN_ROWS = 4;
/** The render window reaches this many viewport heights above and below what is
 *  on screen, bounded by the row limits above. */
export const OVERSCAN_VIEWPORTS = 1;

export function clampOverscan(rows: number): number {
  return Math.min(OVERSCAN_MAX_ROWS, Math.max(OVERSCAN_MIN_ROWS, rows));
}

/**
 * Focus the first control of the nearest row that survived a patch: the next
 * one below the removed row, else the one above. `rows` are the rendered rows
 * of the new window, from item index `start`.
 */
export function focusSurvivingRow(
  prevKeys: readonly string[],
  nextIndex: ReadonlyMap<string, number>,
  rows: readonly HTMLElement[],
  start: number,
  prevStart: number,
  prevEnd: number,
  removedKey: string,
): void {
  const from = prevKeys.indexOf(removedKey);
  const survivor = (i: number): HTMLElement | undefined => {
    const j = nextIndex.get(prevKeys[i]!);
    if (j === undefined) return undefined;
    const el = rows[j - start];
    return el !== undefined && el.querySelector(ROW_FOCUSABLE_SELECTOR) !== null ? el : undefined;
  };
  for (let i = from + 1; i < prevEnd; i++) {
    const el = survivor(i);
    if (el !== undefined) {
      el.querySelector<HTMLElement>(ROW_FOCUSABLE_SELECTOR)?.focus({ preventScroll: true });
      return;
    }
  }
  for (let i = from - 1; i >= prevStart; i--) {
    const el = survivor(i);
    if (el !== undefined) {
      el.querySelector<HTMLElement>(ROW_FOCUSABLE_SELECTOR)?.focus({ preventScroll: true });
      return;
    }
  }
}

/** Share of the visible height one PageUp/PageDown scrolls. */
export const PAGE_SCROLL_FRACTION = 0.875;

/** The scroll viewport's geometry. Reading it forces layout when the DOM is
 *  dirty, so a scroll frame reads it once and passes the result down. */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

export function readMetrics(el: HTMLElement): ScrollMetrics {
  return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
}
