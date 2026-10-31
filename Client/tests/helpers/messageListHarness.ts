import { vi, beforeEach, afterEach } from "vitest";
import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { buildMessage } from "./messageFactory";
import { membersStore } from "@stores/members.store";
import { resetMessagesState, resetMembersState } from "./storeResets";
import { signInAs } from "./storeSeeds";

export function resetStores(): void {
  resetMessagesState();
  resetMembersState();
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

/** Replaces the member list with a single online member. */
export function seedMember(id: number, username: string, role = "member"): void {
  membersStore.setState(() => ({
    members: new Map([[id, { id, username, avatar: null, role, status: "online" as const }]]),
    typingUsers: new Map(),
    roleRevision: 0,
  }));
}

/** Adds an online member and flushes, as a live member_join would. */
export function joinMember(id: number, username: string): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    next.set(id, { id, username, avatar: null, role: "member", status: "online" as const });
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
  membersStore.flush();
}

/** Signs in as user 99, who is not an author in the fixtures. */
export function signInAsViewer(): void {
  signInAs(
    { id: 99, username: "me", avatar: null, role: "member" },
    { token: "t", serverName: null },
  );
}
