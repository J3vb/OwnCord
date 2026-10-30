/**
 * WP 3B-6: consecutive messages by authors you blocked fold into one
 * "N blocked messages" run per stretch. Show and Hide are per run and last for
 * the mount; a jump into a run opens it; a block or an unblock folds or unfolds
 * the rows in place.
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
import { messagesStore, deleteMessage } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import {
  blocksStore,
  resetBlocksStore,
  setBlockedByMe,
  setUserBlockedByMe,
} from "@stores/blocks.store";
import { channelsStore, setActiveChannel, setChannels } from "@stores/channels.store";
import {
  leaveChannel,
  resetReadPointerState,
  setLiveTailInView,
  setMarkReadSender,
} from "@lib/readState";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { makeMessage, makeOpts, resetGateStores } from "../helpers/message-actions-fixtures";

const CHANNEL_ID = 1;
const ALICE = { id: 2, username: "alice", avatar: null };
const BOB = { id: 3, username: "bob", avatar: null };
const CAROL = { id: 4, username: "carol", avatar: null };

function resetStores(): void {
  resetGateStores();
  resetBlocksStore();
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
}

/** Ten minutes apart (past the 7-minute group window), so no two rows group. */
function msg(id: number, user: Message["user"] = ALICE, extra: Partial<Message> = {}): Message {
  return makeMessage({
    id,
    user,
    content: `Message ${id}`,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, 0) + id * 600_000).toISOString(),
    ...extra,
  });
}

