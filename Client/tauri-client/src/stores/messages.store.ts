/**
 * Messages store — holds chat messages per channel, pending send tracking,
 * and load state for infinite scroll.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ChatMessagePayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  ReactionUpdatePayload,
  MessageUser,
  Attachment,
  ReactionSummary,
  MessageResponse,
} from "@lib/types";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Delivery status of a message row.
 * - "sent": confirmed by the server (the default for every server-sourced row).
 * - "pending": optimistic local row awaiting the chat_send_ok ack.
 * - "failed": the send was rejected or dropped; the row offers retry.
 */
export type MessageStatus = "sent" | "pending" | "failed";

export interface Message {
  readonly id: number;
  readonly channelId: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly replyTo: number | null;
  readonly attachments: readonly Attachment[];
  readonly reactions: readonly ReactionSummary[];
  readonly pinned: boolean;
  readonly editedAt: string | null;
  readonly deleted: boolean;
  readonly timestamp: string;
  /** Delivery status. Server-sourced rows are always "sent". */
  readonly status: MessageStatus;
  /**
   * Correlation id for an optimistic row, matching the id echoed on
   * chat_send_ok / error. Null once reconciled or for server-sourced rows.
   */
  readonly correlationId: string | null;
  /** Error code when status === "failed" (e.g. "SLOW_MODE", "FORBIDDEN"). */
  readonly errorCode: string | null;
}

export interface MessagesState {
  /** Messages per channel: channelId -> ordered array of Message */
  readonly messagesByChannel: ReadonlyMap<number, readonly Message[]>;
  /** Pending send confirmations: correlationId -> channelId */
  readonly pendingSends: ReadonlyMap<string, number>;
  /** Whether we've loaded initial messages for a channel */
  readonly loadedChannels: ReadonlySet<number>;
  /** Whether more messages exist above for a channel */
  readonly hasMore: ReadonlyMap<number, boolean>;
  /**
   * First-page history fetch state per channel. Absent entry = idle (loaded or
   * never requested) — the message region then renders normally/empty.
   */
  readonly historyLoadState: ReadonlyMap<number, "loading" | "error">;
}

// -----------------------------------------------------------------------------
// Helpers: convert wire types to store types
// -----------------------------------------------------------------------------

