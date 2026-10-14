/**
 * A live message committed while the final `after` page is in flight is
 * refused (the window is still detached) and may be missing from that page.
 * The follow-up tail fetch after the re-attach must put it back, without
 * dropping a live row that landed in between.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMessageController } from "../../src/pages/main-page/MessageController";
import {
  messagesStore,
  setAroundMessages,
  addMessage,
  getChannelMessages,
  isWindowDetached,
} from "../../src/stores/messages.store";
import type { ChatMessagePayload, MessageResponse, MessageUser } from "../../src/lib/types";

const USER: MessageUser = { id: 1, username: "alice", avatar: null };

function response(id: number): MessageResponse {
  return {
    id,
    channel_id: 1,
    user: USER,
    content: `msg ${id}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2026-03-15T09:00:00Z",
  };
}

function broadcast(id: number): ChatMessagePayload {
  return {
    id,
    channel_id: 1,
    user: USER,
    content: `live ${id}`,
    reply_to: null,
    attachments: [],
    timestamp: "2026-03-15T12:00:00Z",
  } as ChatMessagePayload;
}

const ids = (): number[] => getChannelMessages(1).map((m) => m.id);

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("loadNewerMessages: recovering a live message refused while detached", () => {
  beforeEach(() => {
    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      detachedChannels: new Set(),
    }));
    setAroundMessages(1, [10, 11, 12].map(response), true, true);
  });

  function setup(getMessages: ReturnType<typeof vi.fn>) {
    const api = { getMessages } as unknown as Parameters<typeof createMessageController>[0]["api"];
    return createMessageController({ api, showError: vi.fn() });
  }

  it("puts a message refused during the final page back after the re-attach", async () => {
    const page = deferred<{ messages: MessageResponse[]; has_more: boolean }>();
    const getMessages = vi
      .fn()
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce({ messages: [response(14)], has_more: false });
    const run = setup(getMessages).loadNewerMessages(1, new AbortController().signal);

    addMessage(broadcast(14)); // detached: refused
    expect(ids()).toEqual([10, 11, 12]);
    page.resolve({ messages: [response(13)], has_more: false });
    await run;

    expect(isWindowDetached(1)).toBe(false);
    expect(getMessages).toHaveBeenLastCalledWith(1, { after: 13, limit: 50 }, expect.anything());
    expect(ids()).toEqual([10, 11, 12, 13, 14]);
  });

  it("keeps a live row that landed between the re-attach and the follow-up", async () => {
    const followUp = deferred<{ messages: MessageResponse[]; has_more: boolean }>();
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [response(13)], has_more: false })
      .mockReturnValueOnce(followUp.promise);
    const run = setup(getMessages).loadNewerMessages(1, new AbortController().signal);

    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));
    expect(isWindowDetached(1)).toBe(false);
    addMessage(broadcast(15)); // attached again: appended
    followUp.resolve({ messages: [response(14), response(15)], has_more: false });
    await run;

    expect(ids()).toEqual([10, 11, 12, 13, 14, 15]);
  });
});
