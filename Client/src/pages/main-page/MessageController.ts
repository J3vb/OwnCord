/**
 * MessageController — message loading, pagination, and pending-delete logic.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import type { ApiClient } from "@lib/api";
import type { MessageResponse, MessagesResponse } from "@lib/types";
import { createLogger } from "@lib/logger";
import { shellText } from "../../i18n/shell";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { setChannelWarmHandler } from "@lib/nav/channelNavigation";
import {
  newestSentId,
  recoverAfterReattach,
  recoverRefusedTail,
  withLoadJournal,
} from "../../features/messaging/historyFetch";
import { createChannelWarmup } from "../../features/messaging/channelWarmup";
import {
  setMessages,
  prependMessages,
  appendNewerMessages,
  invalidateChannelMessageWindow,
  isChannelLoaded,
  getChannelMessages,
  isWindowDetached,
  setChannelLoading,
  setChannelLoadError,
  setOlderLoadFailed,
} from "@stores/messages.store";

const emptyPage: MessagesResponse = { messages: [], has_more: false };
const log = createLogger("message-ctrl");
const PAGE_SIZE = 50;
/** The server's largest history page (maxMessageLimit). */
const MAX_PAGE_SIZE = 100;
/** Revisit paging bound: five pages span the 500-row per-channel window. */
const MAX_REVISIT_PAGES = 5;

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

/** A first visit to a text channel or DM that is not on screen. */
function worthWarming(channelId: number): boolean {
  const channels = channelsStore.getState();
  if (channels.activeChannelId === channelId) return false;
  if (isChannelLoaded(channelId) || getChannelMessages(channelId).length > 0) return false;
  const ch = channels.channels.get(channelId);
  if (ch !== undefined) return ch.type === "text" || ch.type === "announcement" || ch.type === "dm";
  return dmStore.getState().channels.some((c) => c.channelId === channelId);
}

function installTail(
  channelId: number,
  fetched: MessageResponse[],
  hasMoreBefore: boolean,
  cached: readonly unknown[],
  head: number,
): void {
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
  // When an older page landed meanwhile it is already on screen, so the whole
  // fetched range goes in: only rows older than that range are kept, and a
  // cached row the range no longer holds (deleted while away) drops out.
  const splice = olderPageLanded(channelId, fetched, head);
  const messages = splice ? fetched : trimmed.length > 0 ? trimmed : fetched;
  const hasMore = hasMoreBefore || messages.length < fetched.length;
  log.info("Messages loaded", {
    channelId,
    count: messages.length,
    hasMore,
  });
  setMessages(channelId, messages, hasMore, splice);
}

/**
 * Whether the reader scrolled up while the refetch was in flight and an older
 * page landed above the cached head. That page was read after this load began,
 * so it is as fresh as the refetch: when the fetched range reaches the head
 * (no gap between them), the window keeps it instead of dropping it as stale
 * cached rows. Dropping it pulled the page out from under the reader, moved
 * the row they were reading and sent the same older request again.
 */
function olderPageLanded(
  channelId: number,
  fetched: readonly MessageResponse[],
  head: number,
): boolean {
  const oldestFetched = fetched[fetched.length - 1]?.id;
  if (head === 0 || oldestFetched === undefined || oldestFetched > head) return false;
  return getChannelMessages(channelId).some((m) => m.status === "sent" && m.id < head);
}

