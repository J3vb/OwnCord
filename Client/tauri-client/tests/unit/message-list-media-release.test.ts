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

// Spy on the media-visibility manager: MessageList must release every tracked
// <img> (unobserveMedia) before discarding rendered rows, otherwise the
// IntersectionObserver + allTracked set + pending timers retain every GIF
// ever rendered.
const { observeMediaMock, unobserveMediaMock } = vi.hoisted(() => ({
  observeMediaMock: vi.fn(),
  unobserveMediaMock: vi.fn(),
}));
vi.mock("@lib/media-visibility", () => ({
  observeMedia: observeMediaMock,
  unobserveMedia: unobserveMediaMock,
}));

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

describe("MessageList media release (GIF observer leak fix)", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;
  let options: MessageListOptions;

  beforeEach(() => {
    resetStores();
    observeMediaMock.mockClear();
    unobserveMediaMock.mockClear();
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

  it("unobserves rendered <img> elements before a full re-render discards them", () => {
    setMessages(1, [makeMessage({ id: 2, content: "look https://example.com/anim.gif" })]);
    msgList.mount(container);

    const img = container.querySelector(".virtual-content img");
    expect(img).not.toBeNull();
    unobserveMediaMock.mockClear();

    // Prepend an older message — NOT a suffix extension, so the list takes
    // the full-rebuild path that tears the rendered rows down.
    setMessages(1, [
      makeMessage({ id: 1, content: "older", timestamp: "2024-01-15T11:00:00Z" }),
      makeMessage({ id: 2, content: "look https://example.com/anim.gif" }),
    ]);
    messagesStore.flush();

    expect(unobserveMediaMock).toHaveBeenCalledWith(img);
  });

  it("unobserves rendered <img> elements on destroy", () => {
    setMessages(1, [makeMessage({ id: 1, content: "look https://example.com/anim.gif" })]);
    msgList.mount(container);

    const img = container.querySelector(".virtual-content img");
    expect(img).not.toBeNull();
    unobserveMediaMock.mockClear();

    msgList.destroy?.();

    expect(unobserveMediaMock).toHaveBeenCalledWith(img);
  });

  it("does not unobserve retained rows on the incremental append fast path", () => {
    const gifMessage = makeMessage({ id: 1, content: "look https://example.com/anim.gif" });
    setMessages(1, [gifMessage]);
    msgList.mount(container);
    expect(container.querySelector(".virtual-content img")).not.toBeNull();
    unobserveMediaMock.mockClear();

    // Suffix extension (same leading references) → rows are kept, so nothing
    // must be released.
    setMessages(1, [
      gifMessage,
      makeMessage({ id: 2, content: "plain follow-up", timestamp: "2024-01-15T12:01:00Z" }),
    ]);
    messagesStore.flush();

    expect(unobserveMediaMock).not.toHaveBeenCalled();
  });
});
