// Chat message, reaction, typing and optimistic-send WebSocket handlers —
// extracted from lib/dispatcher.ts, which keeps every socket subscription and
// calls these plain functions.
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import {
  addMessage,
  updateReaction,
  updatePoll,
  applyPollVoteOk,
  rollbackReaction,
  confirmSend,
  markSendFailed,
  channelIdForSend,
  applyServerMessage,
  messagesStore,
  editMessage,
  deleteMessage,
  bulkDeleteMessages,
  setMessagePinned,
} from "../../stores/messages.store";
import { setTyping, clearTyping } from "../../stores/members.store";
import { dmStore, reviseDmLastMessage } from "../../stores/dm.store";
import type { ConnectionState } from "../../lib/ws";
import { invalidateReactionUsers } from "./reactionUsers";
import { handleThreadDeleted, handleThreadFollow, handleThreadState } from "./threadFrames";
import { loadedThreadsStore } from "../../stores/threadsLoader";
import { isChannelAway } from "@lib/readState";
import { acknowledgePendingMessage } from "../../lib/pendingMessages";
import type { DispatchApi, Payload, ReconnectClock, WsRoute } from "../connection/dispatchContext";
import { log, route } from "../connection/dispatchContext";
import { ServerMessageType as S } from "@lib/protocolTypes";
import {
  isReplayedFrame,
  raisesMentionBadge,
  noteChannelUnread,
  noteDmMessage,
  notifyLiveMessage,
} from "./chatNotify";
import { hasDmPreviewRefetch, reviseDmPreviewAfterDelete } from "./dmPreview";

export { activateReadyPendingMessages, applyReadyMessageResync } from "./readyResync";
export { handleMessagingError } from "./sendErrors";

// Thread frames: the dispatcher reaches them through this module.
export { applyReadyThreads } from "./threadFrames";
export { resumeThreadFocus } from "../../stores/threadsLoader";
export function handleChatMessage(clock: ReconnectClock, payload: Payload<"chat_message">): void {
  if (payload.user.id === authStore.getState().user?.id) {
    acknowledgePendingMessage(payload.client_message_id);
  }
  log.debug("chat_message received", {
    id: payload.id,
    channelId: payload.channel_id,
    user: payload.user.username,
  });
  // The sender's message landing clears their "is typing…" at once.
  // A no-op for an unknown typer (a reconnect replay burst carries no typing
  // state), and scoped to this channel + this sender so other typers stay.
  clearTyping(payload.channel_id, payload.user.id);
  addMessage(payload);
  handleThreadState(payload);
  // A message that lands in the thread the panel has open is seen as it arrives.
  loadedThreadsStore()?.noteOpenThreadMessage(payload.channel_id, payload.id);
  const activeId = channelsStore.select((s) => s.activeChannelId);

  // Check if this is a DM channel and whether the message is from self.
  const dmChannels = dmStore.getState().channels;
  const isDm = dmChannels.some((c) => c.channelId === payload.channel_id);
  const currentUserId = authStore.getState().user?.id ?? null;
  const isOwnMessage = currentUserId !== null && payload.user.id === currentUserId;

  const isReplayFrame = isReplayedFrame(clock, payload);
  const isMention = raisesMentionBadge(payload, isReplayFrame);
  // "active" only means "the reader is watching" while the window is
  // focused (isChannelAway, lib/readState.ts). A minimised or unfocused window
  // shows nothing, so a message landing in the active channel then must count
  // like one in any other channel (badge, taskbar, divider) — the same
  // predicate the ready-time mark-read uses.
  const isAway = isChannelAway(payload.channel_id);

  noteChannelUnread(payload, activeId, isOwnMessage, isMention, isAway);
  if (isDm) noteDmMessage(payload, activeId, isOwnMessage, isMention, isAway);
  if (!isReplayFrame) notifyLiveMessage(clock, payload);
}

export function handleChatEdited(
  api: DispatchApi | undefined,
  payload: Payload<"chat_edited">,
): void {
  editMessage(payload);
  reviseDmLastMessage(payload.channel_id, payload.message_id, { lastMessage: payload.content });
  if (hasDmPreviewRefetch(payload.channel_id)) {
    reviseDmPreviewAfterDelete(api, payload.channel_id, []);
  }
}

export function handleChatDeleted(
  api: DispatchApi | undefined,
  payload: Payload<"chat_deleted">,
): void {
  deleteMessage(payload);
  reviseDmPreviewAfterDelete(api, payload.channel_id, [payload.message_id]);
}

export function handleChatBulkDeleted(
  api: DispatchApi | undefined,
  payload: Payload<"chat_bulk_deleted">,
): void {
  bulkDeleteMessages(payload);
  reviseDmPreviewAfterDelete(api, payload.channel_id, payload.ids);
}
/** A message was pinned or unpinned elsewhere — keep this client's row in
 *  sync (F5). The store's per-channel pin revision moves with it, which is what
 *  an open pinned panel watches to refetch its list. */
export function handleChatPinned(payload: Payload<"chat_pinned">): void {
  setMessagePinned(payload.channel_id, payload.message_id, payload.pinned);
}

