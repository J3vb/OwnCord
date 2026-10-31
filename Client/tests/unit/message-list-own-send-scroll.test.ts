/**
 * WP 2B-9 (C20): the reader's own send always scrolls to the bottom, even from
 * a scrolled-up or detached window. Other people's messages keep the counter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore, isWindowDetached } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { buildMessage } from "../helpers/messageFactory";
import {
  makeListOptions,
  resetStoresAndChannels,
  setMessages,
} from "../helpers/messageListHarness";
import "../helpers/resizeObserverStub";

const CHANNEL_ID = 1;

function makeMessage(id: number, userId = 1): Message {
  return buildMessage(
    { id },
    {
      channelId: CHANNEL_ID,
      user: { id: userId, username: "Alice", avatar: null },
      // 10 minutes apart, on the same UTC day, and past GROUP_THRESHOLD_MS
      // (7 minutes) so shouldGroup never merges two of these rows — every
      // message renders at its full (ungrouped) height.
      timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    },
  );
}

describe("MessageList: own send scrolls to the bottom (C20)", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let scrollHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetStoresAndChannels();
    container = document.createElement("div");
    document.body.appendChild(container);
    // jsdom has no layout: give isNearBottom a real gap to measure.
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

  function mount(extra: Partial<MessageListOptions> = {}): HTMLDivElement {
    const options: MessageListOptions = makeListOptions({ channelId: CHANNEL_ID, ...extra });
    msgList = createMessageList(options);
    msgList.mount(container);
    return container.querySelector(".messages-container") as HTMLDivElement;
  }

  const atBottom = (root: HTMLElement): boolean => root.scrollHeight - root.scrollTop < 100;

  function setDetached(detached: boolean): void {
    messagesStore.setState((prev) => ({
      ...prev,
      detachedChannels: detached ? new Set([CHANNEL_ID]) : new Set(),
    }));
  }

  function pendingRow(
    userId = 1,
    status: Message["status"] = "pending",
    correlationId = "c1",
  ): Message {
    return {
      ...makeMessage(0),
      user: { id: userId, username: "Alice", avatar: null },
      status,
      correlationId,
    };
  }

  function sendWhileDetached(): { root: HTMLDivElement; around: Message[] } {
    const around = Array.from({ length: 20 }, (_, i) => makeMessage(10 + i));
    setMessages(CHANNEL_ID, around);
    setDetached(true);
    const root = mount();
    root.scrollTop = 5_000;
    root.dispatchEvent(new Event("scroll"));
    setMessages(CHANNEL_ID, [...around, pendingRow()]);
    messagesStore.flush();
    return { root, around };
  }

  const history = (): Message[] => Array.from({ length: 50 }, (_, i) => makeMessage(51 + i));

  it("scrolls up two screens, send, and lands at the bottom", () => {
    setMessages(CHANNEL_ID, history());
    const root = mount();
    root.scrollTop = 20_000;
    root.dispatchEvent(new Event("scroll"));
    expect(atBottom(root)).toBe(false);

    setMessages(CHANNEL_ID, [...history(), pendingRow()]);
    messagesStore.flush();

    expect(atBottom(root)).toBe(true);
  });

  it("stays scrolled up for someone else's pending-shaped or live row", () => {
    setMessages(CHANNEL_ID, history());
    const root = mount();
    root.scrollTop = 20_000;
    root.dispatchEvent(new Event("scroll"));

    setMessages(CHANNEL_ID, [...history(), makeMessage(101, 2)]);
    messagesStore.flush();

    expect(atBottom(root)).toBe(false);
  });

  it("detached send waits for the live tail, then lands at the bottom with the pending row", () => {
    const around = Array.from({ length: 20 }, (_, i) => makeMessage(10 + i));
    setMessages(CHANNEL_ID, around);
    setDetached(true);
    const root = mount();
    root.scrollTop = 5_000;
    root.dispatchEvent(new Event("scroll"));

    // performSend reattaches then appends the optimistic row to the old window.
    setMessages(CHANNEL_ID, [...around, pendingRow()]);
    messagesStore.flush();
    expect(isWindowDetached(CHANNEL_ID)).toBe(true);

    // The tail replaces the window and carries the pending row.
    setDetached(false);
    setMessages(CHANNEL_ID, [...history(), pendingRow()]);
    messagesStore.flush();

    expect(atBottom(root)).toBe(true);
    expect(container.querySelector(".message.pending")).not.toBeNull();
  });

  it("an incoming message right after a send keeps the view at the bottom without a counter", () => {
    setMessages(CHANNEL_ID, history());
    const root = mount();
    root.scrollTop = 20_000;
    root.dispatchEvent(new Event("scroll"));

    setMessages(CHANNEL_ID, [...history(), pendingRow()]);
    messagesStore.flush();
    setMessages(CHANNEL_ID, [...history(), makeMessage(101, 2), pendingRow()]);
    messagesStore.flush();

    expect(atBottom(root)).toBe(true);
    const count = container.querySelector(
      '[data-testid="scroll-to-bottom-count"]',
    ) as HTMLElement | null;
    expect(count === null || count.hidden).toBe(true);
  });

  it("a send lands at the bottom when the tail reload beats a newer page in flight", () => {
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(): number {
        return 800;
      },
    });
    try {
      const around = Array.from({ length: 20 }, (_, i) => makeMessage(10 + i));
      setMessages(CHANNEL_ID, around);
      setDetached(true);
      const onScrollBottom = vi.fn(() => new Promise<void>(() => {}));
      const root = mount({ onScrollBottom });
      // Inside the two-viewport zone but past the 100 px bottom threshold.
      root.scrollTop = 100_000 - 800 - 1_000;
      root.dispatchEvent(new Event("scroll"));
      expect(onScrollBottom).toHaveBeenCalledTimes(1);

      setMessages(CHANNEL_ID, [...around, pendingRow()]);
      messagesStore.flush();
      setDetached(false);
      setMessages(CHANNEL_ID, [...history(), pendingRow()]);
      messagesStore.flush();

      expect(atBottom(root)).toBe(true);
    } finally {
      if (clientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
      }
    }
  });

  it("a send that fails at once still lands at the bottom with its failed row", () => {
    setMessages(CHANNEL_ID, history());
    const root = mount();
    root.scrollTop = 20_000;
    root.dispatchEvent(new Event("scroll"));

    setMessages(CHANNEL_ID, [...history(), pendingRow(1, "failed")]);
    messagesStore.flush();

    expect(atBottom(root)).toBe(true);
  });

  it("a recovered draft does not pull the reader down", () => {
    setMessages(CHANNEL_ID, history());
    const root = mount();
    root.scrollTop = 20_000;
    root.dispatchEvent(new Event("scroll"));

    setMessages(CHANNEL_ID, [...history(), pendingRow(1, "failed", "recovered:m-1")]);
    messagesStore.flush();

    expect(atBottom(root)).toBe(false);
  });

  it("a send whose tail never lands stops pulling the reader down", () => {
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValue(1_000);
      const { root } = sendWhileDetached();
      now.mockReturnValue(1_000 + 60_000);
      setDetached(false);
      setMessages(CHANNEL_ID, history());
      messagesStore.flush();

      expect(atBottom(root)).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it("a reattach that changes no rows still lands a pending own send at the bottom", () => {
    const { root, around } = sendWhileDetached();
    expect(atBottom(root)).toBe(false);

    // The tail matched the cached rows, so only the detached flag changes.
    setDetached(false);
    messagesStore.flush();

    expect(atBottom(root)).toBe(true);
    expect(around.length).toBeGreaterThan(0);
  });
});
