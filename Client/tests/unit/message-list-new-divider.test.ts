/**
 * The "NEW" divider: a line above the first message the reader has not seen,
 * placed from the unread count the channel carried when it was opened (the
 * badge itself is cleared by the visit, so the count has to be snapshotted).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore, addMessage } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { setActiveChannel } from "@stores/channels.store";
import {
  makeListOptions,
  nextFrame,
  setMessages,
  setDetached as setChannelDetached,
  openChannel,
} from "../helpers/messageListHarness";
import { resetMessagesState, resetMembersState } from "../helpers/storeResets";
import { resetChannelsState } from "../helpers/storeSeeds";
import { buildMessage } from "../helpers/messageFactory";

const CHANNEL_ID = 1;

function resetStores(): void {
  resetMessagesState();
  resetMembersState();
  resetChannelsState();
}

function makeMessage(id: number): Message {
  return buildMessage(
    { id },
    {
      channelId: CHANNEL_ID,
      // Spaced past the 7-minute group window, so grouping never merges rows.
      timestamp: new Date(Date.UTC(2024, 0, 15, 12, id * 10)).toISOString(),
    },
  );
}

function setDetached(detached: boolean): void {
  setChannelDetached(CHANNEL_ID, detached);
}

/** Seed the channel list with `unread` unread messages, then "open" the channel
 *  the way the app does — which clears the badge and snapshots the count. */
function openChannelWithUnread(unread: number): void {
  openChannel(CHANNEL_ID, unread);
}

