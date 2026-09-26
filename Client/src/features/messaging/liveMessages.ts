// Live-message and optimistic-send reducers for the messages store: a live
// broadcast, the user's own optimistic row and its ack/failure/removal, and an
// authoritative single-row refresh. Pure (prev, input) => next functions,
// extracted from stores/messages.store.ts, whose mutators wrap each in
// messagesStore.setState and keep the documented contracts. Returning `prev`
// by identity when nothing changed is behavior: selector subscriptions
// compare with ===.
import type { MessageResponse } from "../../lib/types";
import { MAX_MESSAGES_PER_CHANNEL, messageResponseToMessage } from "./messageModel";
import type { Message, MessagesState } from "./messageModel";
import { isUnreconciledEcho } from "./echoReconcile";

/** addMessage's reducer: reconcile a live chat_message with its optimistic row, or append it. */
export function reduceAddMessage(prev: MessagesState, message: Message): MessagesState {
  const channelId = message.channelId;
  const existing = prev.messagesByChannel.get(channelId) ?? [];

  // 1. Replace an existing row with the same real id (reconcile / idempotent).
  const idIdx = existing.findIndex((m) => m.id !== 0 && m.id === message.id);
  if (idIdx !== -1) {
    const pendingSends = new Map(prev.pendingSends);
    const replaced = existing.flatMap((m, i) => {
      if (i === idIdx) return [message];
      // History may have arrived before the live echo, carrying the real
      // id but no private receipt. Consume its exact optimistic twin too.
      if (message.clientMessageId !== undefined && isUnreconciledEcho(m, message)) {
        if (m.correlationId) pendingSends.delete(m.correlationId);
        return [];
      }
      return [m];
    });
    const updated = new Map(prev.messagesByChannel);
    updated.set(channelId, replaced);
    return { ...prev, messagesByChannel: updated, pendingSends };
  }

  // 2. Defensive: reconcile the oldest pending (or transport-failed) optimistic
  //    row from this author (a broadcast that arrived before its chat_send_ok
  //    ack, or arrived after the dispatcher's offline sweep gave up on a send
  //    that had actually gone through). Scoped to OFFLINE — a server-rejected
  //    send (SLOW_MODE/FORBIDDEN/...) is never broadcast, so no echo can ever
  //    arrive for it, and eating that row here would silently drop the retry
  //    the user still needs. Content must match too (allowing for the
  //    server's sanitization — see echoNormalize) — a same-author message
  //    from another session of this account carries genuinely different
  //    content, and consuming the pending row for it would orphan the real
  //    send.
  const pendingIdx = existing.findIndex((m) => isUnreconciledEcho(m, message));
  if (pendingIdx !== -1) {
    const replaced = existing.map((m, i) => (i === pendingIdx ? message : m));
    const updated = new Map(prev.messagesByChannel);
    updated.set(channelId, replaced);
    const pendingSends = new Map(prev.pendingSends);
    const correlationId = existing[pendingIdx]!.correlationId;
    if (correlationId) pendingSends.delete(correlationId);
    return { ...prev, messagesByChannel: updated, pendingSends };
  }

  // 3. Append as a new message — unless the channel is showing a detached
  //    around-window, in which case the new message belongs to the live tail
  //    below the gap and must wait for "Jump to Present".
  if (prev.detachedChannels.has(channelId)) return prev;

  // Insert before any trailing unreconciled optimistic row(s) rather than
  // blindly appending at the tail. An optimistic row (status !== "sent")
  // has no real server id/timestamp yet — confirmSend will stamp it in
  // place once its ack arrives — so a message that commits and broadcasts
  // *while our own send is still in flight* must land ahead of it, or the
  // eventually-stamped row (a later server id/timestamp) ends up rendered
  // above an older message it should follow. Rows before the trailing
  // unreconciled run are already "sent" and keep their position.
  let insertAt = existing.length;
  while (insertAt > 0 && existing[insertAt - 1]!.status !== "sent") {
    insertAt--;
  }
  let updatedMsgs = [...existing.slice(0, insertAt), message, ...existing.slice(insertAt)];
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
}

/** addOptimisticMessage's reducer: append the pending row and register its correlation id. */
export function reduceAddOptimisticMessage(
  prev: MessagesState,
  params: { readonly channelId: number; readonly correlationId: string },
  optimistic: Message,
): MessagesState {
  const existing = prev.messagesByChannel.get(params.channelId) ?? [];
  const updated = new Map(prev.messagesByChannel);
  updated.set(params.channelId, [...existing, optimistic]);
  const updatedPending = new Map(prev.pendingSends);
  updatedPending.set(params.correlationId, params.channelId);
  return { ...prev, messagesByChannel: updated, pendingSends: updatedPending };
}

