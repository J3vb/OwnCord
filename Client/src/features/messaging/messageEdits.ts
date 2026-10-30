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
import { isPinRowKind } from "../../lib/text/messageKind";
import type { Message, MessagesState } from "./messageModel";

/** A parent that is deleted, purged or erased: no author, no text. */
function redactSnippet(id: number): ReferencedMessage {
  return { id, user: null, content: "", deleted: true, has_attachments: false };
}

/**
 * The message `m` points at: a reply's parent, or the target of a pin row. A
 * live pin row arrives with no snippet, so its target is only in `replyTo`.
 */
function pointedAt(m: Message): number | null {
  if (m.referencedMessage) return m.referencedMessage.id;
  return isPinRowKind(m.kind) ? m.replyTo : null;
}

/** Redact the snippet of every row in `list` whose parent or pin target `hit` selects; `list` itself when none. */
function redactReplies(list: readonly Message[], hit: (id: number) => boolean): readonly Message[] {
  const hits = (m: Message): boolean => {
    const id = pointedAt(m);
    return id !== null && hit(id);
  };
  if (!list.some(hits)) return list;
  return list.map((m) => (hits(m) ? { ...m, referencedMessage: redactSnippet(pointedAt(m)!) } : m));
}

/** The server caps a reply snippet at 100 code points (Server/db/referenced_message.go). */
const SNIPPET_MAX_CODE_POINTS = 100;

/** Refresh the snippet text of every reply to `parentId`; `list` itself when none. */
function refreshReplies(
  list: readonly Message[],
  parentId: number,
  content: string,
): readonly Message[] {
  if (!list.some((m) => m.referencedMessage?.id === parentId)) return list;
  const snippet = Array.from(content).slice(0, SNIPPET_MAX_CODE_POINTS).join("");
  return list.map((m) =>
    m.referencedMessage?.id === parentId
      ? { ...m, referencedMessage: { ...m.referencedMessage, content: snippet } }
      : m,
  );
}

/** editMessage's reducer. */
export function reduceEditMessage(prev: MessagesState, payload: ChatEditedPayload): MessagesState {
  const channelMessages = prev.messagesByChannel.get(payload.channel_id);
  if (!channelMessages) return prev;

  const updatedList = refreshReplies(
    channelMessages.map((msg) =>
      msg.id === payload.message_id
        ? {
            ...msg,
            content: payload.content,
            editedAt: payload.edited_at,
            mentions: payload.mentions,
            mentionsEveryone: payload.mentions_everyone,
            mentionRoles: payload.mention_roles,
            // A call row's end carries the finished `call`; its edited_at is null.
            ...(payload.call !== undefined && { kind: payload.kind ?? "call", call: payload.call }),
          }
        : msg,
    ),
    payload.message_id,
    payload.content,
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
    (id) => id === payload.message_id,
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
      (msg) => (purged.has(msg.id) && !msg.deleted) || purged.has(pointedAt(msg) ?? 0),
    )
  ) {
    return prev;
  }

  const updatedList = redactReplies(
    channelMessages.map((msg) => (purged.has(msg.id) ? { ...msg, deleted: true } : msg)),
    (id) => purged.has(id),
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
  const pinRevision = new Map(prev.pinRevision);
  pinRevision.set(channelId, (pinRevision.get(channelId) ?? 0) + 1);
  const messagePinRevision = new Map(prev.messagePinRevision);
  messagePinRevision.set(messageId, (messagePinRevision.get(messageId) ?? 0) + 1);

  const channelMessages = prev.messagesByChannel.get(channelId);
  if (!channelMessages) return { ...prev, pinRevision, messagePinRevision };

  const updatedList = channelMessages.map((msg) =>
    msg.id === messageId ? { ...msg, pinned } : msg,
  );

  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, updatedList);
  return { ...prev, messagesByChannel: updatedMessages, pinRevision, messagePinRevision };
}
