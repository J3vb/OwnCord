/**
 * The NEW line by read pointer, and Mark Unread (WP 3D-5d). With the server's
 * `read_pointer` capability the line goes on the first loaded message above the
 * pointer the channel was opened with (also inside an around-window after a
 * jump); without a pointer it stays count-based. Mark Unread, from the message
 * menu and by Alt+click, sends `mark_unread` and puts the line there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { channelsStore, getPointerOnOpen } from "@stores/channels.store";
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
import { makeMessage, makeOpts, resetGateStores } from "../helpers/message-actions-fixtures";
import { resetMessagesState, resetMembersState } from "../helpers/storeResets";
import {
  setMessages,
  setDetached as setChannelDetached,
  openChannel as openListChannel,
  stubElementHeights,
} from "../helpers/messageListHarness";
import "../helpers/resizeObserverStub";
import { resetChannelsState } from "../helpers/storeSeeds";

const CHANNEL_ID = 1;

function resetStores(): void {
  resetGateStores();
  resetMessagesState();
  resetMembersState();
  resetChannelsState();
}

/** Spaced past the 7-minute group window, so grouping never merges rows. */
function msg(id: number): Message {
  return makeMessage({
    id,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, 0) + id * 600_000).toISOString(),
  });
}

function setDetached(detached: boolean): void {
  setChannelDetached(CHANNEL_ID, detached);
}

