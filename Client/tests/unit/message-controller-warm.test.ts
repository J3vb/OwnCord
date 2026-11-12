/**
 * A press on a channel row asks for its first page early. The click still
 * decides: only a first visit to a text channel or DM that is not open asks,
 * and a page read before channel_focus is topped up with what came after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";
vi.mock("@lib/logger", () => loggerMock());

import { createMessageController } from "../../src/pages/main-page/MessageController";
import { WARM_MAX_AGE_MS } from "../../src/features/messaging/channelWarmup";
import { getChannelMessages, isChannelLoaded } from "../../src/stores/messages.store";
import { warmChannel, cancelChannelWarm } from "../../src/lib/nav/channelNavigation";
import { channelsStore } from "../../src/stores/channels.store";
import type { Channel } from "../../src/stores/channels.store";
import type { MessageResponse } from "../../src/lib/types";
import { resetMessagesState } from "../helpers/storeResets";
import { createDeferred as deferred } from "../helpers/deferred";
import { makeChannel } from "../helpers/channelFactory";
import { buildResponse as response } from "../helpers/messageFactory";

type Page = { messages: MessageResponse[]; has_more: boolean };

const channel = (id: number, type: Channel["type"] = "text"): Channel =>
  makeChannel({ id, name: `c${id}`, type, position: id });

const page = (...ids: number[]): Page => ({
  messages: ids.map((id) => response(id)),
  has_more: false,
});
const ids = (channelId: number): number[] => getChannelMessages(channelId).map((m) => m.id);

function setup(getMessages: ReturnType<typeof vi.fn>) {
  const api = { getMessages } as unknown as Parameters<typeof createMessageController>[0]["api"];
  return createMessageController({ api, showError: vi.fn() });
}

describe("press-to-warm first page", () => {
  beforeEach(() => {
    resetMessagesState();
    channelsStore.setState((prev) => ({
      ...prev,
      activeChannelId: 9,
      channels: new Map([
        [1, channel(1)],
        [2, channel(2)],
        [3, channel(3, "voice")],
        [4, channel(4, "forum")],
        [9, channel(9)],
      ]),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it("opens with the warm page, then reconciles what changed since it was read", async () => {
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce(page(12, 11, 10))
      .mockResolvedValueOnce({
        messages: [response(13), response(12), response(10)],
        has_more: false,
      });
    const ctrl = setup(getMessages);
    warmChannel(1);
    await ctrl.loadMessages(1, new AbortController().signal);

    expect(getMessages).toHaveBeenNthCalledWith(1, 1, { limit: 50 }, expect.anything());
    // 11 was deleted and 13 posted after the press-time read.
    await vi.waitFor(() => expect(ids(1)).toEqual([10, 12, 13]));
    expect(getMessages).toHaveBeenNthCalledWith(2, 1, { limit: 100 }, expect.anything());
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(isChannelLoaded(1)).toBe(true);
  });

  it("keeps an older page the reader scrolled to before the top-up refetch returned", async () => {
    const span = (from: number, to: number): Page => ({
      messages: Array.from({ length: to - from + 1 }, (_, i) => response(to - i)),
      has_more: true,
    });
    const topUp = deferred<Page>();
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce(span(81, 130))
      .mockReturnValueOnce(topUp.promise)
      .mockResolvedValueOnce(span(31, 80));
    const ctrl = setup(getMessages);
    const signal = new AbortController().signal;
    warmChannel(1);
    await ctrl.loadMessages(1, signal);
    expect(getMessages).toHaveBeenNthCalledWith(2, 1, { limit: 100 }, expect.anything());

    await ctrl.loadOlderMessages(1, signal);
    expect(getMessages).toHaveBeenNthCalledWith(3, 1, { before: 81, limit: 50 }, expect.anything());
    topUp.resolve(span(31, 130));

    // The older page stays above the reader: not dropped, not asked for again.
    const expected = Array.from({ length: 100 }, (_, i) => 31 + i);
    await vi.waitFor(() => expect(isChannelLoaded(1)).toBe(true));
    expect(ids(1)).toEqual(expected);
    expect(getMessages).toHaveBeenCalledTimes(3);
  });

  it("waits for a warm request still in flight instead of asking again", async () => {
    const warm = deferred<Page>();
    const getMessages = vi
      .fn()
      .mockReturnValueOnce(warm.promise)
      .mockResolvedValueOnce({ messages: [], has_more: false });
    const ctrl = setup(getMessages);
    warmChannel(1);
    const run = ctrl.loadMessages(1, new AbortController().signal);
    expect(getMessages).toHaveBeenCalledTimes(1);
    warm.resolve(page(5, 4));
    await run;
    expect(ids(1)).toEqual([4, 5]);
  });

  it.each([
    ["the open channel", 9],
    ["a voice channel", 3],
    ["a forum", 4],
    ["an unknown channel", 77],
  ])("sends nothing for %s", (_name, id) => {
    const getMessages = vi.fn().mockResolvedValue(page(1));
    setup(getMessages);
    warmChannel(id);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("sends nothing for a channel that is loaded or has cached rows", async () => {
    const getMessages = vi.fn().mockResolvedValue(page(2, 1));
    const ctrl = setup(getMessages);
    await ctrl.loadMessages(1, new AbortController().signal);
    getMessages.mockClear();
    warmChannel(1);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("drops a press that did not become a click: the open takes the normal request", async () => {
    const getMessages = vi.fn().mockResolvedValue(page(7));
    const ctrl = setup(getMessages);
    warmChannel(1);
    cancelChannelWarm(1);
    await ctrl.loadMessages(1, new AbortController().signal);
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(getMessages.mock.calls[0]![2].aborted).toBe(true);
    expect(ids(1)).toEqual([7]);
  });

  it("press on one row, open another: the first request is aborted and writes nothing", async () => {
    const getMessages = vi.fn().mockResolvedValue(page(7));
    const ctrl = setup(getMessages);
    warmChannel(1);
    warmChannel(2);
    await ctrl.loadMessages(2, new AbortController().signal);
    expect(getMessages.mock.calls[0]![2].aborted).toBe(true);
    expect(ids(1)).toEqual([]);
    expect(isChannelLoaded(1)).toBe(false);
    expect(ids(2)).toEqual([7]);
  });

  it("falls back to its own request when the warm one fails", async () => {
    const getMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(page(8));
    const ctrl = setup(getMessages);
    warmChannel(1);
    await ctrl.loadMessages(1, new AbortController().signal);
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(ids(1)).toEqual([8]);
  });

  it("ignores a press older than the click window", async () => {
    vi.useFakeTimers();
    const getMessages = vi.fn().mockResolvedValue(page(6));
    const ctrl = setup(getMessages);
    warmChannel(1);
    vi.setSystemTime(Date.now() + WARM_MAX_AGE_MS + 1);
    await ctrl.loadMessages(1, new AbortController().signal);
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it("asks the normal way when the warm page is empty", async () => {
    const getMessages = vi.fn().mockResolvedValue({ messages: [], has_more: false });
    const ctrl = setup(getMessages);
    warmChannel(1);
    await ctrl.loadMessages(1, new AbortController().signal);
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it("leaves nothing behind when the channel is left while the warm page is in flight", async () => {
    const warm = deferred<Page>();
    const getMessages = vi.fn().mockReturnValueOnce(warm.promise);
    const ctrl = setup(getMessages);
    warmChannel(1);
    const leave = new AbortController();
    const run = ctrl.loadMessages(1, leave.signal);
    leave.abort();
    expect(getMessages.mock.calls[0]![2].aborted).toBe(true);
    warm.resolve(page(3));
    await run;
    expect(ids(1)).toEqual([]);
    expect(getMessages).toHaveBeenCalledTimes(1);
  });
});
