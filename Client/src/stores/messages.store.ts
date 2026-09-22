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
  ChatBulkDeletedPayload,
  ReactionUpdatePayload,
  MessageUser,
  Attachment,
  MessageResponse,
} from "@lib/types";
import { chatPayloadToMessage, INITIAL_STATE } from "../features/messaging/messageModel";
import type { Message, MessagesState, PendingReaction } from "../features/messaging/messageModel";
import {
  reduceAddMessage,
  reduceAddOptimisticMessage,
  reduceMarkSendFailed,
  reduceRemoveOptimistic,
  reduceConfirmSend,
  findSendChannel,
  reduceApplyServerMessage,
} from "../features/messaging/liveMessages";
import {
  reduceSetChannelLoading,
  reduceSetChannelLoadError,
  reduceSetMessages,
  reduceSetAroundMessages,
  reduceInvalidateLoadedMessageWindows,
  reduceInvalidateChannelMessageWindow,
  reduceReattachToPresent,
  reducePrependMessages,
} from "../features/messaging/historyWindows";

export type { Message, PendingReaction, MessagesState } from "../features/messaging/messageModel";
/**
 * Part of this facade's surface since before the model moved out; no importer
 * names it today.
 * @public
 */
export type { MessageStatus } from "../features/messaging/messageModel";

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
 *   2. Otherwise, defensively reconcile the oldest still-pending (or
 *      OFFLINE-failed) row from the same author (covers a broadcast that
 *      raced ahead of its ack, or one the offline sweep gave up on before
 *      learning the server had already stored it).
 *   3. Otherwise, append as a new message.
 */
export function addMessage(payload: ChatMessagePayload): void {
  const message = chatPayloadToMessage(payload);
  messagesStore.setState((prev) => reduceAddMessage(prev, message));
}

/**
 * Insert an optimistic pending row for a message the user just sent. The row
 * carries the correlationId returned by ws.send and renders immediately as
 * "sending"; confirmSend / markSendFailed reconcile it against the server.
 */
export function addOptimisticMessage(params: {
  correlationId: string;
  clientMessageId?: string;
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
    clientMessageId: params.clientMessageId,
    errorCode: null,
  };
  messagesStore.setState((prev) => reduceAddOptimisticMessage(prev, params, optimistic));
}

/** Mark an optimistic row as failed so the UI can offer retry. */
export function markSendFailed(correlationId: string, errorCode: string | null): void {
  messagesStore.setState((prev) => reduceMarkSendFailed(prev, correlationId, errorCode));
}

/** Remove an optimistic row (retry discards the old row; delete-draft dismisses it). */
export function removeOptimistic(correlationId: string): void {
  messagesStore.setState((prev) => reduceRemoveOptimistic(prev, correlationId));
}

/**
 * Mark a channel's first-page history fetch as in flight. Also records a
 * watermark of the highest message id present right now, consumed by the
 * matching setMessages call to tell "nothing arrived after this snapshot" (an
 * empty result really means empty) apart from "no snapshot was taken" — see
 * MessagesState.loadWatermark.
 */
export function setChannelLoading(channelId: number): void {
  messagesStore.setState((prev) => reduceSetChannelLoading(prev, channelId));
}

/** Mark a channel's first-page history fetch as failed (the region offers Retry). */
export function setChannelLoadError(channelId: number): void {
  messagesStore.setState((prev) => reduceSetChannelLoadError(prev, channelId));
}

/** Bulk set messages from a REST response. Marks channel as loaded.
 *  The server returns messages newest-first; we reverse to chronological order.
 *
 *  Merges rather than clobbers: a live broadcast or an optimistic send can
 *  land while the fetch is in flight, and the snapshot predates those rows —
 *  replacing wholesale would silently discard them (and loadedChannels then
 *  blocks any refetch until a full reload). Rows from the previous array are
 *  carried over when they are pending/failed, or "sent" but newer than
 *  anything in the snapshot. */
export function setMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  messagesStore.setState((prev) => reduceSetMessages(prev, channelId, messages, hasMore));
}

/**
 * Replace a channel's loaded window with an around-window centred on a jump
 * target. Unlike setMessages the payload is already oldest-first, so it is not
 * reversed.
 *
 * `hasMoreAfter` marks the window as detached from the live tail: the list
 * offers "Jump to Present" and live broadcasts stop being appended until
 * reattachToPresent (or a fresh setMessages) lands.
 *
 * Carries unreconciled (pending/failed) rows across the replacement exactly
 * like setMessages does — they are the only copy of the user's composed
 * text, and a jump elsewhere must not silently destroy an in-flight send or
 * orphan its Retry draft. When the window reattaches to the live tail it also
 * carries any "sent" row newer than the window, for the same reason
 * setMessages protects a live broadcast that landed mid-fetch: a reattached
 * window claims to BE the live tail, and dropping such a row here would
 * delete it with no badge, no "Jump to Present" pill, and no recovery path.
 */
export function setAroundMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): void {
  messagesStore.setState((prev) =>
    reduceSetAroundMessages(prev, channelId, messages, hasMoreBefore, hasMoreAfter),
  );
}

