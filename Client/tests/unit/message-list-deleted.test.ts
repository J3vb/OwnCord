/**
 * WP 3A-8: a deleted message leaves the list. The store keeps the tombstone
 * (reply checks and the echo reconcile read it); MessageList filters it out
 * and the patch path removes the row, regroups its neighbour and holds the
 * reader's place.
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
import { messagesStore, deleteMessage, bulkDeleteMessages } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import { buildMessage } from "../helpers/messageFactory";

const CHANNEL_ID = 1;
const ME = { id: 1, username: "Alice", avatar: null };
const BOB = { id: 2, username: "Bob", avatar: null };

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
  setChannels([]);
  setActiveChannel(null);
}

function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return buildMessage(overrides, {
    channelId: CHANNEL_ID,
    user: ME,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, overrides.id)).toISOString(),
  });
}

/** Ten minutes apart (past the 7-minute group window), so no two rows group. */
function spaced(id: number): Message {
  return makeMessage({
    id,
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
  });
}

function setMessages(messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(CHANNEL_ID, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
}

function setHasMore(value: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.hasMore);
    next.set(CHANNEL_ID, value);
    return { ...prev, hasMore: next };
  });
}

const del = (id: number): void => {
  deleteMessage({ channel_id: CHANNEL_ID, message_id: id });
  messagesStore.flush();
};

