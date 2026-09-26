// Edit, delete, bulk-delete and pin reducers for the messages store. Pure
// (prev, input) => next functions, extracted from stores/messages.store.ts,
// whose mutators wrap each in messagesStore.setState. Returning `prev` by
// identity when nothing changed is behavior: selector subscriptions compare
// with ===.
import type {
  ChatEditedPayload,
  ChatDeletedPayload,
  ChatBulkDeletedPayload,
} from "../../lib/types";
import type { MessagesState } from "./messageModel";

/** editMessage's reducer. */
export function reduceEditMessage(prev: MessagesState, payload: ChatEditedPayload): MessagesState {
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
}

/** deleteMessage's reducer. */
export function reduceDeleteMessage(
  prev: MessagesState,
  payload: ChatDeletedPayload,
): MessagesState {
  const channelMessages = prev.messagesByChannel.get(payload.channel_id);
  if (!channelMessages) return prev;

  const updatedList = channelMessages.map((msg) =>
    msg.id === payload.message_id ? { ...msg, deleted: true } : msg,
  );

  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(payload.channel_id, updatedList);
  return { ...prev, messagesByChannel: updatedMessages };
}

/** bulkDeleteMessages' reducer. */
export function reduceBulkDeleteMessages(
  prev: MessagesState,
  payload: ChatBulkDeletedPayload,
): MessagesState {
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
}

/** setMessagePinned's reducer. */
export function reduceSetMessagePinned(
  prev: MessagesState,
  channelId: number,
  messageId: number,
  pinned: boolean,
): MessagesState {
  const channelMessages = prev.messagesByChannel.get(channelId);
  if (!channelMessages) return prev;

  const updatedList = channelMessages.map((msg) =>
    msg.id === messageId ? { ...msg, pinned } : msg,
  );

  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, updatedList);
  return { ...prev, messagesByChannel: updatedMessages };
}
