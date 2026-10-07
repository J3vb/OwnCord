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
import type { ReferencedMessage } from "../../lib/types";
import type { Message, MessagesState } from "./messageModel";

/** A parent that is deleted, purged or erased: no author, no text. */
function redactSnippet(id: number): ReferencedMessage {
  return { id, user: null, content: "", deleted: true, has_attachments: false };
}

/** Redact the snippet of every reply in `list` whose parent `hit` selects; `list` itself when none. */
function redactReplies(
  list: readonly Message[],
  hit: (ref: ReferencedMessage) => boolean,
): readonly Message[] {
  if (!list.some((m) => m.referencedMessage && hit(m.referencedMessage))) return list;
  return list.map((m) =>
    m.referencedMessage && hit(m.referencedMessage)
      ? { ...m, referencedMessage: redactSnippet(m.referencedMessage.id) }
      : m,
  );
}

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

  const updatedList = redactReplies(
    channelMessages.map((msg) => (msg.id === payload.message_id ? { ...msg, deleted: true } : msg)),
    (ref) => ref.id === payload.message_id,
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
  if (
    !channelMessages.some(
      (msg) =>
        (purged.has(msg.id) && !msg.deleted) ||
        (msg.referencedMessage && purged.has(msg.referencedMessage.id)),
    )
  ) {
    return prev;
  }

  const updatedList = redactReplies(
    channelMessages.map((msg) => (purged.has(msg.id) ? { ...msg, deleted: true } : msg)),
    (ref) => purged.has(ref.id),
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