/**
 * Invalidate every channel's loaded window after a full-ready resync (see
 * dispatcher.ts's `ready` handler). That tier never replays missed
 * chat_message frames — only a fresh connect and a full resync send `ready`
 * at all, and a successful seq-based replay reconnect doesn't — so a channel
 * loaded before the drop would otherwise keep a permanent hole in its
 * history for the rest of the session.
 *
 * Carries pending/failed optimistic rows exactly like setMessages' merge —
 * they are the only copy of an unsent message — but drops "sent" rows so the
 * next fetch rebuilds a contiguous window instead of leaving stale rows
 * above a gap the fetch has no way to detect.
 */
export function invalidateLoadedMessageWindows(): void {
  messagesStore.setState((prev) => reduceInvalidateLoadedMessageWindows(prev));
}

/**
 * Drop one channel's loaded flag so the next history fetch reloads the live
 * tail. The server only delivers live broadcasts for the focused channel, so
 * a window left behind on a channel switch stops updating the moment focus
 * moves away — the next visit must refetch instead of short-circuiting on
 * "already loaded". The rows themselves are kept (the old window stays
 * rendered until the refetch lands) and setMessages' merge carries
 * pending/failed rows across that refetch. Like reattachToPresent, this
 * leaves detachedChannels alone: setMessages clears it once the tail has
 * actually landed, and until then a detached window must keep refusing live
 * broadcasts.
 */
export function invalidateChannelMessageWindow(channelId: number): void {
  messagesStore.setState((prev) => reduceInvalidateChannelMessageWindow(prev, channelId));
}

/**
 * Drop a channel's loaded flag so the next history fetch reloads the live
 * tail — otherwise MessageController short-circuits on "already loaded" and
 * the stale window stays on screen.
 *
 * Deliberately does NOT clear detachedChannels itself: that flag is what
 * keeps the "Jump to Present" pill visible and blocks addMessage from
 * appending a live broadcast onto the stale around-window. setMessages
 * clears it on success, once the tail has actually landed — if that refetch
 * fails instead, the channel must stay detached so a live broadcast can't
 * splice onto history with a silent gap.
 */
export function reattachToPresent(channelId: number): void {
  messagesStore.setState((prev) => reduceReattachToPresent(prev, channelId));
}

/** Prepend older messages for infinite scroll.
 *  The server returns messages newest-first; we reverse to chronological order. */
export function prependMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  messagesStore.setState((prev) => reducePrependMessages(prev, channelId, messages, hasMore));
}

/** Update message content and editedAt from a chat_edited WS event. */
export function editMessage(payload: ChatEditedPayload): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === payload.message_id
        ? {
            ...msg,
            content: payload.content,
            editedAt: payload.edited_at,
            mentions: payload.mentions,
            mentionsEveryone: payload.mentions_everyone,
          }
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

/**
 * Soft-delete every id in one purge. Renders exactly like a single delete —
 * the rows stay as tombstones — but touches the channel's list once instead of
 * once per message.
 */
export function bulkDeleteMessages(payload: ChatBulkDeletedPayload): void {
  if (payload.ids.length === 0) return;
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const purged = new Set(payload.ids);
    if (!channelMessages.some((msg) => purged.has(msg.id) && !msg.deleted)) return prev;

    const updatedList = channelMessages.map((msg) =>
      purged.has(msg.id) ? { ...msg, deleted: true } : msg,
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

/**
 * Confirm a pending send from a chat_send_ok ack: stamp the optimistic row with
 * its real server id + timestamp and mark it "sent". The subsequent
 * chat_message broadcast then reconciles by real id (addMessage step 1),
 * upgrading the row to the full server message. Removing it from pendingSends
 * makes a late error a no-op.
 */
export function confirmSend(
  correlationId: string,
  messageId: number,
  timestamp: string,
  clientMessageId?: string,
): void {
  messagesStore.setState((prev) =>
    reduceConfirmSend(prev, correlationId, messageId, timestamp, clientMessageId),
  );
}

/**
 * The channel a tracked send belongs to, resolved the way confirmSend resolves
 * it: the pendingSends registry first, then any not-yet-sent row carrying the
 * correlation id or the logical client id.
 *
 * Callers must resolve BEFORE confirmSend: that call deletes the registry entry
 * and flips the row to "sent", destroying both identities this lookup needs.
 * The predicate is duplicated from confirmSend on purpose -- sharing it would
 * mean rewriting a store function this change has no other reason to touch.
 */
export function channelIdForSend(
  correlationId: string,
  clientMessageId?: string,
): number | undefined {
  return findSendChannel(messagesStore.getState(), correlationId, clientMessageId);
}

/**
 * Reconcile one already-loaded row with its authoritative server copy, matched
 * by real id, in place.
 *
 * A deduplicated send ack carries no content, and because the server treats the
 * message as already delivered, no chat_message broadcast follows to reconcile
 * the row — so it keeps whatever the retry sent, which is stale if the message
 * was edited elsewhere. The window either holds the row or does not: this
 * replaces in place and can neither append nor evict, which is what makes it
 * safe to hand it a single row out of a wider history window.
 */
export function applyServerMessage(response: MessageResponse): void {
  messagesStore.setState((prev) => reduceApplyServerMessage(prev, response));
}

/**
 * Apply a single reaction count/me delta to a channel's message list, or null
 * when the message is not loaded (nothing to update). Shared by the
 * server-echo path, the optimistic apply, and its rollback (which applies the
 * inverse action) so the three can never disagree about the arithmetic.
 */
function applyReactionDelta(
  prev: MessagesState,
  { channelId, messageId, emoji, action }: PendingReaction,
  isMe: boolean,
): ReadonlyMap<number, readonly Message[]> | null {
  const channelMessages = prev.messagesByChannel.get(channelId);
  if (!channelMessages) return null;

  const updatedList = channelMessages.map((msg) => {
    if (msg.id !== messageId) return msg;

    const existing = msg.reactions;
    if (action === "add") {
      const found = existing.find((r) => r.emoji === emoji);
      if (found !== undefined) {
        const updatedReactions = existing.map((r) =>
          r.emoji === emoji ? { ...r, count: r.count + 1, me: r.me || isMe } : r,
        );
        return { ...msg, reactions: updatedReactions };
      }
      return { ...msg, reactions: [...existing, { emoji, count: 1, me: isMe }] };
    }

    // action === "remove"
    const updatedReactions = existing
      .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, me: isMe ? false : r.me } : r))
      .filter((r) => r.count > 0);
    return { ...msg, reactions: updatedReactions };
  });

  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, updatedList);
  return updatedMessages;
}

