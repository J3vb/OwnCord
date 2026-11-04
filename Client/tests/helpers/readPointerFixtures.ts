import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import type { DmChannel } from "@stores/dm.store";
import { buildMessage } from "./messageFactory";

/** A sent message from alice in channel 1 whose content is `m<id>`. */
export function pointerMessage(id: number): Message {
  return buildMessage(
    { id, content: `m${id}` },
    { user: { id: 2, username: "alice", avatar: null } },
  );
}

/** Seeds a channel's loaded messages directly, as a history fetch would leave them. */
export function seedLoadedMessages(channelId: number, messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(channelId, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
}

/** A one-to-one DM with bob, unread and holding a read pointer. */
export function makeDmRow(over: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 50,
    recipient: { id: 7, username: "bob", avatar: "", status: "online" },
    participants: [],
    name: "",
    isGroup: false,
    lastMessageId: 30,
    lastReadMessageId: 10,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 2,
    mentionCount: 1,
    ...over,
  };
}
