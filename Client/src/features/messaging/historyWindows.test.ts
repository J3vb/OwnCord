import { describe, it, expect } from "vitest";
import {
  reduceSetChannelLoading,
  reduceSetChannelLoadError,
  reduceSetMessages,
  reduceSetAroundMessages,
  reduceInvalidateLoadedMessageWindows,
  reduceInvalidateChannelMessageWindow,
  reduceReattachToPresent,
  reducePrependMessages,
} from "./historyWindows";
import { INITIAL_STATE, MAX_MESSAGES_PER_CHANNEL } from "./messageModel";
import type { Message, MessagesState } from "./messageModel";
import type { MessageResponse } from "../../lib/types";

const me = { id: 1, username: "me", avatar: null };

function row(overrides: Partial<Message>): Message {
  return {
    id: 0,
    channelId: 1,
    user: me,
    content: "hi",
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2026-03-15T10:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...overrides,
  };
}

function resp(id: number, content = "hi"): MessageResponse {
  return {
    id,
    channel_id: 1,
    user: me,
    content,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2026-03-15T10:00:00Z",
  };
}

/** A newest-first page of ids hi..lo, as the REST history endpoint returns. */
function page(hi: number, lo: number): MessageResponse[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => resp(hi - i));
}

function state(rows: readonly Message[], extra: Partial<MessagesState> = {}): MessagesState {
  return { ...INITIAL_STATE, messagesByChannel: new Map([[1, rows]]), ...extra };
}

const ids = (s: MessagesState, channelId = 1): number[] =>
  (s.messagesByChannel.get(channelId) ?? []).map((m) => m.id);

const pending = row({ status: "pending", correlationId: "c-1", content: "draft" });

describe("reduceSetChannelLoading / reduceSetChannelLoadError", () => {
  it("marks loading and records the highest id present as the watermark", () => {
    const next = reduceSetChannelLoading(state([row({ id: 7 }), row({ id: 3 })]), 1);
    expect(next.historyLoadState.get(1)).toBe("loading");
    expect(next.loadWatermark?.get(1)).toBe(7);
  });

  it("records a zero watermark for an empty channel, with no prior watermark map", () => {
    const next = reduceSetChannelLoading({ ...INITIAL_STATE, loadWatermark: undefined }, 4);
    expect(next.loadWatermark?.get(4)).toBe(0);
  });

  it("marks a failed fetch", () => {
    expect(reduceSetChannelLoadError(INITIAL_STATE, 2).historyLoadState.get(2)).toBe("error");
  });
});

describe("reduceSetMessages", () => {
  it("stores the page oldest-first and resets the channel's window flags", () => {
    const prev = state([], {
      historyLoadState: new Map([[1, "loading"]]),
      detachedChannels: new Set([1]),
      loadWatermark: new Map([[1, 0]]),
    });
    const next = reduceSetMessages(prev, 1, page(3, 1), true);
    expect(ids(next)).toEqual([1, 2, 3]);
    expect(next.loadedChannels.has(1)).toBe(true);
    expect(next.hasMore.get(1)).toBe(true);
    expect(next.historyLoadState.has(1)).toBe(false);
    expect(next.detachedChannels.has(1)).toBe(false);
    expect(next.loadWatermark?.has(1)).toBe(false);
  });

  it("keeps the newest rows of an oversized page and reports more above", () => {
    const next = reduceSetMessages(INITIAL_STATE, 1, page(MAX_MESSAGES_PER_CHANNEL + 2, 1), false);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(3);
    expect(next.hasMore.get(1)).toBe(true);
  });

  it("carries unreconciled rows and live rows newer than snapshot and watermark", () => {
    const prev = state([row({ id: 2 }), row({ id: 9 }), pending], {
      loadWatermark: new Map([[1, 5]]),
    });
    const next = reduceSetMessages(prev, 1, page(3, 1), false);
    expect(ids(next)).toEqual([1, 2, 3, 9, 0]);
    expect(next.hasMore.get(1)).toBe(false);
  });

  it("drops a pre-fetch sent row an empty page no longer holds", () => {
    const prev = state([row({ id: 4 })], { loadWatermark: new Map([[1, 4]]) });
    expect(ids(reduceSetMessages(prev, 1, [], false))).toEqual([]);
  });

  it("keeps a sent row newer than the snapshot when no watermark was taken", () => {
    expect(ids(reduceSetMessages(state([row({ id: 4 })]), 1, [], false))).toEqual([4]);
  });

  it("drops a pending row whose echo is in the snapshot, one echo per row", () => {
    const twin = { ...pending, correlationId: "c-2" };
    const next = reduceSetMessages(state([pending, twin]), 1, [resp(8, "draft")], false);
    expect(ids(next)).toEqual([8, 0]);
  });

  it("trims a merge past the cap from the oldest end and reports more above", () => {
    const prev = state([pending]);
    const next = reduceSetMessages(prev, 1, page(MAX_MESSAGES_PER_CHANNEL, 1), false);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(2);
    expect(ids(next).at(-1)).toBe(0);
    expect(next.hasMore.get(1)).toBe(true);
  });
});

