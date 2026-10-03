/**
 * MessageController — message loading, pagination, and pending-delete logic.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { shellText } from "../../i18n/shell";
import {
  setMessages,
  prependMessages,
  isChannelLoaded,
  getChannelMessages,
  isWindowDetached,
  setChannelLoading,
  setChannelLoadError,
} from "@stores/messages.store";
import { getUnreadOnOpen } from "@stores/channels.store";

const log = createLogger("message-ctrl");
const PAGE_SIZE = 50;
/** The server's largest history page (maxMessageLimit). */
const MAX_PAGE_SIZE = 100;

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
}

export function createMessageController(opts: MessageControllerOptions): MessageController {
  const { api, showError } = opts;

  async function loadMessages(channelId: number, signal: AbortSignal): Promise<void> {
    if (isChannelLoaded(channelId)) {
      log.debug("Messages already loaded", { channelId });
      return;
    }
    // P4-01 R3: a revisit asks for enough rows to reach back to the oldest
    // cached row (capped at the server's 100-row page), so the one refetch
    // revalidates every row it keeps — an edit made while away shows, a delete
    // made while away is gone. A detached around-window's rows are not the
    // tail, so they are excluded: a jump back to present fetches a plain page.
    const cached = isWindowDetached(channelId)
      ? []
      : getChannelMessages(channelId).filter((m) => m.status === "sent");
    // Only a revisit has a cached window to reach back to; a first visit asks
    // for a single page regardless of how many messages await it.
    const limit =
      cached.length > 0
        ? Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, cached.length + getUnreadOnOpen(channelId)))
        : PAGE_SIZE;
    // Runs synchronously before the first await, so an empty message region
    // shows its in-region loading placeholder from the very first render. A
    // revisit's cached rows stay on screen instead, and setMessages below
    // reconciles the refetched page into them.
    setChannelLoading(channelId);
    try {
      const resp = await api.getMessages(channelId, { limit }, signal);
      // Re-check "loaded" after the await: a same-channel jump can install an
      // around-window (setAroundMessages) while this mount-time tail fetch is
      // still in flight — nothing aborts this fetch's signal in that case.
      // Both landing marks the channel loaded, so a tail response that lost
      // the race is discarded instead of clobbering the jump's window.
      if (!signal.aborted && !isChannelLoaded(channelId)) {
        // Rows the extended page brought from above the cached window would
        // land as a prepend and rebuild the list; leave them for scrolling up.
        // Only an extended page (limit > PAGE_SIZE) is trimmed — a default
        // page's extra rows are history the failed-first-load retry fetched.
        const head = limit > PAGE_SIZE ? (cached[0]?.id ?? 0) : 0;
        const trimmed = resp.messages.filter((m) => m.id >= head);
        // Never install an empty window: if everything from the cached head
        // upward was deleted while away the trim would drop every row, so keep
        // the fetched page and let setMessages absorb the stale cached rows.
        const messages = trimmed.length > 0 ? trimmed : resp.messages;
        const hasMore = resp.has_more || messages.length < resp.messages.length;
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
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load older messages", {
          channelId,
          error: String(err),
        });
        showError(shellText("messages.loadOlderFailed"));
      }
    }
  }

  return { loadMessages, loadOlderMessages };
}