function chatPayloadToMessage(payload: ChatMessagePayload): Message {
  return {
    id: payload.id,
    channelId: payload.channel_id,
    user: payload.user,
    content: payload.content,
    replyTo: payload.reply_to,
    attachments: payload.attachments,
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: payload.timestamp,
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

function messageResponseToMessage(response: MessageResponse): Message {
  return {
    id: response.id,
    channelId: response.channel_id,
    user: response.user,
    content: response.content,
    replyTo: response.reply_to,
    attachments: response.attachments,
    reactions: response.reactions,
    pinned: response.pinned,
    editedAt: response.edited_at,
    deleted: response.deleted,
    timestamp: response.timestamp,
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

/** Maximum messages retained per channel. Oldest messages are evicted when exceeded. */
const MAX_MESSAGES_PER_CHANNEL = 500;

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const INITIAL_STATE: MessagesState = {
  messagesByChannel: new Map(),
  pendingSends: new Map(),
  loadedChannels: new Set(),
  hasMore: new Map(),
  historyLoadState: new Map(),
};

// -----------------------------------------------------------------------------
// Store instance
// -----------------------------------------------------------------------------

export const messagesStore = createStore<MessagesState>(INITIAL_STATE);

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/**
 * Append a new message from a chat_message WS event, reconciling with any
 * optimistic row it corresponds to.
 *
 * Reconciliation (the server sends chat_send_ok before the broadcast, so by the
 * time our own echo arrives the optimistic row already carries its real id):
 *   1. If a row with the same real id exists, replace it in place — this turns
 *      an optimistic "sent" row into the full server message (attachments,
 *      sanitized content, server timestamp) and is idempotent against replay.
 *   2. Otherwise, defensively reconcile the oldest still-pending row from the
 *      same author (covers a broadcast that raced ahead of its ack).
 *   3. Otherwise, append as a new message.
 */
export function addMessage(payload: ChatMessagePayload): void {
  const message = chatPayloadToMessage(payload);
  messagesStore.setState((prev) => {
    const channelId = message.channelId;
    const existing = prev.messagesByChannel.get(channelId) ?? [];

    // 1. Replace an existing row with the same real id (reconcile / idempotent).
    const idIdx = existing.findIndex((m) => m.id !== 0 && m.id === message.id);
    if (idIdx !== -1) {
      const replaced = existing.map((m, i) => (i === idIdx ? message : m));
      const updated = new Map(prev.messagesByChannel);
      updated.set(channelId, replaced);
      return { ...prev, messagesByChannel: updated };
    }

    // 2. Defensive: reconcile the oldest pending optimistic row from this author
    //    (a broadcast that arrived before its chat_send_ok ack).
    const pendingIdx = existing.findIndex(
      (m) => m.status === "pending" && m.correlationId !== null && m.user.id === message.user.id,
    );
    if (pendingIdx !== -1) {
      const replaced = existing.map((m, i) => (i === pendingIdx ? message : m));
      const updated = new Map(prev.messagesByChannel);
      updated.set(channelId, replaced);
      return { ...prev, messagesByChannel: updated };
    }

    // 3. Append as a new message.
    let updatedMsgs = [...existing, message];
    // Evict oldest messages if over the cap
    if (updatedMsgs.length > MAX_MESSAGES_PER_CHANNEL) {
      updatedMsgs = updatedMsgs.slice(updatedMsgs.length - MAX_MESSAGES_PER_CHANNEL);
    }
    const updated = new Map(prev.messagesByChannel);
    updated.set(channelId, updatedMsgs);
    // If we evicted, there are now more messages on the server above
    const updatedHasMore = new Map(prev.hasMore);
    if (existing.length + 1 > MAX_MESSAGES_PER_CHANNEL) {
      updatedHasMore.set(channelId, true);
    }
    return { ...prev, messagesByChannel: updated, hasMore: updatedHasMore };
  });
}

/**
 * Insert an optimistic pending row for a message the user just sent. The row
 * carries the correlationId returned by ws.send and renders immediately as
 * "sending"; confirmSend / markSendFailed reconcile it against the server.
 */
export function addOptimisticMessage(params: {
  correlationId: string;
  channelId: number;
  user: MessageUser;
  content: string;
  replyTo: number | null;
  attachments?: readonly Attachment[];
  timestamp: string;
}): void {
  const optimistic: Message = {
    id: 0,
    channelId: params.channelId,
    user: params.user,
    content: params.content,
    replyTo: params.replyTo,
    attachments: params.attachments ?? [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: params.timestamp,
    status: "pending",
    correlationId: params.correlationId,
    errorCode: null,
  };
  messagesStore.setState((prev) => {
    const existing = prev.messagesByChannel.get(params.channelId) ?? [];
    const updated = new Map(prev.messagesByChannel);
    updated.set(params.channelId, [...existing, optimistic]);
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.set(params.correlationId, params.channelId);
    return { ...prev, messagesByChannel: updated, pendingSends: updatedPending };
  });
}

/** Mark an optimistic row as failed so the UI can offer retry. */
export function markSendFailed(correlationId: string, errorCode: string | null): void {
  messagesStore.setState((prev) => {
    const channelId = prev.pendingSends.get(correlationId);
    if (channelId === undefined) return prev;
    const existing = prev.messagesByChannel.get(channelId);
    if (existing === undefined) return prev;
    const updatedList = existing.map((m) =>
      m.correlationId === correlationId ? { ...m, status: "failed" as const, errorCode } : m,
    );
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, updatedList);
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.delete(correlationId);
    return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
  });
}

/** Remove an optimistic row (retry discards the old row; delete-draft dismisses it). */
export function removeOptimistic(correlationId: string): void {
  messagesStore.setState((prev) => {
    const channelId = prev.pendingSends.get(correlationId);
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.delete(correlationId);
    if (channelId === undefined) {
      return { ...prev, pendingSends: updatedPending };
    }
    const existing = prev.messagesByChannel.get(channelId);
    if (existing === undefined) {
      return { ...prev, pendingSends: updatedPending };
    }
    const filtered = existing.filter((m) => m.correlationId !== correlationId);
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, filtered);
    return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
  });
}

/** Mark a channel's first-page history fetch as in flight. */
export function setChannelLoading(channelId: number): void {
  messagesStore.setState((prev) => {
    const updated = new Map(prev.historyLoadState);
    updated.set(channelId, "loading");
    return { ...prev, historyLoadState: updated };
  });
}

/** Mark a channel's first-page history fetch as failed (the region offers Retry). */
export function setChannelLoadError(channelId: number): void {
  messagesStore.setState((prev) => {
    const updated = new Map(prev.historyLoadState);
    updated.set(channelId, "error");
    return { ...prev, historyLoadState: updated };
  });
}

/** Bulk set messages from a REST response. Marks channel as loaded.
 *  The server returns messages newest-first; we reverse to chronological order. */
export function setMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  const converted = messages.map(messageResponseToMessage).toReversed();
  const trimmed =
    converted.length > MAX_MESSAGES_PER_CHANNEL
      ? converted.slice(converted.length - MAX_MESSAGES_PER_CHANNEL)
      : converted;
  messagesStore.setState((prev) => {
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, trimmed);

    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.add(channelId);

    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.set(channelId, hasMore || converted.length > MAX_MESSAGES_PER_CHANNEL);

    const updatedLoadState = new Map(prev.historyLoadState);
    updatedLoadState.delete(channelId);

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
      historyLoadState: updatedLoadState,
    };
  });
}

/** Prepend older messages for infinite scroll.
 *  The server returns messages newest-first; we reverse to chronological order. */
