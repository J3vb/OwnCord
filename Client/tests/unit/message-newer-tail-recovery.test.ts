/**
 * A live message committed while the final `after` page is in flight is
 * refused (the window is still detached) and may be missing from that page.
 * The follow-up tail fetch after the re-attach must put it back, without
 * dropping a live row that landed in between.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createMessageController } from "../../src/pages/main-page/MessageController";
import {
  messagesStore,
  setAroundMessages,
  addMessage,
  getChannelMessages,
  isWindowDetached,
  isChannelLoaded,
} from "../../src/stores/messages.store";
import type { MessageResponse } from "../../src/lib/types";
import { buildResponse as response, buildBroadcast as broadcast } from "../helpers/messageFactory";

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
    setAroundMessages(
      1,
      [10, 11, 12].map((id) => response(id)),
      true,
      true,
    );
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

  it("resolves once the page is applied, without waiting for the recovery request", async () => {
    const followUp = deferred<{ messages: MessageResponse[]; has_more: boolean }>();
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [response(13)], has_more: false })
      .mockReturnValueOnce(followUp.promise);

    await setup(getMessages).loadNewerMessages(1, new AbortController().signal);

    expect(ids()).toEqual([10, 11, 12, 13]);
    expect(getMessages).toHaveBeenCalledTimes(2); // recovery is still pending
    followUp.resolve({ messages: [], has_more: false });
  });

  it("invalidates the window when the recovery request fails, so the next visit refetches", async () => {
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [response(13)], has_more: false })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ messages: [response(14), response(13)], has_more: false });
    const ctrl = setup(getMessages);

    await ctrl.loadNewerMessages(1, new AbortController().signal);
    await vi.waitFor(() => expect(isChannelLoaded(1)).toBe(false));

    await ctrl.loadMessages(1, new AbortController().signal);
    expect(getMessages).toHaveBeenCalledTimes(3);
    expect(ids()).toContain(14);
  });

  it("invalidates the window when the recovery is aborted by a channel switch", async () => {
    const abort = new AbortController();
    const followUp = deferred<{ messages: MessageResponse[]; has_more: boolean }>();
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [response(13)], has_more: false })
      .mockReturnValueOnce(followUp.promise);

    await setup(getMessages).loadNewerMessages(1, abort.signal);
    abort.abort();
    followUp.resolve({ messages: [response(14)], has_more: false });

    await vi.waitFor(() => expect(isChannelLoaded(1)).toBe(false));
    expect(ids()).toEqual([10, 11, 12, 13]);
  });
});
