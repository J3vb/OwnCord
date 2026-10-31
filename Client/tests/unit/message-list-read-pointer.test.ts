/**
 * The NEW line by read pointer, and Mark Unread (WP 3D-5d). With the server's
 * `read_pointer` capability the line goes on the first loaded message above the
 * pointer the channel was opened with (also inside an around-window after a
 * jump); without a pointer it stays count-based. Mark Unread, from the message
 * menu and by Alt+click, sends `mark_unread` and puts the line there.
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
import {
  channelsStore,
  getPointerOnOpen,
  setActiveChannel,
  setChannels,
} from "@stores/channels.store";
import {
  acceptReadState,
  failMarkUnread,
  leaveChannel,
  resetReadPointerState,
  setLiveTailInView,
  setMarkReadSender,
  writeReadPointer,
} from "@lib/readState";
import { setMarkUnreadSender } from "../../src/components/message-list/markUnread";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import type { ReadyChannel } from "@lib/types";
import { makeMessage, makeOpts, resetGateStores } from "../helpers/message-actions-fixtures";
import { resetMessagesState, resetMembersState } from "../helpers/storeResets";

const CHANNEL_ID = 1;

function resetStores(): void {
  resetGateStores();
  resetMessagesState();
  resetMembersState();
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
}

/** Spaced past the 7-minute group window, so grouping never merges rows. */
function msg(id: number): Message {
  return makeMessage({
    id,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, 0) + id * 600_000).toISOString(),
  });
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

/** "Open" the channel the way the app does: seed it, then activate it, which
 *  clears the badge and snapshots both the unread count and the pointer. */
function openChannel(unread: number, pointer: number | undefined): void {
  const ch: ReadyChannel = {
    id: CHANNEL_ID,
    name: "general",
    type: "text",
    category: null,
    position: 0,
    unread_count: unread,
    mention_count: 0,
    ...(pointer !== undefined ? { last_read_message_id: pointer } : {}),
  };
  setChannels([ch]);
  setActiveChannel(CHANNEL_ID);
}

