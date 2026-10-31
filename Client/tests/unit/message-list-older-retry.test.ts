/**
 * C44: a failed older-history fetch shows an inline "Couldn't load messages"
 * row with Retry at the top of the list, driven by the store's per-channel
 * older-page-failed flag. A Retry click goes at once, past the 5 s cooldown
 * that paces automatic scroll retries.
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
import type { MessageListComponent, MessageListOptions } from "@components/MessageList";
import {
  messagesStore,
  hasOlderLoadFailed,
  setOlderLoadFailed,
  setMessages as storeSetMessages,
  prependMessages,
} from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { INITIAL_STATE } from "../../src/features/messaging/messageModel";
import { buildMessage } from "../helpers/messageFactory";

function makeMessage(id: number): Message {
  return buildMessage({ id });
}

function seed(): void {
  messagesStore.setState((prev) => ({
    ...prev,
    messagesByChannel: new Map([[1, [makeMessage(10)]]]),
    hasMore: new Map([[1, true]]),
  }));
  messagesStore.flush();
}

describe("older-history Retry row", () => {
  let container: HTMLDivElement;
  let list: MessageListComponent;

  function mountWith(onScrollTop: MessageListOptions["onScrollTop"]): HTMLDivElement {
    const options: MessageListOptions = {
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop,
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onEditSave: vi.fn(() => true),
      onEmptyEdit: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
    list = createMessageList(options);
    list.mount(container);
    return container.querySelector(".messages-container") as HTMLDivElement;
  }
  const row = (): HTMLElement | null =>
    container.querySelector<HTMLElement>("[data-testid='messages-older-failed']");
  const retry = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>("[data-testid='messages-older-retry']")!;

  beforeEach(() => {
    messagesStore.setState(() => INITIAL_STATE);
    container = document.createElement("div");
    document.body.appendChild(container);
    seed();
  });

  afterEach(() => {
    list.destroy?.();
    container.remove();
  });

  it("is hidden until the store flags a failure, then shows text and Retry", () => {
    mountWith(vi.fn());
    expect(row()?.hidden).toBe(true);

    setOlderLoadFailed(1, true);
    messagesStore.flush();

    expect(row()?.hidden).toBe(false);
    expect(row()?.textContent).toContain("Couldn't load messages");
    expect(retry().textContent).toBe("Retry");
  });

  it("ignores a failure flagged on another channel", () => {
    mountWith(vi.fn());
    setOlderLoadFailed(2, true);
    messagesStore.flush();
    expect(row()?.hidden).toBe(true);
  });

  it("Retry calls onScrollTop at once, even inside the automatic-retry cooldown", async () => {
    vi.useFakeTimers();
    try {
      const onScrollTop = vi.fn(() => Promise.resolve());
      const root = mountWith(onScrollTop);
      // An automatic load fires and fails: the 5 s cooldown starts.
      root.dispatchEvent(new Event("scroll"));
      expect(onScrollTop).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve();
      setOlderLoadFailed(1, true);
      messagesStore.flush();
      root.dispatchEvent(new Event("scroll"));
      expect(onScrollTop).toHaveBeenCalledTimes(1);

      retry().click();

      expect(onScrollTop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the row while a retry is in flight and shows it again if it fails", async () => {
    let settle: () => void = () => {};
    const onScrollTop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    mountWith(onScrollTop);
    setOlderLoadFailed(1, true);
    messagesStore.flush();

    retry().click();
    expect(row()?.hidden).toBe(true);

    // The failure leaves the flag set (the controller sets it again).
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(row()?.hidden).toBe(false);
  });

  it("moves focus to the scroller when Retry hides the row", () => {
    const root = mountWith(vi.fn(() => new Promise<void>(() => {})));
    setOlderLoadFailed(1, true);
    messagesStore.flush();
    retry().focus();

    retry().click();

    expect(document.activeElement).toBe(root);
  });

  it("hides the row when the flag clears", () => {
    mountWith(vi.fn());
    setOlderLoadFailed(1, true);
    messagesStore.flush();
    expect(row()?.hidden).toBe(false);

    setOlderLoadFailed(1, false);
    messagesStore.flush();
    expect(row()?.hidden).toBe(true);
  });
});

describe("older-page-failed flag in the store", () => {
  beforeEach(() => {
    messagesStore.setState(() => INITIAL_STATE);
  });

  it("is set, read and cleared per channel", () => {
    setOlderLoadFailed(1, true);
    expect(hasOlderLoadFailed(1)).toBe(true);
    expect(hasOlderLoadFailed(2)).toBe(false);
    setOlderLoadFailed(1, false);
    expect(hasOlderLoadFailed(1)).toBe(false);
  });

  it("clearing an unset flag leaves the state object untouched", () => {
    const before = messagesStore.getState();
    setOlderLoadFailed(1, false);
    expect(messagesStore.getState()).toBe(before);
  });

  it("a page that lands clears it", () => {
    storeSetMessages(1, [{ id: 10, channel_id: 1 } as never], true);
    setOlderLoadFailed(1, true);
    prependMessages(1, [{ id: 9, channel_id: 1 } as never], false);
    expect(hasOlderLoadFailed(1)).toBe(false);
  });

  it("replacing the window with a fresh first page clears it", () => {
    setOlderLoadFailed(1, true);
    storeSetMessages(1, [], false);
    expect(hasOlderLoadFailed(1)).toBe(false);
  });
});
