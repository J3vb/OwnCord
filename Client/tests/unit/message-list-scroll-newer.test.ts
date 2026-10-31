/**
 * Scrolling down inside a window detached from the live tail (after a jump to
 * an old message) pages toward the present: MessageList fires onScrollBottom
 * near the bottom, once at a time, and a page that lands below the reader
 * must not carry them to the new bottom. Reaching the newest message
 * reattaches the window (store reducer; pinned in messages-store-detached).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { isChannelAway } from "@lib/readState";
import {
  messagesStore,
  addMessage,
  setAroundMessages,
  appendNewerMessages,
  isWindowDetached,
  getChannelMessages,
} from "@stores/messages.store";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import type { MessageResponse } from "@lib/types";
import { resetMessagesState, resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";

const CHANNEL_ID = 1;
let scrollHeight = 100_000;
const NEAR_BOTTOM = 100_000 - 50;

function resetStores(): void {
  resetMessagesState();
  resetMembersState();
  setChannels([]);
  setActiveChannel(null);
}

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
    // 10 minutes apart: past the 7-minute group window, so rows never group.
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
  };
}

function window(from: number, to: number): MessageResponse[] {
  return Array.from({ length: to - from + 1 }, (_, i) => response(from + i));
}

function ids(): number[] {
  return getChannelMessages(CHANNEL_ID).map((m) => m.id);
}

describe("MessageList: paging down from a detached window", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let onScrollBottom: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
  let options: MessageListOptions;
  let scrollHeightDescriptor: PropertyDescriptor | undefined;
  let root: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    scrollHeight = 100_000;
    container = document.createElement("div");
    document.body.appendChild(container);
    onScrollBottom = vi.fn<() => void | Promise<void>>();
    options = {
      channelId: CHANNEL_ID,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onScrollBottom,
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onEditSave: vi.fn(() => true),
      onEmptyEdit: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
    // jsdom lays nothing out (every gap is 0, so "near the bottom" is always
    // true); stub a real scroll height so scrollTop decides.
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(): number {
        return scrollHeight;
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

  function mountDetached(): void {
    setAroundMessages(CHANNEL_ID, window(10, 59), true, true);
    expect(isWindowDetached(CHANNEL_ID)).toBe(true);
    msgList = createMessageList(options);
    msgList.mount(container);
    root = container.querySelector(".messages-container") as HTMLDivElement;
  }

  function scrollTo(top: number): void {
    root.scrollTop = top;
    root.dispatchEvent(new Event("scroll"));
  }

  it("loads the next newer page when the reader scrolls to the bottom of a detached window", () => {
    onScrollBottom.mockReturnValue(new Promise(() => {}));
    mountDetached();

    scrollTo(NEAR_BOTTOM);

    expect(onScrollBottom).toHaveBeenCalledTimes(1);
  });

  it("does not fire away from the bottom or in an attached window", () => {
    mountDetached();
    scrollTo(0);
    expect(onScrollBottom).not.toHaveBeenCalled();

    // Reattached: the bottom is the present, nothing newer to load.
    appendNewerMessages(CHANNEL_ID, [], false);
    scrollTo(NEAR_BOTTOM);
    expect(onScrollBottom).not.toHaveBeenCalled();
  });

  it("sends one fetch for repeated scrolling while one is in flight", async () => {
    let settle!: () => void;
    onScrollBottom.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    mountDetached();

    scrollTo(NEAR_BOTTOM);
    scrollTo(NEAR_BOTTOM + 10);
    scrollTo(NEAR_BOTTOM + 20);
    expect(onScrollBottom).toHaveBeenCalledTimes(1);

    // The page lands, the latch clears, and the next page may be requested.
    appendNewerMessages(CHANNEL_ID, window(60, 109), true);
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(onScrollBottom).toHaveBeenCalledTimes(1);
    scrollTo(NEAR_BOTTOM + 30);
    expect(onScrollBottom).toHaveBeenCalledTimes(2);
  });

  it("backs off after a fetch that landed nothing", async () => {
    onScrollBottom.mockResolvedValue(undefined);
    mountDetached();

    scrollTo(NEAR_BOTTOM);
    await Promise.resolve();
    await Promise.resolve();
    scrollTo(NEAR_BOTTOM + 5);

    expect(onScrollBottom).toHaveBeenCalledTimes(1);
  });

  it("keeps the reader in place when the page lands, and reattaches at the newest", async () => {
    onScrollBottom.mockImplementation(() => {
      appendNewerMessages(CHANNEL_ID, window(60, 79), false);
      messagesStore.flush();
      return Promise.resolve();
    });
    mountDetached();
    root.scrollTop = NEAR_BOTTOM;

    root.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    await Promise.resolve();

    expect(ids().at(-1)).toBe(79);
    expect(isWindowDetached(CHANNEL_ID)).toBe(false);
    // Not carried to the new bottom as a live arrival would be.
    expect(root.scrollTop).toBe(NEAR_BOTTOM);
  });

  /** A final page lands: the list grows below the reader and the window re-attaches. */
  function landFinalPage(): void {
    // Lands after the scroll handler has run, as a fetch response does.
    onScrollBottom.mockImplementation(() =>
      Promise.resolve().then(() => {
        scrollHeight = 200_000; // rows below the viewport now
        appendNewerMessages(CHANNEL_ID, window(60, 79), false);
        messagesStore.flush();
      }),
    );
  }

  it("recomputes live-tail visibility after the page lands, so a message below the viewport counts as unread", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    landFinalPage();
    mountDetached();

    scrollTo(NEAR_BOTTOM); // near the bottom: tail "in view"
    await vi.waitFor(() => expect(isWindowDetached(CHANNEL_ID)).toBe(false));
    expect(isChannelAway(CHANNEL_ID)).toBe(true);
    vi.restoreAllMocks();
  });

  it("counts a live message from someone else as a normal arrival once the final page landed", async () => {
    landFinalPage();
    mountDetached();
    scrollTo(NEAR_BOTTOM);
    await vi.waitFor(() => expect(isWindowDetached(CHANNEL_ID)).toBe(false));
    root.scrollTop = NEAR_BOTTOM; // the reader's spot (jsdom lays nothing out)

    addMessage({
      id: 200,
      channel_id: CHANNEL_ID,
      user: { id: 2, username: "bob", avatar: null },
      content: "live",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T12:00:00Z",
    } as Parameters<typeof addMessage>[0]);
    messagesStore.flush();

    const badge = container.querySelector('[data-testid="scroll-to-bottom-count"]')!;
    expect(badge.textContent).toBe("1");
  });
});
