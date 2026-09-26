// Reaction reducers for the messages store: the shared count/me delta, the
// optimistic toggle, its rollback and the server echo. Pure (prev, input) =>
// next functions, extracted from stores/messages.store.ts, whose mutators wrap
// each in messagesStore.setState. Returning `prev` by identity when nothing
// changed is behavior: selector subscriptions compare with ===.
import type { ReactionUpdatePayload } from "../../lib/types";
import type { Message, MessagesState, PendingReaction } from "./messageModel";

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

/** addOptimisticReaction's reducer. */
export function reduceAddOptimisticReaction(
  prev: MessagesState,
  correlationId: string,
  toggle: PendingReaction,
): MessagesState {
  const updatedMessages = applyReactionDelta(prev, toggle, true);
  if (updatedMessages === null) return prev;
  const updatedPending = new Map(prev.pendingReactions ?? []);
  updatedPending.set(correlationId, toggle);
  return { ...prev, messagesByChannel: updatedMessages, pendingReactions: updatedPending };
}

/** updateReaction's reducer. */
export function reduceUpdateReaction(
  prev: MessagesState,
  payload: ReactionUpdatePayload,
  currentUserId: number,
): MessagesState {
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
}

/** rollbackReaction's reducer; `found` is whether the id matched a pending toggle. */
export function reduceRollbackReaction(
  prev: MessagesState,
  correlationId: string,
): { next: MessagesState; found: boolean } {
  const toggle = prev.pendingReactions?.get(correlationId);
  if (toggle === undefined) return { next: prev, found: false };
  const updatedPending = new Map(prev.pendingReactions);
  updatedPending.delete(correlationId);
  const inverse: PendingReaction = {
    ...toggle,
    action: toggle.action === "add" ? "remove" : "add",
  };
  const updatedMessages = applyReactionDelta(prev, inverse, true);
  if (updatedMessages === null) {
    return { next: { ...prev, pendingReactions: updatedPending }, found: true };
  }
  return {
    next: { ...prev, messagesByChannel: updatedMessages, pendingReactions: updatedPending },
    found: true,
  };
}
