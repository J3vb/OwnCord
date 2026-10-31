import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/messageListMocks";
import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import {
  resetSafetyStore,
  safetyStore,
  setActiveTimeout,
} from "../../../src/features/safety/store";
import { setConnectionStatus, uiStore } from "../../../src/stores/ui.store";
import {
  makeMessage,
  setMessages,
  setHasMore,
  setHistoryLoadState,
  MessageListComponent,
  useMessageListHarness,
} from "../../helpers/messageListHarness";

vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);

describe("MessageList", () => {
  let container: HTMLDivElement;
  let msgList: MessageListComponent;
  let options: MessageListOptions;

  useMessageListHarness(
    (wired) => {
      container = wired.container;
      options = wired.options;
      msgList = wired.msgList;
    },
    () => msgList,
  );

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

  it("scrollToMessage centres the target in the viewport once its row is measured", () => {
    const many = Array.from({ length: 200 }, (_, i) => makeMessage({ id: i + 1 }));
    setMessages(1, many);
    msgList.mount(container);
    const root = container.querySelector(".messages-container") as HTMLDivElement;
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 400 });
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(100);

    expect(msgList.scrollToMessage(150)).toBe(true);
    offsetHeight.mockRestore();

    // Spacer height + rows above the target in the rendered window = the
    // target's top; centred means that top sits (400 - 100) / 2 below scrollTop.
    const spacer = container.querySelector(".virtual-spacer-top") as HTMLElement;
    const row = container.querySelector('[data-testid="message-150"]') as HTMLElement;
    const rowIdx = Array.from(row.parentElement!.children).indexOf(row);
    expect(root.scrollTop).toBe(parseFloat(spacer.style.height) + rowIdx * 100 - 150);
  });

  it("scrollToMessage keeps the target centred when rows above it resize after the jump", () => {
    const observers: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    const rafs: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => rafs.push(cb));
    try {
      const many = Array.from({ length: 200 }, (_, i) => makeMessage({ id: i + 1 }));
      setMessages(1, many);
      msgList.mount(container);
      // The mount's first frame (its scroll to the bottom) runs long before a jump.
      rafs.splice(0).forEach((cb) => cb(0));
      const root = container.querySelector(".messages-container") as HTMLDivElement;
      Object.defineProperty(root, "clientHeight", { configurable: true, value: 400 });
      let height = 100;
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => height);

      expect(msgList.scrollToMessage(150)).toBe(true);
      const settled = root.scrollTop;

      // A preview above the target finishes loading: every rendered row grows.
      height = 160;
      observers.forEach((cb) => cb());
      rafs.splice(0).forEach((cb) => cb(0));

      const spacer = container.querySelector(".virtual-spacer-top") as HTMLElement;
      const row = container.querySelector('[data-testid="message-150"]') as HTMLElement;
      const rowIdx = Array.from(row.parentElement!.children).indexOf(row);
      expect(root.scrollTop).not.toBe(settled);
      expect(root.scrollTop).toBe(parseFloat(spacer.style.height) + rowIdx * 160 - (400 - 160) / 2);
    } finally {
      globalThis.ResizeObserver = original;
      vi.restoreAllMocks();
    }
  });

  it("repeated jumps do not each register a permanent row listener on the component-lifetime signal", () => {
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
    // In jsdom with 0 clientHeight, renderWindow computes start=0, end=OVERSCAN_MAX_ROWS+1.
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

  it("disables every reaction control inline while timed out, and re-enables on lift", () => {
    setConnectionStatus("connected");
    uiStore.flush();
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

  it("disables delete while the socket is down and re-enables it on reconnect", () => {
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

  describe("time format preference", () => {
    afterEach(() => {
      localStorage.removeItem("owncord:settings:timeFormat");
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }),
      );
    });

    it("relabels rendered message times when the clock format changes", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2024, 0, 15, 18, 34, 0));
        setMessages(1, [makeMessage({ id: 1, timestamp: new Date().toISOString() })]);
        msgList.mount(container);

        expect(container.querySelector(".msg-time")!.textContent).toContain("6:34 PM");

        localStorage.setItem("owncord:settings:timeFormat", JSON.stringify("24h"));
        window.dispatchEvent(
          new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }),
        );

        const text = container.querySelector(".msg-time")!.textContent!;
        expect(text).toContain("18:34");
        expect(text).not.toMatch(/AM|PM/i);
        expect(container.querySelector<HTMLElement>(".msg-time")!.title).toContain("18:34");
      } finally {
        vi.useRealTimers();
      }
    });

    it("relabels the compact and gutter clock times, keeping them short", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2024, 0, 15, 18, 34, 0));
        const now = new Date().toISOString();
        setMessages(1, [
          makeMessage({ id: 1, timestamp: now }),
          makeMessage({ id: 2, timestamp: now }),
        ]);
        msgList.mount(container);

        const compact = container.querySelector<HTMLElement>(".msg-compact-time")!;
        const hover = container.querySelector<HTMLElement>(".msg-hover-time")!;
        expect(compact.textContent).toContain("6:34 PM");
        expect(hover.textContent).toContain("6:34 PM");

        localStorage.setItem("owncord:settings:timeFormat", JSON.stringify("24h"));
        window.dispatchEvent(
          new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }),
        );

        for (const el of [compact, hover]) {
          expect(el.textContent).toContain("18:34");
          expect(el.textContent).not.toMatch(/AM|PM|Today|Yesterday/i);
          expect(el.title).toContain("18:34");
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("rewrites a relative <t:…:R> timestamp as time passes", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
        const target = Math.floor(Date.now() / 1000) + 5 * 60;
        setMessages(1, [
          makeMessage({ id: 1, content: `<t:${target}:R>`, timestamp: new Date().toISOString() }),
        ]);
        msgList.mount(container);
        const time = container.querySelector("time.md-timestamp")!;
        expect(time.textContent).toBe("in 5 minutes");

        vi.advanceTimersByTime(3 * 60_000);
        expect(time.textContent).toBe("in 2 minutes");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