describe("MessageList — new-messages divider", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeListOptions({ channelId: CHANNEL_ID });
  });

  afterEach(() => {
    msgList?.destroy?.();
    msgList = null;
    container.remove();
  });

  function mount(): void {
    msgList = createMessageList(options);
    msgList.mount(container);
  }

  const dividerEl = (): Element | null =>
    container.querySelector('[data-testid="new-messages-divider"]');

  /** The rendered row node for each message id, to check node identity. */
  function rowNodes(ids: readonly number[]): (Element | null)[] {
    return ids.map((id) => container.querySelector(`[data-testid="message-${id}"]`));
  }

  function dividerIndex(): number {
    const rows = [...container.querySelectorAll(".virtual-content > *")];
    return rows.findIndex((el) => el.classList.contains("msg-new-divider"));
  }

  it("renders no divider when the channel was opened with nothing unread", () => {
    setMessages(CHANNEL_ID, [1, 2, 3].map(makeMessage));
    openChannelWithUnread(0);
    mount();

    expect(dividerEl()).toBeNull();
  });

  it("places the divider above the first unread message", () => {
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    mount();

    const divider = dividerEl();
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain("NEW");

    // The row right after the divider must be message 4 — the first of the
    // last two (unread) messages.
    const next = divider?.nextElementSibling as HTMLElement;
    expect(next.dataset.testid).toBe("message-4");
  });

  it("places the divider at the top when every loaded message is unread", () => {
    setMessages(CHANNEL_ID, [1, 2, 3].map(makeMessage));
    openChannelWithUnread(10);
    mount();

    // Index 0 is the day divider; the NEW line comes right after it and
    // before the first message.
    const idx = dividerIndex();
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = container.querySelectorAll(".virtual-content > *")[idx + 1] as HTMLElement;
    expect(next.dataset.testid).toBe("message-1");
  });

  it("renders exactly one divider", () => {
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(3);
    mount();

    expect(container.querySelectorAll('[data-testid="new-messages-divider"]')).toHaveLength(1);
  });

  it("renders no divider for an empty channel", () => {
    setMessages(CHANNEL_ID, []);
    openChannelWithUnread(5);
    mount();

    expect(dividerEl()).toBeNull();
  });

  // A detached window is a slice around some old message, so "the last N
  // loaded messages" no longer identifies the unread ones.
  it("suppresses the divider while the window is detached", () => {
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    setDetached(true);
    mount();

    expect(dividerEl()).toBeNull();
  });

  // A jump into another channel mounts the list first (not yet detached) and
  // only then installs the around-window.
  it("draws no divider in an around-window that lands after the mount", async () => {
    setMessages(CHANNEL_ID, [100].map(makeMessage));
    openChannelWithUnread(3);
    mount();

    setDetached(true);
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5, 6].map(makeMessage));
    await nextFrame();

    expect(dividerEl()).toBeNull();
  });

  it("restores the divider at the right place when the reader returns to the tail", async () => {
    setMessages(CHANNEL_ID, [100].map(makeMessage));
    openChannelWithUnread(3);
    mount();

    setDetached(true);
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5, 6].map(makeMessage));
    await nextFrame();
    expect(dividerEl()).toBeNull();

    setDetached(false);
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(makeMessage));
    await nextFrame();
    const divider = dividerEl();
    expect(divider).not.toBeNull();
    expect((divider!.nextElementSibling as HTMLElement).dataset.testid).toBe("message-8");
  });

  it("clears on the next visit to the channel", () => {
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    mount();
    expect(dividerEl()).not.toBeNull();

    // Leave and come back: the badge is gone now, so no divider.
    msgList?.destroy?.();
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    setActiveChannel(null);
    setActiveChannel(CHANNEL_ID);
    mount();

    expect(dividerEl()).toBeNull();
  });

  // Regression: firstUnreadIndex is messages.length - unreadOnOpen, an offset
  // from the end. A full rebuild after messages arrive during the visit used
  // to recompute that offset against the new (longer) length, sliding the
  // line down past the messages it was placed to mark.
  it("keeps the divider anchored to the same message across a rebuild after messages arrive", () => {
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(makeMessage));
    openChannelWithUnread(2);
    mount();

    const before = dividerEl()?.nextElementSibling as HTMLElement;
    expect(before.dataset.testid).toBe("message-4");

    // Three more messages arrive while the reader is on the channel, via the
    // real append path (addMessage), which preserves the existing rows'
    // identity — the append fast path handles this correctly on its own.
    // Store notifications are microtask-batched, so every step is flushed:
    // without that the assertions below read the DOM from mount() and pass
    // no matter what rebuildItems would have done.
    for (const id of [6, 7, 8]) {
      addMessage({
        id,
        channel_id: CHANNEL_ID,
        user: { id: 1, username: "Alice", avatar: null },
        content: `Message ${id}`,
        reply_to: null,
        attachments: [],
        timestamp: new Date(Date.UTC(2024, 0, 15, 12, id * 10)).toISOString(),
      });
    }
    messagesStore.flush();
    expect(container.querySelector('[data-testid="message-8"]')).not.toBeNull();
    const afterAppend = dividerEl()?.nextElementSibling as HTMLElement;
    expect(afterAppend.dataset.testid).toBe("message-4");

    // A non-append change (an edit) forces a full rebuild instead of the
    // append fast path — this is where the count-based offset used to drift.
    messagesStore.setState((prev) => {
      const list = prev.messagesByChannel.get(CHANNEL_ID)!;
      const next = list.map((m) => (m.id === 1 ? { ...m, content: "edited" } : m));
      const updated = new Map(prev.messagesByChannel);
      updated.set(CHANNEL_ID, next);
      return { ...prev, messagesByChannel: updated };
    });
    messagesStore.flush();

    const after = dividerEl()?.nextElementSibling as HTMLElement;
    expect(after.dataset.testid).toBe("message-4");
  });

  // Regression (OC-0258): a message arriving before the async history fetch
  // resolves must not latch the divider onto it. mountChannel starts with an
  // empty window (the fetch is in flight), so a live message landing first
  // produces a 1-row window — nowhere near long enough to contain the real
  // unread boundary — and resolveNewDividerIndex used to latch onto whatever
  // that 1-row formula pointed at (the live message itself) regardless.
  it("does not latch the divider onto a message that arrives before the history page loads", () => {
    openChannelWithUnread(3);
    mount(); // 0 rows: the async history fetch has not resolved yet.
    expect(dividerEl()).toBeNull();

    // A live message lands first, via the real append path — exactly what
    // dispatcher.ts's chat_message handler does while a history fetch for
    // the same channel is still outstanding.
    const liveTimestamp = new Date(Date.UTC(2024, 0, 15, 0, 51 * 10)).toISOString();
    addMessage({
      id: 1001,
      channel_id: CHANNEL_ID,
      user: { id: 1, username: "Alice", avatar: null },
      content: "Message 1001",
      reply_to: null,
      attachments: [],
      timestamp: liveTimestamp,
    });
    messagesStore.flush();

    // The history page then lands: 50 older messages plus the message that
    // had already arrived live, exactly as the real merge produces.
    const history = Array.from({ length: 50 }, (_, i) => ({
      ...makeMessage(951 + i),
      timestamp: new Date(Date.UTC(2024, 0, 15, 0, (i + 1) * 10)).toISOString(),
    }));
    setMessages(CHANNEL_ID, [...history, { ...makeMessage(1001), timestamp: liveTimestamp }]);
    messagesStore.flush();

    // The divider must separate the actual tail of the now-51-message window
    // (999/1000/1001) from history, not sit directly above message 1001 —
    // which would render 999 and 1000 as indistinguishable from read history.
    const divider = dividerEl();
    expect(divider).not.toBeNull();
    const next = divider?.nextElementSibling as HTMLElement;
    expect(next.dataset.testid).toBe("message-999");
  });

  // The server caps unread_count at 100, so a channel with 137 unread arrives
  // as 100. Pinning the divider "100 back from the newest" once 100 rows had
  // loaded would leave the 37 oldest unread messages above the line, rendered
  // as read, when the next page of history is prepended.
  it("keeps every unread message below the divider when the count is capped", async () => {
    const TOTAL = 200;
    const firstUnreadId = TOTAL - 137 + 1;
    const range = (from: number): Message[] =>
      Array.from({ length: TOTAL - from + 1 }, (_, i) => makeMessage(from + i));

    setMessages(CHANNEL_ID, range(TOTAL - 49));
    openChannelWithUnread(100);
    mount();

    for (const oldest of [TOTAL - 49, TOTAL - 99, TOTAL - 149]) {
      setMessages(CHANNEL_ID, range(oldest));
      messagesStore.flush();
      // Scroll to the top of the loaded window so the virtual list renders
      // the oldest rows, where the divider must sit.
      const root = container.querySelector(".messages-container") as HTMLDivElement;
      root.scrollTop = 0;
      root.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const rows = [...container.querySelectorAll(".virtual-content > *")] as HTMLElement[];
      const divider = dividerIndex();
      expect(divider).toBeGreaterThanOrEqual(0);
      const unreadAbove = rows
        .slice(0, divider)
        .filter((el) => Number(el.dataset.testid?.replace("message-", "")) >= firstUnreadId);
      expect(unreadAbove).toEqual([]);
      expect(rows[divider + 1]?.dataset.testid).toBe(`message-${oldest}`);
    }
  });

  // DP-10: a revisit mounts on the cached window while the refetch is in
  // flight. Those rows predate what arrived while away, so counting the unread
  // messages back from their end would mark rows the reader already saw.
  /** Mounts a revisit on five cached rows while the refetch is still loading; returns those row nodes. */
  function mountRevisitOnCachedWindow(): (Element | null)[] {
    setMessages(CHANNEL_ID, [1, 2, 3, 4, 5].map(makeMessage));
    messagesStore.setState((prev) => ({
      ...prev,
      historyLoadState: new Map([[CHANNEL_ID, "loading" as const]]),
    }));
    openChannelWithUnread(1);
    mount();
    expect(dividerEl()).toBeNull();
    return rowNodes([1, 2, 3, 4, 5]);
  }

  it("places the divider on a revisit only once the refetched tail lands", () => {
    const cachedRows = mountRevisitOnCachedWindow();

    // The refetch lands: the cached rows unchanged plus the one posted while away.
    messagesStore.setState((prev) => {
      const updated = new Map(prev.messagesByChannel);
      updated.set(CHANNEL_ID, [...prev.messagesByChannel.get(CHANNEL_ID)!, makeMessage(6)]);
      return { ...prev, messagesByChannel: updated, historyLoadState: new Map() };
    });
    messagesStore.flush();

    const divider = dividerEl();
    expect((divider?.nextElementSibling as HTMLElement | undefined)?.dataset.testid).toBe(
      "message-6",
    );
    // R2: the divider is inserted on its own; the rows already shown stay.
    cachedRows.forEach((el, i) => expect(rowNodes([i + 1])[0]).toBe(el));
  });

  // A DM's messages reach the cached window live while it is not open, so the
  // refetch can land with nothing to change; the divider must still appear.
  it("places a deferred divider when the revisit refetch lands unchanged", () => {
    const cachedRows = mountRevisitOnCachedWindow();

    messagesStore.setState((prev) => ({ ...prev, historyLoadState: new Map() }));
    messagesStore.flush();

    const divider = dividerEl();
    expect((divider?.nextElementSibling as HTMLElement | undefined)?.dataset.testid).toBe(
      "message-5",
    );
    cachedRows.forEach((el, i) => expect(rowNodes([i + 1])[0]).toBe(el));
  });

  // The line marks a boundary; the message under it must not be rendered as a
  // grouped continuation of the message above the line.
  it("breaks message grouping at the divider", () => {
    const sameMinute = [1, 2, 3].map((id) => ({
      ...makeMessage(id),
      timestamp: "2024-01-15T12:00:00Z",
    }));
    setMessages(CHANNEL_ID, sameMinute);
    openChannelWithUnread(1);
    mount();

    const divider = dividerEl();
    const first = divider?.nextElementSibling as HTMLElement;
    expect(first.dataset.testid).toBe("message-3");
    expect(first.classList.contains("grouped")).toBe(false);
    // The message before the line is still grouped — only the boundary breaks.
    expect(
      (container.querySelector('[data-testid="message-2"]') as HTMLElement).classList.contains(
        "grouped",
      ),
    ).toBe(true);
  });
});
