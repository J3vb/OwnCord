// Shared helpers for the history fetches that install pages into a loaded
// window: the load journal a page fetch holds, and the one-shot recovery of a
// live message refused while a detached window re-attached.
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import {
  getChannelMessages,
  holdLoadJournal,
  invalidateChannelMessageWindow,
  isWindowDetached,
  mergeTailMessages,
  releaseLoadJournal,
} from "@stores/messages.store";

const log = createLogger("history-fetch");
const RECOVERY_PAGE_SIZE = 50;

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
  signal: AbortSignal,
  reload?: () => Promise<void>,
): Promise<void> {
  // An empty window has no cursor, and the server refuses after=0.
  if (after <= 0) return;
  try {
    await withLoadJournal(channelId, async () => {
      const tail = await api.getMessages(channelId, { after, limit: RECOVERY_PAGE_SIZE }, signal);
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (tail.has_more) {
        invalidateChannelMessageWindow(channelId);
        await reload?.();
      } else {
        mergeTailMessages(channelId, tail.messages);
      }
    });
    return;
  } catch (err) {
    if (!signal.aborted) {
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
  signal: AbortSignal,
  reload?: () => Promise<void>,
): void {
  if (!wasDetached || isWindowDetached(channelId)) return;
  void recoverRefusedTail(api, channelId, newestSentId(channelId), signal, reload);
}
