/**
 * MessageController — message loading, pagination, and pending-delete logic.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import type { ApiClient } from "@lib/api";
import type { MessageResponse } from "@lib/types";
import { createLogger } from "@lib/logger";
import { shellText } from "../../i18n/shell";
import {
  setMessages,
  prependMessages,
  appendNewerMessages,
  mergeTailMessages,
  invalidateChannelMessageWindow,
  isChannelLoaded,
  getChannelMessages,
  isWindowDetached,
  setChannelLoading,
  setChannelLoadError,
  setOlderLoadFailed,
} from "@stores/messages.store";

const log = createLogger("message-ctrl");
const PAGE_SIZE = 50;
/** The server's largest history page (maxMessageLimit). */
const MAX_PAGE_SIZE = 100;
/** Revisit paging bound: five pages span the 500-row per-channel window. */
const MAX_REVISIT_PAGES = 5;

/** Newest delivered row of the window (optimistic rows carry id 0): the cursor
 *  an `after` page continues from. */
function newestSentId(channelId: number): number {
  return getChannelMessages(channelId).findLast((m) => m.id > 0)?.id ?? 0;
}

// ---------------------------------------------------------------------------
// Message Controller
// ---------------------------------------------------------------------------

export interface MessageControllerOptions {
  readonly api: ApiClient;
  readonly showError: (msg: string) => void;
}

export interface MessageController {
  loadMessages(channelId: number, signal: AbortSignal): Promise<void>;
  loadOlderMessages(channelId: number, signal: AbortSignal): Promise<void>;
  /** Load the next page below a detached window; reaching the newest message reattaches it. */
  loadNewerMessages(channelId: number, signal: AbortSignal): Promise<void>;
}

