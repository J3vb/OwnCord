import { describe, it, expect, vi, type Mock } from "vitest";
import { fakeTimersTest } from "../../helpers/fakeTimersTest";
import * as mocks from "../../helpers/messageListMocks";
import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import {
  makeMessage,
  setMessages,
  setHasMore,
  MessageListComponent,
  useMessageListHarness,
} from "../../helpers/messageListHarness";

vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);

/** An onScrollTop whose fetch stays pending until `resolveLoad` is called. */
function pendingScrollTop(): { onScrollTop: Mock<() => Promise<void>>; resolveLoad: () => void } {
  let resolveLoad: () => void = () => {};
  const onScrollTop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
  );
  return { onScrollTop, resolveLoad: () => resolveLoad() };
}

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
    const { onScrollTop, resolveLoad } = pendingScrollTop();
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

  it(
    "after a failed older-page fetch, scrolling inside the zone waits 5s before retrying",
    fakeTimersTest(async () => {
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
    }),
  );

  it("does not re-trigger onScrollTop from a live tail append while a history fetch is in flight", async () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 1 })]);
    messagesStore.flush();

    const { onScrollTop, resolveLoad } = pendingScrollTop();
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

  it("starts loading older history about 1.5 viewports before the top, once", () => {
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

  it("shows a loading row at the top while the older page is pending, on success and failure", async () => {
    setHasMore(1, true);
    setMessages(1, [makeMessage({ id: 10 })]);
    messagesStore.flush();
    const { onScrollTop, resolveLoad } = pendingScrollTop();
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
      // Alice, then Bob a minute apart: Bob's second and third rows are grouped.
      const bob = (id: number): Message =>
        makeMessage({
          id,
          user: { id: 2, username: "Bob", avatar: null },
          timestamp: new Date(Date.UTC(2024, 0, 15, 12, id)).toISOString(),
        });
      setMessages(1, [
        makeMessage({ id: 1, timestamp: new Date(Date.UTC(2024, 0, 15, 12, 1)).toISOString() }),
        bob(2),
        bob(3),
        bob(4),
      ]);
      msgList.mount(container);
      const [row1, row3, row4] = [row(1), row(3), row(4)];
      expect(row3!.classList.contains("grouped")).toBe(true);

      replace(2, { deleted: true });

      // The deleted row leaves the list (the store keeps its tombstone).
      expect(row(2)).toBeNull();
      expect(row(1)).toBe(row1);
      expect(row(4)).toBe(row4);
      // The row under it now follows Alice's message, so it shows its author.
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
});
