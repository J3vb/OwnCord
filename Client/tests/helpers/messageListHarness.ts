import { vi, beforeEach, afterEach } from "vitest";
import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { buildMessage } from "./messageFactory";

export function resetStores(): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

export function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return buildMessage(overrides);
}

export function setMessages(channelId: number, messages: Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(channelId, messages);
    return { ...prev, messagesByChannel: next };
  });
}

export function setHasMore(channelId: number, value: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.hasMore);
    next.set(channelId, value);
    return { ...prev, hasMore: next };
  });
}

export function setHistoryLoadState(channelId: number, value: "loading" | "error"): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.historyLoadState);
    next.set(channelId, value);
    return { ...prev, historyLoadState: next };
  });
}

export type MessageListComponent = ReturnType<typeof createMessageList>;

/** Registers the shared beforeEach/afterEach for every messageList test file. */
export function useMessageListHarness(
  bind: (wired: {
    container: HTMLDivElement;
    options: MessageListOptions;
    msgList: MessageListComponent;
  }) => void,
  current: () => MessageListComponent,
): void {
  let container: HTMLDivElement;
  let options: MessageListOptions;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = {
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onEditSave: vi.fn(() => true),
      onEmptyEdit: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
    const msgList = createMessageList(options);
    bind({ container, options, msgList });
  });

  afterEach(() => {
    current().destroy?.();
    container.remove();
  });
}