function openChannel(unread: number, pointer: number | undefined): void {
  openListChannel(CHANNEL_ID, unread, pointer);
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

  function altClick(target: Element, init: MouseEventInit = {}): void {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true, ...init }),
    );
  }
  const altClickText = (id: number): void => altClick(row(id).querySelector(".msg-text")!);

  /** Right-clicks a message's text and waits for its context menu. */
  async function openMessageMenu(id: number): Promise<void> {
    row(id)
      .querySelector(".msg-text")!
      .dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
    await vi.waitFor(() => expect(document.querySelector(".message-context-menu")).not.toBeNull());
  }

  describe("placed by the pointer", () => {
    it("goes above the first message past the pointer", () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      expect(lineAbove()).toBe("message-3");
    });

    it("trusts the pointer over the count when they disagree", () => {
      // The count says 'the last 2'; the pointer says the last 3 (a blocked
      // author's message is not counted but is still unseen).
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(2, 2);
      mount();
      expect(lineAbove()).toBe("message-3");
    });

    it("keeps the count-based line when the server sent no pointer", () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(2, undefined);
      mount();
      expect(lineAbove()).toBe("message-4");
    });

    it("keeps the count-based line without the capability, even with a pointer", () => {
      applyReadyCapabilities({});
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(2, 1);
      mount();
      expect(lineAbove()).toBe("message-4");
    });

    it("draws no line when the channel was opened with nothing unread", () => {
      setMessages(CHANNEL_ID, [1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      expect(lineAbove()).toBeNull();
    });

    it("draws none above a live arrival in a channel that was fully read", () => {
      setMessages(CHANNEL_ID, [1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      setMessages(CHANNEL_ID, [1, 2, 3, 4].map(msg));
      messagesStore.flush();
      expect(lineAbove()).toBeNull();
    });

    it("sits at the top when every loaded message is past the pointer", () => {
      setMessages(CHANNEL_ID, [10, 11, 12].map(msg));
      openChannel(40, 3);
      mount();
      expect(lineAbove()).toBe("message-10");
    });

    it("does not move when the live pointer does (read_state, a mark)", () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      writeReadPointer(CHANNEL_ID, 5, { unread: 0, mention: 0 });
      expect(getPointerOnOpen(CHANNEL_ID)).toBe(2);
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      expect(lineAbove()).toBe("message-3");
    });
  });

  describe("a pointer line at the top of the window", () => {
    it("moves when older history is prepended", () => {
      setMessages(CHANNEL_ID, [10, 11, 12].map(msg));
      openChannel(5, 7);
      mount();
      expect(lineAbove()).toBe("message-10");
      setMessages(CHANNEL_ID, [5, 6, 7, 8, 9, 10, 11, 12].map(msg));
      messagesStore.flush();
      expect(lineAbove()).toBe("message-8");
    });
  });

  describe("after a jump", () => {
    it("draws the line inside an around-window, and does not scroll to it", () => {
      setMessages(CHANNEL_ID, [100, 101, 102, 103, 104, 105, 106].map(msg));
      openChannel(0, 103);
      setDetached(true);
      mount();
      expect(lineAbove()).toBe("message-104");
      // No auto-scroll: the reader jumped to a message, not to the line.
      expect(container.querySelector<HTMLElement>(".virtual-scroll")?.scrollTop ?? 0).toBe(0);
    });

    it("draws none when the around-window holds nothing past the pointer", () => {
      setMessages(CHANNEL_ID, [100, 101, 102].map(msg));
      openChannel(0, 500);
      setDetached(true);
      mount();
      expect(lineAbove()).toBeNull();
    });

    it("draws none in an around-window without a pointer, as before", () => {
      setMessages(CHANNEL_ID, [100, 101, 102, 103].map(msg));
      openChannel(2, undefined);
      setDetached(true);
      mount();
      expect(lineAbove()).toBeNull();
    });

    it("moves to the new window when a jump replaces the loaded one", async () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      expect(lineAbove()).toBe("message-3");
      setDetached(true);
      setMessages(CHANNEL_ID, [200, 201, 202].map(msg));
      await vi.waitFor(() => expect(lineAbove()).toBe("message-200"));
    });
  });

  describe("Mark Unread", () => {
    const settled = async (): Promise<void> => {
      await import("@components/message-list/messageMenu");
      await new Promise((r) => setTimeout(r, 0));
    };

    beforeEach(() => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(0, 5);
    });

    it("Alt+click sends mark_unread, moves the pointer and draws the line there", async () => {
      mount();
      altClickText(3);
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(2);
      expect(lineAbove()).toBe("message-3");
    });

    it("moves the line when another message is marked unread", async () => {
      mount();
      altClickText(3);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      altClickText(5);
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
      setMessages(CHANNEL_ID, [
        msg(1),
        makeMessage({ ...msg(2), content: "see https://example.com/x" }),
      ]);
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
      altClickText(3);
      await settled();
      expect(unreads).toEqual([]);
      expect(lineAbove()).toBeNull();
    });

    it("the top bar follows the new count once the server answers", async () => {
      messagesStore.flush();
      mount();
      altClickText(3);
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
      altClickText(3);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      expect(barLabel()).toMatch(/^3 new messages since/);
      expect(failMarkUnread("req-1", "rateLimited")).toBe(true);
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(5);
      expect(lineAbove()).toBeNull();
      expect(barLabel()).toBe("");
    });

    it("a failed send takes the line back to where an earlier Mark Unread put it", async () => {
      mount();
      altClickText(3);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      writeReadPointer(CHANNEL_ID, 2, { unread: 3, mention: 0 });
      altClickText(4);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-4"));
      expect(failMarkUnread("req-2", "failed")).toBe(true);
      expect(lineAbove()).toBe("message-3");
    });

    it("a confirmed Mark Unread keeps the line and the bar", async () => {
      messagesStore.flush();
      mount();
      altClickText(3);
      await vi.waitFor(() => expect(lineAbove()).toBe("message-3"));
      writeReadPointer(CHANNEL_ID, 2, { unread: 3, mention: 0 });
      // The server's answer settles the request, so a late failure restores nothing.
      expect(acceptReadState(CHANNEL_ID, 2)).toBe(true);
      expect(failMarkUnread("req-1", "failed")).toBe(false);
      expect(lineAbove()).toBe("message-3");
    });

    it("the message menu offers Mark Unread just above Copy Message Link", async () => {
      mount();
      await openMessageMenu(3);
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
      await openMessageMenu(3);
      expect(document.querySelector('[data-testid="msg-menu-mark-unread"]')).toBeNull();
    });
  });

  describe("marking what is seen", () => {
    const SCROLL_HEIGHT = 4000;
    const CLIENT_HEIGHT = 500;
    let restoreHeights: () => void;

    beforeEach(() => {
      // The mark_read throttle runs on the fake clock; vi.waitFor advances it.
      vi.useFakeTimers();
      restoreHeights = stubElementHeights({
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      restoreHeights();
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
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      scrollUp();
      scrollToEnd();
      expect(marks).toEqual([[CHANNEL_ID, 5]]);
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(5);
    });

    it("scrolling at the bottom again sends nothing more", () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      scrollToEnd();
      scrollToEnd();
      expect(marks).toEqual([[CHANNEL_ID, 5]]);
    });

    it("sends nothing while the pointer already covers what is loaded", () => {
      setMessages(CHANNEL_ID, [1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      scrollToEnd();
      expect(marks).toEqual([]);
    });

    it("marks nothing while scrolled away from the tail", () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(3, 2);
      mount();
      scrollUp();
      expect(marks).toEqual([]);
    });

    it("a partial scroll, then leaving, marks read up to the newest visible message", () => {
      const ids = Array.from({ length: 40 }, (_, i) => i + 1);
      setMessages(CHANNEL_ID, ids.map(msg));
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
      setMessages(CHANNEL_ID, Array.from({ length: 40 }, (_, i) => i + 1).map(msg));
      openChannel(30, 5);
      mount();
      hasFocus.mockReturnValue(false);
      scrollTo(600);
      hasFocus.mockReturnValue(true);
      leaveChannel(CHANNEL_ID);
      expect(marks).toEqual([]);
    });

    it("a live arrival with the tail in view is marked read by its id", async () => {
      setMessages(CHANNEL_ID, [1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      scrollToEnd();
      setMessages(CHANNEL_ID, [1, 2, 3, 4].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(marks).toEqual([[CHANNEL_ID, 4]]);
    });

    it("six live arrivals at the bottom within a second send at most one mark_read", async () => {
      setMessages(CHANNEL_ID, [1, 2, 3].map(msg));
      openChannel(0, 3);
      mount();
      scrollToEnd();
      for (let id = 4; id <= 9; id++) {
        setMessages(
          CHANNEL_ID,
          Array.from({ length: id }, (_, i) => msg(i + 1)),
        );
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
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
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
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(marks).toContainEqual([CHANNEL_ID, 6]);
    });

    it("a live arrival that releases the hold at the bottom is marked read", async () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(0, 5);
      mount();
      scrollToEnd();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      scrollUp();
      scrollToEnd();
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(marks).toEqual([[CHANNEL_ID, 6]]);
    });

    it("Mark Unread is not undone by reaching the bottom or by a live arrival", async () => {
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(msg));
      openChannel(0, 5);
      mount();
      scrollToEnd();
      row(3)
        .querySelector(".msg-text")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
      await vi.waitFor(() => expect(unreads).toEqual([[CHANNEL_ID, 3]]));
      scrollToEnd();
      setMessages(CHANNEL_ID, [1, 2, 3, 4, 5, 6].map(msg));
      messagesStore.flush();
      await vi.advanceTimersByTimeAsync(1300);
      expect(marks).toEqual([]);
      expect(channelsStore.getState().channels.get(CHANNEL_ID)?.lastReadMessageId).toBe(2);
    });
  });
});
