import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

// Unique markers so the offsetHeight stub below can tell the two unconfirmed
// (id: 0) optimistic rows apart by content, since both currently collide on
// the cache key "msg-0".
const MARK_A = "ZZMARKAAA";
const MARK_B = "ZZMARKBBB";
const HEIGHT_A = 111;
const HEIGHT_B = 222;
const HEIGHT_DEFAULT = 10;

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

describe("MessageList height cache key for unconfirmed optimistic rows", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;
  let options: MessageListOptions;
  let offsetHeightDescriptor: PropertyDescriptor | undefined;

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

    // jsdom never lays anything out, so offsetHeight is always 0. Stub it so
    // MessageList's real measurement path (measureRendered) has distinct,
    // deterministic heights to record for each top-level rendered item:
    // the two markers stand in for the two unconfirmed rows, everything
    // else (day dividers, confirmed messages) gets a uniform default.
    offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        const text = this.textContent ?? "";
        if (text.includes(MARK_A)) return HEIGHT_A;
        if (text.includes(MARK_B)) return HEIGHT_B;
        return HEIGHT_DEFAULT;
      },
    });
  });

  afterEach(() => {
    msgList.destroy?.();
    container.remove();
    if (offsetHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
    }
  });

  it("keeps two unconfirmed (id: 0) optimistic rows' measured heights distinct across a tree rebuild", () => {
    // Two unconfirmed optimistic rows, both id: 0 (as addOptimisticMessage
    // produces before confirmSend stamps a real id), distinguished only by
    // correlationId and content/measured height.
    const rowA = makeMessage({ id: 0, correlationId: "corr-a", content: MARK_A });
    const rowB = makeMessage({ id: 0, correlationId: "corr-b", content: MARK_B });
    const confirmed = Array.from({ length: 40 }, (_, i) =>
      makeMessage({ id: 1000 + i, content: `Confirmed ${i}` }),
    );

    setMessages(1, [rowA, rowB, ...confirmed]);
    msgList = createMessageList(options);
    msgList.mount(container);

    // Initial mount positions the render window at the tail (wasAtBottom is
    // always true in jsdom), so rowA/rowB are not yet in the DOM and not yet
    // measured. Force them into view and measured by jumping to rowA (id 0
    // resolves to the first such row) — OVERSCAN(20) around index 1 (rowA,
    // right after the single leading day divider) also covers rowB at index
    // 2, so both get real, distinct measurements written to the shared
    // height cache: heightCache["msg-0"] ends up holding rowB's height,
    // last-measured-wins, per the bug's own description.
    expect(msgList.scrollToMessage(0)).toBe(true);

    // Now grow the channel at the tail while the render window is NOT at the
    // tail (renderedEnd stopped at rowA's OVERSCAN window, well short of the
    // 43-item list). This is a pure suffix extension, so it takes the fast
    // "tryAppendMessages" path, which re-seeds a fresh Fenwick tree from the
    // (colliding) height cache for every index WITHOUT re-rendering/
    // remeasuring rowA or rowB (they are outside the appended tail and the
    // window is not at the tail, so tryAppendMessages skips remeasurement).
    const grown = [
      rowA,
      rowB,
      ...confirmed,
      ...Array.from({ length: 5 }, (_, i) => makeMessage({ id: 2000 + i, content: `New ${i}` })),
    ];
    setMessages(1, grown);
    messagesStore.flush();

    // A confirmed message that was already measured (index 3..21 window,
    // i.e. one of the first 19 "confirmed" rows) sits after both rowA and
    // rowB. Its offset-before is the sum of every item ahead of it: the one
    // leading day divider (HEIGHT_DEFAULT) + rowA + rowB + N confirmed rows
    // at HEIGHT_DEFAULT each. If the cache collision corrupted rowA's slot
    // in the tree, that offset is inflated by (HEIGHT_B - HEIGHT_A).
    const target = confirmed[5]!; // id 1005, virtual index 3 + 5 = 8
    expect(msgList.scrollToMessage(target.id)).toBe(true);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    const expectedCorrect = HEIGHT_DEFAULT + HEIGHT_A + HEIGHT_B + 5 * HEIGHT_DEFAULT;

    // This is the assertion the bug breaks: with the shared "msg-0" cache
    // key, rowA's tree slot gets re-seeded from rowB's cached height instead
    // of its own, inflating the offset by (HEIGHT_B - HEIGHT_A) = 111.
    expect(root.scrollTop).toBe(expectedCorrect);
  });
});
