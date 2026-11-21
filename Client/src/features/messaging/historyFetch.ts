// Shared helpers for the history fetches that install pages into a loaded
// window: the load journal a page fetch holds, paging a refetch back to the
// loaded rows, revalidating the rows a splice kept, and the one-shot recovery
// of a live message refused while a detached window re-attached.
import type { ApiClient } from "@lib/api";
import type { MessageResponse, MessagesResponse } from "@lib/types";
import { createLogger } from "@lib/logger";
import {
  getChannelMessages,
  holdLoadJournal,
  invalidateChannelMessageWindow,
  isWindowDetached,
  mergeTailMessages,
  releaseLoadJournal,
  revalidateRows,
} from "@stores/messages.store";

const log = createLogger("history-fetch");
const RECOVERY_PAGE_SIZE = 50;
/** The server's largest history page (maxMessageLimit). */
const MAX_PAGE_SIZE = 100;
/** Five pages span the 500-row per-channel window. */
const MAX_PAGES = 5;

/** Runs a page fetch and its install with the channel's load journal held, so
 *  an edit, delete or pin that arrives meanwhile is replayed onto the page.
 *  The hold is released when `run` settles, whatever the outcome. */
export async function withLoadJournal<T>(channelId: number, run: () => Promise<T>): Promise<T> {
  holdLoadJournal(channelId);
  try {
    return await run();
  } finally {
    releaseLoadJournal(channelId);
  }
}

/** Newest delivered row of the window (optimistic rows carry id 0): the cursor
 *  an `after` page continues from. */
export function newestSentId(channelId: number): number {
  return getChannelMessages(channelId).findLast((m) => m.id > 0)?.id ?? 0;
}

/**
 * The window was detached while the final page was in flight, so a live message
 * committed after the server's read was refused and is in neither that page nor
 * the list. One fetch after the re-attach fills the hole. Runs detached from the
 * page load (its own catch: nothing rejects). If it fails or is aborted the hole
 * would persist on an attached, "loaded" window, so the window is invalidated
 * and the next visit refetches the tail. `reload` refetches the tail when too
 * much arrived to patch; without it the window is only invalidated.
 */
export async function recoverRefusedTail(
  api: Pick<ApiClient, "getMessages">,
  channelId: number,
  after: number,
  signal?: AbortSignal,
  reload?: () => Promise<void>,
): Promise<void> {
  // An empty window has no cursor, and the server refuses after=0.
  if (after <= 0) return;
  try {
    await withLoadJournal(channelId, async () => {
      const tail = await api.getMessages(channelId, { after, limit: RECOVERY_PAGE_SIZE }, signal);
      if (signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      if (tail.has_more) {
        invalidateChannelMessageWindow(channelId);
        await reload?.();
      } else {
        mergeTailMessages(channelId, tail.messages);
      }
    });
    return;
  } catch (err) {
    if (signal?.aborted !== true) {
      log.error("Failed to recover the tail after a re-attach", { channelId, error: String(err) });
    }
  }
  invalidateChannelMessageWindow(channelId);
}

/** After an install: when it cleared the detached flag, fetch what a live
 *  message refused meanwhile left out. */
export function recoverAfterReattach(
  api: Pick<ApiClient, "getMessages">,
  channelId: number,
  wasDetached: boolean,
  signal?: AbortSignal,
  reload?: () => Promise<void>,
): void {
  if (!wasDetached || isWindowDetached(channelId)) return;
  void recoverRefusedTail(api, channelId, newestSentId(channelId), signal, reload);
}

/**
 * A page that stops short of the loaded rows leaves a gap above them: page
 * backwards from `first` until the fetched range reaches `target` (an id the
 * window holds), the history runs out, or five pages in all were read. A
 * target of 0 asks for no paging. A failed page stops with hasMoreBefore set.
 */
export async function pageBackTo(
  api: Pick<ApiClient, "getMessages">,
  channelId: number,
  first: Pick<MessagesResponse, "messages" | "has_more">,
  target: number,
  signal?: AbortSignal,
): Promise<{ fetched: MessageResponse[]; hasMoreBefore: boolean }> {
  const fetched: MessageResponse[] = [...first.messages];
  let oldest = fetched.at(-1)?.id ?? 0;
  let hasMoreBefore = first.has_more;
  if (target <= 0) return { fetched, hasMoreBefore };
  for (let pages = 1; oldest > target && hasMoreBefore && pages < MAX_PAGES; pages++) {
    if (signal?.aborted === true) break;
    // oxlint-disable-next-line no-await-in-loop -- sequential paging: each page is fetched before the one below it
    const older = await api
      .getMessages(channelId, { before: oldest, limit: MAX_PAGE_SIZE }, signal)
      .catch(() => null);
    if (!older) {
      hasMoreBefore = true;
      break;
    }
    if (older.messages.length === 0) break;
    fetched.push(...older.messages);
    oldest = older.messages.at(-1)!.id;
    hasMoreBefore = older.has_more;
  }
  return { fetched, hasMoreBefore };
}

/**
 * A splice keeps the loaded rows older than its page (ids below `below`) so the
 * reader's place survives, but nothing refetched them. Page back from `below`
 * until the pages reach the oldest kept row, then swap each kept row for the
 * server's copy and drop the ones it no longer has, so an edit, delete or
 * reaction made while away shows. Runs off the paint path with the load journal
 * held. A failure or an abort leaves the rows as they were.
 */
export async function revalidateOlderRows(
  api: Pick<ApiClient, "getMessages">,
  channelId: number,
  below: number,
  signal?: AbortSignal,
): Promise<void> {
  const oldest = getChannelMessages(channelId).find((m) => m.status === "sent")?.id;
  if (oldest === undefined || below <= 0 || oldest >= below) return;
  try {
    await withLoadJournal(channelId, async () => {
      const fetched: MessageResponse[] = [];
      let cursor = below;
      let more = true;
      for (let pages = 0; more && cursor > oldest && pages < MAX_PAGES; pages++) {
        // oxlint-disable-next-line no-await-in-loop -- sequential paging: each page continues from the last
        const page = await api.getMessages(
          channelId,
          { before: cursor, limit: MAX_PAGE_SIZE },
          signal,
        );
        if (signal?.aborted === true) return;
        more = page.has_more;
        if (page.messages.length === 0) break;
        fetched.push(...page.messages);
        cursor = page.messages.at(-1)!.id;
      }
      // Only the range the pages cover without a gap was checked.
      revalidateRows(channelId, fetched, more ? cursor : 0, below);
    });
  } catch (err) {
    if (signal?.aborted !== true) {
      log.warn("Failed to revalidate older rows", { channelId, error: String(err) });
    }
  }
}
