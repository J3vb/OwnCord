import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jsdom does not provide ResizeObserver — stub it so MessageList can mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  } as unknown as typeof ResizeObserver;
}

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
    pinned: false,
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

export type MessageListComponent = ReturnType<typeof createMessageList>;

describe("MessageList", () => {
  let container: HTMLDivElement;
  let msgList: MessageListComponent;
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
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
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

  it("empty channel renders welcome state", () => {
    msgList.mount(container);
    const welcome = container.querySelector(".channel-welcome");
    expect(welcome).not.toBeNull();
    const title = container.querySelector(".channel-welcome-title");
    expect(title?.textContent).toBe("Welcome to #general!");
    const text = container.querySelector(".channel-welcome-text");
    expect(text?.textContent).toBe("This is the start of the #general channel.");
  });

  it("destroy removes DOM and cleans up", () => {
    msgList.mount(container);
    expect(container.querySelector(".messages-container")).not.toBeNull();
    msgList.destroy?.();
    expect(container.querySelector(".messages-container")).toBeNull();
  });

  it("reacts to store updates", () => {
    msgList.mount(container);
    // Initially shows welcome state
    expect(container.querySelector(".channel-welcome")).not.toBeNull();

    // Add messages
    setMessages(1, [makeMessage({ id: 1, content: "New message" })]);
    messagesStore.flush();

    const content = container.querySelector(".virtual-content");
    expect(content!.children.length).toBeGreaterThan(0);
    // Welcome state should be gone once messages exist
    expect(container.querySelector(".channel-welcome")).toBeNull();
  });

  it("scrollToMessage returns true when message exists in virtual items", () => {
    const messages = [
      makeMessage({ id: 1, content: "Hello" }),
      makeMessage({ id: 2, content: "Target message" }),
      makeMessage({ id: 3, content: "World" }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    const result = msgList.scrollToMessage(2);
    expect(result).toBe(true);
  });

  it("scrollToMessage returns false when message not found", () => {
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const result = msgList.scrollToMessage(999);
    expect(result).toBe(false);
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

  it("renders DM channel empty state differently from text channels", () => {
    msgList.destroy?.();
    const dmOptions: MessageListOptions = {
      ...options,
      channelName: "Bob",
      channelType: "dm",
    };
    msgList = createMessageList(dmOptions);
    msgList.mount(container);

    const title = container.querySelector(".channel-welcome-title");
    expect(title?.textContent).toBe("Bob");

    const icon = container.querySelector(".channel-welcome-icon");
    expect(icon?.textContent).toBe("@");

    const text = container.querySelector(".channel-welcome-text");
    expect(text?.textContent).toBe(
      "This is the beginning of your direct message history with Bob.",
    );
  });

  it("includes a scroll-to-bottom button", () => {
    msgList.mount(container);
    const btn = container.querySelector(".scroll-to-bottom-btn");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("\u2193");
  });

  it("calls onScrollTop when scrolling near the top and there are more messages", () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    // jsdom scrollTop defaults to 0 which is already < SCROLL_TOP_THRESHOLD(50)
    // Manually trigger the scroll event
    root.dispatchEvent(new Event("scroll"));

    expect(options.onScrollTop).toHaveBeenCalledOnce();
  });

  it("does not call onScrollTop when no more messages are available", () => {
    setHasMore(1, false);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));

    expect(options.onScrollTop).not.toHaveBeenCalled();
  });

  it("does not call onScrollTop twice without new messages arriving", () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    root.dispatchEvent(new Event("scroll"));

    // loadingOlder guard prevents double-calling
    expect(options.onScrollTop).toHaveBeenCalledTimes(1);
  });

  it("resets loadingOlder flag when new messages arrive after scroll-top", () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    expect(options.onScrollTop).toHaveBeenCalledTimes(1);

    // Simulate new messages arriving (load-more response)
    setMessages(1, [makeMessage({ id: 0, content: "Older message" }), makeMessage({ id: 1 })]);
    messagesStore.flush();

    // Now scrolling to top again should trigger onScrollTop again
    root.dispatchEvent(new Event("scroll"));
    expect(options.onScrollTop).toHaveBeenCalledTimes(2);
  });

  it("scrollToMessage returns false before mount", () => {
    // scrollToMessage should be safe to call before mount
    const unmounted = createMessageList(options);
    expect(unmounted.scrollToMessage(1)).toBe(false);
    unmounted.destroy?.();
  });

  it("groups consecutive messages from the same user within threshold", () => {
    // Two messages from same user within 5 minutes
    const messages = [
      makeMessage({
        id: 1,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: "2024-01-15T12:00:00Z",
        content: "First message",
      }),
      makeMessage({
        id: 2,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: "2024-01-15T12:01:00Z",
        content: "Second message",
      }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    const content = container.querySelector(".virtual-content");
    expect(content).not.toBeNull();
    // Both messages should render; the second should be grouped (class "message grouped")
    const grouped = content!.querySelectorAll(".message.grouped");
    expect(grouped.length).toBeGreaterThanOrEqual(1);
  });

  it("destroys cleanly without errors even with loaded messages", () => {
    setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
    msgList.mount(container);
    expect(container.querySelector(".messages-container")).not.toBeNull();

    // destroy should not throw
    expect(() => msgList.destroy?.()).not.toThrow();
    expect(container.querySelector(".messages-container")).toBeNull();
  });
});
