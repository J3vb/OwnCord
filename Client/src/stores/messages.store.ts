/**
 * Messages store — chat messages per channel, pending send tracking and load
 * state for infinite scroll. Immutable state updates only.
 *
 * The facade: the store instance, every mutator and selector, and the model
 * types. The reducer bodies are pure functions in features/messaging/; import
 * from here, never from there, so local/no-store-write-in-ws-on still sees
 * every mutator call.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";
import { adoptStarterThreads } from "./threadsLoader";
import type {
  ChatMessagePayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  ChatBulkDeletedPayload,
  ReactionUpdatePayload,
  PollUpdatePayload,
  PollVoteOkPayload,
  MessageLinkPreviewsPayload,
  MessageResponse,
} from "@lib/types";
import { createStore } from "@lib/store";
import { createMessagesSelectors } from "./messagesSelectors";
import { chatPayloadToMessage, INITIAL_STATE } from "../features/messaging/messageModel";
import type { MessagesState, PendingReaction } from "../features/messaging/messageModel";
import {
  reduceAddMessage,
  reduceAddOptimisticMessage,
  reduceMarkSendFailed,
  reduceRemoveOptimistic,
  reduceConfirmSend,
  findSendChannel,
  reduceApplyServerMessage,
  buildOptimisticMessage,
  type OptimisticMessageParams,
} from "../features/messaging/liveMessages";
import {
  reduceSetChannelLoading,
  reduceSetChannelLoadError,
  reduceSetOlderLoadFailed,
  reduceSetMessages,
  reduceSetAroundMessages,
  reduceInvalidateLoadedMessageWindows,
  reduceInvalidateChannelMessageWindow,
  reduceClearChannelContent,
  reduceReattachToPresent,
  reducePrependMessages,
  reduceAppendNewerMessages,
  reduceMergeTailMessages,
  reduceHoldLoadJournal,
  reduceReleaseLoadJournal,
} from "../features/messaging/historyWindows";
import {
  reduceEditMessage,
  reduceDeleteMessage,
  reduceBulkDeleteMessages,
  reduceSetMessagePinned,
  reduceMarkStickersDeleted,
} from "../features/messaging/messageEdits";
import {
  reduceAddOptimisticReaction,
  reduceRollbackReaction,
  reduceUpdateReaction,
} from "../features/messaging/reactionState";
import { reducePollUpdate, reducePollVoteOk } from "@lib/pollState";
import { reduceLinkPreviews } from "@lib/linkPreviewState";

export type { Message, PendingReaction, MessagesState } from "../features/messaging/messageModel";
/** Facade surface since before the model moved out; no importer names it today. @public */
export type { MessageStatus } from "../features/messaging/messageModel";

// -----------------------------------------------------------------------------
// Store instance
// -----------------------------------------------------------------------------

export const messagesStore = createStore<MessagesState>(INITIAL_STATE);

