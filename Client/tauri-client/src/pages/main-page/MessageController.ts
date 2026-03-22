/**
 * MessageController — message loading, pagination, and pending-delete logic.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import {
  setMessages,
  prependMessages,
  isChannelLoaded,
  getChannelMessages,
} from "@stores/messages.store";

const log = createLogger("message-ctrl");
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Pending Delete Manager
// ---------------------------------------------------------------------------

export interface PendingDeleteManager {
  /**
   * Attempt to delete a message. Returns "confirmed" on the second click
   * within the timeout window, "pending" on the first click.
   */
  tryDelete(msgId: number): "confirmed" | "pending";
  /** Clear all pending timeouts. */
  cleanup(): void;
}

export function createPendingDeleteManager(): PendingDeleteManager {
  const pending = new Map<number, number>();

  function tryDelete(msgId: number): "confirmed" | "pending" {
    if (pending.has(msgId)) {
      window.clearTimeout(pending.get(msgId));
      pending.delete(msgId);
      return "confirmed";
    }
    const tid = window.setTimeout(() => pending.delete(msgId), 5000);
    pending.set(msgId, tid);
    return "pending";
  }

  function cleanup(): void {
    for (const tid of pending.values()) {
      window.clearTimeout(tid);
    }
    pending.clear();
  }

  return { tryDelete, cleanup };
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
}

export function createMessageController(
  opts: MessageControllerOptions,
): MessageController {
  const { api, showError } = opts;

  async function loadMessages(
    channelId: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (isChannelLoaded(channelId)) {
      log.debug("Messages already loaded", { channelId });
      return;
    }
    try {
      const resp = await api.getMessages(channelId, { limit: PAGE_SIZE }, signal);
      if (!signal.aborted) {
        log.info("Messages loaded", {
          channelId,
          count: resp.messages.length,
          hasMore: resp.has_more,
        });
        setMessages(channelId, resp.messages, resp.has_more);
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load messages", {
          channelId,
          error: String(err),
        });
        showError("Failed to load messages");
      }
    }
  }

  async function loadOlderMessages(
    channelId: number,
    signal: AbortSignal,
  ): Promise<void> {
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
        prependMessages(channelId, resp.messages, resp.has_more);
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load older messages", {
          channelId,
          error: String(err),
        });
        showError("Failed to load older messages");
      }
    }
  }

  return { loadMessages, loadOlderMessages };
}
