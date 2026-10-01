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

// An avatar change repaints through createAvatarElement, which fetches the
// picture bytes through the authenticated attachment path. Stub just that fetch
// so the swap can be observed; the URL resolution stays real.
const { fetchImageAsObjectUrlMock } = vi.hoisted(() => ({
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
});

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import type { Message } from "@stores/messages.store";
import { resetSafetyStore, safetyStore, setActiveTimeout } from "../../src/features/safety/store";
import { setConnectionStatus, uiStore } from "../../src/stores/ui.store";
import { expectConsole } from "../helpers/console";

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

function setHasMore(channelId: number, value: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.hasMore);
    next.set(channelId, value);
    return { ...prev, hasMore: next };
  });
}

function setHistoryLoadState(channelId: number, value: "loading" | "error"): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.historyLoadState);
    next.set(channelId, value);
    return { ...prev, historyLoadState: next };
  });
}

export type MessageListComponent = ReturnType<typeof createMessageList>;

describe("MessageList", () => {
  let container: HTMLDivElement;
  let msgList: MessageListComponent;
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
    msgList = createMessageList(options);
  });

  afterEach(() => {
    msgList.destroy?.();
    container.remove();
  });

  it("mounts with messages-container class", () => {
    msgList.mount(container);
    const root = container.querySelector(".messages-container");
    expect(root).not.toBeNull();
  });

  it("renders virtual scroll structure (spacers + content)", () => {
    msgList.mount(container);
    expect(container.querySelector(".virtual-spacer-top")).not.toBeNull();
    expect(container.querySelector(".virtual-content")).not.toBeNull();
    expect(container.querySelector(".virtual-spacer-bottom")).not.toBeNull();
  });

  it("renders messages from store", () => {
    const messages = [
      makeMessage({ id: 1, content: "Hello" }),
      makeMessage({ id: 2, content: "World" }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    const content = container.querySelector(".virtual-content");
    expect(content).not.toBeNull();
    // Should have rendered items (day divider + messages)
    expect(content!.children.length).toBeGreaterThan(0);
  });

  it("empty channel renders welcome state", () => {
    msgList.mount(container);
    const welcome = container.querySelector(".channel-welcome");
    expect(welcome).not.toBeNull();
    const title = container.querySelector(".channel-welcome-title");
    expect(title?.textContent).toBe("Welcome to #general!");
    const text = container.querySelector(".channel-welcome-text");
    expect(text?.textContent).toBe("This is the start of the #general channel.");
  });

  it("renders the in-region loading placeholder while history is loading", () => {
    setHistoryLoadState(1, "loading");
    msgList.mount(container);

    expect(container.querySelector(".messages-loading")).not.toBeNull();
    expect(container.querySelector(".channel-welcome")).toBeNull();
  });

  it("renders inline error with Retry on load failure, and Retry calls onRetryLoad", () => {
    const onRetryLoad = vi.fn();
    msgList.destroy?.();
    msgList = createMessageList({ ...options, onRetryLoad });
    setHistoryLoadState(1, "error");
    msgList.mount(container);

    expect(container.querySelector(".messages-load-error")).not.toBeNull();
    expect(container.querySelector(".channel-welcome")).toBeNull();
    const retry = container.querySelector("[data-testid='messages-retry']") as HTMLButtonElement;
    expect(retry).not.toBeNull();
    retry.click();
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it("transitions loading → welcome once the load state clears", () => {
    setHistoryLoadState(1, "loading");
    msgList.mount(container);
    expect(container.querySelector(".messages-loading")).not.toBeNull();

    messagesStore.setState((prev) => {
      const next = new Map(prev.historyLoadState);
      next.delete(1);
      return { ...prev, historyLoadState: next };
    });
    messagesStore.flush();

    expect(container.querySelector(".messages-loading")).toBeNull();
    expect(container.querySelector(".channel-welcome")).not.toBeNull();
  });

  it("destroy removes DOM and cleans up", () => {
    msgList.mount(container);
    expect(container.querySelector(".messages-container")).not.toBeNull();
    msgList.destroy?.();
    expect(container.querySelector(".messages-container")).toBeNull();
  });

  it("reacts to store updates", () => {
    msgList.mount(container);
    // Initially shows welcome state
    expect(container.querySelector(".channel-welcome")).not.toBeNull();

    // Add messages
    setMessages(1, [makeMessage({ id: 1, content: "New message" })]);
    messagesStore.flush();

    const content = container.querySelector(".virtual-content");
    expect(content!.children.length).toBeGreaterThan(0);
    // Welcome state should be gone once messages exist
    expect(container.querySelector(".channel-welcome")).toBeNull();
  });

  it("scrollToMessage returns true when message exists in virtual items", () => {
    const messages = [
      makeMessage({ id: 1, content: "Hello" }),
      makeMessage({ id: 2, content: "Target message" }),
      makeMessage({ id: 3, content: "World" }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    const result = msgList.scrollToMessage(2);
    expect(result).toBe(true);
  });

  it("scrollToMessage returns false when message not found", () => {
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const result = msgList.scrollToMessage(999);
    expect(result).toBe(false);
  });

  it("scrollToMessage flashes the target row so the eye can find it", () => {
    setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 }), makeMessage({ id: 3 })]);
    msgList.mount(container);

    msgList.scrollToMessage(2);

    // A scroll with no visual marker leaves the reader hunting; the row the
    // jump landed on must be the one that flashes.
    const flashed = container.querySelector(".highlight-flash");
    expect(flashed).not.toBeNull();
    expect(flashed!.getAttribute("data-testid")).toBe("message-2");
  });

  it("scrollToMessage renders a target that was outside the rendered window", () => {
    // A long channel: without forcing a rebuild the target stays unrendered
    // and there is nothing to scroll to or flash.
    const many = Array.from({ length: 200 }, (_, i) => makeMessage({ id: i + 1 }));
    setMessages(1, many);
    msgList.mount(container);

    expect(msgList.scrollToMessage(150)).toBe(true);
    expect(container.querySelector('[data-testid="message-150"]')).not.toBeNull();
  });

  it("OC-0217/OC-0286: repeated jumps do not each register a permanent row listener on the component-lifetime signal", () => {
    // As a user clicking a reply bar's jump arrow, a search hit, or a pinned
    // entry repeatedly does across a live session.
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage({ id: i + 1 }));
    setMessages(1, messages);
    msgList.mount(container);

    // Row listeners are registered as addEventListener(type, fn, { signal }).
    // Installed after mount() so it only observes what scrollToMessage does,
    // not mount's own (single, expected) registrations.
    const addEventListenerSpy = vi.spyOn(EventTarget.prototype, "addEventListener");

    /** Distinct AbortSignals handed to row listeners since the previous call. */
    function rowSignalsSinceLastRender(): AbortSignal[] {
      const signals = addEventListenerSpy.mock.calls
        .map((call) => call[2])
        .filter(
          (opts): opts is AddEventListenerOptions =>
            typeof opts === "object" && opts !== null && "signal" in opts,
        )
        .map((opts) => opts.signal)
        .filter((signal): signal is AbortSignal => signal != null);
      addEventListenerSpy.mockClear();
      return [...new Set(signals)];
    }

    const windowSignals: AbortSignal[][] = [];
    for (let i = 1; i <= 5; i++) {
      expect(msgList.scrollToMessage(i)).toBe(true);
      const signals = rowSignalsSinceLastRender();
      // Each rendered row has its own owner (P4-01), so a row patch can
      // release exactly the rows it replaces.
      if (signals.length === 0) throw new Error(`jump ${i} rendered no row listeners`);
      windowSignals.push(signals);
    }

    // Each jump renders against fresh signals, so nothing accumulates row
    // listeners on one long-lived signal.
    const all = windowSignals.flat();
    expect(new Set(all).size).toBe(all.length);

    // A superseded window is released by the render that replaced it, not
    // deferred to destroy(). Before OC-0286 rows registered directly against
    // the component-lifetime signal (`ac.signal`), so all five of these would
    // still be live here, each pinning a whole window of detached rows and
    // everything they reference — videos, images, embeds, tooltips.
    const superseded = windowSignals.slice(0, -1).flat();
    const current = windowSignals[windowSignals.length - 1]!;
    expect(superseded.every((signal) => signal.aborted)).toBe(true);
    expect(current.some((signal) => signal.aborted)).toBe(false);

    addEventListenerSpy.mockRestore();
  });

  it("rebuilds the virtual window when scrolling outside the rendered range", async () => {
    setHasMore(1, false);
    const many = Array.from({ length: 300 }, (_, i) => makeMessage({ id: i + 1 }));
    setMessages(1, many);
    msgList.mount(container);

    // renderAll positions the window at the tail; rows near the top are
    // virtualized away behind the top spacer.
    expect(container.querySelector('[data-testid="message-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-300"]')).not.toBeNull();

    // mount's trailing scrollToBottom leaves scrollTop at 0 in jsdom
    // (scrollHeight is 0 without layout), so the scroll position now sits at
    // the very top of the list while the rendered window is still the tail —
    // exactly the state a user scrolling far past the overscan produces.
    const root = container.querySelector(".messages-container") as HTMLDivElement;
    expect(root.scrollTop).toBe(0);
    root.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // The window must follow the scroll: rows at the top render, and the old
    // tail rows are released back to the spacers.
    expect(container.querySelector('[data-testid="message-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="message-300"]')).toBeNull();
  });

  it("renders day dividers between messages on different days", () => {
    const messages = [
      makeMessage({ id: 1, timestamp: "2024-01-15T12:00:00Z" }),
      makeMessage({ id: 2, timestamp: "2024-01-16T12:00:00Z" }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    // Virtual scroll in jsdom has no real layout (clientHeight=0),
    // so we verify content was rendered at all — the render window
    // may include all items since offsetToIndex returns 0-based for
    // zero-height containers. Check for msg-day-divider class.
    const content = container.querySelector(".virtual-content");
    expect(content).not.toBeNull();
    // The virtual scroll renders items based on estimated heights.
    // In jsdom with 0 clientHeight, renderWindow computes start=0, end=OVERSCAN+1.
    // With only 4 items (2 dividers + 2 messages), all should be in the window.
    const dividers = container.querySelectorAll(".msg-day-divider");
    expect(dividers.length).toBe(2);
  });

  it("day divider breaks grouping even for the same author posting across midnight", () => {
    // isSameDay compares local calendar days, so the boundary is built with
    // the local-time Date constructor (not UTC ISO literals) to stay
    // independent of the machine/CI runner's timezone.
    const beforeMidnight = new Date(2024, 0, 15, 23, 58, 0).toISOString();
    const afterMidnight = new Date(2024, 0, 16, 0, 1, 0).toISOString();
    const messages = [
      makeMessage({
        id: 1,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: beforeMidnight,
      }),
      makeMessage({
        id: 2,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: afterMidnight,
      }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    // 2 dividers: the leading one before the first message, plus one for the
    // day change (matches "renders day dividers between messages on
    // different days" above -- the assertion here is on grouping, not count).
    expect(container.querySelectorAll(".msg-day-divider").length).toBe(2);
    const row2 = container.querySelector("[data-testid='message-2']")!;
    expect(row2.classList.contains("grouped")).toBe(false);
  });

  it("renders DM channel empty state differently from text channels", () => {
    msgList.destroy?.();
    const dmOptions: MessageListOptions = {
      ...options,
      channelName: "Bob",
      channelType: "dm",
    };
    msgList = createMessageList(dmOptions);
    msgList.mount(container);

    const title = container.querySelector(".channel-welcome-title");
    expect(title?.textContent).toBe("Bob");

    const icon = container.querySelector(".channel-welcome-icon");
    expect(icon?.textContent).toBe("@");

    const text = container.querySelector(".channel-welcome-text");
    expect(text?.textContent).toBe(
      "This is the beginning of your direct message history with Bob.",
    );
  });

  it("includes a scroll-to-bottom button", () => {
    msgList.mount(container);
    const btn = container.querySelector(".scroll-to-bottom-btn");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("\u2193");
  });

  it("anchors the floating controls outside the scroller so they cannot scroll away", () => {
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const scroller = container.querySelector(".messages-container") as HTMLDivElement;
    const btn = container.querySelector(".scroll-to-bottom-btn") as HTMLButtonElement;
    const pill = container.querySelector('[data-testid="jump-to-present"]') as HTMLButtonElement;
    expect(scroller).not.toBeNull();
    expect(btn).not.toBeNull();
    expect(pill).not.toBeNull();

    // Anything inside the overflow scroller is part of its scrollable
    // overflow and translates with the content, so the controls must not be
    // descendants of it.
    expect(scroller.contains(btn)).toBe(false);
    expect(scroller.contains(pill)).toBe(false);

    // They anchor to the component's non-scrolling frame around the scroller
    // (the positioned containing block that keeps them pinned to the
    // viewport edge).
    const region = scroller.parentElement as HTMLDivElement;
    expect(region.classList.contains("messages-region")).toBe(true);
    expect(container.contains(region)).toBe(true);
    expect(btn.parentElement).toBe(region);
    expect(pill.parentElement).toBe(region);

    // destroy removes the frame — and with it the controls — not just the
    // scroller.
    msgList.destroy?.();
    expect(container.querySelector(".messages-region")).toBeNull();
    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
    expect(container.querySelector('[data-testid="jump-to-present"]')).toBeNull();
  });

  it("calls onScrollTop when scrolling near the top and there are more messages", () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    // jsdom scrollTop defaults to 0 which is already < SCROLL_TOP_THRESHOLD(50)
    // Manually trigger the scroll event
    root.dispatchEvent(new Event("scroll"));

    expect(options.onScrollTop).toHaveBeenCalledOnce();
  });

  it("does not call onScrollTop when no more messages are available", () => {
    setHasMore(1, false);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));

    expect(options.onScrollTop).not.toHaveBeenCalled();
  });

  it("does not call onScrollTop twice without new messages arriving", () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    root.dispatchEvent(new Event("scroll"));

    // loadingOlder guard prevents double-calling
    expect(options.onScrollTop).toHaveBeenCalledTimes(1);
  });

  it("resets loadingOlder flag when new messages arrive after scroll-top", () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    expect(options.onScrollTop).toHaveBeenCalledTimes(1);

    // Simulate new messages arriving (load-more response)
    setMessages(1, [makeMessage({ id: 0, content: "Older message" }), makeMessage({ id: 1 })]);
    messagesStore.flush();

    // Now scrolling to top again should trigger onScrollTop again
    root.dispatchEvent(new Event("scroll"));
    expect(options.onScrollTop).toHaveBeenCalledTimes(2);
  });

  it("clears loadingOlder once the onScrollTop promise settles, even when no new messages arrived (failed fetch)", async () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    // Flush this setup notification now — store notifications are deferred to
    // a microtask, and without this it would land during the first `await`
    // below and reset loadingOlder for an unrelated reason (prevMessageCount
    // syncing from its initial 0), masking the bug this test targets.
    messagesStore.flush();
    let resolveLoad: () => void = () => {};
    const onScrollTop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    // Recreate with the overriding onScrollTop — it's declared readonly, so
    // it must be set at construction rather than mutated on the shared
    // `options` object from beforeEach.
    msgList = createMessageList({ ...options, onScrollTop });
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    // A second scroll-to-top while the fetch is still in flight must not
    // re-trigger it.
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    // The fetch settles WITHOUT any new messages arriving — the failure path
    // (a real onScrollTop catches its own error and never rejects, so the
    // promise resolves either way; the store just never changed).
    resolveLoad();
    await Promise.resolve();
    await Promise.resolve();

    // loadingOlder must now be false. Scrolling on inside the trigger zone
    // waits out the retry cooldown, but leaving the zone (50px while jsdom's
    // clientHeight is 0) and coming back re-triggers it.
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);
    root.scrollTop = 100;
    root.dispatchEvent(new Event("scroll"));
    root.scrollTop = 0;
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(2);
  });

  it("DP-46: after a failed older-page fetch, scrolling inside the zone waits 5s before retrying", async () => {
    vi.useFakeTimers();
    try {
      setHasMore(1, true);
      setMessages(1, [makeMessage({ id: 1 })]);
      messagesStore.flush();
      const onScrollTop = vi.fn(() => Promise.resolve());
      msgList = createMessageList({ ...options, onScrollTop });
      msgList.mount(container);
      const root = container.querySelector(".messages-container") as HTMLDivElement;
      Object.defineProperty(root, "clientHeight", { configurable: true, value: 600 });

      root.scrollTop = 900;
      root.dispatchEvent(new Event("scroll"));
      expect(onScrollTop).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve();

      // The fetch failed (nothing prepended). The reader keeps scrolling up
      // through the zone: no request goes out within the cooldown.
      for (let top = 880; top >= 0; top -= 40) {
        root.scrollTop = top;
        root.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(16);
        await Promise.resolve();
      }
      vi.advanceTimersByTime(4000);
      root.dispatchEvent(new Event("scroll"));
      expect(onScrollTop).toHaveBeenCalledTimes(1);

      // Past 5s, the next scroll in the zone retries.
      vi.advanceTimersByTime(1000);
      root.dispatchEvent(new Event("scroll"));
      expect(onScrollTop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-trigger onScrollTop from a live tail append while a history fetch is in flight", async () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    messagesStore.flush();

    let resolveLoad: () => void = () => {};
    const onScrollTop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    msgList = createMessageList({ ...options, onScrollTop });
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    // A live message arrives at the tail while the older-page fetch is still
    // in flight. messages[0] (the oldest loaded message) is unchanged, so the
    // latch must stay set -- otherwise the next scroll refires the fetch with
    // the same unchanged cursor and the same page lands twice.
    setMessages(1, [
      ...(messagesStore.getState().messagesByChannel.get(1) ?? []),
      makeMessage({ id: 2 }),
    ]);
    messagesStore.flush();

    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);

    resolveLoad();
    await Promise.resolve();
  });

  it("DP-46: starts loading older history about 1.5 viewports before the top, once", () => {
    setHasMore(1, true);
    setMessages(
      1,
      Array.from({ length: 300 }, (_, i) => makeMessage({ id: i + 1 })),
    );
    msgList.mount(container);

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 600 });

    // Three viewports down is still far enough from the top.
    root.scrollTop = 1800;
    root.dispatchEvent(new Event("scroll"));
    expect(options.onScrollTop).not.toHaveBeenCalled();

    // About 1.5 viewports from the top: the older page must already be on its
    // way, long before the reader hits the top edge.
    root.scrollTop = 900;
    root.dispatchEvent(new Event("scroll"));
    root.dispatchEvent(new Event("scroll"));
    expect(options.onScrollTop).toHaveBeenCalledOnce();
  });

  it("DP-46: shows a loading row at the top while the older page is pending, on success and failure", async () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 10 })]);
    messagesStore.flush();
    let resolveLoad: () => void = () => {};
    const onScrollTop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    msgList = createMessageList({ ...options, onScrollTop });
    msgList.mount(container);
    const root = container.querySelector(".messages-container") as HTMLDivElement;
    const loadingRow = (): Element | null => container.querySelector(".messages-older-loading");
    expect(loadingRow()).toBeNull();

    // Success: the page lands, then the fetch settles.
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(1);
    expect(loadingRow()).not.toBeNull();
    setMessages(1, [makeMessage({ id: 9 }), makeMessage({ id: 10 })]);
    messagesStore.flush();
    resolveLoad();
    await Promise.resolve();
    await Promise.resolve();
    expect(loadingRow()).toBeNull();

    // Failure: the fetch settles without any new page (a real onScrollTop
    // catches its own error). The row clears and nothing refires on its own.
    root.dispatchEvent(new Event("scroll"));
    expect(onScrollTop).toHaveBeenCalledTimes(2);
    expect(loadingRow()).not.toBeNull();
    resolveLoad();
    await Promise.resolve();
    await Promise.resolve();
    expect(loadingRow()).toBeNull();
    expect(onScrollTop).toHaveBeenCalledTimes(2);
  });

  it("scrollToMessage returns false before mount", () => {
    // scrollToMessage should be safe to call before mount
    const unmounted = createMessageList(options);
    expect(unmounted.scrollToMessage(1)).toBe(false);
    unmounted.destroy?.();
  });

  it("groups consecutive messages from the same user within threshold", () => {
    // Two messages from same user within 5 minutes
    const messages = [
      makeMessage({
        id: 1,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: "2024-01-15T12:00:00Z",
        content: "First message",
      }),
      makeMessage({
        id: 2,
        user: { id: 1, username: "Alice", avatar: null },
        timestamp: "2024-01-15T12:01:00Z",
        content: "Second message",
      }),
    ];
    setMessages(1, messages);
    msgList.mount(container);

    const content = container.querySelector(".virtual-content");
    expect(content).not.toBeNull();
    // Both messages should render; the second should be grouped (class "message grouped")
    const grouped = content!.querySelectorAll(".message.grouped");
    expect(grouped.length).toBeGreaterThanOrEqual(1);
  });

  it("destroys cleanly without errors even with loaded messages", () => {
    setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
    msgList.mount(container);
    expect(container.querySelector(".messages-container")).not.toBeNull();

    // destroy should not throw
    expect(() => msgList.destroy?.()).not.toThrow();
    expect(container.querySelector(".messages-container")).toBeNull();
  });

  it("disables every reaction control inline while timed out, and re-enables on lift (B9-15)", () => {
    setMessages(1, [makeMessage({ id: 1, reactions: [{ emoji: "🔥", count: 2, me: false }] })]);
    msgList.mount(container);
    const controls = (): HTMLElement[] => [
      ...container.querySelectorAll<HTMLElement>(
        "[data-testid='message-1'] .reaction-chip, [data-testid='msg-react-1']",
      ),
    ];
    expect(controls()).toHaveLength(3);

    setActiveTimeout(new Date(Date.now() + 60_000).toISOString());
    safetyStore.flush();
    for (const el of controls()) {
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.title).toMatch(/^You can't add reactions until /);
      el.click();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    expect(options.onReactionClick).not.toHaveBeenCalled();

    setActiveTimeout(null);
    safetyStore.flush();
    for (const el of controls()) expect(el.hasAttribute("aria-disabled")).toBe(false);
    controls()[0]!.click();
    expect(options.onReactionClick).toHaveBeenCalledWith(1, "🔥");
    resetSafetyStore();
  });

  it("disables delete while the socket is down and re-enables it on reconnect (CLI-08)", () => {
    setConnectionStatus("connected");
    uiStore.flush();
    setMessages(1, [makeMessage({ id: 1 })]);
    msgList.mount(container);
    const deleteBtn = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>("[data-testid='msg-delete-1']")!;
    expect(deleteBtn().disabled).toBe(false);

    setConnectionStatus("disconnected");
    uiStore.flush();
    expect(deleteBtn().disabled).toBe(true);
    expect(deleteBtn().getAttribute("aria-disabled")).toBe("true");

    setConnectionStatus("connected");
    uiStore.flush();
    deleteBtn().click();
    expect(options.onDeleteClick).toHaveBeenCalledWith(1, false);
  });

  it("does not re-render when a DIFFERENT channel's messages update", () => {
    setMessages(1, [makeMessage({ id: 1, content: "Mine" })]);
    msgList.mount(container);

    const rowBefore = container.querySelector("[data-testid='message-1']");
    expect(rowBefore).not.toBeNull();

    // Update another channel — this list (channel 1) must not rebuild.
    setMessages(2, [makeMessage({ id: 50, channelId: 2, content: "Other channel" })]);
    messagesStore.flush();

    const rowAfter = container.querySelector("[data-testid='message-1']");
    expect(rowAfter).toBe(rowBefore); // same element instance — no re-render
  });

  describe("incremental tail append", () => {
    it("appends new rows without rebuilding existing ones", () => {
      setMessages(1, [
        makeMessage({ id: 1, content: "First" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      msgList.mount(container);

      const row1Before = container.querySelector("[data-testid='message-1']");
      const row2Before = container.querySelector("[data-testid='message-2']");
      expect(row1Before).not.toBeNull();
      expect(row2Before).not.toBeNull();

      // Pure suffix extension → fast path: existing rows keep their identity.
      setMessages(1, [
        ...(messagesStore.getState().messagesByChannel.get(1) ?? []),
        makeMessage({ id: 3, content: "Third", timestamp: "2024-01-15T12:02:00Z" }),
      ]);
      messagesStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1Before);
      expect(container.querySelector("[data-testid='message-2']")).toBe(row2Before);
      expect(container.querySelector("[data-testid='message-3']")).not.toBeNull();
    });

    it("appended rows preserve order, grouping, and day dividers vs a full rebuild", () => {
      const initial = [
        makeMessage({ id: 1, content: "First", timestamp: "2024-01-15T12:00:00Z" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ];
      setMessages(1, initial);
      msgList.mount(container);

      const appended = [
        // Same user within threshold → must render grouped.
        makeMessage({ id: 3, content: "Third", timestamp: "2024-01-15T12:02:00Z" }),
        // Next day, different user → must be preceded by a day divider.
        makeMessage({
          id: 4,
          content: "Fourth",
          user: { id: 2, username: "Bob", avatar: null },
          timestamp: "2024-01-16T09:00:00Z",
        }),
      ];
      const finalMessages = [...initial, ...appended];
      setMessages(1, finalMessages);
      messagesStore.flush();

      const content = container.querySelector(".virtual-content")!;

      // Reference render: a fresh list mounted with the final message set
      // (full rebuild path) must produce the same structure.
      const refContainer = document.createElement("div");
      document.body.appendChild(refContainer);
      const refList = createMessageList(options);
      refList.mount(refContainer);
      const refContent = refContainer.querySelector(".virtual-content")!;

      const describeChildren = (el: Element): string[] =>
        Array.from(el.children).map((c) => `${c.className}|${c.getAttribute("data-testid") ?? ""}`);
      expect(describeChildren(content)).toEqual(describeChildren(refContent));

      // Explicit semantic checks on the appended tail.
      expect(container.querySelectorAll(".msg-day-divider").length).toBe(2);
      const row3 = container.querySelector("[data-testid='message-3']")!;
      expect(row3.classList.contains("grouped")).toBe(true);
      const row4 = container.querySelector("[data-testid='message-4']")!;
      expect(row4.classList.contains("grouped")).toBe(false);
      const ids = Array.from(content.querySelectorAll("[data-testid^='message-']")).map((el) =>
        el.getAttribute("data-testid"),
      );
      expect(ids).toEqual(["message-1", "message-2", "message-3", "message-4"]);

      refList.destroy?.();
      refContainer.remove();
    });

    it("falls back to a full rebuild for non-append updates (edit)", () => {
      setMessages(1, [
        makeMessage({ id: 1, content: "Original" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      msgList.mount(container);

      // Replace message 1's object (an edit) — not a suffix extension.
      setMessages(1, [
        makeMessage({ id: 1, content: "Edited" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      messagesStore.flush();

      const row1 = container.querySelector("[data-testid='message-1']");
      expect(row1).not.toBeNull();
      expect(row1!.textContent).toContain("Edited");
    });
  });

  // P4-01: an update that touches a few rows re-renders only those rows (and a
  // neighbour whose grouping changed); every other row keeps its DOM node, so
  // a playing video, a revealed spoiler, a selection or focus elsewhere survive.
  describe("row-level patch", () => {
    /** One minute apart and alternating authors, so no two rows group. */
    function ungrouped(id: number): Message {
      return makeMessage({
        id,
        user: { id: (id % 2) + 1, username: id % 2 === 0 ? "Alice" : "Bob", avatar: null },
        timestamp: new Date(Date.UTC(2024, 0, 15, 12, id)).toISOString(),
      });
    }
    const row = (id: number): Element | null =>
      container.querySelector(`[data-testid='message-${id}']`);
    const current = (): readonly Message[] => messagesStore.getState().messagesByChannel.get(1)!;
    function replace(id: number, patch: Partial<Message>): void {
      setMessages(
        1,
        current().map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
      messagesStore.flush();
    }

    it("re-renders only the row a reaction changed and leaves focus where it was", () => {
      setMessages(
        1,
        Array.from({ length: 40 }, (_, i) => ungrouped(i + 1)),
      );
      msgList.mount(container);
      // jsdom mounts at the tail; bring the oldest rows into the window.
      expect(msgList.scrollToMessage(2)).toBe(true);
      const row2 = row(2);
      const row5 = row(5);
      const row10 = row(10);
      expect(row2).not.toBeNull();
      expect(row5).not.toBeNull();
      expect(row10).not.toBeNull();
      const reply10 = container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-10']")!;
      reply10.focus();

      replace(5, { reactions: [{ emoji: "👍", count: 1, me: false }] });

      expect(row(2)).toBe(row2);
      expect(row(10)).toBe(row10);
      expect(row(5)).not.toBe(row5);
      expect(row(5)!.querySelector(".reaction-chip")).not.toBeNull();
      expect(document.activeElement).toBe(reply10);
    });

    it("re-renders an edited row in place", () => {
      setMessages(1, [1, 2, 3].map(ungrouped));
      msgList.mount(container);
      const [row1, row2, row3] = [row(1), row(2), row(3)];

      replace(2, { content: "Edited", editedAt: "2024-01-15T12:10:00Z" });

      expect(row(1)).toBe(row1);
      expect(row(3)).toBe(row3);
      expect(row(2)).not.toBe(row2);
      expect(row(2)!.textContent).toContain("Edited");
      const ids = [...container.querySelectorAll("[data-testid^='message-']")].map(
        (el) => (el as HTMLElement).dataset.testid,
      );
      expect(ids).toEqual(["message-1", "message-2", "message-3"]);
    });

    it("re-renders the next row when a delete ends its grouping, and nothing further", () => {
      // Same author a minute apart: every row after the first is grouped.
      setMessages(
        1,
        [1, 2, 3, 4].map((id) =>
          makeMessage({ id, timestamp: new Date(Date.UTC(2024, 0, 15, 12, id)).toISOString() }),
        ),
      );
      msgList.mount(container);
      const [row1, row3, row4] = [row(1), row(3), row(4)];
      expect(row3!.classList.contains("grouped")).toBe(true);

      replace(2, { deleted: true });

      expect(row(1)).toBe(row1);
      expect(row(4)).toBe(row4);
      // A deleted row never groups, so the row under it now shows its author.
      expect(row(3)).not.toBe(row3);
      expect(row(3)!.classList.contains("grouped")).toBe(false);
    });

    it("swaps a confirmed send in for its optimistic row without touching the others", () => {
      const optimistic = makeMessage({
        id: 0,
        correlationId: "c-1",
        status: "pending",
        content: "sending",
        timestamp: "2024-01-15T12:30:00Z",
      });
      setMessages(1, [1, 2, 3].map(ungrouped).concat(optimistic));
      msgList.mount(container);
      const [row1, row2, row3] = [row(1), row(2), row(3)];
      expect(row(0)).not.toBeNull();

      setMessages(
        1,
        current().map((m) => (m === optimistic ? { ...m, id: 4, status: "sent" as const } : m)),
      );
      messagesStore.flush();

      expect(row(1)).toBe(row1);
      expect(row(2)).toBe(row2);
      expect(row(3)).toBe(row3);
      expect(row(0)).toBeNull();
      expect(row(4)).not.toBeNull();
    });

    it("re-renders a loaded reply whose parent was edited", () => {
      setMessages(1, [ungrouped(1), ungrouped(2), { ...ungrouped(3), replyTo: 1 }]);
      msgList.mount(container);
      const [row2, row3] = [row(2), row(3)];

      replace(1, { content: "Parent edited" });

      expect(row(2)).toBe(row2);
      expect(row(3)).not.toBe(row3);
      expect(row(3)!.querySelector(".msg-reply-ref")!.textContent).toContain("Parent edited");
    });

    it("keeps a loaded reply's row when its parent only gains a reaction", () => {
      setMessages(1, [ungrouped(1), ungrouped(2), { ...ungrouped(3), replyTo: 1 }]);
      msgList.mount(container);
      const [row1, row3] = [row(1), row(3)];

      replace(1, { reactions: [{ emoji: "👍", count: 1, me: false }] });

      expect(row(1)).not.toBe(row1);
      expect(row(3)).toBe(row3);
    });

    it("re-renders a loaded reply whose parent arrives", () => {
      setMessages(1, [ungrouped(1), ungrouped(4), { ...ungrouped(5), replyTo: 2 }]);
      msgList.mount(container);
      const [row1, row5] = [row(1), row(5)];
      expect(row5!.querySelector(".msg-reply-ref")!.textContent).not.toContain("Message 2");

      // The parent lands above the reply's neighbour, so the reply's own
      // grouping is unchanged: only its quote is stale.
      const [first, ...rest] = current();
      setMessages(1, [first!, ungrouped(2), ...rest]);
      messagesStore.flush();

      expect(row(1)).toBe(row1);
      expect(row(5)).not.toBe(row5);
      expect(row(5)!.querySelector(".msg-reply-ref")!.textContent).toContain("Message 2");
    });

    // R1: a revisit's page drops the oldest rows and adds the ones posted while away.
    it("drops head rows and appends tail rows without rebuilding the rows that stay", () => {
      const all = Array.from({ length: 63 }, (_, i) => ungrouped(i + 1));
      setMessages(1, all.slice(0, 60));
      msgList.mount(container);
      const kept = [45, 50, 60].map((id) => [id, row(id)] as const);
      for (const [, el] of kept) expect(el).not.toBeNull();

      setMessages(1, all.slice(10, 63));
      messagesStore.flush();

      for (const [id, el] of kept) expect(row(id)).toBe(el);
      expect(row(63)).not.toBeNull();
      expect(row(5)).toBeNull();
    });
  });

  // DP-10: revisiting a channel shows its cached rows while the tail is
  // refetched; the fetch finishing must not rebuild them.
  describe("channel revisit", () => {
    it("does not rebuild shown rows when the history fetch goes from loading to idle", () => {
      setMessages(1, [
        makeMessage({ id: 1, content: "First" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      setHistoryLoadState(1, "loading");
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      expect(row1).not.toBeNull();

      messagesStore.setState((prev) => ({ ...prev, historyLoadState: new Map() }));
      messagesStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
    });

    it("still swaps the loading placeholder when no rows are shown", () => {
      setHistoryLoadState(1, "loading");
      msgList.mount(container);
      expect(container.querySelector(".messages-loading")).not.toBeNull();

      setHistoryLoadState(1, "error");
      messagesStore.flush();

      expect(container.querySelector(".messages-loading")).toBeNull();
    });
  });

  // P4-02: an append at the 500-row cap, a connection flip, a timeout change
  // and a role change must not rebuild the rendered rows. The cap append goes
  // through P4-01's row patch; the three flips are targeted updates.
  describe("P4-02 targeted updates", () => {
    const current = (): readonly Message[] => messagesStore.getState().messagesByChannel.get(1)!;

    it("appends at the 500-row cap without rebuilding the rows that stay", () => {
      const full = Array.from({ length: 500 }, (_, i) =>
        makeMessage({
          id: i + 1,
          timestamp: new Date(Date.UTC(2024, 0, 15, 0, 0, i)).toISOString(),
        }),
      );
      setMessages(1, full);
      msgList.mount(container);

      const row498 = container.querySelector("[data-testid='message-498']");
      const row500 = container.querySelector("[data-testid='message-500']");
      expect(row498).not.toBeNull();
      expect(row500).not.toBeNull();

      // The live reducer trims the head to stay at the cap; the array length is
      // unchanged, which used to defeat the append path and force renderAll.
      messagesStore.setState((prev) => {
        const next = [...current(), makeMessage({ id: 501, timestamp: "2024-01-15T01:00:00Z" })];
        const trimmed = next.slice(next.length - 500);
        const m = new Map(prev.messagesByChannel);
        m.set(1, trimmed);
        return { ...prev, messagesByChannel: m };
      });
      messagesStore.flush();

      expect(container.querySelector("[data-testid='message-498']")).toBe(row498);
      expect(container.querySelector("[data-testid='message-500']")).toBe(row500);
      expect(container.querySelector("[data-testid='message-501']")).not.toBeNull();
    });

    it("keeps row identity through a connection flip and still gates delete (CLI-08)", () => {
      setConnectionStatus("connected");
      uiStore.flush();
      setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const deleteBtn = (): HTMLButtonElement =>
        container.querySelector<HTMLButtonElement>("[data-testid='msg-delete-1']")!;
      expect(deleteBtn().disabled).toBe(false);

      setConnectionStatus("disconnected");
      uiStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(deleteBtn().disabled).toBe(true);
      expect(deleteBtn().getAttribute("aria-disabled")).toBe("true");

      setConnectionStatus("connected");
      uiStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      deleteBtn().click();
      expect(options.onDeleteClick).toHaveBeenCalledWith(1, false);
    });

    it("disables reaction controls while timed out without rebuilding rows (B9-15)", () => {
      setMessages(1, [makeMessage({ id: 1, reactions: [{ emoji: "🔥", count: 2, me: false }] })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const chip = (): HTMLElement =>
        container.querySelector<HTMLElement>("[data-testid='message-1'] .reaction-chip")!;
      expect(chip().getAttribute("aria-disabled")).not.toBe("true");

      setActiveTimeout(new Date(Date.now() + 60_000).toISOString());
      safetyStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(chip().getAttribute("aria-disabled")).toBe("true");
      chip().click();
      expect(options.onReactionClick).not.toHaveBeenCalled();

      setActiveTimeout(null);
      safetyStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(chip().hasAttribute("aria-disabled")).toBe(false);
      chip().click();
      expect(options.onReactionClick).toHaveBeenCalledWith(1, "🔥");
      resetSafetyStore();
    });

    it("repaints author identity on a roleRevision bump without rebuilding rows", () => {
      membersStore.setState(() => ({
        members: new Map([
          [
            1,
            { id: 1, username: "Alice", avatar: null, role: "member", status: "online" as const },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const authorSpan = (): HTMLElement =>
        container.querySelector<HTMLElement>("[data-testid='message-1'] .msg-author")!;
      expect(authorSpan().dataset["roleColor"]).toBe("var(--role-member)");
      expect(authorSpan().textContent).toBe("Alice");

      // A role change bumps roleRevision; a rename bumps it too (OC-0108).
      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(1, { ...next.get(1)!, role: "admin", username: "Alicia" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(authorSpan().dataset["roleColor"]).toBe("var(--role-admin)");
      expect(authorSpan().textContent).toBe("Alicia");
    });

    it("re-resolves @mention highlighting on every rendered row on a rename (F3)", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 99, username: "me", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));
      membersStore.setState(() => ({
        members: new Map([
          [
            10,
            {
              id: 10,
              username: "alice",
              avatar: null,
              role: "member",
              status: "online" as const,
            },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      // Row 1 is authored by alice; row 2 mentions alice but is authored by Bob,
      // so the pill lives on a row that member did not author.
      setMessages(1, [
        makeMessage({ id: 1, user: { id: 10, username: "alice", avatar: null } }),
        makeMessage({
          id: 2,
          user: { id: 2, username: "Bob", avatar: null },
          content: "hey @alice",
        }),
      ]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const row2 = container.querySelector("[data-testid='message-2']");
      expect(container.querySelector("[data-testid='message-2'] .mention")?.textContent).toBe(
        "@alice",
      );

      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(10, { ...next.get(10)!, username: "alicia" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(container.querySelector("[data-testid='message-2']")).toBe(row2);
      expect(container.querySelector("[data-testid='message-2'] .mention")).toBeNull();
      expect(row2!.querySelector(".msg-text")!.textContent).toBe("hey @alice");
    });

    it("wraps every newly-resolving @token across sibling prose nodes on a member join (F3)", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 99, username: "me", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));
      membersStore.setState(() => ({
        members: new Map([
          [2, { id: 2, username: "Bob", avatar: null, role: "member", status: "online" as const }],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      setMessages(1, [
        makeMessage({
          id: 1,
          user: { id: 2, username: "Bob", avatar: null },
          content: "check @alice and **@carol** and [@dave](https://example.com)",
        }),
      ]);
      msgList.mount(container);
      const row = container.querySelector("[data-testid='message-1']")!;
      expect(row.querySelectorAll(".mention").length).toBe(0);

      // alice, carol and dave all become resolvable at once via a join.
      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(10, {
          id: 10,
          username: "alice",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        next.set(11, {
          id: 11,
          username: "carol",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        next.set(12, {
          id: 12,
          username: "dave",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      const text = row.querySelector(".msg-text")!;
      const mentions = [...text.querySelectorAll(".mention")].map((m) => m.textContent);
      expect(mentions).toContain("@alice");
      expect(mentions).toContain("@carol");
      expect(mentions).toContain("@dave");
      expect(text.querySelector("a.msg-link .mention")?.textContent).toBe("@dave");
      // The prose keeps its full text; only the tokens became pills.
      expect(text.textContent).toBe("check @alice and @carol and @dave");
    });

    it("repaints a reply's quoted author on a rename without rebuilding either row", () => {
      membersStore.setState(() => ({
        members: new Map([
          [
            1,
            { id: 1, username: "Alice", avatar: null, role: "member", status: "online" as const },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      // Row 2 replies to row 1; row 2's own author (id 2) never changes.
      setMessages(1, [
        makeMessage({ id: 1 }),
        makeMessage({
          id: 2,
          user: { id: 2, username: "Bob", avatar: null },
          replyTo: 1,
        }),
      ]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const row2 = container.querySelector("[data-testid='message-2']");
      const rrAuthor = (): HTMLElement =>
        container.querySelector<HTMLElement>("[data-testid='message-2'] .rr-author")!;
      expect(rrAuthor().textContent).toBe("Alice");

      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(1, { ...next.get(1)!, username: "Alicia" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(container.querySelector("[data-testid='message-2']")).toBe(row2);
      expect(rrAuthor().textContent).toBe("Alicia");
    });

    it("refetches an author's avatar on an avatar-only profile change (OC-0108)", async () => {
      membersStore.setState(() => ({
        members: new Map([
          [
            1,
            {
              id: 1,
              username: "Alice",
              avatar: "/api/v1/files/old",
              role: "member",
              status: "online" as const,
            },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      fetchImageAsObjectUrlMock.mockClear();
      setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      // The initial row's own avatar fetch, then the change below.
      await vi.waitFor(() => {
        expect(fetchImageAsObjectUrlMock).toHaveBeenCalledWith("/api/v1/files/old");
      });
      fetchImageAsObjectUrlMock.mockClear();

      // Only the avatar changes; username and role stay put. The author key
      // includes the avatar URL, so the row must rebuild and refetch, not just
      // repaint the letter fallback.
      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(1, { ...next.get(1)!, avatar: "/api/v1/files/new" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      const rowAvatar = row1!.querySelector<HTMLElement>(".msg-avatar")!;
      await vi.waitFor(() => {
        expect(rowAvatar.querySelector<HTMLImageElement>(".avatar-img")?.getAttribute("src")).toBe(
          "data:image/png;base64,AAAA",
        );
      });
      expect(fetchImageAsObjectUrlMock).toHaveBeenCalledWith("/api/v1/files/new");
    });
  });

  describe("renderAll rapid-fire breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders the final state once the 2s burst window resets, instead of staying stuck at the pre-trip state", () => {
      const others = Array.from({ length: 25 }, (_, i) => makeMessage({ id: i + 2 }));
      setMessages(1, [makeMessage({ id: 1, content: "v0" }), ...others]);
      msgList.mount(container); // 1st renderAll call, starts the 2s window

      // Fire 25 updates back-to-back, well inside the 2s window, each editing
      // message 1 and moving it one row further down. Every update is then a
      // reorder against any earlier state, the last one rendered before the
      // breaker trips included, and the row patch leaves a reorder to
      // renderAll. Combined with the mount's call, this is 26 renderAll
      // invocations — calls 21+ trip the >20-in-2s breaker and must return
      // without rendering.
      for (let i = 1; i <= 25; i++) {
        setMessages(1, others.toSpliced(i, 0, makeMessage({ id: 1, content: `v${i}` })));
        messagesStore.flush();
      }
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);

      const rowDuringBurst = container.querySelector("[data-testid='message-1']");
      expect(rowDuringBurst).not.toBeNull();
      // The breaker tripped partway through, so the DOM is stuck behind the
      // final store state (still showing an earlier version, not "v25").
      expect(rowDuringBurst!.textContent).not.toContain("v25");

      // Let the 2s reset window elapse with no further store updates.
      vi.advanceTimersByTime(2100);

      // Once the burst is over, the list must reflect the final state that
      // triggered the last suppressed renderAll — not stay frozen on
      // whatever rendered right before the breaker tripped.
      const rowAfterReset = container.querySelector("[data-testid='message-1']");
      expect(rowAfterReset).not.toBeNull();
      expect(rowAfterReset!.textContent).toContain("v25");
    });
  });

  describe("renderWindow rebuild breaker replay (DP-12)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it(
      "renders the rows for the final scrollTop once the 2s burst resets",
      { timeout: 20_000 },
      () => {
        setHasMore(1, false);
        setMessages(
          1,
          Array.from({ length: 300 }, (_, i) => makeMessage({ id: i + 1 })),
        );
        msgList.mount(container); // rebuild 1
        const root = container.querySelector(".messages-container") as HTMLDivElement;

        // A fast scrollbar drag: every frame lands somewhere the window has not
        // rendered, so each one is a range-changing rebuild. 34 of them inside
        // 2s trip the >30 breaker.
        for (let i = 0; i < 34; i++) {
          root.scrollTop = i % 2 === 0 ? 0 : 6000;
          root.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(16);
        }
        // The drag stops mid-channel (message 134 sits at about 3000px).
        root.scrollTop = 3000;
        root.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(16);
        expectConsole("error", /\[MessageList\] renderWindow REBUILD called >30 times in 2s/);
        expect(container.querySelector('[data-testid="message-134"]')).toBeNull();

        // Idle past the reset: the deferred replay renders where the reader stopped.
        vi.advanceTimersByTime(2100);
        expect(container.querySelector('[data-testid="message-134"]')).not.toBeNull();
      },
    );
  });

  describe("midnight rollover", () => {
    it("relabels 'Today at' to 'Yesterday at' at midnight without a channel switch", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
        const msg = makeMessage({ id: 1, timestamp: new Date().toISOString() });
        setMessages(1, [msg]);
        msgList.mount(container);

        const row = container.querySelector('[data-testid="message-1"]');
        expect(container.querySelector(".msg-time")!.textContent).toMatch(/^Today at /);

        // Cross local midnight (00:00 on the 16th) on the same channel.
        vi.advanceTimersByTime(13 * 60 * 60 * 1000);

        expect(container.querySelector(".msg-time")!.textContent).toMatch(/^Yesterday at /);
        expect(container.querySelector('[data-testid="message-1"]')).toBe(row);
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases the midnight timer on destroy", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
        setMessages(1, [makeMessage({ id: 1, timestamp: new Date().toISOString() })]);
        const pendingBeforeMount = vi.getTimerCount();
        msgList.mount(container);
        expect(vi.getTimerCount()).toBeGreaterThan(pendingBeforeMount);

        msgList.destroy?.();

        expect(vi.getTimerCount()).toBe(pendingBeforeMount);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("scrollToMessage vs renderWindow rebuild breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // 30 synchronous full renderWindow rebuilds of a 100-row list can exceed
    // vitest's default 5s on a loaded CI runner (audit-2026-08-19 F-5), so
    // this test carries its own timeout.
    it(
      "does not report success when renderWindow's own >30-in-2s breaker drops the rebuild",
      { timeout: 20_000 },
      () => {
        const many = Array.from({ length: 100 }, (_, i) => makeMessage({ id: i + 1 }));
        setMessages(1, many);
        msgList.mount(container); // mount's renderAll -> renderWindow: rebuild count = 1

        // Every scrollToMessage call forces renderedStart = -1 and calls
        // renderWindow() directly, bypassing renderAll's own (lower) rapid-fire
        // limit. 29 more calls bring the shared renderWindow rebuild counter to
        // 30 (still under the >30 breaker), each one landing normally.
        for (let i = 0; i < 29; i++) {
          expect(msgList.scrollToMessage(i + 1)).toBe(true);
        }

        // The 30th call pushes the counter to 31 and trips the breaker inside
        // renderWindow: it returns before reassigning renderedStart/renderedEnd
        // or touching the DOM, so the target (far outside the last rendered
        // window) never actually renders.
        const result = msgList.scrollToMessage(90);
        expectConsole("error", /\[MessageList\] renderWindow REBUILD called >30 times in 2s/);

        // The rebuild did not happen — the row is not in the DOM — so this must
        // be reported as a failed jump (matching the "false if the message is
        // not in the loaded window" contract), not a false "true".
        expect(container.querySelector('[data-testid="message-90"]')).toBeNull();
        expect(result).toBe(false);
      },
    );
  });
});
