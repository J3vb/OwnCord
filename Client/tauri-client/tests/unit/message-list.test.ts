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
    historyLoadState: new Map(),
    detachedChannels: new Set(),
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
    status: "sent",
    correlationId: null,
    errorCode: null,
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

function setHistoryLoadState(channelId: number, value: "loading" | "error"): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.historyLoadState);
    next.set(channelId, value);
    return { ...prev, historyLoadState: next };
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

  it("renders the in-region loading placeholder while history is loading", () => {
    setHistoryLoadState(1, "loading");
    msgList.mount(container);

    expect(container.querySelector(".messages-loading")).not.toBeNull();
    expect(container.querySelector(".channel-welcome")).toBeNull();
  });

  it("renders inline error with Retry on load failure, and Retry calls onRetryLoad", () => {
    const onRetryLoad = vi.fn();
    msgList.destroy?.();
    msgList = createMessageList({ ...options, onRetryLoad });
    setHistoryLoadState(1, "error");
    msgList.mount(container);

    expect(container.querySelector(".messages-load-error")).not.toBeNull();
    expect(container.querySelector(".channel-welcome")).toBeNull();
    const retry = container.querySelector("[data-testid='messages-retry']") as HTMLButtonElement;
    expect(retry).not.toBeNull();
    retry.click();
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it("transitions loading → welcome once the load state clears", () => {
    setHistoryLoadState(1, "loading");
    msgList.mount(container);
    expect(container.querySelector(".messages-loading")).not.toBeNull();

    messagesStore.setState((prev) => {
      const next = new Map(prev.historyLoadState);
      next.delete(1);
      return { ...prev, historyLoadState: next };
    });
    messagesStore.flush();

    expect(container.querySelector(".messages-loading")).toBeNull();
    expect(container.querySelector(".channel-welcome")).not.toBeNull();
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

  it("scrollToMessage flashes the target row so the eye can find it", () => {
    setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 }), makeMessage({ id: 3 })]);
    msgList.mount(container);

    msgList.scrollToMessage(2);

    // A scroll with no visual marker leaves the reader hunting; the row the
    // jump landed on must be the one that flashes.
    const flashed = container.querySelector(".highlight-flash");
    expect(flashed).not.toBeNull();
    expect(flashed!.getAttribute("data-testid")).toBe("message-2");
  });

  it("scrollToMessage renders a target that was outside the rendered window", () => {
    // A long channel: without forcing a rebuild the target stays unrendered
    // and there is nothing to scroll to or flash.
    const many = Array.from({ length: 200 }, (_, i) => makeMessage({ id: i + 1 }));
    setMessages(1, many);
    msgList.mount(container);

    expect(msgList.scrollToMessage(150)).toBe(true);
    expect(container.querySelector('[data-testid="message-150"]')).not.toBeNull();
  });

  it("rebuilds the virtual window when scrolling outside the rendered range", async () => {
    setHasMore(1, false);
    const many = Array.from({ length: 300 }, (_, i) => makeMessage({ id: i + 1 }));
    setMessages(1, many);
    msgList.mount(container);

    // renderAll positions the window at the tail; rows near the top are
    // virtualized away behind the top spacer.
    expect(container.querySelector('[data-testid="message-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-300"]')).not.toBeNull();

    // mount's trailing scrollToBottom leaves scrollTop at 0 in jsdom
    // (scrollHeight is 0 without layout), so the scroll position now sits at
    // the very top of the list while the rendered window is still the tail —
    // exactly the state a user scrolling far past the overscan produces.
    const root = container.querySelector(".messages-container") as HTMLDivElement;
    expect(root.scrollTop).toBe(0);
    root.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // The window must follow the scroll: rows at the top render, and the old
    // tail rows are released back to the spacers.
    expect(container.querySelector('[data-testid="message-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="message-300"]')).toBeNull();
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

  it("day divider breaks grouping even for the same author posting across midnight", () => {
    // isSameDay compares local calendar days, so the boundary is built with
    // the local-time Date constructor (not UTC ISO literals) to stay
    // independent of the machine/CI runner's timezone.
    const beforeMidnight = new Date(2024, 0, 15, 23, 58, 0).toISOString();
    const afterMidnight = new Date(2024, 0, 16, 0, 1, 0).toISOString();
    const messages = [
      makeMessage({
        id: 1,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: beforeMidnight,
      }),
      makeMessage({
        id: 2,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: afterMidnight,
      }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    // 2 dividers: the leading one before the first message, plus one for the
    // day change (matches "renders day dividers between messages on
    // different days" above -- the assertion here is on grouping, not count).
    expect(container.querySelectorAll(".msg-day-divider").length).toBe(2);
    const row2 = container.querySelector("[data-testid='message-2']")!;
    expect(row2.classList.contains("grouped")).toBe(false);
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

  it("clears loadingOlder once the onScrollTop promise settles, even when no new messages arrived (failed fetch)", async () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    // Flush this setup notification now — store notifications are deferred to
    // a microtask, and without this it would land during the first `await`
    // below and reset loadingOlder for an unrelated reason (prevMessageCount
    // syncing from its initial 0), masking the bug this test targets.
    messagesStore.flush();
    let resolveLoad: () => void = () => {};
    const onScrollTop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    // Recreate with the overriding onScrollTop — it's declared readonly, so
    // it must be set at construction rather than mutated on the shared
    // `options` object from beforeEach.
    msgList = createMessageList({ ...options, onScrollTop });
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    // A second scroll-to-top while the fetch is still in flight must not
    // re-trigger it.
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    // The fetch settles WITHOUT any new messages arriving — the failure path
    // (a real onScrollTop catches its own error and never rejects, so the
    // promise resolves either way; the store just never changed).
    resolveLoad();
    await Promise.resolve();
    await Promise.resolve();

    // loadingOlder must now be false — scrolling to top again re-triggers it.
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(2);
  });

  it("does not re-trigger onScrollTop from a live tail append while a history fetch is in flight", async () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    messagesStore.flush();

    let resolveLoad: () => void = () => {};
    const onScrollTop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    msgList = createMessageList({ ...options, onScrollTop });
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    // A live message arrives at the tail while the older-page fetch is still
    // in flight. messages[0] (the oldest loaded message) is unchanged, so the
    // latch must stay set -- otherwise the next scroll refires the fetch with
    // the same unchanged cursor and the same page lands twice.
    setMessages(1, [
      ...(messagesStore.getState().messagesByChannel.get(1) ?? []),
      makeMessage({ id: 2 }),
    ]);
    messagesStore.flush();

    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    resolveLoad();
    await Promise.resolve();
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

  it("does not re-render when a DIFFERENT channel's messages update", () => {
    setMessages(1, [makeMessage({ id: 1, content: "Mine" })]);
    msgList.mount(container);

    const rowBefore = container.querySelector("[data-testid='message-1']");
    expect(rowBefore).not.toBeNull();

    // Update another channel — this list (channel 1) must not rebuild.
    setMessages(2, [makeMessage({ id: 50, channelId: 2, content: "Other channel" })]);
    messagesStore.flush();

    const rowAfter = container.querySelector("[data-testid='message-1']");
    expect(rowAfter).toBe(rowBefore); // same element instance — no re-render
  });

  describe("incremental tail append", () => {
    it("appends new rows without rebuilding existing ones", () => {
      setMessages(1, [
        makeMessage({ id: 1, content: "First" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      msgList.mount(container);

      const row1Before = container.querySelector("[data-testid='message-1']");
      const row2Before = container.querySelector("[data-testid='message-2']");
      expect(row1Before).not.toBeNull();
      expect(row2Before).not.toBeNull();

      // Pure suffix extension → fast path: existing rows keep their identity.
      setMessages(1, [
        ...(messagesStore.getState().messagesByChannel.get(1) ?? []),
        makeMessage({ id: 3, content: "Third", timestamp: "2024-01-15T12:02:00Z" }),
      ]);
      messagesStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1Before);
      expect(container.querySelector("[data-testid='message-2']")).toBe(row2Before);
      expect(container.querySelector("[data-testid='message-3']")).not.toBeNull();
    });

    it("appended rows preserve order, grouping, and day dividers vs a full rebuild", () => {
      const initial = [
        makeMessage({ id: 1, content: "First", timestamp: "2024-01-15T12:00:00Z" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ];
      setMessages(1, initial);
      msgList.mount(container);

      const appended = [
        // Same user within threshold → must render grouped.
        makeMessage({ id: 3, content: "Third", timestamp: "2024-01-15T12:02:00Z" }),
        // Next day, different user → must be preceded by a day divider.
        makeMessage({
          id: 4,
          content: "Fourth",
          user: { id: 2, username: "Bob", avatar: null },
          timestamp: "2024-01-16T09:00:00Z",
        }),
      ];
      const finalMessages = [...initial, ...appended];
      setMessages(1, finalMessages);
      messagesStore.flush();

      const content = container.querySelector(".virtual-content")!;

      // Reference render: a fresh list mounted with the final message set
      // (full rebuild path) must produce the same structure.
      const refContainer = document.createElement("div");
      document.body.appendChild(refContainer);
      const refList = createMessageList(options);
      refList.mount(refContainer);
      const refContent = refContainer.querySelector(".virtual-content")!;

      const describeChildren = (el: Element): string[] =>
        Array.from(el.children).map((c) => `${c.className}|${c.getAttribute("data-testid") ?? ""}`);
      expect(describeChildren(content)).toEqual(describeChildren(refContent));

      // Explicit semantic checks on the appended tail.
      expect(container.querySelectorAll(".msg-day-divider").length).toBe(2);
      const row3 = container.querySelector("[data-testid='message-3']")!;
      expect(row3.classList.contains("grouped")).toBe(true);
      const row4 = container.querySelector("[data-testid='message-4']")!;
      expect(row4.classList.contains("grouped")).toBe(false);
      const ids = Array.from(content.querySelectorAll("[data-testid^='message-']")).map((el) =>
        el.getAttribute("data-testid"),
      );
      expect(ids).toEqual(["message-1", "message-2", "message-3", "message-4"]);

      refList.destroy?.();
      refContainer.remove();
    });

    it("falls back to a full rebuild for non-append updates (edit)", () => {
      setMessages(1, [
        makeMessage({ id: 1, content: "Original" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      msgList.mount(container);

      // Replace message 1's object (an edit) — not a suffix extension.
      setMessages(1, [
        makeMessage({ id: 1, content: "Edited" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      messagesStore.flush();

      const row1 = container.querySelector("[data-testid='message-1']");
      expect(row1).not.toBeNull();
      expect(row1!.textContent).toContain("Edited");
    });
  });
});
