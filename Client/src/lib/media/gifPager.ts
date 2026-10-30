// Paging state for the GIF picker's "load more on scroll".
//
// Tenor-style paging: each page carries an opaque `next` cursor that is sent
// back as `pos`. The provider is not documented to us, so this is defensive:
// a page that brings no id we have not already seen ends paging (a provider
// that ignores `pos` would otherwise hand back page one forever), and so does
// an empty `next`. A failed page does not end paging; the caller may retry.
//
// A generation token (bumped by begin()) makes a page that resolves after the
// query changed a no-op, so it can never be appended to the new query's grid.

import { ApiClientError } from "../api";
import type { GifPage, GifResult } from "./gifProvider";
import { RestErrorCode } from "@lib/protocolTypes";

/** Most pages (the first included) one query will ever load. */
export const MAX_PAGES = 10;
/** No retry within this long of a failed page; doubles per consecutive failure. */
export const RETRY_COOLDOWN_MS = 3_000;
export const RETRY_COOLDOWN_MAX_MS = 30_000;

/** A failure a retry cannot fix: a client error other than 429, or GIFs disabled. */
function isPermanent(err: unknown): boolean {
  if (!(err instanceof ApiClientError)) return false;
  if (err.code === RestErrorCode.GIF_DISABLED) return true;
  return err.status >= 400 && err.status < 500 && err.status !== 429;
}

/** Dedupe key: the id, or the full URL for a result that came without one. */
function keyOf(gif: GifResult): string {
  return gif.id !== "" ? gif.id : gif.fullUrl;
}

export interface GifPager {
  /** Start a new query from its first page; returns the page deduped by id. */
  begin(first: GifPage): readonly GifResult[];
  /** True while another page may exist (not exhausted). */
  hasMore(): boolean;
  /** True after the last loadMore failed; the next attempt retries the same cursor. */
  failed(): boolean;
  /**
   * Fetch the next page. Resolves to the GIFs not seen before, or `null` when
   * nothing should be rendered (exhausted, already loading, stale, or failed).
   */
  loadMore(fetchPage: (pos: string) => Promise<GifPage>): Promise<readonly GifResult[] | null>;
  /** Bumped by begin() and reset(); compare before and after an await. */
  generation(): number;
  /** Invalidate any in-flight page and stop paging (tab switch, new query). */
  reset(): void;
}

export function createGifPager(now: () => number = Date.now): GifPager {
  let generation = 0;
  let seen = new Set<string>();
  let next = "";
  let loading = false;
  let lastFailed = false;
  let pages = 0;
  let failures = 0;
  let retryAt = 0;

  function take(gifs: readonly GifResult[]): readonly GifResult[] {
    const fresh: GifResult[] = [];
    for (const gif of gifs) {
      const key = keyOf(gif);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(gif);
    }
    return fresh;
  }

  return {
    begin(first) {
      generation++;
      seen = new Set();
      loading = false;
      lastFailed = false;
      pages = 1;
      failures = 0;
      retryAt = 0;
      next = first.next;
      return take(first.gifs);
    },
    hasMore: () => next !== "",
    failed: () => lastFailed,
    generation: () => generation,
    reset() {
      generation++;
      loading = false;
      lastFailed = false;
      next = "";
    },
    async loadMore(fetchPage) {
      if (next === "" || loading || now() < retryAt) return null;
      const mine = generation;
      loading = true;
      lastFailed = false;
      try {
        const page = await fetchPage(next);
        if (mine !== generation) return null;
        const fresh = take(page.gifs);
        // No new id: either the provider ignored `pos` or it ran dry.
        pages++;
        failures = 0;
        next = fresh.length === 0 || pages >= MAX_PAGES ? "" : page.next;
        return fresh;
      } catch (err) {
        if (mine !== generation) return null;
        if (isPermanent(err)) {
          next = "";
          return null;
        }
        lastFailed = true;
        failures++;
        retryAt = now() + Math.min(RETRY_COOLDOWN_MS * 2 ** (failures - 1), RETRY_COOLDOWN_MAX_MS);
        return null;
      } finally {
        if (mine === generation) loading = false;
      }
    },
  };
}