describe("reduceSetAroundMessages", () => {
  const around = [resp(10), resp(11), resp(12)];

  it("stores an oldest-first window unreversed and detaches it", () => {
    const next = reduceSetAroundMessages(state([row({ id: 99 })]), 1, around, true, true);
    expect(ids(next)).toEqual([10, 11, 12]);
    expect(next.detachedChannels.has(1)).toBe(true);
    expect(next.hasMore.get(1)).toBe(true);
    expect(next.loadedChannels.has(1)).toBe(true);
  });

  it("reattaches a window that reaches the tail and keeps newer live rows", () => {
    const prev = state([row({ id: 5 }), row({ id: 20 }), pending], {
      detachedChannels: new Set([1]),
      historyLoadState: new Map([[1, "loading"]]),
    });
    const next = reduceSetAroundMessages(prev, 1, around, false, false);
    expect(ids(next)).toEqual([10, 11, 12, 20, 0]);
    expect(next.detachedChannels.has(1)).toBe(false);
    expect(next.hasMore.get(1)).toBe(false);
    expect(next.historyLoadState.has(1)).toBe(false);
  });

  it("carries only unreconciled rows across a detached window", () => {
    const next = reduceSetAroundMessages(state([row({ id: 20 }), pending]), 1, around, false, true);
    expect(ids(next)).toEqual([10, 11, 12, 0]);
  });

  it("keeps the head of an oversized window and stays detached", () => {
    const big = Array.from({ length: MAX_MESSAGES_PER_CHANNEL + 1 }, (_, i) => resp(i + 1));
    const next = reduceSetAroundMessages(INITIAL_STATE, 1, big, false, false);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(1);
    expect(next.detachedChannels.has(1)).toBe(true);
  });
});

describe("reduceInvalidateLoadedMessageWindows", () => {
  it("returns prev by identity when nothing is loaded", () => {
    const prev = state([row({ id: 1 })]);
    expect(reduceInvalidateLoadedMessageWindows(prev)).toBe(prev);
  });

  it("keeps only unreconciled rows and clears every window flag", () => {
    const prev: MessagesState = {
      ...INITIAL_STATE,
      messagesByChannel: new Map([
        [1, [row({ id: 1 }), pending]],
        [2, [row({ id: 2 })]],
        [3, [row({ id: 3 })]],
      ]),
      loadedChannels: new Set([1, 2, 4]),
      hasMore: new Map([[1, true]]),
      detachedChannels: new Set([2]),
    };
    const next = reduceInvalidateLoadedMessageWindows(prev);
    expect(ids(next, 1)).toEqual([0]);
    expect(next.messagesByChannel.has(2)).toBe(false);
    expect(ids(next, 3)).toEqual([3]);
    expect(next.loadedChannels.size).toBe(0);
    expect(next.hasMore.size).toBe(0);
    expect(next.detachedChannels.size).toBe(0);
  });
});

describe("reduceInvalidateChannelMessageWindow / reduceReattachToPresent", () => {
  const loaded = state([row({ id: 1 })], {
    loadedChannels: new Set([1, 2]),
    detachedChannels: new Set([1]),
  });

  it("drops one channel's loaded flag and keeps rows and detachment", () => {
    const next = reduceInvalidateChannelMessageWindow(loaded, 1);
    expect([...next.loadedChannels]).toEqual([2]);
    expect(next.messagesByChannel).toBe(loaded.messagesByChannel);
    expect(next.detachedChannels.has(1)).toBe(true);
  });

  it("returns prev by identity for a channel that is not loaded", () => {
    expect(reduceInvalidateChannelMessageWindow(loaded, 3)).toBe(loaded);
  });

  it("reattach drops the loaded flag of a detached channel only", () => {
    const next = reduceReattachToPresent(loaded, 1);
    expect([...next.loadedChannels]).toEqual([2]);
    expect(next.detachedChannels.has(1)).toBe(true);
    expect(reduceReattachToPresent(loaded, 2)).toBe(loaded);
  });
});

describe("reducePrependMessages", () => {
  it("puts the older page, oldest-first, above the window", () => {
    const next = reducePrependMessages(state([row({ id: 5 })]), 1, page(4, 3), true);
    expect(ids(next)).toEqual([3, 4, 5]);
    expect(next.hasMore.get(1)).toBe(true);
    expect(next.detachedChannels.has(1)).toBe(false);
  });

  it("keeps the oldest rows past the cap, carries unreconciled tail rows and detaches", () => {
    const window = [
      ...Array.from({ length: MAX_MESSAGES_PER_CHANNEL - 1 }, (_, i) => row({ id: 100 + i })),
      pending,
    ];
    const next = reducePrependMessages(state(window), 1, page(2, 1), false);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 1);
    expect(ids(next).slice(0, 3)).toEqual([1, 2, 100]);
    expect(ids(next).at(-2)).toBe(100 + MAX_MESSAGES_PER_CHANNEL - 3);
    expect(ids(next).at(-1)).toBe(0);
    expect(next.hasMore.get(1)).toBe(false);
    expect(next.detachedChannels.has(1)).toBe(true);
  });

  it("drops sent tail rows past the cap", () => {
    const window = Array.from({ length: MAX_MESSAGES_PER_CHANNEL }, (_, i) => row({ id: 100 + i }));
    const next = reducePrependMessages(state(window), 1, page(1, 1), true);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next).at(-1)).toBe(100 + MAX_MESSAGES_PER_CHANNEL - 2);
  });
});