describe("MessageList: NEW line by read pointer and Mark Unread", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let marks: Array<[number, number | undefined]>;
  let unreads: Array<[number, number]>;
  let hasFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetStores();
    localStorage.clear();
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    marks = [];
    unreads = [];
    setMarkReadSender((c, m) => marks.push([c, m]));
    setMarkUnreadSender((c, m) => {
      unreads.push([c, m]);
      return `req-${unreads.length}`;
    });
    applyReadyCapabilities({ read_pointer: true });
    setLiveTailInView(CHANNEL_ID, true);
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeOpts({ currentUserId: 99 });
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    setMarkReadSender(null);
    setMarkUnreadSender(null);
    resetServerCapabilities();
    resetReadPointerState();
    hasFocus.mockRestore();
  });

  function mount(): void {
    list = createMessageList(options);
    list.mount(container);
  }

  /** The id of the message right under the NEW line, or null for no line. */
  function lineAbove(): string | null {
    const divider = container.querySelector('[data-testid="new-messages-divider"]');
    return divider === null
      ? null
      : ((divider.nextElementSibling as HTMLElement).dataset.testid ?? null);
  }

  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="message-${id}"]`)!;

  describe("placed by the pointer", () => {
    it("goes above the first message past the pointer", () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      expect(lineAbove()).toBe("message-3");
    });

    it("trusts the pointer over the count when they disagree", () => {
      // The count says 'the last 2'; the pointer says the last 3 (a blocked
      // author's message is not counted but is still unseen).
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(2, 2);
      mount();
      expect(lineAbove()).toBe("message-3");
    });

    it("keeps the count-based line when the server sent no pointer", () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(2, undefined);
      mount();
      expect(lineAbove()).toBe("message-4");
    });

    it("keeps the count-based line without the capability, even with a pointer", () => {
      applyReadyCapabilities({});
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(2, 1);
      mount();
      expect(lineAbove()).toBe("message-4");
    });

    it("draws no line when the channel was opened with nothing unread", () => {
      setMessages([1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      expect(lineAbove()).toBeNull();
    });

    it("draws none above a live arrival in a channel that was fully read", () => {
      setMessages([1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      setMessages([1, 2, 3, 4].map(msg));
      messagesStore.flush();
      expect(lineAbove()).toBeNull();
    });

    it("sits at the top when every loaded message is past the pointer", () => {
      setMessages([10, 11, 12].map(msg));
      openChannel(40, 3);
      mount();
      expect(lineAbove()).toBe("message-10");
    });

    it("does not move when the live pointer does (read_state, a mark)", () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      writeReadPointer(CHANNEL_ID, 5, { unread: 0, mention: 0 });
      expect(getPointerOnOpen(CHANNEL_ID)).toBe(2);
      setMessages([1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      expect(lineAbove()).toBe("message-3");
    });
  });

  describe("a pointer line at the top of the window", () => {
    it("moves when older history is prepended", () => {
      setMessages([10, 11, 12].map(msg));
      openChannel(5, 7);
      mount();
      expect(lineAbove()).toBe("message-10");
      setMessages([5, 6, 7, 8, 9, 10, 11, 12].map(msg));
      messagesStore.flush();
      expect(lineAbove()).toBe("message-8");
    });
  });

  describe("after a jump", () => {
    it("draws the line inside an around-window, and does not scroll to it", () => {
      setMessages([100, 101, 102, 103, 104, 105, 106].map(msg));
      openChannel(0, 103);
      setDetached(true);
      mount();
      expect(lineAbove()).toBe("message-104");
      // No auto-scroll: the reader jumped to a message, not to the line.
      expect(container.querySelector<HTMLElement>(".virtual-scroll")?.scrollTop ?? 0).toBe(0);
    });

    it("draws none when the around-window holds nothing past the pointer", () => {
      setMessages([100, 101, 102].map(msg));
      openChannel(0, 500);
      setDetached(true);
      mount();
      expect(lineAbove()).toBeNull();
    });

    it("draws none in an around-window without a pointer, as before", () => {
      setMessages([100, 101, 102, 103].map(msg));
      openChannel(2, undefined);
      setDetached(true);
      mount();
      expect(lineAbove()).toBeNull();
    });

    it("moves to the new window when a jump replaces the loaded one", async () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      expect(lineAbove()).toBe("message-3");
      setDetached(true);
      setMessages([200, 201, 202].map(msg));
      await vi.waitFor(() => expect(lineAbove()).toBe("message-200"));
    });
  });

  describe("Mark Unread", () => {
    const settled = async (): Promise<void> => {
      await import("@components/message-list/messageMenu");
      await new Promise((r) => setTimeout(r, 0));
    };

    function altClick(target: Element, init: MouseEventInit = {}): void {
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true, ...init }),
      );
    }

    beforeEach(() => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(0, 5);
    });

    it("Alt+click sends mark_unread, moves the pointer and draws the line there", async () => {
      mount();
      altClick(row(3).querySelector(".msg-text")!);
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(2);
      expect(lineAbove()).toBe("message-3");
    });

    it("moves the line when another message is marked unread", async () => {
      mount();
      altClick(row(3).querySelector(".msg-text")!);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      altClick(row(5).querySelector(".msg-text")!);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-5"));
      expect(container.querySelectorAll('[data-testid="new-messages-divider"]')).toHaveLength(1);
    });

    it("a plain click does nothing", async () => {
      mount();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settled();
      expect(unreads).toEqual([]);
    });

    it("Alt+click on a link does nothing", async () => {
      options = makeOpts({ currentUserId: 99 });
      setMessages([msg(1), makeMessage({ ...msg(2), content: "see https://example.com/x" })]);
      openChannel(0, 2);
      mount();
      const link = container.querySelector<HTMLElement>(".msg-text a")!;
      expect(link).not.toBeNull();
      altClick(link);
      await settled();
      expect(unreads).toEqual([]);
    });

    it("Alt+click on a button or the author name does nothing", async () => {
      mount();
      const button = document.createElement("button");
      row(3).appendChild(button);
      altClick(button);
      const author = row(3).querySelector<HTMLElement>(".msg-author");
      if (author !== null) altClick(author);
      await settled();
      expect(unreads).toEqual([]);
    });

    it("Alt+click does nothing without the capability", async () => {
      applyReadyCapabilities({});
      mount();
      altClick(row(3).querySelector(".msg-text")!);
      await settled();
      expect(unreads).toEqual([]);
      expect(lineAbove()).toBeNull();
    });

    it("the top bar follows the new count once the server answers", async () => {
      messagesStore.flush();
      mount();
      altClick(row(3).querySelector(".msg-text")!);
      const label = (): string =>
        container.querySelector('[data-testid="unread-bar-label"]')?.textContent ?? "";
      await vi.waitFor(() => expect(label()).toMatch(/^3 new messages since/));
      writeReadPointer(CHANNEL_ID, 2, { unread: 7, mention: 0 });
      await vi.waitFor(() => expect(label()).toMatch(/^7 new messages since/));
    });

    const barLabel = (): string =>
      container.querySelector('[data-testid="unread-bar-label"]')?.textContent ?? "";

    it("a refused Mark Unread takes the NEW line and the unread bar back", async () => {
      messagesStore.flush();
      mount();
      expect(lineAbove()).toBeNull();
      altClick(row(3).querySelector(".msg-text")!);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      expect(barLabel()).toMatch(/^3 new messages since/);
      expect(failMarkUnread("req-1", "rateLimited")).toBe(true);
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(5);
      expect(lineAbove()).toBeNull();
      expect(barLabel()).toBe("");
    });

    it("a failed send takes the line back to where an earlier Mark Unread put it", async () => {
      mount();
      altClick(row(3).querySelector(".msg-text")!);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      writeReadPointer(CHANNEL_ID, 2, { unread: 3, mention: 0 });
      altClick(row(4).querySelector(".msg-text")!);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-4"));
      expect(failMarkUnread("req-2", "failed")).toBe(true);
      expect(lineAbove()).toBe("message-3");
    });

    it("a confirmed Mark Unread keeps the line and the bar", async () => {
      messagesStore.flush();
      mount();
      altClick(row(3).querySelector(".msg-text")!);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      writeReadPointer(CHANNEL_ID, 2, { unread: 3, mention: 0 });
      // The server's answer settles the request, so a late failure restores nothing.
      expect(acceptReadState(CHANNEL_ID, 2)).toBe(true);
      expect(failMarkUnread("req-1", "failed")).toBe(false);
      expect(lineAbove()).toBe("message-3");
    });

    it("the message menu offers Mark Unread just above Copy Message Link", async () => {
      mount();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 5,
          }),
        );
      await vi.waitFor(() =>
        expect(document.querySelector(".message-context-menu")).not.toBeNull(),
      );
      const names = [
        ...document.querySelectorAll<HTMLElement>('.message-context-menu [role="menuitem"]'),
      ].map((el) => el.dataset["testid"]);
      const at = names.indexOf("msg-menu-mark-unread");
      expect(at).toBeGreaterThan(-1);
      expect(names[at + 1]).toBe("msg-menu-copy-message-link");

      document.querySelector<HTMLElement>('[data-testid="msg-menu-mark-unread"]')!.click();
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      expect(lineAbove()).toBe("message-3");
    });

    it("the message menu hides Mark Unread without the capability", async () => {
      applyReadyCapabilities({});
      mount();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 5,
          }),
        );
      await vi.waitFor(() =>
        expect(document.querySelector(".message-context-menu")).not.toBeNull(),
      );
      expect(document.querySelector('[data-testid="msg-menu-mark-unread"]')).toBeNull();
    });
  });

  describe("marking what is seen", () => {
    const SCROLL_HEIGHT = 4000;
    const CLIENT_HEIGHT = 500;
    const saved = new Map<string, PropertyDescriptor | undefined>();

    beforeEach(() => {
      // The mark_read throttle runs on the fake clock; vi.waitFor advances it.
      vi.useFakeTimers();
      for (const [prop, value] of [
        ["scrollHeight", SCROLL_HEIGHT],
        ["clientHeight", CLIENT_HEIGHT],
      ] as const) {
        saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
        Object.defineProperty(HTMLElement.prototype, prop, {
          configurable: true,
          get: () => value,
        });
      }
    });

    afterEach(() => {
      vi.useRealTimers();
      for (const [prop, descriptor] of saved) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
      }
      saved.clear();
    });

    const root = (): HTMLDivElement =>
      container.querySelector(".messages-container") as HTMLDivElement;
    function scrollTo(top: number): void {
      root().scrollTop = top;
      root().dispatchEvent(new Event("scroll"));
    }
    const scrollToEnd = (): void => scrollTo(SCROLL_HEIGHT - CLIENT_HEIGHT);
    const scrollUp = (): void => scrollTo(300);

    it("reaching the bottom marks read up to the newest loaded message, by id", () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      scrollUp();
      scrollToEnd();
      expect(marks).toEqual([[CHANNEL_ID, 5]]);
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(5);
    });

    it("scrolling at the bottom again sends nothing more", () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      scrollToEnd();
      scrollToEnd();
      expect(marks).toEqual([[CHANNEL_ID, 5]]);
    });

    it("sends nothing while the pointer already covers what is loaded", () => {
      setMessages([1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      scrollToEnd();
      expect(marks).toEqual([]);
    });

    it("marks nothing while scrolled away from the tail", () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      scrollUp();
      expect(marks).toEqual([]);
    });

    it("a partial scroll, then leaving, marks read up to the newest visible message", () => {
      const ids = Array.from({ length: 40 }, (_, i) => i + 1);
      setMessages(ids.map(msg));
      openChannel(30, 5);
      mount();
      scrollTo(600);
      leaveChannel(CHANNEL_ID);
      expect(marks).toHaveLength(1);
      const [, sent] = marks[0]!;
      // Seen, so past the pointer; but nowhere near the newest loaded (40).
      expect(sent).toBeGreaterThan(5);
      expect(sent).toBeLessThan(40);
      // Scrolling further raises it, and never lowers it.
      marks.length = 0;
      scrollTo(900);
      scrollTo(300);
      leaveChannel(CHANNEL_ID);
      expect(marks).toHaveLength(1);
      expect(marks[0]![1]).toBeGreaterThan(sent!);
      expect(marks[0]![1]).toBeLessThan(40);
    });

    it("a partial scroll in a blurred window records nothing", () => {
      setMessages(Array.from({ length: 40 }, (_, i) => i + 1).map(msg));
      openChannel(30, 5);
      mount();
      hasFocus.mockReturnValue(false);
      scrollTo(600);
      hasFocus.mockReturnValue(true);
      leaveChannel(CHANNEL_ID);
      expect(marks).toEqual([]);
    });

    it("a live arrival with the tail in view is marked read by its id", async () => {
      setMessages([1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      scrollToEnd();
      setMessages([1, 2, 3, 4].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(marks).toEqual([[CHANNEL_ID, 4]]);
    });

    it("six live arrivals at the bottom within a second send at most one mark_read", async () => {
      setMessages([1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      scrollToEnd();
      for (let id = 4; id <= 9; id++) {
        setMessages(Array.from({ length: id }, (_, i) => msg(i + 1)));
        messagesStore.flush();
        // The auto-scroll that follows an append reaches the scroll handler.
        root().dispatchEvent(new Event("scroll"));
      }
      expect(marks.length).toBeLessThanOrEqual(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(marks).toEqual([[CHANNEL_ID, 9]]);
      expect(marks).toHaveLength(1);
    });

    it("Escape on a channel just marked unread marks it read at latest and ends the hold", async () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(0, 5);
      mount();
      scrollToEnd();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      list!.markReadAndJumpToPresent();
      expect(marks).toEqual([[CHANNEL_ID, undefined]]);
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.unreadCount).toBe(0);
      setMessages([1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(marks).toContainEqual([CHANNEL_ID, 6]);
    });

    it("a live arrival that releases the hold at the bottom is marked read", async () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(0, 5);
      mount();
      scrollToEnd();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      scrollUp();
      scrollToEnd();
      setMessages([1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(marks).toEqual([[CHANNEL_ID, 6]]);
    });

    it("Mark Unread is not undone by reaching the bottom or by a live arrival", async () => {
      setMessages([1, 2, 3, 4, 5].map(msg));
      openChannel(0, 5);
      mount();
      scrollToEnd();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      scrollToEnd();
      setMessages([1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1300);
      expect(marks).toEqual([]);
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(2);
    });
  });
});