describe("MessageList — deleted messages leave the list", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;

  const row = (id: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid='message-${id}']`);
  const stored = (): readonly Message[] => messagesStore.getState().messagesByChannel.get(1)!;
  const mount = (): void => {
    list = createMessageList(options);
    list.mount(container);
  };

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
      onEditSave: vi.fn(() => true),
      onEmptyEdit: vi.fn(),
      onEditEnd: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
  });

  it("a message deleted while the list is open loses its row, and the store keeps the tombstone", () => {
    setMessages([1, 2, 3].map(spaced));
    mount();
    expect(row(2)).not.toBeNull();

    del(2);

    expect(row(2)).toBeNull();
    expect(row(1)).not.toBeNull();
    expect(row(3)).not.toBeNull();
    expect(container.textContent).not.toContain("[message deleted]");
    // The tombstone is still in the store: reply checks and the dedup reconcile read it.
    expect(stored().find((m) => m.id === 2)?.deleted).toBe(true);
  });

  it("history holding a tombstone renders one row fewer", () => {
    setMessages([1, 2, 3, 4].map((id) => ({ ...spaced(id), deleted: id === 3 })));
    mount();

    const ids = [...container.querySelectorAll("[data-testid^='message-']")].map(
      (el) => (el as HTMLElement).dataset.testid,
    );
    expect(ids).toEqual(["message-1", "message-2", "message-4"]);
  });

  it("the row after a deleted one shows its author when the row above is someone else's", () => {
    setMessages([
      makeMessage({ id: 1 }),
      makeMessage({ id: 2, user: BOB }),
      makeMessage({ id: 3, user: BOB }),
      makeMessage({ id: 4, user: BOB }),
    ]);
    mount();
    const [row1, row3, row4] = [row(1), row(3), row(4)];
    expect(row3!.classList.contains("grouped")).toBe(true);

    del(2);

    expect(row(3)).not.toBe(row3);
    expect(row(3)!.classList.contains("grouped")).toBe(false);
    expect(row(3)!.querySelector(".msg-author")).not.toBeNull();
    expect(row(1)).toBe(row1);
    expect(row(4)).toBe(row4);
  });

  it("the row after a deleted one stays grouped, and untouched, when the earlier row still matches", () => {
    setMessages([1, 2, 3].map((id) => makeMessage({ id })));
    mount();
    const [row1, row3] = [row(1), row(3)];
    expect(row3!.classList.contains("grouped")).toBe(true);

    del(2);

    expect(row(2)).toBeNull();
    expect(row(1)).toBe(row1);
    expect(row(3)).toBe(row3);
    expect(row(3)!.classList.contains("grouped")).toBe(true);
  });

  it("deleting the last message of a day takes its day divider with it", () => {
    setMessages([
      makeMessage({ id: 1 }),
      makeMessage({ id: 2 }),
      makeMessage({ id: 3, timestamp: "2024-01-16T12:00:00Z" }),
    ]);
    mount();
    expect(container.querySelectorAll(".msg-day-divider")).toHaveLength(2);

    del(3);

    expect(row(3)).toBeNull();
    expect(container.querySelectorAll(".msg-day-divider")).toHaveLength(1);
    expect(row(2)).not.toBeNull();
  });

  it("a bulk delete of three rows removes all three in one patch and keeps the other rows", () => {
    setMessages([1, 2, 3, 4, 5, 6].map(spaced));
    mount();
    const [row1, row5, row6] = [row(1), row(5), row(6)];

    bulkDeleteMessages({ channel_id: CHANNEL_ID, ids: [2, 3, 4] });
    messagesStore.flush();

    expect([2, 3, 4].map((id) => row(id))).toEqual([null, null, null]);
    // Patched, not rebuilt: the rows that stay are the same nodes.
    expect(row(1)).toBe(row1);
    expect(row(5)).toBe(row5);
    expect(row(6)).toBe(row6);
  });

  describe("scrolled up", () => {
    let scrollHeightDescriptor: PropertyDescriptor | undefined;
    let offsetHeightDescriptor: PropertyDescriptor | undefined;
    beforeEach(() => {
      scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollHeight",
      );
      offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "offsetHeight",
      );
      // jsdom lays nothing out: a tall scroller, and fixed row heights.
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get: () => 100_000,
      });
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get(this: HTMLElement): number {
          return this.classList.contains("message") ? 100 : 32;
        },
      });
    });
    afterEach(() => {
      for (const [name, d] of [
        ["scrollHeight", scrollHeightDescriptor],
        ["offsetHeight", offsetHeightDescriptor],
      ] as const) {
        if (d) Object.defineProperty(HTMLElement.prototype, name, d);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    });

    /** Px between the top of the view and `id`'s row, from the spacer and the rows above it. */
    function offsetOf(id: number): number {
      const root = container.querySelector<HTMLElement>(".messages-container")!;
      const rows = [...container.querySelectorAll<HTMLElement>(".virtual-content > *")];
      const at = rows.indexOf(row(id)!);
      const above = rows.slice(0, at).reduce((h, el) => h + el.offsetHeight, 0);
      const spacer = parseFloat(
        container.querySelector<HTMLElement>(".virtual-spacer-top")!.style.height,
      );
      return spacer + above - root.scrollTop;
    }

    it("removing a row above the view keeps the top visible row where it was", () => {
      setMessages(Array.from({ length: 60 }, (_, i) => spaced(i + 1)));
      mount();
      const root = container.querySelector<HTMLElement>(".messages-container")!;
      // Read from the middle: row 30 is the first row under the top edge.
      root.scrollTop = 3300;
      root.dispatchEvent(new Event("scroll"));
      messagesStore.flush();
      const topId = [...container.querySelectorAll<HTMLElement>(".virtual-content > .message")]
        .map((el) => Number(el.dataset.testid!.replace("message-", "")))
        .find((id) => offsetOf(id) >= 0)!;
      const before = offsetOf(topId);
      expect(row(5)).not.toBeNull();

      del(5);

      expect(row(5)).toBeNull();
      expect(offsetOf(topId)).toBe(before);
    });
  });

  describe("the NEW line", () => {
    function openWithUnread(unread: number): void {
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
    const divider = (): HTMLElement | null =>
      container.querySelector<HTMLElement>("[data-testid='new-messages-divider']");

    it("moves to the next message when the message it sat above is deleted", () => {
      setMessages([1, 2, 3, 4, 5].map(spaced));
      openWithUnread(3);
      mount();
      expect(divider()?.nextElementSibling).toBe(row(3));

      del(3);

      expect(row(3)).toBeNull();
      expect(divider()).not.toBeNull();
      expect(divider()!.nextElementSibling).toBe(row(4));
    });

    it("is dropped when the message it sat above was the last one", () => {
      setMessages([1, 2, 3].map(spaced));
      openWithUnread(1);
      mount();
      expect(divider()?.nextElementSibling).toBe(row(3));

      del(3);

      expect(divider()).toBeNull();
      expect(row(2)).not.toBeNull();
    });
  });

  it("with every loaded row deleted and older history on the server, it loads more instead of welcoming", () => {
    setMessages([1, 2].map((id) => ({ ...spaced(id), deleted: true })));
    setHasMore(true);

    mount();

    expect(options.onScrollTop).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".channel-welcome")).toBeNull();
    expect(container.querySelector(".messages-loading")).not.toBeNull();
  });

  it("with every loaded row deleted and nothing older, it shows the welcome state", () => {
    setMessages([1, 2].map((id) => ({ ...spaced(id), deleted: true })));
    setHasMore(false);

    mount();

    expect(options.onScrollTop).not.toHaveBeenCalled();
    expect(container.querySelector(".channel-welcome")).not.toBeNull();
  });

  it("focus on a deleted row's control moves to the next row", () => {
    setMessages([1, 2, 3].map(spaced));
    mount();
    const reply = container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-2']")!;
    reply.focus();
    expect(document.activeElement).toBe(reply);

    del(2);

    expect(row(2)).toBeNull();
    expect(row(3)!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("focus on the last row's control moves up when that row is deleted", () => {
    setMessages([1, 2, 3].map(spaced));
    mount();
    container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-3']")!.focus();

    del(3);

    expect(row(2)!.contains(document.activeElement)).toBe(true);
  });

  describe("replies to a deleted message", () => {
    const parentRef = (deleted: boolean): NonNullable<Message["referencedMessage"]> => ({
      id: 1,
      user: deleted ? null : ME,
      content: deleted ? "" : "the parent text",
      deleted,
      has_attachments: false,
    });

    it("read 'Original message was deleted': plain text, no avatar, not a jump link", () => {
      const onJump = vi.fn();
      options = { ...options, onJumpToMessage: onJump };
      setMessages([
        { ...spaced(1), deleted: true },
        { ...spaced(2), replyTo: 1, referencedMessage: parentRef(true) },
      ]);
      mount();

      const ref = row(2)!.querySelector<HTMLElement>(".msg-reply-ref")!;
      expect(ref.textContent).toBe("Original message was deleted");
      expect(ref.classList.contains("msg-reply-ref--deleted")).toBe(true);
      expect(ref.getAttribute("role")).toBeNull();
      expect(ref.querySelector(".rr-avatar, .rr-author")).toBeNull();
      ref.click();
      ref.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(onJump).not.toHaveBeenCalled();
    });

    it("re-render live when their parent is deleted", () => {
      setMessages([spaced(1), { ...spaced(2), replyTo: 1, referencedMessage: parentRef(false) }]);
      mount();
      const before = row(2)!.querySelector(".msg-reply-ref")!;
      expect(before.querySelector(".rr-text")?.textContent).toBe("Message 1");

      del(1);

      expect(row(1)).toBeNull();
      const after = row(2)!.querySelector(".msg-reply-ref")!;
      expect(after.textContent).toBe("Original message was deleted");
      expect(after.querySelector(".rr-avatar")).toBeNull();
    });

    it("re-render live even when the reply carries no server snippet", () => {
      // Nothing redacts this reply's snippet, so only the list's own check of
      // its parent leaving the window can redraw it.
      setMessages([spaced(1), { ...spaced(2), replyTo: 1 }]);
      mount();
      const reply = row(2)!;
      expect(reply.querySelector(".msg-reply-ref .rr-text")?.textContent).toBe("Message 1");

      del(1);

      expect(row(2)).not.toBe(reply);
      expect(row(2)!.querySelector(".rr-text")).toBeNull();
    });
  });

  // Edge case 2 of the design note: the edited message, or the one above it, is deleted.
  describe("deleting under an open inline editor", () => {
    const editor = (id: number): HTMLTextAreaElement | null =>
      container.querySelector<HTMLTextAreaElement>(`[data-testid='msg-edit-input-${id}']`);
    async function openEditor(id: number): Promise<HTMLTextAreaElement> {
      expect(list!.startEdit(id)).toBe(true);
      await vi.waitFor(() => expect(editor(id)).not.toBeNull());
      return editor(id)!;
    }

    it("chat_deleted for the edited message closes the editor and focuses the composer", async () => {
      setMessages([1, 2, 3].map(spaced));
      mount();
      const textarea = await openEditor(2);
      textarea.focus();
      expect(document.activeElement).toBe(textarea);

      del(2);

      expect(row(2)).toBeNull();
      expect(editor(2)).toBeNull();
      expect(list!.isEditing()).toBe(false);
      // The host hands focus to the composer; no toast, no extra callback.
      expect(options.onEditEnd).toHaveBeenCalledTimes(1);
    });

    it("chat_deleted for the message above regroups the edited row and keeps its editor and text", async () => {
      setMessages([
        makeMessage({ id: 1, user: BOB }),
        makeMessage({ id: 2 }),
        makeMessage({ id: 3 }),
      ]);
      mount();
      const textarea = await openEditor(3);
      textarea.value = "half-typed edit";
      textarea.focus();
      textarea.setSelectionRange(4, 9);
      expect(row(3)!.classList.contains("grouped")).toBe(true);

      del(2);

      expect(row(2)).toBeNull();
      // Row 3 now follows Bob's message, so it shows its author, and the same
      // textarea (value, selection, focus) was moved into the new row.
      expect(row(3)!.classList.contains("grouped")).toBe(false);
      expect(editor(3)).toBe(textarea);
      expect(row(3)!.contains(textarea)).toBe(true);
      expect(textarea.value).toBe("half-typed edit");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 9]);
      expect(document.activeElement).toBe(textarea);
      expect(list!.isEditing()).toBe(true);
      expect(options.onEditEnd).not.toHaveBeenCalled();
    });
  });
});
