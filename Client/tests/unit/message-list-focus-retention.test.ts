// B9-22: a virtualized rebuild must put focus back on the control it was on, so
// a keyboard user reading a long channel does not lose their place when the
// window materializes rows around them (Q1 focus: stable location through
// async update/removal).
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
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
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

describe("MessageList focus retention across a virtualized rebuild (B9-22)", () => {
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
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
    setMessages(1, [
      makeMessage({ id: 1, user: { id: 2, username: "Bob", avatar: null } }),
      makeMessage({ id: 2, user: { id: 2, username: "Bob", avatar: null } }),
    ]);
  });

  afterEach(() => {
    container.remove();
    resetStores();
  });

  it("restores focus to the action button on its row after a full rebuild", async () => {
    const list = createMessageList(options);
    list.mount(container);

    const replyBtn = container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-2']");
    expect(replyBtn).not.toBeNull();
    replyBtn!.focus();
    expect(document.activeElement).toBe(replyBtn);

    // An edit to an existing row is not a pure suffix append, so it forces the
    // full rebuild path (renderAll → renderWindow REBUILD) that clears and
    // re-renders every row, replacing the focused node. setState batches on a
    // microtask, so wait for it to run.
    const msgs = messagesStore.getState().messagesByChannel.get(1)!;
    setMessages(
      1,
      msgs.map((m) =>
        m.id === 2 ? { ...m, content: "edited", editedAt: "2024-01-15T12:01:00Z" } : m,
      ),
    );
    await messagesStore.flush();

    const restored = container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-2']");
    expect(restored).not.toBeNull();
    expect(restored).not.toBe(replyBtn);
    expect(document.activeElement).toBe(restored);

    list.destroy?.();
  });

  it("leaves focus alone when it was outside the rendered window", async () => {
    const list = createMessageList(options);
    list.mount(container);

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const msgs = messagesStore.getState().messagesByChannel.get(1)!;
    setMessages(
      1,
      msgs.map((m) =>
        m.id === 2 ? { ...m, content: "edited", editedAt: "2024-01-15T12:01:00Z" } : m,
      ),
    );
    await messagesStore.flush();

    expect(document.activeElement).toBe(outside);

    outside.remove();
    list.destroy?.();
  });
});
