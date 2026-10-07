/**
 * P4-03 (DP-14 part 1): unread navigation within the loaded window.
 *
 * - Step A: a channel counts as read once the reader has seen its bottom with
 *   the window focused, or focus returns while the bottom is in view.
 * - Step B: opening a channel with unread messages shows the "N new messages
 *   since <time>" bar with "Mark as read", and lands on the NEW divider
 *   instead of the bottom.
 * - Step C: the ↓ button shows how many messages arrived below the view.
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
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import {
  channelsStore,
  setChannels,
  setActiveChannel,
  incrementUnread,
} from "@stores/channels.store";
import { setMarkReadSender } from "@lib/read-state";
import { formatMessageTimestamp } from "@lib/formatting";

const CHANNEL_ID = 1;
const ME = 1;
/** Stubbed scroller geometry: jsdom lays nothing out, so without these every
 *  scroll position reads as "at the bottom". */
const SCROLL_HEIGHT = 100_000;
const CLIENT_HEIGHT = 600;
/** Estimated heights MessageList uses before anything is measured (jsdom
 *  measures 0): a day or NEW divider is 32 px, an ungrouped text row 61 px. */
const DIVIDER_PX = 32;
const ROW_PX = 61;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

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

/** Authors alternate between two other users so no row is ever grouped, and
 *  every message is within one minute so there is exactly one day divider. */
