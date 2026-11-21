import { describe, it, expect, vi, beforeEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";
import { useMountContainer } from "../helpers/mountContainer";

// P4-01 R3: a revisit keeps the older history the reader had loaded. The
// revisit pages backwards from the newest message (100-row server pages) until
// the fetched range reaches the oldest cached row, so every row it keeps is
// revalidated: an edit made while away shows, a delete made while away is
// gone, and the older rows need no rebuild.

vi.mock("@lib/logger", () => loggerMock());

import { createMessageController } from "../../src/features/messaging/MessageController";
import type { MessageControllerOptions } from "../../src/features/messaging/MessageController";
import { createDeferred } from "../helpers/deferred";
import { createMessageList } from "../../src/features/messaging/MessageList";
import { makeListOptions } from "../helpers/messageListHarness";
import {
  getChannelMessages,
  getHistoryLoadState,
  hasMoreMessages,
  invalidateChannelMessageWindow,
  isWindowDetached,
  messagesStore,
  reattachToPresent,
  resetMessagesStore,
  setAroundMessages,
  setChannelLoading,
  setMessages,
} from "@stores/messages.store";
import { setActiveChannel, setChannels } from "@stores/channels.store";
import { applyReadyMessageResync } from "../../src/features/messaging/readyResync";
import type { DispatchApi, ReconnectClock } from "../../src/features/connection/dispatchContext";
import { registerReadingAnchor } from "../../src/features/messaging/readingAnchor";
import type { MessageResponse } from "../../src/lib/types";
import "../helpers/resizeObserverStub";

const CH = 1;

function row(id: number, content = `m${id}`): MessageResponse {
  return {
    id,
    channel_id: CH,
    user: { id: 2, username: "bob", avatar: null },
    content,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: new Date(Date.UTC(2026, 2, 15, 9, 0, id)).toISOString(),
  };
}

/** Oldest-first ids from..to inclusive. */
function rows(from: number, to: number): MessageResponse[] {
  return Array.from({ length: to - from + 1 }, (_, i) => row(from + i));
}

/** The server's history, oldest-first; GET /messages semantics, limit clamped to 100. */
let server: MessageResponse[] = [];
const getMessages = vi.fn(
  async (_channelId: number, opts?: { before?: number; after?: number; limit?: number }) => {
    const limit = Math.min(opts?.limit ?? 50, 100);
    if (opts?.after !== undefined) {
      const following = server.filter((m) => m.id > opts.after!);
      return { messages: following.slice(0, limit), has_more: following.length > limit };
    }
    const before = opts?.before ?? 0;
    const eligible = server.filter((m) => before === 0 || m.id < before);
    return {
      messages: eligible.slice(-limit).toReversed(),
      has_more: eligible.length > limit,
    };
  },
);

function controller() {
  return createMessageController({
    api: { getMessages } as unknown as MessageControllerOptions["api"],
    showError: vi.fn(),
  });
}

/** The reader had rows from..to loaded, then left the channel. */
function cacheWindow(from: number, to: number): void {
  setMessages(CH, rows(from, to).toReversed(), true);
  invalidateChannelMessageWindow(CH);
}

/** The reader comes back to the channel with `unread` messages waiting. */
function openWithUnread(unread: number): void {
  setChannels([
    { id: CH, name: "general", type: "text", category: null, position: 0, unread_count: unread },
  ]);
  setActiveChannel(CH);
}

const ids = (): number[] => getChannelMessages(CH).map((m) => m.id);
const limitAsked = (): number | undefined => getMessages.mock.calls.at(-1)?.[1]?.limit;

/**
 * Open the cached channel and, while its tail refetch is held, load the
 * older page above the cached head; then let the refetch land. A request
 * `failing` picks rejects.
 */
async function olderPageDuringRefetch(failing?: (before?: number) => boolean): Promise<void> {
  const real = getMessages.getMockImplementation()!;
  const gate = createDeferred();
  getMessages.mockImplementation(async (channelId, opts) => {
    if (opts?.before === undefined) await gate.promise;
    if (failing?.(opts?.before)) throw new Error("offline");
    return real(channelId, opts);
  });
  try {
    openWithUnread(0);
    const head = ids()[0]!;
    const ctrl = controller();
    const signal = new AbortController().signal;
    const refetch = ctrl.loadMessages(CH, signal);
    await ctrl.loadOlderMessages(CH, signal);
    expect(ids()[0]).toBe(head - 50);
    gate.resolve();
    await refetch;
  } finally {
    getMessages.mockImplementation(real);
  }
}

describe("revisit keeps and revalidates older loaded history", () => {
  beforeEach(() => {
    resetMessagesStore();
    getMessages.mockClear();
    server = rows(1, 200);
  });

  it("asks a revisit for the server's full page, so it reaches back to the oldest cached row", async () => {
    cacheWindow(126, 200); // 75 rows loaded
    server = rows(1, 205); // 5 posted while away
    openWithUnread(5);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(limitAsked()).toBe(100);
  });

  it("keeps the cached history when messages arrived unseen (local unread is 0)", async () => {
    // Posted while the reader was in another channel: the client was not
    // subscribed to this topic, so no unread was counted locally.
    cacheWindow(126, 200);
    server = rows(1, 220);
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(ids()[0]).toBe(126);
    expect(ids().at(-1)).toBe(220);
    expect(ids()).toHaveLength(95);
  });

  it("keeps the older cached rows as the same objects, revalidated by that one request", async () => {
    cacheWindow(126, 200);
    const cached = getChannelMessages(CH);
    // While away: 201-205 posted, 140 deleted, 130 edited.
    server = rows(1, 205)
      .filter((m) => m.id !== 140)
      .map((m) =>
        m.id === 130 ? { ...m, content: "edited", edited_at: "2026-03-15T10:00:00Z" } : m,
      );
    openWithUnread(5);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(getMessages).toHaveBeenCalledTimes(1);
    const expected = [...rows(126, 205)].map((m) => m.id).filter((id) => id !== 140);
    expect(ids()).toEqual(expected);
    // Unchanged rows keep their object, so the list keeps their DOM and height.
    expect(getChannelMessages(CH)[0]).toBe(cached.find((m) => m.id === 126));
    expect(getChannelMessages(CH).find((m) => m.id === 150)).toBe(cached.find((m) => m.id === 150));
    // Nothing deleted or edited while away is presented as current.
    expect(ids()).not.toContain(140);
    expect(getChannelMessages(CH).find((m) => m.id === 130)!.content).toBe("edited");
    expect(hasMoreMessages(CH)).toBe(true);
  });

  it("drops rows the page brought from above the cached window, so the window keeps its head", async () => {
    cacheWindow(126, 200);
    server = rows(1, 205);
    // The unread count over-estimates what arrived (10 vs 5), so the page
    // reaches five rows past the oldest cached one.
    openWithUnread(10);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(limitAsked()).toBe(100);
    expect(ids()[0]).toBe(126);
    expect(ids().at(-1)).toBe(205);
    // The rows left out are still there to scroll up to.
    expect(hasMoreMessages(CH)).toBe(true);
  });

  it("pages back to keep a cached window larger than the newest server page", async () => {
    server = rows(1, 300);
    cacheWindow(151, 300); // 150 rows loaded
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(limitAsked()).toBe(100);
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(ids()[0]).toBe(151);
    expect(ids().at(-1)).toBe(300);
    expect(ids()).toHaveLength(150);
  });

  it("keeps a cached window spanning several server pages", async () => {
    server = rows(1, 300);
    cacheWindow(1, 300); // 300 rows loaded
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(getMessages).toHaveBeenCalledTimes(3);
    expect(ids()).toEqual([...rows(1, 300)].map((m) => m.id));
  });

  it("keeps the pages it fetched when an optional older page fails", async () => {
    server = rows(1, 300);
    cacheWindow(151, 300); // 150 rows loaded
    openWithUnread(0);
    const real = getMessages.getMockImplementation()!;
    getMessages.mockImplementation(async (channelId, opts) => {
      if (opts?.before) throw new Error("offline");
      return real(channelId, opts);
    });
    const showError = vi.fn();
    const ctrl = createMessageController({
      api: { getMessages } as unknown as MessageControllerOptions["api"],
      showError,
    });
    try {
      await ctrl.loadMessages(CH, new AbortController().signal);
    } finally {
      getMessages.mockImplementation(real);
    }

    // The first, revalidating page (201..300) is installed rather than thrown
    // away by the failed optional page; more history is reported above it.
    expect(ids()).toEqual([...rows(201, 300)].map((m) => m.id));
    expect(hasMoreMessages(CH)).toBe(true);
    expect(getHistoryLoadState(CH)).toBeNull();
    expect(isWindowDetached(CH)).toBe(false);
    expect(showError).not.toHaveBeenCalled();
  });

  it("drops the stale cache when the unseen gap outruns the paging bound", async () => {
    server = rows(1, 1000);
    cacheWindow(1, 10); // 10 rows loaded
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    // Five 100-row pages reach back to 501 but not to the cached head at 1, and
    // a gap that wide cannot be bridged: the freshly fetched range stays and the
    // stale cached rows below it are dropped honestly.
    expect(getMessages).toHaveBeenCalledTimes(5);
    expect(ids()[0]).toBe(501);
    expect(ids().at(-1)).toBe(1000);
    expect(ids()).toHaveLength(500);
  });

  it("asks a first visit for one 50-row page", async () => {
    openWithUnread(100);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(limitAsked()).toBe(50);
  });

  it("keeps the fetched tail when the extended page is entirely below the cached head", async () => {
    cacheWindow(101, 200); // 100 rows loaded
    server = rows(1, 100); // a purge removed every row the reader had cached
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(limitAsked()).toBe(100);
    expect(ids()).toEqual([...rows(1, 100)].map((m) => m.id));
  });

  it("refetches a plain 50-row page when jumping back to present from a detached window", async () => {
    setAroundMessages(CH, rows(1, 80), false, true);
    reattachToPresent(CH);
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    // The first request is the page itself; the re-attach then asks what follows it.
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(getMessages.mock.calls[0]?.[1]?.limit).toBe(50);
    expect(getMessages.mock.calls[1]?.[1]?.after).toBe(ids().at(-1));
    expect(ids()[0]).toBe(151);
  });

  it("does not trim a default-size page (a retry after a failed first load keeps what it fetched)", async () => {
    // A live row landed while the first load had failed; the retry's page
    // reaches far past it and every row it brought stays.
    messagesStore.setState((prev) => {
      const m = new Map(prev.messagesByChannel);
      m.set(CH, [
        {
          id: 200,
          channelId: CH,
          user: { id: 2, username: "bob", avatar: null },
          content: "m200",
          replyTo: null,
          attachments: [],
          reactions: [],
          pinned: false,
          editedAt: null,
          deleted: false,
          timestamp: row(200).timestamp,
          status: "sent",
          correlationId: null,
          errorCode: null,
        },
      ]);
      return { ...prev, messagesByChannel: m };
    });
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(limitAsked()).toBe(100);
    expect(ids()).toHaveLength(50);
    expect(ids()[0]).toBe(151);
  });

  it("keeps an older page the reader scrolled to while the refetch was in flight", async () => {
    cacheWindow(151, 200);

    await olderPageDuringRefetch();

    // The page read after the refetch began is as fresh as it: it stays above
    // the reader instead of being dropped and asked for again.
    expect(ids()).toEqual([...rows(101, 200)].map((m) => m.id));
    expect(hasMoreMessages(CH)).toBe(true);
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it("drops a cached row deleted while away when it keeps the older page", async () => {
    server = rows(1, 250).filter((m) => m.id !== 151);
    cacheWindow(151, 250);

    await olderPageDuringRefetch();

    // The refetch reached past the cached head and no longer holds 151, so
    // the kept window must not either.
    expect(ids()).not.toContain(151);
    expect(ids()).toEqual([...rows(101, 250)].map((m) => m.id).filter((id) => id !== 151));
    // The tail refetch, the older page, then one revalidation of the rows the
    // splice kept above the refetched range.
    expect(getMessages).toHaveBeenCalledTimes(3);
    expect(getMessages.mock.calls[2]?.[1]).toEqual({ before: 150, limit: 100 });
  });

  it("drops that older page when the refetch does not reach the cached head", async () => {
    server = rows(1, 300);
    cacheWindow(151, 300);

    await olderPageDuringRefetch((before) => before === 201);

    // 151..200 were not revalidated, so nothing below the fetched range may
    // stay: a kept older page would sit across a gap.
    expect(ids()).toEqual([...rows(201, 300)].map((m) => m.id));
    expect(hasMoreMessages(CH)).toBe(true);
  });

  it("keeps the rows the reader is on when the kept older page passes the row cap", async () => {
    server = rows(1, 820);
    cacheWindow(351, 800);
    const unregister = registerReadingAnchor((channelId) => (channelId === CH ? 305 : null));
    try {
      await olderPageDuringRefetch();
    } finally {
      unregister();
    }

    // 321..820 plus the kept 301..320 is 520 rows: the newest end goes, not
    // the rows the reader scrolled up to, and the window detaches.
    expect(ids()).toEqual([...rows(301, 800)].map((m) => m.id));
    expect(isWindowDetached(CH)).toBe(true);
  });

  it("leaves the kept rows alone when the revisit is aborted during their revalidation", async () => {
    server = rows(1, 250);
    cacheWindow(151, 250);
    const real = getMessages.getMockImplementation()!;
    const tailGate = createDeferred();
    const recheckGate = createDeferred();
    getMessages.mockImplementation(async (channelId, opts) => {
      if (opts?.before === undefined) await tailGate.promise;
      if (opts?.before === 151 && opts.limit === 100) await recheckGate.promise;
      return real(channelId, opts);
    });
    try {
      openWithUnread(0);
      const ctrl = controller();
      const abort = new AbortController();
      const refetch = ctrl.loadMessages(CH, abort.signal);
      await ctrl.loadOlderMessages(CH, abort.signal);
      tailGate.resolve();
      await refetch;
      // The reader leaves while the kept rows are being checked; the server
      // has since lost one of them.
      server = server.filter((m) => m.id !== 120);
      abort.abort();
      recheckGate.resolve();
      for (let i = 0; i < 30; i++) await Promise.resolve();

      expect(ids()).toContain(120);
      expect(ids()[0]).toBe(101);
    } finally {
      getMessages.mockImplementation(real);
    }
  });

  describe("a full-ready resync during the revisit's refetch", () => {
    const clock = (): ReconnectClock => ({ hasReceivedReadyBefore: true }) as ReconnectClock;
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };

    for (const first of ["revisit", "resync"] as const) {
      it(`keeps the older page the reader loaded when the ${first} lands first`, async () => {
        server = rows(1, 260);
        cacheWindow(151, 200);
        const real = getMessages.getMockImplementation()!;
        const revisitGate = createDeferred();
        const resyncGate = createDeferred();
        let tails = 0;
        getMessages.mockImplementation(async (channelId, opts) => {
          if (opts?.before === undefined) {
            tails++;
            await (tails === 1 ? revisitGate.promise : resyncGate.promise);
          }
          return real(channelId, opts);
        });
        try {
          openWithUnread(0);
          const ctrl = controller();
          const signal = new AbortController().signal;
          const revisit = ctrl.loadMessages(CH, signal);
          await ctrl.loadOlderMessages(CH, signal);
          expect(ids()[0]).toBe(101);
          // 60 messages arrived during the outage, more than the resync's page.
          applyReadyMessageResync({ getMessages } as unknown as DispatchApi, clock());
          const gates = first === "revisit" ? [revisitGate, resyncGate] : [resyncGate, revisitGate];
          for (const gate of gates) {
            gate.resolve();
            await settle();
          }
          await revisit;
          await settle();

          // One unbroken window from at least the reader's page to the newest
          // row (the revisit may have paged further back than the older page).
          const top = ids()[0]!;
          expect(top).toBeLessThanOrEqual(101);
          expect(ids()).toEqual([...rows(top, 260)].map((m) => m.id));
          expect(isWindowDetached(CH)).toBe(false);
        } finally {
          getMessages.mockImplementation(real);
        }
      });
    }
  });

  describe("with the list mounted", () => {
    let container: HTMLDivElement;
    let list: ReturnType<typeof createMessageList>;

    useMountContainer(
      (c) => {
        container = c;
      },
      () => list.destroy?.(),
    );

    it("keeps the rendered rows' nodes and the older rows through the revisit's refetch", async () => {
      cacheWindow(126, 200);
      server = rows(1, 205).filter((m) => m.id !== 140);
      openWithUnread(5);
      // ChannelController mounts the list over the cached rows, then loads.
      setChannelLoading(CH);
      list = createMessageList(makeListOptions({ channelId: CH }));
      list.mount(container);
      const node = (id: number): Element | null =>
        container.querySelector(`[data-testid='message-${id}']`);
      const before = node(200);
      expect(before).not.toBeNull();

      await controller().loadMessages(CH, new AbortController().signal);
      messagesStore.flush();

      // No rebuild: the row on screen is the same node.
      expect(node(200)).toBe(before);
      expect(node(205)).not.toBeNull();
      expect(ids()[0]).toBe(126);
    });
  });
});