export function createMessageController(opts: MessageControllerOptions): MessageController {
  const { api, showError } = opts;
  const warmup = createChannelWarmup(api, PAGE_SIZE);

  /** The page the press already asked for when this is a first visit, else the normal request. */
  async function firstPage(
    channelId: number,
    limit: number,
    firstVisit: boolean,
    signal: AbortSignal,
  ): Promise<{ first: MessagesResponse; warmed: MessagesResponse | null }> {
    const pending = firstVisit ? warmup.take(channelId, signal) : null;
    const taken = pending === null ? null : await pending;
    // Nothing to top up from on an empty page: ask the normal way.
    const warmed = taken !== null && taken.messages.length > 0 ? taken : null;
    if (warmed !== null || signal.aborted) return { first: warmed ?? emptyPage, warmed };
    return { first: await api.getMessages(channelId, { limit }, signal), warmed: null };
  }

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
    const wasDetached = isWindowDetached(channelId);
    setChannelLoading(channelId);
    try {
      const { first, warmed } = await firstPage(channelId, limit, cached.length === 0, signal);
      if (signal.aborted) return;
      const head = cached[0]?.id ?? 0;
      const { fetched, hasMoreBefore } = await pageBackToHead(
        channelId,
        signal,
        first,
        cached,
        head,
      );
      // Re-check "loaded" after the awaits: a same-channel jump can install an
      // around-window (setAroundMessages) while this mount-time tail fetch is
      // still in flight — nothing aborts this fetch's signal in that case.
      // Both landing marks the channel loaded, so a tail response that lost
      // the race is discarded instead of clobbering the jump's window.
      if (!signal.aborted && !isChannelLoaded(channelId)) {
        installTail(channelId, fetched, hasMoreBefore, cached, head);
        // A live message refused while the window was detached is in neither
        // the page nor the list: fetch what follows the newest row.
        recoverAfterReattach(api, channelId, wasDetached, signal, () =>
          loadMessages(channelId, signal),
        );
        // The page was read before channel_focus left, so a message posted, edited
        // or deleted in between reached neither the page nor the live feed: the
        // revisit refetch reconciles the rows just shown, off the paint path.
        if (warmed !== null) {
          invalidateChannelMessageWindow(channelId);
          void loadMessages(channelId, signal);
        }
      }
    } catch (err) {
      // Same re-check as the success path above: a jump's window that already
      // landed means this fetch lost the race and is discarded silently.
      if (!signal.aborted && !isChannelLoaded(channelId)) reportLoadFailure(channelId, err);
    }
  }

  /**
   * A page that stops short of the oldest cached row leaves a gap above the
   * cached window; page backwards until the fetched range reaches the head
   * (or the history runs out). Five 100-row pages span the 500-row window:
   * when the cached window plus the unseen gap exceeds them the head is not
   * reached, so the rows below the fetched range are dropped instead.
   */
  async function pageBackToHead(
    channelId: number,
    signal: AbortSignal,
    first: { readonly messages: readonly MessageResponse[]; readonly has_more: boolean },
    cached: readonly unknown[],
    head: number,
  ): Promise<{ fetched: MessageResponse[]; hasMoreBefore: boolean }> {
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
    return { fetched, hasMoreBefore };
  }

  function reportLoadFailure(channelId: number, err: unknown): void {
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

  function loadOlderMessages(channelId: number, signal: AbortSignal): Promise<void> {
    const oldest = getChannelMessages(channelId)[0];
    if (oldest === undefined) return Promise.resolve();
    return withLoadJournal(channelId, () => fetchOlderPage(channelId, oldest, signal));
  }

  async function fetchOlderPage(
    channelId: number,
    oldest: { readonly id: number },
    signal: AbortSignal,
  ): Promise<void> {
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

  /** After a re-attach: fetch what a live message refused meanwhile left out. */
  function recoverTail(channelId: number, after: number, signal: AbortSignal): Promise<void> {
    return recoverRefusedTail(api, channelId, after, signal, () => loadMessages(channelId, signal));
  }

  function loadNewerMessages(channelId: number, signal: AbortSignal): Promise<void> {
    if (!isWindowDetached(channelId) || newestSentId(channelId) === 0) return Promise.resolve();
    return withLoadJournal(channelId, () => fetchNewerPage(channelId, signal));
  }

  async function fetchNewerPage(channelId: number, signal: AbortSignal): Promise<void> {
    const newest = newestSentId(channelId);
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
          void recoverTail(channelId, resp.messages.at(-1)?.id ?? newest, signal);
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

  // The controller owns the press-to-warm door while its session lives; a newer
  // controller (a new sign-in) takes the door over, and the session end releases it.
  const releaseDoor = setChannelWarmHandler({
    warm: (channelId) => {
      if (worthWarming(channelId)) warmup.warm(channelId);
    },
    cancel: warmup.cancel,
  });
  api.getSession?.().addCleanup?.(() => {
    releaseDoor();
    warmup.destroy();
  });

  return { loadMessages, loadOlderMessages, loadNewerMessages };
}
