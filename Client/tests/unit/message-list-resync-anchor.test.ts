/**
 * P2-T4: a full-ready resync (a server restart) splices the refetched tail
 * into the loaded window. The reader scrolled back into older history must
 * stay on the message they were reading, and the list must report that
 * message as its reading anchor so a detached window can refetch around it.
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
import {
  messagesStore,
  resetMessagesStore,
  setMessages,
  prependMessages,
  setChannelLoading,
  invalidateLoadedMessageWindows,
} from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { readingAnchor } from "../../src/features/messaging/readingAnchor";
import type { MessageResponse } from "@lib/types";

const CHANNEL_ID = 1;

function response(id: number): MessageResponse {
  return {
    id,
    channel_id: CHANNEL_ID,
    user: { id: 1, username: "Alice", avatar: null },
    content: `Message ${id}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    // 5 minutes apart on one UTC day: no grouping, no day dividers.
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 5)).toISOString(),
  };
}

/** Newest-first page of ids [from, to], as the REST API returns it. */
function page(from: number, to: number): MessageResponse[] {
  const out: MessageResponse[] = [];
  for (let id = to; id >= from; id--) out.push(response(id));
  return out;
}

describe("MessageList — a full-ready resync keeps the reading position (P2-T4)", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let scrollHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetMessagesStore();
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
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
    // jsdom lays nothing out, so isNearBottom() would always be true; stub a
    // real gap so it reflects the scrollTop the test sets.
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

  it("keeps the message being read in view across the invalidate and the spliced tail", () => {
    setMessages(CHANNEL_ID, page(151, 200), true);
    prependMessages(CHANNEL_ID, page(101, 150), true);
    prependMessages(CHANNEL_ID, page(51, 100), true);
    prependMessages(CHANNEL_ID, page(1, 50), false);
    msgList = createMessageList(options);
    msgList.mount(container);
    const root = container.querySelector(".messages-container") as HTMLDivElement;

    // Scroll back to message 30, then let the list rebuild at that position.
    expect(msgList.scrollToMessage(30)).toBe(true);
    root.dispatchEvent(new Event("scroll"));
    expect(readingAnchor(CHANNEL_ID)).toBe(30);
    const scrollTop = root.scrollTop;

    // The resync: invalidate, then the refetched tail (with one edit) lands.
    setChannelLoading(CHANNEL_ID);
    invalidateLoadedMessageWindows();
    messagesStore.flush();
    expect(container.querySelector('[data-testid="message-30"]')).not.toBeNull();

    const fresh = page(151, 200).map((m) => (m.id === 190 ? { ...m, content: "edited" } : m));
    setMessages(CHANNEL_ID, fresh, true, true);
    messagesStore.flush();

    expect(container.querySelector('[data-testid="message-30"]')).not.toBeNull();
    expect(root.scrollTop).toBe(scrollTop);
    expect(readingAnchor(CHANNEL_ID)).toBe(30);
  });

  it("reports no reading anchor for another channel or once destroyed", () => {
    setMessages(CHANNEL_ID, page(1, 50), false);
    msgList = createMessageList(options);
    msgList.mount(container);

    expect(readingAnchor(CHANNEL_ID + 1)).toBeNull();
    msgList.destroy?.();
    msgList = null;
    expect(readingAnchor(CHANNEL_ID)).toBeNull();
  });
});
