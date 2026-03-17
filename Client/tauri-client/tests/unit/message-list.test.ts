import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";

function resetStores(): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return {
    channelId: 1,
    user: { id: 1, username: "Alice", avatar: null },
    content: `Message ${overrides.id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    editedAt: null,
    deleted: false,
    timestamp: "2024-01-15T12:00:00Z",
    ...overrides,
  };
}

function setMessages(channelId: number, messages: Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(channelId, messages);
    return { ...prev, messagesByChannel: next };
  });
}

function setHasMore(channelId: number, value: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.hasMore);
    next.set(channelId, value);
    return { ...prev, hasMore: next };
  });
}

describe("MessageList", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;
  let options: MessageListOptions;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = {
      channelId: 1,
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
    };
    msgList = createMessageList(options);
  });

  afterEach(() => {
    msgList.destroy?.();
    container.remove();
  });

  it("mounts with messages-container class", () => {
    msgList.mount(container);
    const root = container.querySelector(".messages-container");
    expect(root).not.toBeNull();
  });

  it("renders virtual scroll structure (spacers + content)", () => {
    msgList.mount(container);
    expect(container.querySelector(".virtual-spacer-top")).not.toBeNull();
    expect(container.querySelector(".virtual-content")).not.toBeNull();
    expect(container.querySelector(".virtual-spacer-bottom")).not.toBeNull();
  });

  it("renders messages from store", () => {
    const messages = [
      makeMessage({ id: 1, content: "Hello" }),
      makeMessage({ id: 2, content: "World" }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    const content = container.querySelector(".virtual-content");
    expect(content).not.toBeNull();
    // Should have rendered items (day divider + messages)
    expect(content!.children.length).toBeGreaterThan(0);
  });

  it("empty channel renders no content children (besides spacers)", () => {
    msgList.mount(container);
    const content = container.querySelector(".virtual-content");
    expect(content).not.toBeNull();
    expect(content!.children.length).toBe(0);
  });

  it("destroy removes DOM and cleans up", () => {
    msgList.mount(container);
    expect(container.querySelector(".messages-container")).not.toBeNull();
    msgList.destroy?.();
    expect(container.querySelector(".messages-container")).toBeNull();
  });

  it("reacts to store updates", () => {
    msgList.mount(container);
    const content = container.querySelector(".virtual-content");
    expect(content!.children.length).toBe(0);

    // Add messages
    setMessages(1, [makeMessage({ id: 1, content: "New message" })]);
    messagesStore.flush();

    expect(content!.children.length).toBeGreaterThan(0);
  });

  it("renders day dividers between messages on different days", () => {
    const messages = [
      makeMessage({ id: 1, timestamp: "2024-01-15T12:00:00Z" }),
      makeMessage({ id: 2, timestamp: "2024-01-16T12:00:00Z" }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    // Virtual scroll in jsdom has no real layout (clientHeight=0),
    // so we verify content was rendered at all — the render window
    // may include all items since offsetToIndex returns 0-based for
    // zero-height containers. Check for msg-day-divider class.
    const content = container.querySelector(".virtual-content");
    expect(content).not.toBeNull();
    // The virtual scroll renders items based on estimated heights.
    // In jsdom with 0 clientHeight, renderWindow computes start=0, end=OVERSCAN+1.
    // With only 4 items (2 dividers + 2 messages), all should be in the window.
    const dividers = container.querySelectorAll(".msg-day-divider");
    expect(dividers.length).toBe(2);
  });
});