/** markSendFailed's reducer. */
export function reduceMarkSendFailed(
  prev: MessagesState,
  correlationId: string,
  errorCode: string | null,
): MessagesState {
  // A row that already failed was dropped from pendingSends by an earlier
  // call, so a second call must still find it: an offline send is marked
  // failed at once, then relabeled when its deferred persistence also
  // fails. Fall back to the same scan removeOptimistic uses.
  let channelId = prev.pendingSends.get(correlationId);
  if (channelId === undefined) {
    for (const [cid, list] of prev.messagesByChannel) {
      if (!list.some((m) => m.correlationId === correlationId)) continue;
      channelId = cid;
      break;
    }
    if (channelId === undefined) return prev;
  }
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
}

/** removeOptimistic's reducer. */
export function reduceRemoveOptimistic(prev: MessagesState, correlationId: string): MessagesState {
  const updatedPending = new Map(prev.pendingSends);
  updatedPending.delete(correlationId);

  // A "failed" row has already been dropped from pendingSends by
  // markSendFailed, so pendingSends can't tell us its channel — scan for
  // the row itself instead. This is the common case: Retry/Delete only
  // render for status==="failed" rows (renderers.ts), so a pendingSends
  // hit here would mean removeOptimistic raced ahead of the row ever
  // failing.
  const channelId = prev.pendingSends.get(correlationId);
  if (channelId !== undefined) {
    const existing = prev.messagesByChannel.get(channelId);
    if (existing === undefined) {
      return { ...prev, pendingSends: updatedPending };
    }
    const filtered = existing.filter((m) => m.correlationId !== correlationId);
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, filtered);
    return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
  }

  for (const [cid, list] of prev.messagesByChannel) {
    if (!list.some((m) => m.correlationId === correlationId)) continue;
    const filtered = list.filter((m) => m.correlationId !== correlationId);
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(cid, filtered);
    return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
  }

  return { ...prev, pendingSends: updatedPending };
}

/** confirmSend's reducer. */
export function reduceConfirmSend(
  prev: MessagesState,
  correlationId: string,
  messageId: number,
  timestamp: string,
  clientMessageId?: string,
): MessagesState {
  // A lost ACK can arrive after the offline sweep removed pendingSends, or
  // after a retry has a new transport id. The logical identity still owns it.
  let channelId = prev.pendingSends.get(correlationId);
  if (channelId === undefined) {
    for (const [id, rows] of prev.messagesByChannel) {
      if (
        rows.some(
          (m) =>
            m.status !== "sent" &&
            (m.correlationId === correlationId ||
              (clientMessageId !== undefined && m.clientMessageId === clientMessageId)),
        )
      ) {
        channelId = id;
        break;
      }
    }
  }
  const updatedPending = new Map(prev.pendingSends);
  updatedPending.delete(correlationId);
  if (channelId === undefined) {
    return { ...prev, pendingSends: updatedPending };
  }
  const existing = prev.messagesByChannel.get(channelId);
  if (existing === undefined) {
    return { ...prev, pendingSends: updatedPending };
  }
  const alreadyInHistory = existing.some((m) => m.id === messageId && m.status === "sent");
  let reconciled = alreadyInHistory;
  const updatedList = existing.flatMap((m) => {
    const matches =
      m.status !== "sent" &&
      (m.correlationId === correlationId ||
        (clientMessageId !== undefined && m.clientMessageId === clientMessageId));
    if (!matches) return [m];
    if (m.correlationId) updatedPending.delete(m.correlationId);
    // Replayed ACKs have no second broadcast. Keep the authoritative history
    // row (including sanitization/edits), rather than displaying it twice.
    if (reconciled) return [];
    reconciled = true;
    return [{ ...m, id: messageId, timestamp, status: "sent" as const, errorCode: null }];
  });
  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, updatedList);
  return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
}

/** applyServerMessage's reducer. */
export function reduceApplyServerMessage(
  prev: MessagesState,
  response: MessageResponse,
): MessagesState {
  const existing = prev.messagesByChannel.get(response.channel_id);
  if (existing === undefined) return prev;
  const incoming = messageResponseToMessage(response);
  const index = existing.findIndex((m) => m.id !== 0 && m.id === incoming.id);
  if (index === -1) return prev;
  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(
    response.channel_id,
    existing.map((m, i) => (i === index ? incoming : m)),
  );
  return { ...prev, messagesByChannel: updatedMessages };
}

/** channelIdForSend's lookup, over the state it is handed. */
export function findSendChannel(
  state: MessagesState,
  correlationId: string,
  clientMessageId?: string,
): number | undefined {
  const registered = state.pendingSends.get(correlationId);
  if (registered !== undefined) return registered;
  for (const [channelId, rows] of state.messagesByChannel) {
    if (
      rows.some(
        (m) =>
          m.status !== "sent" &&
          (m.correlationId === correlationId ||
            (clientMessageId !== undefined && m.clientMessageId === clientMessageId)),
      )
    ) {
      return channelId;
    }
  }
  return undefined;
}
