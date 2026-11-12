/**
 * An edit, delete or pin that arrives while an older, newer, tail or around
 * page is in flight is replayed onto that page when it lands, and a live
 * message refused while a detached window re-attaches is fetched afterwards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";
vi.mock("@lib/logger", () => loggerMock());

import { createMessageController } from "../../src/pages/main-page/MessageController";
import { createMessageJumper } from "../../src/pages/main-page/MessageJump";
import {
  addMessage,
  deleteMessage,
  getChannelMessages,
  holdLoadJournal,
  messagesStore,
  reattachToPresent,
  releaseLoadJournal,
  setAroundMessages,
  setChannelLoading,
  setMessagePinned,
  setMessages,
} from "../../src/stores/messages.store";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import type { ApiClient } from "../../src/lib/api";
import type { MessageResponse } from "../../src/lib/types";
import { buildResponse as response, buildBroadcast as broadcast } from "../helpers/messageFactory";

type Page = { messages: MessageResponse[]; has_more: boolean };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const rowsOf = (id: number) => getChannelMessages(1).find((m) => m.id === id);
const journalOpen = (): boolean => messagesStore.getState().loadJournal?.has(1) === true;

function controller(getMessages: ReturnType<typeof vi.fn>) {
  const api = { getMessages } as unknown as ApiClient;
  return createMessageController({ api, showError: vi.fn() });
}

beforeEach(() => {
  messagesStore.setState((prev) => ({
    ...prev,
    messagesByChannel: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    detachedChannels: new Set(),
    historyLoadState: new Map(),
    loadJournal: new Map(),
    loadJournalHolds: new Map(),
  }));
});

describe("older page journal", () => {
  it("applies a delete that arrived while the page was in flight to the page's rows", async () => {
    setMessages(1, [11, 12].map((id) => response(id)).toReversed(), true);
    const page = deferred<Page>();
    const getMessages = vi.fn().mockReturnValueOnce(page.promise);
    const run = controller(getMessages).loadOlderMessages(1, new AbortController().signal);

    deleteMessage({ message_id: 9, channel_id: 1 });
    page.resolve({ messages: [response(10), response(9)], has_more: false });
    await run;

    expect(getChannelMessages(1).map((m) => m.id)).toEqual([9, 10, 11, 12]);
    expect(rowsOf(9)?.deleted).toBe(true);
    expect(rowsOf(10)?.deleted).not.toBe(true);
    expect(journalOpen()).toBe(false);
  });

  it("closes the journal when the fetch fails", async () => {
    setMessages(1, [response(11)], true);
    const getMessages = vi.fn().mockRejectedValue(new Error("offline"));
    await controller(getMessages).loadOlderMessages(1, new AbortController().signal);
    expect(journalOpen()).toBe(false);
  });
});

describe("newer page journal", () => {
  it("applies a delete that arrived while the newer page was in flight", async () => {
    setAroundMessages(
      1,
      [10, 11].map((id) => response(id)),
      true,
      true,
    );
    const page = deferred<Page>();
    const getMessages = vi.fn().mockReturnValueOnce(page.promise).mockResolvedValue({
      messages: [],
      has_more: false,
    });
    const run = controller(getMessages).loadNewerMessages(1, new AbortController().signal);

    deleteMessage({ message_id: 12, channel_id: 1 });
    page.resolve({ messages: [response(12), response(13)], has_more: true });
    await run;

    expect(rowsOf(12)?.deleted).toBe(true);
    expect(rowsOf(13)?.deleted).not.toBe(true);
    expect(journalOpen()).toBe(false);
  });
});

describe("first-page load while a fetch holds the journal", () => {
  it("does not replay entries recorded before the load began", () => {
    setMessages(1, [response(5)], false);
    holdLoadJournal(1);
    setMessagePinned(1, 5, true); // before the gap: the fresh page supersedes it
    setChannelLoading(1);
    setMessages(1, [response(5, { pinned: false })], false);
    expect(rowsOf(5)?.pinned).toBe(false);
  });
});

describe("overlapping holds", () => {
  it("stays open until the last fetch lets go", () => {
    holdLoadJournal(1);
    holdLoadJournal(1);
    releaseLoadJournal(1);
    expect(journalOpen()).toBe(true);
    releaseLoadJournal(1);
    expect(journalOpen()).toBe(false);
  });

  it("is not closed under a first-page load that is still running", () => {
    setChannelLoading(1);
    holdLoadJournal(1);
    releaseLoadJournal(1);
    expect(journalOpen()).toBe(true);
  });
});

describe("re-attach while a live message is refused", () => {
  it("shows a message that arrived while Jump to Present was fetching", async () => {
    setAroundMessages(
      1,
      [10, 11, 12].map((id) => response(id)),
      true,
      true,
    );
    reattachToPresent(1);
    const tail = deferred<Page>();
    const getMessages = vi
      .fn()
      .mockReturnValueOnce(tail.promise)
      .mockResolvedValueOnce({ messages: [response(31)], has_more: false });
    const run = controller(getMessages).loadMessages(1, new AbortController().signal);

    addMessage(broadcast(31)); // the window is still detached: refused
    tail.resolve({ messages: [response(30)], has_more: false });
    await run;
    await vi.waitFor(() => expect(getChannelMessages(1).map((m) => m.id)).toEqual([30, 31]));
    expect(getMessages).toHaveBeenLastCalledWith(1, { after: 30, limit: 50 }, expect.anything());
  });
});

describe("re-attach onto an empty page", () => {
  it("asks for nothing after id 0", async () => {
    setAroundMessages(1, [response(10)], true, true);
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map() }));
    reattachToPresent(1);
    const getMessages = vi.fn().mockResolvedValue({ messages: [], has_more: false });
    await controller(getMessages).loadMessages(1, new AbortController().signal);
    await Promise.resolve();
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages.mock.calls[0]?.[1]).not.toHaveProperty("after");
  });
});

describe("same-channel jump journal", () => {
  it("applies a delete that arrived while the around window was in flight", async () => {
    setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
    expect(channelsStore.getState().channels.size).toBeGreaterThan(0);
    setMessages(1, [response(90)], false);
    const win = deferred<{
      messages: MessageResponse[];
      has_more_before: boolean;
      has_more_after: boolean;
    }>();
    const getMessagesAround = vi.fn().mockReturnValue(win.promise);
    const ctrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) },
    };
    const jumper = createMessageJumper({
      api: { getMessagesAround } as unknown as ApiClient,
      getChannelCtrl: () => ctrl as never,
      nextFrame: () => Promise.resolve(),
    });

    const done = jumper.jumpTo(1, 41);
    deleteMessage({ message_id: 40, channel_id: 1 });
    win.resolve({
      messages: [response(40), response(41)],
      has_more_before: true,
      has_more_after: true,
    });
    await done;

    expect(rowsOf(40)?.deleted).toBe(true);
    expect(rowsOf(41)?.deleted).not.toBe(true);
    expect(journalOpen()).toBe(false);
  });
});