// Selectors live in messagesSelectors.ts, built from this store.
export const {
  getChannelMessages,
  isChannelLoaded,
  hasMoreMessages,
  getHistoryLoadState,
  isWindowDetached,
  hasMessageLoaded,
} = createMessagesSelectors(messagesStore);

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
export function addOptimisticMessage(params: OptimisticMessageParams): void {
  const optimistic = buildOptimisticMessage(params);
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

/** A page fetch holds the journal until it settles; changes meanwhile replay onto its page. */
export const holdLoadJournal = (channelId: number): void =>
  messagesStore.setState((prev) => reduceHoldLoadJournal(prev, channelId));
export const releaseLoadJournal = (channelId: number): void =>
  messagesStore.setState((prev) => reduceReleaseLoadJournal(prev, channelId));

/** Mark a channel's first-page history fetch as failed (the region offers Retry).
 *  A window with rows is detached, since they may end short of the live tail. */
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
 *  anything in the snapshot.
 *
 *  A revisit's refetch reconciles into the cached window: a row the
 *  page left unchanged keeps its object. While the window is still exactly
 *  the latest page, a page that changes nothing leaves the channel's array
 *  reference as it was. A post-only page only appends when the channel's
 *  whole history fits in one page (hasMore false). Otherwise cached "sent"
 *  rows older than the page are dropped, so nothing deleted or edited while
 *  away stays on screen (scrolling up loads them again). A revisit's refetch
 *  (MessageController.loadMessages) pages backwards from the newest
 *  message until the fetched range reaches the oldest cached row, so the rows
 *  it keeps are revalidated by that range; when the cached window plus the
 *  unseen gap outruns the paging bound, the fetched range is kept and the
 *  stale cached rows below it are dropped, as before.
 *  The list patches
 *  only the rows that changed: the dropped head, the new tail and, for a
 *  revisit that opened with unread messages, the NEW divider.
 *
 *  `splice` is a full-ready resync's refetch (P2-T4), or a tail refetch
 *  (MessageController.loadMessages) that an older page landed above while it
 *  was in flight; the controller passes it only when its fetched range reaches
 *  the cached head, so nothing is missing between that page and the window.
 *  When the page reaches
 *  back to the newest row loaded at setChannelLoading, the loaded rows older
 *  than the page stay above it instead of being dropped. They may still show
 *  an edit, delete or reaction missed while offline until the next visit
 *  refetches them. A gap, or a page that is the whole channel, replaces the
 *  window as usual. A splice past the row cap trims the oldest rows, unless
 *  that would drop `anchorId`, the row the reader is looking at: then it
 *  trims the newest end and detaches the window, as prependMessages does. */
export function setMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
  splice = false,
  anchorId: number | null = null,
): void {
  adoptStarterThreads(messages);
  messagesStore.setState((prev) =>
    reduceSetOlderLoadFailed(
      reduceSetMessages(prev, channelId, messages, hasMore, splice, anchorId),
      channelId,
      false,
    ),
  );
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
 *
 * `splice` is a full-ready resync's refetch around a loaded row (P2-T4): the
 * loaded rows above the window stay, and so do the rows below it while it
 * stays detached, with the same missed-change caveat as setMessages'.
 */
export function setAroundMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
  splice = false,
): void {
  adoptStarterThreads(messages);
  messagesStore.setState((prev) =>
    reduceSetOlderLoadFailed(
      reduceSetAroundMessages(prev, channelId, messages, hasMoreBefore, hasMoreAfter, splice),
      channelId,
      false,
    ),
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
 * invalidateChannelMessageWindow for every loaded channel (P2-T4): the rows,
 * hasMore and the detached flag stay, so the screen does not change, and the
 * next fetch reconciles into them — setMessages replaces a window the tail
 * does not reach, so no gap survives it.
 */
export function invalidateLoadedMessageWindows(): void {
  messagesStore.setState((prev) => reduceInvalidateLoadedMessageWindows(prev));
}

/**
 * Drop one channel's loaded flag so the next history fetch reloads the live
 * tail. The server only delivers live broadcasts for the focused channel, so
 * a window left behind on a channel switch stops updating the moment focus
 * moves away — the next visit must refetch instead of short-circuiting on
 * "already loaded": that refetch is the only way to learn about edits,
 * deletes and reactions made while away. The rows themselves are kept (the
 * next visit renders them at once) and setMessages reconciles the refetched
 * page into them, keeping the rows it left unchanged, dropping older rows
 * beyond it and carrying pending/failed rows across. The refetch pages back up
 * to five 100-row pages, so the cached window is kept and revalidated when it
 * plus the unseen gap fits within them; when the two together outrun that
 * range, the fetched range is kept and the rows below it are dropped. Like
 * reattachToPresent,
 * this leaves detachedChannels alone: setMessages clears it once the tail has
 * actually landed, and until then a detached window must keep refusing live
 * broadcasts.
 */
export function invalidateChannelMessageWindow(channelId: number): void {
  messagesStore.setState((prev) => reduceInvalidateChannelMessageWindow(prev, channelId));
}

/**
 * Forget every delivered row of one channel along with its window state, so
 * nothing from it can render again until a fresh fetch — used when NSFW
 * consent for the channel is gone. Carries pending/failed rows, the
 * user's own unsent text, like every other window-replacing writer.
 */
export function clearChannelContent(channelId: number): void {
  messagesStore.setState((prev) =>
    reduceSetOlderLoadFailed(reduceClearChannelContent(prev, channelId), channelId, false),
  );
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
  adoptStarterThreads(messages);
  messagesStore.setState((prev) =>
    reduceSetOlderLoadFailed(
      reducePrependMessages(prev, channelId, messages, hasMore),
      channelId,
      false,
    ),
  );
}

/** Record that a channel's older-page fetch failed (the list offers Retry at
 *  its top), or clear the mark. Clearing an unset mark changes nothing. */
export function setOlderLoadFailed(channelId: number, failed: boolean): void {
  messagesStore.setState((prev) => reduceSetOlderLoadFailed(prev, channelId, failed));
}

/** Whether the channel's last older-page fetch failed. */
export function hasOlderLoadFailed(channelId: number): boolean {
  return messagesStore.select((s) => s.olderLoadFailed?.has(channelId) ?? false);
}

/** Append the next newer page below a detached window. The server returns an
 *  `after` page oldest-first (render order). A page with `hasMore` false
 *  reaches the newest message and reattaches the window to the live tail; a
 *  window that is not detached ignores the page. */
export function appendNewerMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  adoptStarterThreads(messages);
  messagesStore.setState((prev) => reduceAppendNewerMessages(prev, channelId, messages, hasMore));
}

/** Union an oldest-first page into an attached window (the follow-up after a
 *  re-attach, which recovers a live message refused while detached). */
export function mergeTailMessages(channelId: number, messages: readonly MessageResponse[]): void {
  adoptStarterThreads(messages);
  messagesStore.setState((prev) => reduceMergeTailMessages(prev, channelId, messages));
}

/** Update message content and editedAt from a chat_edited WS event. */
export function editMessage(payload: ChatEditedPayload): void {
  messagesStore.setState((prev) => reduceEditMessage(prev, payload));
}

/** Soft-delete: mark message as deleted but keep in array. */
export function deleteMessage(payload: ChatDeletedPayload): void {
  messagesStore.setState((prev) => reduceDeleteMessage(prev, payload));
}

/**
 * A sticker_update removed stickers: every loaded sticker message
 * whose sticker is no longer in `liveIds` becomes a deleted-sticker row, the
 * same shape the server sends for history (id and url null, name kept). Lists
 * with nothing to change keep their identity, so only the affected channels
 * (channel, thread and DM rows all live here) are touched.
 */
export function markStickersDeleted(liveIds: ReadonlySet<number>): void {
  messagesStore.setState((prev) => reduceMarkStickersDeleted(prev, liveIds));
}

/**
 * Soft-delete every id in one purge. Renders exactly like a single delete —
 * the rows stay as tombstones — but touches the channel's list once instead of
 * once per message.
 */
export function bulkDeleteMessages(payload: ChatBulkDeletedPayload): void {
  if (payload.ids.length === 0) return;
  messagesStore.setState((prev) => reduceBulkDeleteMessages(prev, payload));
}

/** Toggle the pinned state of a message (optimistic update after API call). */
export function setMessagePinned(channelId: number, messageId: number, pinned: boolean): void {
  messagesStore.setState((prev) => reduceSetMessagePinned(prev, channelId, messageId, pinned));
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
 * The channel a tracked send belongs to, resolved as confirmSend does (the
 * pendingSends registry, then a not-yet-sent row with the correlation or client
 * id). Resolve BEFORE confirmSend, which deletes the entry and flips the row to "sent". The predicate is duplicated from confirmSend on purpose (sharing it
 * would rewrite a store function with no other reason to change).
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
  adoptStarterThreads([response]);
  messagesStore.setState((prev) => reduceApplyServerMessage(prev, response));
}

/**
 * Apply the user's own reaction toggle locally before the server confirms it —
 * the pill reacts to the click, not to the round-trip (ux/messaging §5) — and
 * register it under the send's correlation id. updateReaction consumes the
 * matching self-echo (instead of re-applying it), and rollbackReaction
 * reverts the toggle when the send errors.
 */
export function addOptimisticReaction(correlationId: string, toggle: PendingReaction): void {
  messagesStore.setState((prev) => reduceAddOptimisticReaction(prev, correlationId, toggle));
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
    const result = reduceRollbackReaction(prev, correlationId);
    found = result.found;
    return result.next;
  });
  return found;
}

/** Update reactions on a message from a reaction_update WS event. */
export function updateReaction(payload: ReactionUpdatePayload, currentUserId: number): void {
  messagesStore.setState((prev) => reduceUpdateReaction(prev, payload, currentUserId));
}

/** Apply a poll_update: counts in version order, the viewer's own selection by its own watermark. */
export function updatePoll(payload: PollUpdatePayload, currentUserId: number): void {
  messagesStore.setState((prev) => reducePollUpdate(prev, payload, currentUserId));
}

/** Apply the sender's poll_vote_ok: their stored selection, ahead of the poll_update that carries the counts. */
export function applyPollVoteOk(payload: PollVoteOkPayload): void {
  messagesStore.setState((prev) => reducePollVoteOk(prev, payload));
}

/** Apply a message_link_previews frame: the message's cards, unless it holds newer ones or is not loaded. */
export function updateLinkPreviews(payload: MessageLinkPreviewsPayload): void {
  messagesStore.setState((prev) => reduceLinkPreviews(prev, payload));
}

/** Reset the entire store to its initial (empty) state — e.g. on logout. */
export function resetMessagesStore(): void {
  messagesStore.setState(() => INITIAL_STATE);
}
void registerSessionReset("messages:store", resetMessagesStore); // app-lifetime