export function prependMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  const converted = messages.map(messageResponseToMessage).toReversed();
  messagesStore.setState((prev) => {
    const existing = prev.messagesByChannel.get(channelId) ?? [];
    let combined = [...converted, ...existing];
    // Keep newest messages (end of array); drop oldest loaded history when cap exceeded
    const wasTrimmed = combined.length > MAX_MESSAGES_PER_CHANNEL;
    if (wasTrimmed) {
      combined = combined.slice(combined.length - MAX_MESSAGES_PER_CHANNEL);
    }
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, combined);

    const updatedHasMore = new Map(prev.hasMore);
    // If we trimmed older messages, there are definitely more on the server above.
    updatedHasMore.set(channelId, hasMore || wasTrimmed);

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      hasMore: updatedHasMore,
    };
  });
}

/** Update message content and editedAt from a chat_edited WS event. */
export function editMessage(payload: ChatEditedPayload): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === payload.message_id
        ? { ...msg, content: payload.content, editedAt: payload.edited_at }
        : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Soft-delete: mark message as deleted but keep in array. */
export function deleteMessage(payload: ChatDeletedPayload): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === payload.message_id ? { ...msg, deleted: true } : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Toggle the pinned state of a message (optimistic update after API call). */
export function setMessagePinned(channelId: number, messageId: number, pinned: boolean): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(channelId);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === messageId ? { ...msg, pinned } : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Track a pending outbound message send. */
export function addPendingSend(correlationId: string, channelId: number): void {
  messagesStore.setState((prev) => {
    const updated = new Map(prev.pendingSends);
    updated.set(correlationId, channelId);
    return { ...prev, pendingSends: updated };
  });
}

/**
 * Confirm a pending send from a chat_send_ok ack: stamp the optimistic row with
 * its real server id + timestamp and mark it "sent". The subsequent
 * chat_message broadcast then reconciles by real id (addMessage step 1),
 * upgrading the row to the full server message. Removing it from pendingSends
 * makes a late error a no-op.
 */
export function confirmSend(correlationId: string, messageId: number, timestamp: string): void {
  messagesStore.setState((prev) => {
    const channelId = prev.pendingSends.get(correlationId);
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.delete(correlationId);
    if (channelId === undefined) {
      return { ...prev, pendingSends: updatedPending };
    }
    const existing = prev.messagesByChannel.get(channelId);
    if (existing === undefined) {
      return { ...prev, pendingSends: updatedPending };
    }
    const updatedList = existing.map((m) =>
      m.correlationId === correlationId
        ? { ...m, id: messageId, timestamp, status: "sent" as const, errorCode: null }
        : m,
    );
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, updatedList);
    return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
  });
}

/** Clear all messages for a channel. */
export function clearChannelMessages(channelId: number): void {
  messagesStore.setState((prev) => {
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.delete(channelId);

    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.delete(channelId);

    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.delete(channelId);

    const updatedLoadState = new Map(prev.historyLoadState);
    updatedLoadState.delete(channelId);

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
      historyLoadState: updatedLoadState,
    };
  });
}

/** Update reactions on a message from a reaction_update WS event. */
export function updateReaction(payload: ReactionUpdatePayload, currentUserId: number): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) => {
      if (msg.id !== payload.message_id) return msg;

      const isMe = payload.user_id === currentUserId;
      const existing = msg.reactions;

      if (payload.action === "add") {
        const found = existing.find((r) => r.emoji === payload.emoji);
        if (found !== undefined) {
          const updatedReactions = existing.map((r) =>
            r.emoji === payload.emoji ? { ...r, count: r.count + 1, me: r.me || isMe } : r,
          );
          return { ...msg, reactions: updatedReactions };
        }
        return {
          ...msg,
          reactions: [...existing, { emoji: payload.emoji, count: 1, me: isMe }],
        };
      }

      // action === "remove"
      const updatedReactions = existing
        .map((r) =>
          r.emoji === payload.emoji ? { ...r, count: r.count - 1, me: isMe ? false : r.me } : r,
        )
        .filter((r) => r.count > 0);
      return { ...msg, reactions: updatedReactions };
    });

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

/** Get messages for a channel, or empty array if none loaded. */
export function getChannelMessages(channelId: number): readonly Message[] {
  return messagesStore.select((s) => s.messagesByChannel.get(channelId) ?? []);
}

/** Check whether initial messages have been loaded for a channel. */
export function isChannelLoaded(channelId: number): boolean {
  return messagesStore.select((s) => s.loadedChannels.has(channelId));
}

/** Check whether a channel has more older messages to fetch. */
export function hasMoreMessages(channelId: number): boolean {
  return messagesStore.select((s) => s.hasMore.get(channelId) ?? false);
}

/** First-page history fetch state for a channel; null when idle/loaded. */
export function getHistoryLoadState(channelId: number): "loading" | "error" | null {
  return messagesStore.select((s) => s.historyLoadState.get(channelId) ?? null);
}