/**
 * Apply the user's own reaction toggle locally before the server confirms it —
 * the pill reacts to the click, not to the round-trip (ux/messaging §5) — and
 * register it under the send's correlation id. updateReaction consumes the
 * matching self-echo (instead of re-applying it), and rollbackReaction
 * reverts the toggle when the send errors.
 */
export function addOptimisticReaction(correlationId: string, toggle: PendingReaction): void {
  messagesStore.setState((prev) => {
    const updatedMessages = applyReactionDelta(prev, toggle, true);
    if (updatedMessages === null) return prev;
    const updatedPending = new Map(prev.pendingReactions ?? []);
    updatedPending.set(correlationId, toggle);
    return { ...prev, messagesByChannel: updatedMessages, pendingReactions: updatedPending };
  });
}

/**
 * Roll back an optimistic reaction toggle whose send failed (server error
 * reply or local transport failure) by applying the inverse delta. Returns
 * whether the correlation id matched a pending toggle, so the dispatcher's
 * error handler knows the failed envelope was a reaction's.
 */
export function rollbackReaction(correlationId: string): boolean {
  let found = false;
  messagesStore.setState((prev) => {
    const toggle = prev.pendingReactions?.get(correlationId);
    if (toggle === undefined) return prev;
    found = true;
    const updatedPending = new Map(prev.pendingReactions);
    updatedPending.delete(correlationId);
    const inverse: PendingReaction = {
      ...toggle,
      action: toggle.action === "add" ? "remove" : "add",
    };
    const updatedMessages = applyReactionDelta(prev, inverse, true);
    if (updatedMessages === null) {
      return { ...prev, pendingReactions: updatedPending };
    }
    return { ...prev, messagesByChannel: updatedMessages, pendingReactions: updatedPending };
  });
  return found;
}

/** Update reactions on a message from a reaction_update WS event. */
export function updateReaction(payload: ReactionUpdatePayload, currentUserId: number): void {
  messagesStore.setState((prev) => {
    const isMe = payload.user_id === currentUserId;

    // The echo of an optimistic toggle: consume it instead of re-applying —
    // the delta arithmetic above would double-count otherwise. Matched by
    // content, not envelope id (broadcasts carry no request correlation).
    if (isMe) {
      for (const [cid, t] of prev.pendingReactions ?? []) {
        if (
          t.channelId === payload.channel_id &&
          t.messageId === payload.message_id &&
          t.emoji === payload.emoji &&
          t.action === payload.action
        ) {
          const updatedPending = new Map(prev.pendingReactions);
          updatedPending.delete(cid);
          return { ...prev, pendingReactions: updatedPending };
        }
      }
    }

    const updatedMessages = applyReactionDelta(
      prev,
      {
        channelId: payload.channel_id,
        messageId: payload.message_id,
        emoji: payload.emoji,
        action: payload.action,
      },
      isMe,
    );
    if (updatedMessages === null) return prev;
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Reset the entire store to its initial (empty) state — e.g. on logout. */
export function resetMessagesStore(): void {
  messagesStore.setState(() => INITIAL_STATE);
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

/**
 * Whether the channel's loaded window is an around-window detached from the
 * live tail — newer messages exist below what is rendered.
 */
export function isWindowDetached(channelId: number): boolean {
  return messagesStore.select((s) => s.detachedChannels.has(channelId));
}

/** Whether a message id is present in a channel's loaded window. */
export function hasMessageLoaded(channelId: number, messageId: number): boolean {
  return messagesStore.select(
    (s) => s.messagesByChannel.get(channelId)?.some((m) => m.id === messageId) ?? false,
  );
}
