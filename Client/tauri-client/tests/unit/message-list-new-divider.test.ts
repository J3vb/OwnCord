/**
 * The "NEW" divider: a line above the first message the reader has not seen,
 * placed from the unread count the channel carried when it was opened (the
 * badge itself is cleared by the visit, so the count has to be snapshotted).
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
import { messagesStore, addMessage } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { channelsStore, setChannels, setActiveChannel } from "@stores/channels.store";
import type { ReadyChannel } from "@lib/types";

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
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
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
    // Spaced far enough apart that grouping never merges rows.
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, id * 5)).toISOString(),
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

function setDetached(detached: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Set(prev.detachedChannels);
    if (detached) next.add(CHANNEL_ID);
    else next.delete(CHANNEL_ID);
    return { ...prev, detachedChannels: next };
  });
}

/** Seed the channel list with `unread` unread messages, then "open" the channel
 *  the way the app does — which clears the badge and snapshots the count. */
function openChannelWithUnread(unread: number): void {
  const ch: ReadyChannel = {
    id: CHANNEL_ID,
    name: "general",
    type: "text",
    category: null,
    position: 0,
    unread_count: unread,
    mention_count: 0,
  };
  setChannels([ch]);
  setActiveChannel(CHANNEL_ID);
}

describe("MessageList — new-messages divider", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;

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
  });

  afterEach(() => {
    msgList?.destroy?.();
    msgList = null;
    container.remove();
  });

  function mount(): void {
    msgList = createMessageList(options);
    msgList.mount(container);
  }

  function dividerIndex(): number {
    const rows = [...container.querySelectorAll(".virtual-content > *")];
    return rows.findIndex((el) => el.classList.contains("msg-new-divider"));
  }

  it("renders no divider when the channel was opened with nothing unread", () => {
    setMessages([1, 2, 3].map(makeMessage));
    openChannelWithUnread(0);
    mount();

    expect(container.querySelector('[data-testid="new-messages-divider"]')).toBeNull();
  });

  it("places the divider above the first unread message", () => {
    setMessages([1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    mount();

    const divider = container.querySelector('[data-testid="new-messages-divider"]');
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain("NEW");

    // The row right after the divider must be message 4 — the first of the
    // last two (unread) messages.
    const next = divider?.nextElementSibling as HTMLElement;
    expect(next.dataset.testid).toBe("message-4");
  });

  it("places the divider at the top when every loaded message is unread", () => {
    setMessages([1, 2, 3].map(makeMessage));
    openChannelWithUnread(10);
    mount();

    // Index 0 is the day divider; the NEW line comes right after it and
    // before the first message.
    const idx = dividerIndex();
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = container.querySelectorAll(".virtual-content > *")[idx + 1] as HTMLElement;
    expect(next.dataset.testid).toBe("message-1");
  });

  it("renders exactly one divider", () => {
    setMessages([1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(3);
    mount();

    expect(container.querySelectorAll('[data-testid="new-messages-divider"]')).toHaveLength(1);
  });

  it("renders no divider for an empty channel", () => {
    setMessages([]);
    openChannelWithUnread(5);
    mount();

    expect(container.querySelector('[data-testid="new-messages-divider"]')).toBeNull();
  });

  // A detached window is a slice around some old message, so "the last N
  // loaded messages" no longer identifies the unread ones.
  it("suppresses the divider while the window is detached", () => {
    setMessages([1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    setDetached(true);
    mount();

    expect(container.querySelector('[data-testid="new-messages-divider"]')).toBeNull();
  });

  it("clears on the next visit to the channel", () => {
    setMessages([1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    mount();
    expect(container.querySelector('[data-testid="new-messages-divider"]')).not.toBeNull();

    // Leave and come back: the badge is gone now, so no divider.
    msgList?.destroy?.();
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    setActiveChannel(null);
    setActiveChannel(CHANNEL_ID);
    mount();

    expect(container.querySelector('[data-testid="new-messages-divider"]')).toBeNull();
  });

  // Regression: firstUnreadIndex is messages.length - unreadOnOpen, an offset
  // from the end. A full rebuild after messages arrive during the visit used
  // to recompute that offset against the new (longer) length, sliding the
  // line down past the messages it was placed to mark.
  it("keeps the divider anchored to the same message across a rebuild after messages arrive", () => {
    setMessages([1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    mount();

    const before = container.querySelector('[data-testid="new-messages-divider"]')
      ?.nextElementSibling as HTMLElement;
    expect(before.dataset.testid).toBe("message-4");

    // Three more messages arrive while the reader is on the channel, via the
    // real append path (addMessage), which preserves the existing rows'
    // identity — the append fast path handles this correctly on its own.
    // Store notifications are microtask-batched, so every step is flushed:
    // without that the assertions below read the DOM from mount() and pass
    // no matter what rebuildItems would have done.
    for (const id of [6, 7, 8]) {
      addMessage({
        id,
        channel_id: CHANNEL_ID,
        user: { id: 1, username: "Alice", avatar: null },
        content: `Message ${id}`,
        reply_to: null,
        attachments: [],
        timestamp: new Date(Date.UTC(2024, 0, 15, 12, id * 5)).toISOString(),
      });
    }
    messagesStore.flush();
    expect(container.querySelector('[data-testid="message-8"]')).not.toBeNull();
    const afterAppend = container.querySelector('[data-testid="new-messages-divider"]')
      ?.nextElementSibling as HTMLElement;
    expect(afterAppend.dataset.testid).toBe("message-4");

    // A non-append change (an edit) forces a full rebuild instead of the
    // append fast path — this is where the count-based offset used to drift.
    messagesStore.setState((prev) => {
      const list = prev.messagesByChannel.get(CHANNEL_ID)!;
      const next = list.map((m) => (m.id === 1 ? { ...m, content: "edited" } : m));
      const updated = new Map(prev.messagesByChannel);
      updated.set(CHANNEL_ID, next);
      return { ...prev, messagesByChannel: updated };
    });
    messagesStore.flush();

    const after = container.querySelector('[data-testid="new-messages-divider"]')
      ?.nextElementSibling as HTMLElement;
    expect(after.dataset.testid).toBe("message-4");
  });

  // The line marks a boundary; the message under it must not be rendered as a
  // grouped continuation of the message above the line.
  it("breaks message grouping at the divider", () => {
    const sameMinute = [1, 2, 3].map((id) => ({
      ...makeMessage(id),
      timestamp: "2024-01-15T12:00:00Z",
    }));
    setMessages(sameMinute);
    openChannelWithUnread(1);
    mount();

    const divider = container.querySelector('[data-testid="new-messages-divider"]');
    const first = divider?.nextElementSibling as HTMLElement;
    expect(first.dataset.testid).toBe("message-3");
    expect(first.classList.contains("grouped")).toBe(false);
    // The message before the line is still grouped — only the boundary breaks.
    expect(
      (container.querySelector('[data-testid="message-2"]') as HTMLElement).classList.contains(
        "grouped",
      ),
    ).toBe(true);
  });
});