function makeMessage(id: number, userId = 2 + (id % 2)): Message {
  return {
    id,
    channelId: CHANNEL_ID,
    user: { id: userId, username: `user${userId}`, avatar: null },
    content: `Message ${id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, 0, id % 60)).toISOString(),
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

function range(from: number, to: number): Message[] {
  return Array.from({ length: to - from + 1 }, (_, i) => makeMessage(from + i));
}

function setMessages(messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(CHANNEL_ID, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
  messagesStore.flush();
}

function setDetached(detached: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Set(prev.detachedChannels);
    if (detached) next.add(CHANNEL_ID);
    else next.delete(CHANNEL_ID);
    return { ...prev, detachedChannels: next };
  });
}

/** Seed the channel with `unread` unread messages and open it the way the app
 *  does (the badge clears and the count is snapshotted for the divider). */
function openChannelWithUnread(unread: number): void {
  setChannels([
    {
      id: CHANNEL_ID,
      name: "general",
      type: "text",
      category: null,
      position: 0,
      unread_count: unread,
      mention_count: 0,
    },
  ]);
  setActiveChannel(CHANNEL_ID);
}

const unreadCount = () => channelsStore.getState().channels.get(CHANNEL_ID)!.unreadCount;

describe("MessageList — unread navigation (P4-03)", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let sendMarkRead: ReturnType<typeof vi.fn<(channelId: number) => void>>;
  let hasFocus: ReturnType<typeof vi.spyOn>;
  const saved = new Map<string, PropertyDescriptor | undefined>();

  function stub(prop: "scrollHeight" | "clientHeight", value: number): void {
    saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = {
      channelId: CHANNEL_ID,
      channelName: "general",
      currentUserId: ME,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
    sendMarkRead = vi.fn<(channelId: number) => void>();
    setMarkReadSender(sendMarkRead);
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    stub("scrollHeight", SCROLL_HEIGHT);
    stub("clientHeight", CLIENT_HEIGHT);
  });

  afterEach(() => {
    msgList?.destroy?.();
    msgList = null;
    container.remove();
    setMarkReadSender(null);
    hasFocus.mockRestore();
    for (const [prop, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
    saved.clear();
  });

  function mount(): void {
    msgList = createMessageList(options);
    msgList.mount(container);
  }

  const root = () => container.querySelector(".messages-container") as HTMLDivElement;

  function scrollTo(top: number): void {
    root().scrollTop = top;
    root().dispatchEvent(new Event("scroll"));
  }
  const scrollToEnd = () => scrollTo(SCROLL_HEIGHT - CLIENT_HEIGHT);
  const scrollUp = () => scrollTo(300);

  // ---------------------------------------------------------------------------
  // Step A — read when seen
  // ---------------------------------------------------------------------------

  describe("Step A: marks read when the bottom is seen", () => {
    it("marks the channel read when the reader reaches the bottom with the window focused", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();
      scrollUp();
      // A message counted while the window was unfocused (wsHandlers, Step A).
      incrementUnread(CHANNEL_ID, true);

      scrollToEnd();

      expect(sendMarkRead).toHaveBeenCalledWith(CHANNEL_ID);
      expect(unreadCount()).toBe(0);
    });

    it("does not mark read at the bottom while the window is unfocused", () => {
      hasFocus.mockReturnValue(false);
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();
      incrementUnread(CHANNEL_ID, true);

      scrollUp();
      scrollToEnd();

      expect(sendMarkRead).not.toHaveBeenCalled();
      expect(unreadCount()).toBe(1);
    });

    it("marks read when focus returns with the bottom in view", () => {
      hasFocus.mockReturnValue(false);
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();
      scrollToEnd();
      incrementUnread(CHANNEL_ID, true);

      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));

      expect(sendMarkRead).toHaveBeenCalledWith(CHANNEL_ID);
      expect(unreadCount()).toBe(0);
    });

    it("does not mark read when focus returns while the reader is scrolled up", () => {
      hasFocus.mockReturnValue(false);
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();
      scrollUp();
      incrementUnread(CHANNEL_ID, true);

      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));

      expect(sendMarkRead).not.toHaveBeenCalled();
      expect(unreadCount()).toBe(1);
    });

    // mark_read has a 5/s per-user budget the server enforces by dropping
    // frames; every scroll to the bottom must not spend it.
    it("sends no mark_read when nothing is unread", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();

      scrollUp();
      scrollToEnd();
      window.dispatchEvent(new Event("focus"));

      expect(sendMarkRead).not.toHaveBeenCalled();
    });

    // OC-0204: the bottom of a detached window is not the present.
    it("does not mark read at the bottom of a detached window", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      setDetached(true);
      mount();
      incrementUnread(CHANNEL_ID, true);

      scrollUp();
      scrollToEnd();
      window.dispatchEvent(new Event("focus"));

      expect(sendMarkRead).not.toHaveBeenCalled();
      expect(unreadCount()).toBe(1);
    });

    it("does not mark read from a scroll while its channel is not the active one", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();
      incrementUnread(CHANNEL_ID, true);
      setActiveChannel(999);

      scrollUp();
      scrollToEnd();

      expect(sendMarkRead).not.toHaveBeenCalled();
      expect(unreadCount()).toBe(1);
    });

    it("stops listening for focus once destroyed", () => {
      hasFocus.mockReturnValue(false);
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();
      scrollToEnd();
      incrementUnread(CHANNEL_ID, true);
      msgList!.destroy!();
      msgList = null;

      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));

      expect(sendMarkRead).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Step B — the unread bar and opening at the NEW divider
  // ---------------------------------------------------------------------------

  describe("Step B: unread bar and open at the divider", () => {
    const bar = () => container.querySelector<HTMLElement>('[data-testid="unread-bar"]');
    const barShown = () => bar() !== null && !bar()!.hidden;
    const barLabel = () =>
      container.querySelector('[data-testid="unread-bar-label"]')?.textContent ?? "";
    const markReadButton = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="unread-bar-mark-read"]');

    it("shows the count and the time of the first unread message", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(5);
      mount();

      expect(barShown()).toBe(true);
      expect(barLabel()).toBe(
        `5 new messages since ${formatMessageTimestamp(makeMessage(46).timestamp)}`,
      );
      expect(markReadButton()?.textContent).toBe("Mark as read");
    });

    it("uses the singular for one new message", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(1);
      mount();

      expect(barLabel()).toBe(
        `1 new message since ${formatMessageTimestamp(makeMessage(50).timestamp)}`,
      );
    });

    // With #2024 a capped count (ready reports 100 for 100 or more) puts the
    // divider at the top of the loaded page, which is not the first unread
    // message, so the bar gives no time.
    it("says 99+ new messages when the count is capped", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(100);
      mount();

      expect(barShown()).toBe(true);
      expect(barLabel()).toBe("99+ new messages");
    });

    it("shows no bar when the channel opened with nothing unread", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();

      expect(barShown()).toBe(false);
    });

    it("shows no bar while the window is detached", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(5);
      setDetached(true);
      mount();

      expect(barShown()).toBe(false);
    });

    it("Mark as read clears the badge, sends mark_read and hides the bar", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(5);
      mount();
      incrementUnread(CHANNEL_ID, true);

      markReadButton()!.click();

      expect(sendMarkRead).toHaveBeenCalledWith(CHANNEL_ID);
      expect(unreadCount()).toBe(0);
      expect(barShown()).toBe(false);
      // The divider stays for the rest of the visit.
      expect(container.querySelector('[data-testid="new-messages-divider"]')).not.toBeNull();
    });

    it("hides the bar once the reader reaches the bottom with the window focused", () => {
      setMessages(range(1, 50));
      openChannelWithUnread(5);
      mount();

      hasFocus.mockReturnValue(false);
      scrollToEnd();
      expect(barShown()).toBe(true);

      hasFocus.mockReturnValue(true);
      scrollUp();
      scrollToEnd();
      expect(barShown()).toBe(false);
    });

    /** The NEW divider and the first unread row below it are inside the viewport. */
    function expectDividerInView(dividerOffset: number): void {
      const top = root().scrollTop;
      expect(top).toBeLessThanOrEqual(dividerOffset);
      expect(top + CLIENT_HEIGHT).toBeGreaterThanOrEqual(dividerOffset + DIVIDER_PX + ROW_PX);
    }

    it("opens at the NEW divider instead of the bottom", async () => {
      setMessages(range(1, 50));
      openChannelWithUnread(5);
      mount();
      await nextFrame();

      // Day divider + 45 read rows above the NEW line.
      expectDividerInView(DIVIDER_PX + 45 * ROW_PX);
      const divider = container.querySelector('[data-testid="new-messages-divider"]');
      expect(divider).not.toBeNull();
      expect((divider!.nextElementSibling as HTMLElement).dataset.testid).toBe("message-46");
    });

    it("still opens at the bottom when nothing is unread", async () => {
      setMessages(range(1, 50));
      openChannelWithUnread(0);
      mount();
      await nextFrame();

      expect(root().scrollTop).toBeGreaterThanOrEqual(SCROLL_HEIGHT - CLIENT_HEIGHT - 100);
    });

    // DP-10/R2: a revisit renders the cached rows first and places the divider
    // when the refetched tail lands; the view moves to it then, since the
    // reader has not scrolled yet.
    it("moves to a deferred divider when the revisit's refetch lands", async () => {
      setMessages(range(1, 50));
      messagesStore.setState((prev) => ({
        ...prev,
        historyLoadState: new Map([[CHANNEL_ID, "loading" as const]]),
      }));
      openChannelWithUnread(10);
      mount();
      await nextFrame();

      messagesStore.setState((prev) => {
        const next = new Map(prev.messagesByChannel);
        next.set(CHANNEL_ID, range(1, 60));
        return { ...prev, messagesByChannel: next, historyLoadState: new Map() };
      });
      messagesStore.flush();
      await nextFrame();

      expectDividerInView(DIVIDER_PX + 50 * ROW_PX);
    });

    it("keeps following new messages at the bottom once the reader has scrolled down", async () => {
      setMessages(range(1, 50));
      openChannelWithUnread(5);
      mount();
      await nextFrame();
      scrollToEnd();

      setMessages(range(1, 51));

      expect(root().scrollTop).toBeGreaterThanOrEqual(SCROLL_HEIGHT - CLIENT_HEIGHT - 100);
    });
  });
});