export function createMessageController(opts: MessageControllerOptions): MessageController {
  const { api, showError } = opts;

  async function loadMessages(channelId: number, signal: AbortSignal): Promise<void> {
    // Mounting a channel starts it clean: an older-page failure from an
    // earlier visit does not follow it back in.
    setOlderLoadFailed(channelId, false);
    if (isChannelLoaded(channelId)) {
      log.debug("Messages already loaded", { channelId });
      return;
    }
    // A revisit refetches the tail and reconciles it into the cached
    // window, so every cached row it keeps is revalidated — an edit made while
    // away shows, a delete made while away is gone. The page is not sized from
    // the local unread count: messages posted while the reader was in another
    // channel arrive unsubscribed and are never counted, so that count can be
    // 0 while the tail grew. A detached around-window's rows are not the tail,
    // so they are excluded: a jump back to present fetches a plain page.
    const cached = isWindowDetached(channelId)
      ? []
      : getChannelMessages(channelId).filter((m) => m.status === "sent");
    // Only a revisit has a cached window to reach back to; a first visit asks
    // for a single page regardless of how many messages await it.
    const limit = cached.length > 0 ? MAX_PAGE_SIZE : PAGE_SIZE;
    // Runs synchronously before the first await, so an empty message region
    // shows its in-region loading placeholder from the very first render. A
    // revisit's cached rows stay on screen instead, and setMessages below
    // reconciles the refetched page into them.
    setChannelLoading(channelId);
    try {
      const first = await api.getMessages(channelId, { limit }, signal);
      // A page that stops short of the oldest cached row leaves a gap above the
      // cached window; page backwards until the fetched range reaches the head
      // (or the history runs out). Five 100-row pages span the 500-row window:
      // when the cached window plus the unseen gap exceeds them the head is not
      // reached, so the rows below the fetched range are dropped instead.
      const head = cached[0]?.id ?? 0;
      const fetched: MessageResponse[] = [...first.messages];
      let oldest = fetched[fetched.length - 1]?.id ?? 0;
      let hasMoreBefore = first.has_more;
      for (
        let pages = 1;
        cached.length > 0 &&
        !signal.aborted &&
        oldest > head &&
        hasMoreBefore &&
        pages < MAX_REVISIT_PAGES;
        pages++
      ) {
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
        oldest = older.messages[older.messages.length - 1]!.id;
        hasMoreBefore = older.has_more;
      }
      // Re-check "loaded" after the awaits: a same-channel jump can install an
      // around-window (setAroundMessages) while this mount-time tail fetch is
      // still in flight — nothing aborts this fetch's signal in that case.
      // Both landing marks the channel loaded, so a tail response that lost
      // the race is discarded instead of clobbering the jump's window.
      if (!signal.aborted && !isChannelLoaded(channelId)) {
        // Rows the fetched range brought from above the cached window would
        // land as a prepend and rebuild the list; leave them for scrolling up.
        // A cache shorter than a default page keeps the newest default page
        // instead — a revisit never shows fewer rows than a first visit.
        let trimmed = fetched.filter((m) => m.id >= head);
        if (cached.length > 0 && trimmed.length > 0 && trimmed.length < PAGE_SIZE) {
          trimmed = fetched.slice(0, PAGE_SIZE);
        }
        // Never install an empty window: if everything from the cached head
        // upward was deleted while away the trim would drop every row, so keep
        // the fetched range and let setMessages absorb the stale cached rows.
        const messages = trimmed.length > 0 ? trimmed : fetched;
        const hasMore = hasMoreBefore || messages.length < fetched.length;
        log.info("Messages loaded", {
          channelId,
          count: messages.length,
          hasMore,
        });
        setMessages(channelId, messages, hasMore);
      }
    } catch (err) {
      // Same re-check as the success path above: a same-channel jump can
      // install an around-window (setAroundMessages) while this mount-time
      // tail fetch is still in flight, and nothing aborts this fetch's
      // signal in that case. If that window already landed and marked the
      // channel loaded, this fetch lost the race — it must be discarded
      // silently instead of flagging a correctly-loaded, fully-rendered
      // channel as load-errored and toasting on top of a jump that worked.
      if (!signal.aborted && !isChannelLoaded(channelId)) {
        log.error("Failed to load messages", {
          channelId,
          error: String(err),
        });
        // Inline section error + Retry in the message region (UX spec §2) —
        // a toast would vanish and leave the region silently empty.
        setChannelLoadError(channelId);
        // The inline region only renders when the channel has no rows; live
        // broadcasts or an optimistic send may already have populated it, in
        // which case the failure must still be surfaced (no silent drop).
        if (getChannelMessages(channelId).length > 0) {
          showError(shellText("messages.loadHistoryFailed"));
        }
      }
    }
  }

  async function loadOlderMessages(channelId: number, signal: AbortSignal): Promise<void> {
    const messages = getChannelMessages(channelId);
    if (messages.length === 0) return;
    const oldest = messages[0]!;
    try {
      const resp = await api.getMessages(
        channelId,
        { before: oldest.id, limit: PAGE_SIZE },
        signal,
      );
      if (!signal.aborted) {
        // The window can be replaced wholesale while this fetch is in flight
        // (e.g. a same-channel jump swaps in an around-window via
        // setAroundMessages) — nothing aborts this fetch's controller in that
        // case. Splicing this now-stale page onto a window it was never
        // fetched for would duplicate/misorder rows, so bail if the row this
        // page continues from is no longer the window's oldest.
        const current = getChannelMessages(channelId);
        if (current.length > 0 && current[0]!.id === oldest.id) {
          prependMessages(channelId, resp.messages, resp.has_more);
        }
        // The fetch itself succeeded, so any earlier failure is over; a page
        // that no longer fits the window needs no Retry either.
        setOlderLoadFailed(channelId, false);
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load older messages", {
          channelId,
          error: String(err),
        });
        // Inline Retry at the top of the list (a toast would vanish and leave
        // the reader at the top with no way to ask again). An aborted fetch
        // never reaches here, so it sets no flag.
        // Only for the window this fetch started from: after a jump replaced
        // it, the failure belongs to a page nobody is waiting for.
        if (getChannelMessages(channelId)[0]?.id === oldest.id) {
          setOlderLoadFailed(channelId, true);
        }
      }
    }
  }

  // The window was detached while the final page was in flight, so a live
  // message committed after the server's read was refused and is in neither
  // that page nor the list. One tail fetch after the re-attach fills the hole.
  // Runs detached from the page load (its own catch: nothing rejects). If it
  // fails or is aborted the hole would persist on an attached, "loaded"
  // window, so the window is invalidated and the next visit refetches the tail.
  async function recoverRefusedTail(
    channelId: number,
    after: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const tail = await api.getMessages(channelId, { after, limit: PAGE_SIZE }, signal);
      if (!signal.aborted) {
        if (tail.has_more) {
          // Too much arrived to patch: reload the live tail instead.
          invalidateChannelMessageWindow(channelId);
          await loadMessages(channelId, signal);
        } else {
          mergeTailMessages(channelId, tail.messages);
        }
        return;
      }
    } catch (err) {
      log.error("Failed to recover the tail after a newer page", { channelId, error: String(err) });
    }
    invalidateChannelMessageWindow(channelId);
  }

  async function loadNewerMessages(channelId: number, signal: AbortSignal): Promise<void> {
    if (!isWindowDetached(channelId)) return;
    const newest = newestSentId(channelId);
    if (newest === 0) return;
    try {
      const resp = await api.getMessages(channelId, { after: newest, limit: PAGE_SIZE }, signal);
      // The window can be replaced while this fetch is in flight (a new jump
      // installs another around-window, a jump to present reloads the tail):
      // nothing aborts this fetch's controller then. Splicing a page fetched
      // for the old window onto the new one would misorder rows, so apply it
      // only while the window is still detached and ends at the same row.
      if (!signal.aborted && isWindowDetached(channelId) && newestSentId(channelId) === newest) {
        appendNewerMessages(channelId, resp.messages, resp.has_more);
        if (!resp.has_more) {
          void recoverRefusedTail(channelId, resp.messages.at(-1)?.id ?? newest, signal);
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load newer messages", {
          channelId,
          error: String(err),
        });
        showError(shellText("messages.loadNewerFailed"));
      }
    }
  }

  return { loadMessages, loadOlderMessages, loadNewerMessages };
}