function setMessages(messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(CHANNEL_ID, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
  messagesStore.flush();
}

function block(...ids: number[]): void {
  setBlockedByMe(ids);
  blocksStore.flush();
}

describe("MessageList: blocked users' messages", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;

  const row = (id: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid='message-${id}']`);
  const runs = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>("[data-testid^='msg-blocked-run-']"),
  ];
  const run = (firstId: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid='msg-blocked-run-${firstId}']`);
  const toggle = (firstId: number): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`[data-testid='msg-blocked-toggle-${firstId}']`)!;
  const messageIds = (): string[] =>
    [...container.querySelectorAll("[data-testid^='message-']")].map((el) =>
      (el as HTMLElement).dataset["testid"]!.slice("message-".length),
    );
  const mount = (): void => {
    list = createMessageList(options);
    list.mount(container);
  };

  beforeEach(() => {
    resetStores();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeOpts({ currentUserId: 99 });
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
  });

  it("consecutive blocked messages from two blocked authors give one run with the right count", () => {
    block(BOB.id, CAROL.id);
    setMessages([msg(1), msg(2, BOB), msg(3, CAROL), msg(4, BOB), msg(5)]);
    mount();

    expect(runs()).toHaveLength(1);
    expect(run(2)!.textContent).toContain("3 blocked messages");
    expect(toggle(2).textContent).toBe("Show");
    expect(toggle(2).getAttribute("aria-expanded")).toBe("false");
    expect(messageIds()).toEqual(["1", "5"]);
  });

  it("reads 'blocked message' for a single one", () => {
    block(BOB.id);
    setMessages([msg(1), msg(2, BOB), msg(3)]);
    mount();
    expect(run(2)!.textContent).toContain("1 blocked message");
    expect(run(2)!.textContent).not.toContain("1 blocked messages");
  });

  it("a server row (group event, call, unknown kind) by a blocked author is never folded", () => {
    block(BOB.id);
    setMessages([
      msg(1, BOB),
      msg(2, BOB, { kind: "group_add", groupEvent: { target_user_id: 4 } }),
      msg(3, BOB, { kind: "group_future", content: "something happened" }),
      msg(4, BOB, { kind: "" }),
    ]);
    mount();

    // Rows 2 and 3 stay visible and split the blocked messages around them;
    // an empty kind is an ordinary message and still folds.
    expect(messageIds()).toEqual(["2", "3"]);
    expect(runs().map((r) => r.dataset["testid"])).toEqual([
      "msg-blocked-run-1",
      "msg-blocked-run-4",
    ]);
  });

  it("a message by someone else splits the run", () => {
    block(BOB.id);
    setMessages([msg(1, BOB), msg(2, BOB), msg(3), msg(4, BOB)]);
    mount();

    expect(runs().map((r) => r.dataset["testid"])).toEqual([
      "msg-blocked-run-1",
      "msg-blocked-run-4",
    ]);
    expect(run(1)!.textContent).toContain("2 blocked messages");
    expect(run(4)!.textContent).toContain("1 blocked message");
    expect(messageIds()).toEqual(["3"]);
  });

  it("a run breaks at a day divider", () => {
    block(BOB.id);
    setMessages([
      msg(1, BOB, { timestamp: "2024-01-15T22:00:00Z" }),
      msg(2, BOB, { timestamp: "2024-01-15T22:05:00Z" }),
      msg(3, BOB, { timestamp: "2024-01-17T10:00:00Z" }),
    ]);
    mount();

    expect(container.querySelectorAll(".msg-day-divider")).toHaveLength(2);
    expect(run(1)!.textContent).toContain("2 blocked messages");
    expect(run(3)!.textContent).toContain("1 blocked message");
  });

  it("a run breaks at the NEW line", () => {
    block(BOB.id);
    setMessages([msg(1), msg(2, BOB), msg(3, BOB), msg(4, BOB), msg(5)]);
    setChannels([
      {
        id: CHANNEL_ID,
        name: "general",
        type: "text",
        category: null,
        position: 0,
        unread_count: 3,
        mention_count: 0,
      },
    ]);
    setActiveChannel(CHANNEL_ID);
    mount();

    const kids = [...container.querySelector(".messages-content, .virtual-content")!.children];
    const labels = kids.map((el) =>
      el.classList.contains("msg-new-divider")
        ? "new"
        : el.classList.contains("msg-day-divider")
          ? "day"
          : (el as HTMLElement).dataset["testid"],
    );
    expect(labels).toEqual([
      "day",
      "message-1",
      "msg-blocked-run-2",
      "new",
      "msg-blocked-run-3",
      "message-5",
    ]);
    expect(run(2)!.textContent).toContain("1 blocked message");
    expect(run(3)!.textContent).toContain("2 blocked messages");
  });

  it("the row after a collapsed run is not grouped with the one before it", () => {
    block(BOB.id);
    setMessages([
      msg(1, ALICE, { timestamp: "2024-01-15T12:00:00Z" }),
      msg(2, BOB, { timestamp: "2024-01-15T12:01:00Z" }),
      msg(3, ALICE, { timestamp: "2024-01-15T12:02:00Z" }),
    ]);
    mount();

    expect(row(3)!.classList.contains("grouped")).toBe(false);
    expect(row(3)!.querySelector(".msg-author")).not.toBeNull();
  });

  it("Show expands that run only, Hide collapses it, and a remount collapses everything again", () => {
    block(BOB.id);
    setMessages([msg(1, BOB), msg(2), msg(3, BOB), msg(4, BOB)]);
    mount();
    expect(messageIds()).toEqual(["2"]);

    toggle(3).click();
    expect(messageIds()).toEqual(["2", "3", "4"]);
    expect(toggle(3).textContent).toBe("Hide");
    expect(toggle(3).getAttribute("aria-expanded")).toBe("true");
    expect(run(1)!.textContent).toContain("1 blocked message");
    expect(toggle(1).textContent).toBe("Show");
    expect(row(3)!.classList.contains("grouped")).toBe(false);
    expect(row(4)!.classList.contains("grouped")).toBe(false);

    toggle(3).click();
    expect(messageIds()).toEqual(["2"]);
    expect(toggle(3).textContent).toBe("Show");

    toggle(3).click();
    expect(messageIds()).toEqual(["2", "3", "4"]);
    list!.destroy?.();
    container.replaceChildren();
    mount();
    expect(messageIds()).toEqual(["2"]);
  });

  it("a live blocked message extends the collapsed run in place", () => {
    block(BOB.id);
    const first = [msg(1), msg(2, BOB), msg(3, BOB)];
    setMessages(first);
    mount();
    const row1 = row(1);
    expect(run(2)!.textContent).toContain("2 blocked messages");

    setMessages([...first, msg(4, BOB)]);

    expect(runs()).toHaveLength(1);
    expect(run(2)!.textContent).toContain("3 blocked messages");
    expect(row(1)).toBe(row1);
    expect(messageIds()).toEqual(["1"]);
  });

  describe("read pointer", () => {
    const SCROLL_HEIGHT = 4000;
    const CLIENT_HEIGHT = 500;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    let marks: Array<[number, number | undefined]>;
    let hasFocus: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      marks = [];
      setMarkReadSender((c, m) => marks.push([c, m]));
      applyReadyCapabilities({ read_pointer: true });
      setLiveTailInView(CHANNEL_ID, true);
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
      for (const [prop, descriptor] of saved) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
      }
      saved.clear();
      setMarkReadSender(null);
      resetServerCapabilities();
      resetReadPointerState();
      hasFocus.mockRestore();
    });

    const root = (): HTMLDivElement =>
      container.querySelector(".messages-container") as HTMLDivElement;
    function scrollTo(top: number): void {
      root().scrollTop = top;
      root().dispatchEvent(new Event("scroll"));
    }
    function openChannel(pointer: number): void {
      setChannels([
        {
          id: CHANNEL_ID,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          unread_count: 0,
          mention_count: 0,
          last_read_message_id: pointer,
        },
      ]);
      setActiveChannel(CHANNEL_ID);
    }

    it("a collapsed run at the tail is marked seen up to its last id", () => {
      block(BOB.id);
      setMessages([msg(1), msg(2), msg(3, BOB), msg(4, BOB), msg(5, BOB)]);
      openChannel(2);
      mount();
      scrollTo(300);
      expect(messageIds()).toEqual(["1", "2"]);
      leaveChannel(CHANNEL_ID);
      expect(marks).toEqual([[CHANNEL_ID, 5]]);
    });

    it("a live blocked arrival with the tail in view is marked seen by its id", async () => {
      block(BOB.id);
      setMessages([msg(1), msg(2), msg(3, BOB), msg(4, BOB)]);
      openChannel(2);
      mount();
      scrollTo(SCROLL_HEIGHT - CLIENT_HEIGHT);
      marks.length = 0;
      setMessages([msg(1), msg(2), msg(3, BOB), msg(4, BOB), msg(5, BOB)]);
      await vi.waitFor(() => expect(marks).toEqual([[CHANNEL_ID, 5]]), { timeout: 3000 });
      expect(run(3)!.textContent).toContain("3 blocked messages");
    });

    it("a block landing on the row the reader is anchored to folds the list without losing it", () => {
      setMessages(Array.from({ length: 40 }, (_, i) => msg(i + 1)));
      openChannel(0);
      mount();
      scrollTo(600);
      expect(row(10)).not.toBeNull();

      block(ALICE.id);

      expect(messageIds()).toEqual([]);
      expect(runs()).toHaveLength(1);
      expect(run(1)!.textContent).toContain("40 blocked messages");
      expect(list!.scrollToMessage(10)).toBe(true);
      expect(row(10)).not.toBeNull();
    });
  });

  it("block and unblock mid-session collapse and expand without remount", () => {
    setMessages([msg(1), msg(2, BOB), msg(3, BOB), msg(4)]);
    mount();
    expect(runs()).toHaveLength(0);
    expect(messageIds()).toEqual(["1", "2", "3", "4"]);

    setUserBlockedByMe(BOB.id, true);
    blocksStore.flush();
    expect(messageIds()).toEqual(["1", "4"]);
    expect(run(2)!.textContent).toContain("2 blocked messages");

    toggle(2).click();
    expect(messageIds()).toEqual(["1", "2", "3", "4"]);

    setUserBlockedByMe(BOB.id, false);
    blocksStore.flush();
    expect(runs()).toHaveLength(0);
    expect(messageIds()).toEqual(["1", "2", "3", "4"]);
  });

  it("scrollToMessage into a collapsed run expands it and reveals the target", () => {
    block(BOB.id);
    setMessages([msg(1, BOB), msg(2, BOB), msg(3), msg(4, BOB), msg(5, BOB)]);
    mount();
    expect(messageIds()).toEqual(["3"]);

    expect(list!.scrollToMessage(5)).toBe(true);

    expect(messageIds()).toEqual(["3", "4", "5"]);
    expect(toggle(4).textContent).toBe("Hide");
    expect(toggle(1).textContent).toBe("Show");
    expect(row(5)!.classList.contains("highlight-flash")).toBe(true);
    expect(list!.scrollToMessage(99)).toBe(false);
  });

  it("a jump to a deleted id inside a run changes nothing and leaves the list in step", () => {
    block(BOB.id);
    setMessages([msg(1, BOB), msg(2, BOB, { deleted: true }), msg(3, BOB), msg(4)]);
    mount();
    expect(run(1)!.textContent).toContain("2 blocked messages");

    expect(list!.scrollToMessage(2)).toBe(false);
    expect(messageIds()).toEqual(["4"]);
    expect(toggle(1).textContent).toBe("Show");

    setMessages([msg(1, BOB), msg(2, BOB, { deleted: true }), msg(3, BOB), msg(4), msg(5)]);
    expect(messageIds()).toEqual(["4", "5"]);
    expect(run(1)!.textContent).toContain("2 blocked messages");
    expect(toggle(1).textContent).toBe("Show");
  });

  it("blocking someone again folds the rows they were shown on", () => {
    block(BOB.id);
    setMessages([msg(1), msg(2, BOB), msg(3, BOB), msg(4)]);
    mount();
    toggle(2).click();
    expect(messageIds()).toEqual(["1", "2", "3", "4"]);

    block();
    expect(runs()).toHaveLength(0);
    block(BOB.id);
    expect(messageIds()).toEqual(["1", "4"]);
    expect(toggle(2).textContent).toBe("Show");
  });

  it("the toggle acts on the current run after a live arrival extended it", () => {
    block(BOB.id);
    const first = [msg(1), msg(2, BOB), msg(3, BOB)];
    setMessages(first);
    mount();
    setMessages([...first, msg(4, BOB)]);
    toggle(2).click();
    expect(messageIds()).toEqual(["1", "2", "3", "4"]);
    toggle(2).click();
    expect(messageIds()).toEqual(["1"]);
  });

  describe("scroll hold on Show and Hide", () => {
    const CLIENT_HEIGHT = 500;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    let rectSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      for (const [prop, value] of [
        ["scrollHeight", 4000],
        ["clientHeight", CLIENT_HEIGHT],
      ] as const) {
        saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
        Object.defineProperty(HTMLElement.prototype, prop, {
          configurable: true,
          get: () => value,
        });
      }
      // A one-column layout: 61 px per message, 32 px for anything else.
      rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element,
      ) {
        const rect = (top: number, height: number): DOMRect =>
          ({
            top,
            height,
            bottom: top + height,
            left: 0,
            right: 0,
            width: 0,
            x: 0,
            y: top,
          }) as DOMRect;
        const scroller = container.querySelector<HTMLElement>(".messages-container");
        const content = container.querySelector<HTMLElement>(".virtual-content");
        if (scroller === null || content === null) return rect(0, 0);
        if (this === scroller) return rect(0, CLIENT_HEIGHT);
        if (this.parentElement !== content) return rect(0, 0);
        const heightOf = (el: Element): number => (el.classList.contains("message") ? 61 : 32);
        let top = parseFloat((content.previousElementSibling as HTMLElement).style.height || "0");
        for (const sib of content.children) {
          if (sib === this) break;
          top += heightOf(sib);
        }
        return rect(top - scroller.scrollTop, heightOf(this));
      });
    });

    afterEach(() => {
      rectSpy.mockRestore();
      for (const [prop, descriptor] of saved) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
      }
      saved.clear();
    });

    const scroller = (): HTMLDivElement =>
      container.querySelector(".messages-container") as HTMLDivElement;
    const headerTop = (): number => run(11)!.getBoundingClientRect().top;
    const load = (): void => {
      block(BOB.id);
      setMessages([
        ...Array.from({ length: 10 }, (_, i) => msg(i + 1)),
        msg(11, BOB),
        msg(12, BOB),
        msg(13, BOB),
        ...Array.from({ length: 17 }, (_, i) => msg(i + 14)),
      ]);
      mount();
    };

    it("keeps the header where it was after Show, and after Hide", () => {
      load();
      // The header is the topmost row, partly above the viewport.
      scroller().scrollTop = 32 + 10 * 61 + 10;
      scroller().dispatchEvent(new Event("scroll"));
      const before = headerTop();
      expect(before).toBe(-10);

      toggle(11).click();
      expect(messageIds()).toContain("12");
      expect(headerTop()).toBe(before);

      // Scrolled so the top row is inside the expanded run.
      scroller().scrollTop = 32 + 10 * 61 + 32 + 61 + 20;
      scroller().dispatchEvent(new Event("scroll"));
      const expandedEdge = headerTop();
      toggle(11).click();
      expect(messageIds()).not.toContain("12");
      expect(headerTop()).toBe(expandedEdge);
    });
  });

  it("deleting the run's first message leaves one header with the count reduced", () => {
    block(BOB.id);
    setMessages([msg(1), msg(2, BOB), msg(3, BOB), msg(4, BOB)]);
    mount();
    expect(run(2)!.textContent).toContain("3 blocked messages");

    deleteMessage({ channel_id: CHANNEL_ID, message_id: 2 });
    messagesStore.flush();

    expect(runs()).toHaveLength(1);
    expect(run(3)!.textContent).toContain("2 blocked messages");
    expect(run(2)).toBeNull();
  });

  it("an older page that adds blocked messages above an expanded run keeps it expanded", () => {
    block(BOB.id);
    const loaded = [msg(3, BOB), msg(4, BOB), msg(5)];
    setMessages(loaded);
    mount();
    toggle(3).click();
    expect(messageIds()).toEqual(["3", "4", "5"]);

    setMessages([msg(1, BOB), msg(2, BOB), ...loaded]);

    expect(run(3)).toBeNull();
    expect(run(1)!.textContent).toContain("4 blocked messages");
    expect(toggle(1).textContent).toBe("Hide");
    expect(messageIds()).toEqual(["1", "2", "3", "4", "5"]);
  });

  describe("reply bars", () => {
    it("a reply to a blocked parent shows 'Blocked message' with no author or excerpt, and still jumps", () => {
      block(BOB.id);
      options = makeOpts({ currentUserId: 99, onJumpToMessage: vi.fn() });
      setMessages([msg(1, BOB, { content: "secret words" }), msg(2, ALICE, { replyTo: 1 })]);
      mount();

      const bar = row(2)!.querySelector<HTMLElement>(".msg-reply-ref")!;
      expect(bar.classList.contains("msg-reply-ref--blocked")).toBe(true);
      expect(bar.textContent).toBe("Blocked message");
      expect(bar.querySelector(".rr-author, .rr-text, .rr-avatar")).toBeNull();
      expect(row(2)!.textContent).not.toContain("secret words");

      bar.click();
      expect(options.onJumpToMessage).toHaveBeenCalledWith(1);
    });

    it("a parent outside the loaded window is judged by its quoted author", () => {
      block(BOB.id);
      setMessages([
        msg(5, ALICE, {
          replyTo: 1,
          referencedMessage: {
            id: 1,
            content: "far away",
            user: BOB,
            deleted: false,
          } as Message["referencedMessage"],
        }),
      ]);
      mount();
      const bar = row(5)!.querySelector<HTMLElement>(".msg-reply-ref")!;
      expect(bar.textContent).toBe("Blocked message");
    });

    it("a reply to someone who is not blocked still quotes them", () => {
      block(CAROL.id);
      setMessages([msg(1, BOB, { content: "hello there" }), msg(2, ALICE, { replyTo: 1 })]);
      mount();
      const bar = row(2)!.querySelector<HTMLElement>(".msg-reply-ref")!;
      expect(bar.querySelector(".rr-author")!.textContent).toBe("bob");
      expect(bar.textContent).toContain("hello there");
    });

    it("a deleted blocked parent still reads 'Original message was deleted'", () => {
      block(BOB.id);
      setMessages([msg(1, BOB, { deleted: true }), msg(2, ALICE, { replyTo: 1 })]);
      mount();
      const bar = row(2)!.querySelector<HTMLElement>(".msg-reply-ref")!;
      expect(bar.textContent).toBe("Original message was deleted");
      expect(bar.classList.contains("msg-reply-ref--blocked")).toBe(false);
    });
  });
});
