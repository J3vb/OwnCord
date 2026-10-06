import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// P4-01 R3: a revisit keeps the older history the reader had loaded. The
// revisit's one refetch asks for enough rows to reach back to the oldest cached
// row (capped at the server's 100-row page), so every row it keeps is
// revalidated by that request: an edit made while away shows, a delete made
// while away is gone, and the older rows need no second request or rebuild.

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
  };
}

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createMessageController } from "../../src/pages/main-page/MessageController";
import type { MessageControllerOptions } from "../../src/pages/main-page/MessageController";
import { createMessageList } from "@components/MessageList";
import {
  getChannelMessages,
  hasMoreMessages,
  invalidateChannelMessageWindow,
  messagesStore,
  reattachToPresent,
  resetMessagesStore,
  setAroundMessages,
  setChannelLoading,
  setMessages,
} from "@stores/messages.store";
import { setActiveChannel, setChannels } from "@stores/channels.store";
import type { MessageResponse } from "../../src/lib/types";

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
  async (_channelId: number, opts?: { before?: number; limit?: number }) => {
    const limit = Math.min(opts?.limit ?? 50, 100);
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

describe("revisit keeps and revalidates older loaded history (P4-01 R3)", () => {
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

  it("caps the request at the server's 100-row page", async () => {
    server = rows(1, 300);
    cacheWindow(151, 300); // 150 rows loaded
    openWithUnread(0);

    await controller().loadMessages(CH, new AbortController().signal);

    expect(limitAsked()).toBe(100);
    expect(ids()[0]).toBe(201);
    expect(ids().at(-1)).toBe(300);
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

    expect(limitAsked()).toBe(50);
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

  describe("with the list mounted", () => {
    let container: HTMLDivElement;
    let list: ReturnType<typeof createMessageList>;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    afterEach(() => {
      list.destroy?.();
      container.remove();
    });

    it("keeps the rendered rows' nodes and the older rows through the revisit's refetch", async () => {
      cacheWindow(126, 200);
      server = rows(1, 205).filter((m) => m.id !== 140);
      openWithUnread(5);
      // ChannelController mounts the list over the cached rows, then loads.
      setChannelLoading(CH);
      list = createMessageList({
        channelId: CH,
        channelName: "general",
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
        onPinClick: vi.fn(),
      });
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
