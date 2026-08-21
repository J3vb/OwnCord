/**
 * OC-0248: prepending a history page (loadOlderMessages -> prependMessages)
 * must keep whatever message the reader was actually looking at in view.
 * renderAll() only has a scroll-anchor branch for "was at the bottom"; a
 * prepend takes the non-append, non-bottom path and currently leaves
 * root.scrollTop untouched, which after the prepend points at completely
 * different (older) content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";

const CHANNEL_ID = 1;

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

function makeMessage(id: number): Message {
  return {
    id,
    channelId: CHANNEL_ID,
    user: { id: 1, username: "Alice", avatar: null },
    content: `Message ${id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    // 5 minutes apart, on the same UTC day, and exactly at (not under)
    // GROUP_THRESHOLD_MS so shouldGroup never merges two of these rows —
    // every message renders at its full (ungrouped) height.
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 5)).toISOString(),
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

function setMessages(messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(CHANNEL_ID, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
}

function setHasMore(value: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.hasMore);
    next.set(CHANNEL_ID, value);
    return { ...prev, hasMore: next };
  });
}

describe("MessageList — history prepend keeps the reading position (OC-0248)", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let scrollHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = {
      channelId: CHANNEL_ID,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };

    // jsdom never lays anything out, so scrollHeight/clientHeight are always
    // 0 — which makes isNearBottom() (scrollHeight - scrollTop - clientHeight
    // < 100) unconditionally TRUE regardless of scrollTop, hiding this bug
    // entirely (it only manifests when the reader is scrolled away from the
    // bottom). Stub a real gap so isNearBottom reflects the scrollTop we set.
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(): number {
        return 100_000;
      },
    });
  });

  afterEach(() => {
    msgList?.destroy?.();
    msgList = null;
    container.remove();
    if (scrollHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });

  function mount(): void {
    msgList = createMessageList(options);
    msgList.mount(container);
  }

  it("keeps the previously-topmost message rendered after a history page is prepended", async () => {
    // The currently loaded window: 50 messages, ids 51..100 (oldest loaded
    // message is 51).
    const initial = Array.from({ length: 50 }, (_, i) => makeMessage(51 + i));
    setMessages(initial);
    setHasMore(true);
    mount();

    const root = container.querySelector(".messages-container") as HTMLDivElement;

    // Scroll near the top -- exactly the state that fires loadOlderMessages
    // in production (handleScroll's scrollTop < SCROLL_TOP_THRESHOLD(50)
    // check) -- landing inside message-51's row, the oldest loaded message.
    root.scrollTop = 40;
    root.dispatchEvent(new Event("scroll"));
    await Promise.resolve();

    // A history page of 50 older messages (ids 1..50) is prepended in front
    // of the array -- a real prependMessages call. This is not a suffix
    // extension (allMessages[0] changes), so the store subscriber's
    // tryAppendMessages() bails and falls through to renderAll().
    const older = Array.from({ length: 50 }, (_, i) => makeMessage(1 + i));
    setMessages([...older, ...initial]);
    messagesStore.flush();

    // Message 51 -- what the reader was actually looking at -- must still be
    // rendered near the top of the (virtualized) window. Before the fix,
    // root.scrollTop is left at ~40px, which after the prepend now falls
    // inside message-1's row (the new oldest message) instead: the reader is
    // thrown ~50 messages backwards.
    expect(container.querySelector('[data-testid="message-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-51"]')).not.toBeNull();

    // The scroll position must have moved forward by roughly the height of
    // the prepended page, not stayed pinned at its pre-prepend value.
    expect(root.scrollTop).toBeGreaterThan(1000);
  });
});