export function handleChatSendOk(
  api: DispatchApi | undefined,
  payload: Payload<"chat_send_ok">,
  id: string | undefined,
): void {
  acknowledgePendingMessage(payload.client_message_id);
  if (id) {
    // Resolve the channel before confirmSend: that call drops the
    // pendingSends entry and flips the row to "sent", destroying both
    // identities this lookup needs.
    const channelId = channelIdForSend(id, payload.client_message_id);
    confirmSend(id, payload.message_id, payload.timestamp, payload.client_message_id);
    // A deduplicated ack means the server already had the message, so no
    // chat_message broadcast follows to reconcile the row. The local copy
    // can be stale -- fetch the authoritative row and replace it in place.
    // The around endpoint 404s for a deleted message or one in another
    // channel, so a rejection here is only worth a log line.
    if (payload.deduplicated === true && channelId !== undefined && api?.getMessagesAround) {
      const getMessagesAround = api.getMessagesAround;
      const localRow = () =>
        messagesStore
          .getState()
          .messagesByChannel.get(channelId)
          ?.find((m) => m.id === payload.message_id);
      // The REST read is a snapshot; a chat_edited, chat_deleted or
      // reaction_update can land while it is in flight, and replacing the
      // row with the older snapshot would undo it (a deleted message is a
      // tombstone here, so it would come back). Store updates replace the
      // row object, so a changed reference means a newer frame won: read
      // again rather than apply. Three reads, then the frames stand.
      const reconcile = (readsLeft: number): void => {
        const before = localRow();
        getMessagesAround(channelId, payload.message_id)
          .then((resp) => {
            const row = resp.messages.find((m) => m.id === payload.message_id);
            if (!row) return;
            if (localRow() !== before) {
              if (readsLeft > 1) reconcile(readsLeft - 1);
              return;
            }
            applyServerMessage(row);
          })
          .catch((err) =>
            log.warn("Failed to reconcile a deduplicated send", { error: String(err) }),
          );
      };
      reconcile(3);
    }
  }
}

export function handleReactionUpdate(payload: Payload<"reaction_update">): void {
  const userId = authStore.getState().user?.id ?? 0;
  updateReaction(payload, userId);
  // The who-reacted tooltip caches the reactor list per message+emoji; any
  // add/remove on this message makes those lists stale.
  invalidateReactionUsers(payload.message_id);
}

/** A poll's counts after a vote or its end; the store keeps them in version order. */
export function handlePollUpdate(payload: Payload<"poll_update">): void {
  updatePoll(payload, authStore.getState().user?.id ?? 0);
}

/** The sender's stored selection, so the card shows it before the poll_update that carries the counts. */
export function handlePollVoteOk(payload: Payload<"poll_vote_ok">): void {
  applyPollVoteOk(payload);
}

export function handleTyping(payload: Payload<"typing">): void {
  setTyping(payload.channel_id, payload.user_id);
}

/** Fail every pending optimistic send and reaction once the socket leaves "connected". */
export function failPendingOnDisconnect(state: ConnectionState): void {
  if (state !== "reconnecting" && state !== "disconnected") return;
  // Snapshot the ids: markSendFailed deletes from pendingSends, so
  // iterating the live Map's keys would mutate during iteration.
  for (const id of Array.from(messagesStore.getState().pendingSends.keys())) {
    markSendFailed(id, "OFFLINE");
  }
  // Same reasoning applies to optimistic reaction toggles: a reaction
  // frame already handed to a dying socket can never deliver its
  // chat_send_ok/error either, so roll back every pending toggle instead
  // of leaving a permanently wrong pill and a stale pendingReactions
  // entry that could later consume an unrelated self-echo.
  for (const id of Array.from(messagesStore.getState().pendingReactions?.keys() ?? [])) {
    rollbackReaction(id);
  }
}

/** A local transport failure for a request id: fail its pending send, else roll back its reaction. */
export function handleSendFailure(id: string, code: string): void {
  if (messagesStore.getState().pendingSends.has(id)) {
    markSendFailed(id, code);
    return;
  }
  rollbackReaction(id);
}
// Messages, threads, reactions, polls and typing. thread_create_ok,
// thread_changed and forum_post_create_ok all carry a thread's whole state.
export const wsRoutes: readonly WsRoute[] = [
  route(S.CHAT_MESSAGE, (c) => (p) => handleChatMessage(c.clock, p)),
  route(S.THREAD_CREATE_OK, () => handleThreadState),
  route(S.THREAD_CHANGED, () => handleThreadState),
  route(S.FORUM_POST_CREATE_OK, () => handleThreadState),
  route(S.THREAD_DELETED, () => handleThreadDeleted),
  route(S.THREAD_FOLLOW_OK, () => handleThreadFollow),
  route(S.THREAD_FOLLOW_UPDATE, () => handleThreadFollow),
  route(S.CHAT_EDITED, (c) => (p) => handleChatEdited(c.api, p)),
  route(S.CHAT_DELETED, (c) => (p) => handleChatDeleted(c.api, p)),
  route(S.CHAT_BULK_DELETED, (c) => (p) => handleChatBulkDeleted(c.api, p)),
  route(S.CHAT_PINNED, () => handleChatPinned),
  route(S.CHAT_SEND_OK, (c) => (p, id) => handleChatSendOk(c.api, p, id)),
  route(S.REACTION_UPDATE, () => handleReactionUpdate),
  route(S.POLL_UPDATE, () => handlePollUpdate),
  route(S.POLL_VOTE_OK, () => handlePollVoteOk),
  route(S.TYPING, () => handleTyping),
];
