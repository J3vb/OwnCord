import { describe, it, expect } from "vitest";
import {
  reduceSetChannelLoading,
  reduceSetChannelLoadError,
  reduceSetMessages,
  reduceSetAroundMessages,
  reduceInvalidateLoadedMessageWindows,
  reduceInvalidateChannelMessageWindow,
  reduceClearChannelContent,
  reduceReattachToPresent,
  reducePrependMessages,
  reduceSetOlderLoadFailed,
  reduceAppendNewerMessages,
  reduceMergeTailMessages,
} from "./historyWindows";
import { INITIAL_STATE, MAX_MESSAGES_PER_CHANNEL } from "./messageModel";
import type { Message, MessagesState } from "./messageModel";
import type { MessageResponse, PollInfo } from "../../lib/types";

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

  it("clears loaded for every channel and keeps rows, hasMore and detachment (P2-T4)", () => {
    const prev: MessagesState = {
      ...INITIAL_STATE,
      messagesByChannel: new Map([
        [1, [row({ id: 1 }), pending]],
        [2, [row({ id: 2 })]],
      ]),
      loadedChannels: new Set([1, 2, 4]),
      hasMore: new Map([[1, true]]),
      detachedChannels: new Set([2]),
    };
    const next = reduceInvalidateLoadedMessageWindows(prev);
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
    expect(next.loadedChannels.size).toBe(0);
    expect(next.hasMore).toBe(prev.hasMore);
    expect(next.detachedChannels).toBe(prev.detachedChannels);
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

describe("reduceClearChannelContent", () => {
  it("forgets one channel's delivered rows and window, keeping the user's unsent text", () => {
    const prev = state([row({ id: 1 }), pending], {
      loadedChannels: new Set([1, 2]),
      hasMore: new Map([
        [1, true],
        [2, true],
      ]),
      detachedChannels: new Set([1]),
    });
    const next = reduceClearChannelContent(prev, 1);
    expect(next.messagesByChannel.get(1)).toEqual([pending]);
    expect([...next.loadedChannels]).toEqual([2]);
    expect([...next.hasMore.keys()]).toEqual([2]);
    expect(next.detachedChannels.size).toBe(0);
  });

  it("drops the channel entry when nothing unsent is left", () => {
    const next = reduceClearChannelContent(state([row({ id: 1 })]), 1);
    expect(next.messagesByChannel.has(1)).toBe(false);
  });

  it("returns prev by identity for a channel it knows nothing about", () => {
    const prev = state([row({ id: 1 })]);
    expect(reduceClearChannelContent(prev, 3)).toBe(prev);
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

const poll = (version: number, extra: Partial<PollInfo> = {}): PollInfo => ({
  question: "Lunch?",
  answers: [{ answer_id: 1, text: "Pizza", emoji: null }],
  allow_multiselect: false,
  expires_at: "2026-03-16T10:00:00Z",
  ended: false,
  ended_at: null,
  results: { version, total_voters: version, counts: [{ answer_id: 1, count: version }], me: [] },
  ...extra,
});

const tailPage = () => page(MAX_MESSAGES_PER_CHANNEL + 5, MAX_MESSAGES_PER_CHANNEL - 4);

const detached = (rows: readonly Message[], extra: Partial<MessagesState> = {}) =>
  state(rows, { detachedChannels: new Set([1]), ...extra });

/** An oldest-first page of ids lo..hi, as an `after` fetch returns. */
const afterPage = (lo: number, hi: number): MessageResponse[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => resp(lo + i));

const attached = (rows: readonly Message[]) => state(rows);

/** Delivered rows with ids lo..hi, oldest first. */
const range = (lo: number, hi: number): Message[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => row({ id: lo + i }));

describe("reduceSetChannelLoading details", () => {
  it("keeps other channels' load state and watermarks", () => {
    const prev = state([row({ id: 3 })], {
      historyLoadState: new Map([[2, "error"]]),
      loadWatermark: new Map([[2, 40]]),
    });
    const next = reduceSetChannelLoading(prev, 1);
    expect(next.historyLoadState.get(2)).toBe("error");
    expect(next.loadWatermark?.get(2)).toBe(40);
    expect(prev.historyLoadState.get(1)).toBeUndefined();
    expect(prev.loadWatermark?.get(1)).toBeUndefined();
  });
});

describe("reduceSetOlderLoadFailed", () => {
  it("flags a channel and unflags it again", () => {
    const flagged = reduceSetOlderLoadFailed(INITIAL_STATE, 1, true);
    expect(flagged.olderLoadFailed?.has(1)).toBe(true);
    const cleared = reduceSetOlderLoadFailed(flagged, 1, false);
    expect(cleared.olderLoadFailed?.has(1)).toBe(false);
    expect(flagged.olderLoadFailed?.has(1)).toBe(true);
  });

  it("returns prev by identity when the flag already has that value", () => {
    const flagged = reduceSetOlderLoadFailed(INITIAL_STATE, 1, true);
    expect(reduceSetOlderLoadFailed(flagged, 1, true)).toBe(flagged);
    expect(reduceSetOlderLoadFailed(INITIAL_STATE, 1, false)).toBe(INITIAL_STATE);
  });

  it("keeps other channels flagged", () => {
    const both = reduceSetOlderLoadFailed(
      reduceSetOlderLoadFailed(INITIAL_STATE, 1, true),
      2,
      true,
    );
    const next = reduceSetOlderLoadFailed(both, 1, false);
    expect([...(next.olderLoadFailed ?? [])]).toEqual([2]);
  });
});

describe("reduceSetChannelLoadError details", () => {
  it("detaches a window that holds delivered rows", () => {
    const next = reduceSetChannelLoadError(state([row({ id: 3 })]), 1);
    expect(next.detachedChannels.has(1)).toBe(true);
    expect(next.historyLoadState.get(1)).toBe("error");
  });

  it("leaves the window attached when only unsent rows or nothing is there", () => {
    expect(reduceSetChannelLoadError(state([pending]), 1).detachedChannels.has(1)).toBe(false);
    expect(reduceSetChannelLoadError(state([]), 1).detachedChannels.has(1)).toBe(false);
    expect(reduceSetChannelLoadError(INITIAL_STATE, 1).detachedChannels.has(1)).toBe(false);
  });

  it("keeps other detached channels and load states", () => {
    const prev = state([row({ id: 3 })], {
      detachedChannels: new Set([5]),
      historyLoadState: new Map([[5, "loading"]]),
    });
    const next = reduceSetChannelLoadError(prev, 1);
    expect([...next.detachedChannels].toSorted()).toEqual([1, 5]);
    expect(next.historyLoadState.get(5)).toBe("loading");
    expect(prev.detachedChannels.has(1)).toBe(false);
  });
});

describe("reduceSetMessages row reuse", () => {
  it("keeps the same row objects and array when a refetch changed nothing", () => {
    const first = reduceSetMessages(INITIAL_STATE, 1, page(3, 1), false);
    const second = reduceSetMessages(first, 1, page(3, 1), false);
    expect(second.messagesByChannel.get(1)).toBe(first.messagesByChannel.get(1));
  });

  it("keeps the unchanged rows but replaces one whose content changed", () => {
    const first = reduceSetMessages(INITIAL_STATE, 1, page(3, 1), false);
    const refetched = [resp(3), resp(2, "changed"), resp(1)];
    const second = reduceSetMessages(first, 1, refetched, false);
    const before = first.messagesByChannel.get(1)!;
    const rows = second.messagesByChannel.get(1)!;
    expect(rows).not.toBe(before);
    expect(rows[0]).toBe(before[0]);
    expect(rows[1]).not.toBe(before[1]);
    expect(rows[1]?.content).toBe("changed");
    expect(rows[2]).toBe(before[2]);
  });

  it("treats fields only a live row carries as unchanged", () => {
    const cached = row({
      id: 4,
      clientMessageId: "m-4",
      user: { id: 1, username: "me", avatar: null, role: "admin" } as Message["user"],
    });
    const next = reduceSetMessages(state([cached]), 1, [resp(4)], false);
    expect(next.messagesByChannel.get(1)?.[0]).toBe(cached);
  });

  it("replaces a row whose attachments or reactions differ", () => {
    const cached = row({ id: 4 });
    const withAttachment: MessageResponse = {
      ...resp(4),
      attachments: [
        {
          id: "a1",
          filename: "a.png",
          size: 1,
          mime: "image/png",
          url: "/a.png",
        },
      ],
    };
    const next = reduceSetMessages(state([cached]), 1, [withAttachment], false);
    expect(next.messagesByChannel.get(1)?.[0]).not.toBe(cached);
    expect(next.messagesByChannel.get(1)?.[0]?.attachments).toHaveLength(1);
    const withReaction: MessageResponse = {
      ...resp(4),
      reactions: [{ emoji: "x", count: 1, me: false }],
    };
    const again = reduceSetMessages(state([cached]), 1, [withReaction], false);
    expect(again.messagesByChannel.get(1)?.[0]).not.toBe(cached);
  });

  it("a page fetched before a newer poll update does not roll the poll back", () => {
    const cached = row({ id: 4, poll: { ...poll(5), selfVersion: 5 } });
    const stale: MessageResponse = { ...resp(4), poll: poll(3) };
    const next = reduceSetMessages(state([cached]), 1, [stale], false);
    expect(next.messagesByChannel.get(1)?.[0]?.poll?.results.version).toBe(5);
    const fresh: MessageResponse = { ...resp(4), poll: poll(7) };
    const newer = reduceSetMessages(state([cached]), 1, [fresh], false);
    expect(newer.messagesByChannel.get(1)?.[0]?.poll?.results.version).toBe(7);
  });

  it("does not keep a cached row that was never delivered as the page's twin", () => {
    const cachedPending = row({ id: 0, status: "pending", correlationId: "c-9", content: "other" });
    const next = reduceSetMessages(state([cachedPending]), 1, [resp(4)], false);
    expect(ids(next)).toEqual([4, 0]);
  });
});

describe("reduceSetMessages carry rules", () => {
  it("drops a pending row only when its echo is the snapshot's, for a failed OFFLINE row too", () => {
    const offline = row({
      status: "failed",
      errorCode: "OFFLINE",
      correlationId: "c-3",
      content: "draft",
    });
    const rejected = row({
      status: "failed",
      errorCode: "SLOW_MODE",
      correlationId: "c-4",
      content: "draft",
    });
    const next = reduceSetMessages(state([offline, rejected]), 1, [resp(8, "draft")], false);
    expect(ids(next)).toEqual([8, 0]);
    expect(next.messagesByChannel.get(1)?.at(-1)?.errorCode).toBe("SLOW_MODE");
  });

  it("keeps a sent row exactly at the snapshot's newest id out, one above in", () => {
    const prev = state([row({ id: 3 }), row({ id: 4 })], { loadWatermark: new Map([[1, 0]]) });
    // id 3 is in the snapshot; id 4 is newer than every snapshot row.
    expect(ids(reduceSetMessages(prev, 1, page(3, 1), false))).toEqual([1, 2, 3, 4]);
    const atFloor = state([row({ id: 3 })], { loadWatermark: new Map([[1, 3]]) });
    expect(ids(reduceSetMessages(atFloor, 1, page(2, 1), false))).toEqual([1, 2]);
  });

  it("uses the higher of the snapshot's newest id and the watermark as the floor", () => {
    const prev = state([row({ id: 6 }), row({ id: 9 })], { loadWatermark: new Map([[1, 8]]) });
    expect(ids(reduceSetMessages(prev, 1, page(5, 4), false))).toEqual([4, 5, 9]);
  });

  it("clears only this channel's watermark and load state", () => {
    const prev = state([], {
      loadWatermark: new Map([
        [1, 2],
        [2, 9],
      ]),
      historyLoadState: new Map([
        [1, "loading"],
        [2, "loading"],
      ]),
      loadedChannels: new Set([2]),
      hasMore: new Map([[2, true]]),
      detachedChannels: new Set([2]),
    });
    const next = reduceSetMessages(prev, 1, page(3, 1), false);
    expect(next.loadWatermark?.get(2)).toBe(9);
    expect(next.loadWatermark?.has(1)).toBe(false);
    expect(next.historyLoadState.get(2)).toBe("loading");
    expect([...next.loadedChannels].toSorted()).toEqual([1, 2]);
    expect(next.hasMore.get(2)).toBe(true);
    expect(next.detachedChannels.has(2)).toBe(true);
  });

  it("works without a watermark map", () => {
    const prev: MessagesState = { ...INITIAL_STATE, loadWatermark: undefined };
    const next = reduceSetMessages(prev, 1, page(2, 1), false);
    expect(ids(next)).toEqual([1, 2]);
    expect(next.loadWatermark?.size).toBe(0);
  });
});

describe("reduceSetMessages resync splice", () => {
  const loadedRows = range(5, 25);
  const watermark = new Map([[1, 25]]);

  it("keeps the loaded rows above a page that reaches back to what was loaded", () => {
    const prev = state(loadedRows, {
      loadWatermark: watermark,
      hasMore: new Map([[1, false]]),
    });
    const next = reduceSetMessages(prev, 1, page(30, 20), true, true);
    expect(ids(next)).toEqual(Array.from({ length: 26 }, (_, i) => i + 5));
    // The older rows were already known to have nothing above them.
    expect(next.hasMore.get(1)).toBe(false);
  });

  it("takes hasMore from the page when nothing above was known", () => {
    const prev = state(loadedRows, { loadWatermark: watermark });
    const next = reduceSetMessages(prev, 1, page(30, 20), true, true);
    expect(next.hasMore.get(1)).toBe(true);
  });

  it("keeps older rows when the page starts exactly at the watermark", () => {
    const prev = state(loadedRows, { loadWatermark: watermark });
    const next = reduceSetMessages(prev, 1, page(30, 25), true, true);
    expect(ids(next).slice(0, 3)).toEqual([5, 6, 7]);
  });

  it("replaces the window when the page starts after the watermark", () => {
    const prev = state(loadedRows, { loadWatermark: watermark });
    const next = reduceSetMessages(prev, 1, page(40, 26), true, true);
    expect(ids(next)).toEqual(Array.from({ length: 15 }, (_, i) => i + 26));
  });

  it("replaces the window without the splice flag, for the whole channel, or an empty page", () => {
    const prev = state(loadedRows, { loadWatermark: watermark });
    expect(ids(reduceSetMessages(prev, 1, page(30, 20), true, false))[0]).toBe(20);
    expect(ids(reduceSetMessages(prev, 1, page(30, 20), false, true))[0]).toBe(20);
    expect(ids(reduceSetMessages(prev, 1, [], true, true))).toEqual([]);
  });

  it("does not keep unsent rows above the page as older history", () => {
    const prev = state([...loadedRows, pending], { loadWatermark: watermark });
    const next = reduceSetMessages(prev, 1, page(30, 20), true, true);
    expect(ids(next).filter((id) => id === 0)).toHaveLength(1);
    expect(ids(next).at(-1)).toBe(0);
  });

  describe("when keeping the older rows overflows the cap", () => {
    const full = range(1, MAX_MESSAGES_PER_CHANNEL);
    const base = (extra: Partial<MessagesState> = {}) =>
      state(full, {
        loadWatermark: new Map([[1, MAX_MESSAGES_PER_CHANNEL]]),
        hasMore: new Map([[1, true]]),
        ...extra,
      });

    it("trims the oldest rows when the reader's anchor is not in the cut part", () => {
      const next = reduceSetMessages(base(), 1, tailPage(), true, true, 100);
      expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
      expect(ids(next)[0]).toBe(6);
      expect(next.detachedChannels.has(1)).toBe(false);
      expect(next.hasMore.get(1)).toBe(true);
    });

    it("trims the oldest rows when no anchor is given or the anchor is gone", () => {
      expect(ids(reduceSetMessages(base(), 1, tailPage(), true, true))[0]).toBe(6);
      expect(ids(reduceSetMessages(base(), 1, tailPage(), true, true, null))[0]).toBe(6);
      expect(ids(reduceSetMessages(base(), 1, tailPage(), true, true, 9999))[0]).toBe(6);
    });

    it("keeps the head and detaches when the anchor would be trimmed off the top", () => {
      const next = reduceSetMessages(base(), 1, tailPage(), true, true, 3);
      expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
      expect(ids(next)[0]).toBe(1);
      expect(ids(next).at(-1)).toBe(MAX_MESSAGES_PER_CHANNEL);
      expect(next.detachedChannels.has(1)).toBe(true);
      // The loaded history above was known to have more; the cut rows are below.
      expect(next.hasMore.get(1)).toBe(true);
    });

    it("an anchor on the last row to be trimmed keeps the head, the next row does not", () => {
      const overflow = 5;
      expect(ids(reduceSetMessages(base(), 1, tailPage(), true, true, overflow))[0]).toBe(1);
      expect(ids(reduceSetMessages(base(), 1, tailPage(), true, true, overflow + 1))[0]).toBe(6);
    });

    it("keeps unsent rows when it keeps the head", () => {
      const next = reduceSetMessages(
        base({ messagesByChannel: new Map([[1, [...full, pending]]]) }),
        1,
        tailPage(),
        true,
        true,
        3,
      );
      expect(ids(next)[0]).toBe(1);
      expect(ids(next).at(-1)).toBe(0);
      expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 1);
    });

    it("keeping the head does not claim more above than was known", () => {
      const next = reduceSetMessages(
        base({ hasMore: new Map([[1, false]]) }),
        1,
        tailPage(),
        true,
        true,
        3,
      );
      expect(next.hasMore.get(1)).toBe(false);
      expect(next.detachedChannels.has(1)).toBe(true);
    });
  });
});

describe("reduceSetAroundMessages details", () => {
  const around = [resp(10), resp(11), resp(12)];

  it("a window fetched before a newer poll update does not roll the poll back", () => {
    const cached = row({ id: 11, poll: { ...poll(5), selfVersion: 5 } });
    const stale = [resp(10), { ...resp(11), poll: poll(2) }, resp(12)];
    const next = reduceSetAroundMessages(state([cached]), 1, stale, false, true);
    expect(next.messagesByChannel.get(1)?.[1]?.poll?.results.version).toBe(5);
  });

  it("keeps unsent rows, and sent rows newer than a window that reaches the tail", () => {
    const prev = state([row({ id: 12 }), row({ id: 13 }), pending]);
    const next = reduceSetAroundMessages(prev, 1, around, false, false);
    expect(ids(next)).toEqual([10, 11, 12, 13, 0]);
  });

  it("drops a sent row older than the window it replaces", () => {
    const next = reduceSetAroundMessages(state([row({ id: 2 })]), 1, around, false, false);
    expect(ids(next)).toEqual([10, 11, 12]);
  });

  it("stays detached when more lies after the window, even if every row fit", () => {
    const next = reduceSetAroundMessages(state([row({ id: 13 })]), 1, around, true, true);
    expect(next.detachedChannels.has(1)).toBe(true);
    expect(ids(next)).toEqual([10, 11, 12]);
  });

  it("clears the channel's load state and marks it loaded, leaving others", () => {
    const prev = state([], {
      historyLoadState: new Map([
        [1, "loading"],
        [2, "error"],
      ]),
      loadedChannels: new Set([2]),
      hasMore: new Map([[2, true]]),
      detachedChannels: new Set([2]),
    });
    const next = reduceSetAroundMessages(prev, 1, around, false, false);
    expect(next.historyLoadState.has(1)).toBe(false);
    expect(next.historyLoadState.get(2)).toBe("error");
    expect([...next.loadedChannels].toSorted()).toEqual([1, 2]);
    expect(next.hasMore.get(2)).toBe(true);
    expect(next.detachedChannels.has(2)).toBe(true);
    expect(next.hasMore.get(1)).toBe(false);
  });

  it("reports more before the window when the server says so", () => {
    expect(reduceSetAroundMessages(INITIAL_STATE, 1, around, true, false).hasMore.get(1)).toBe(
      true,
    );
    expect(reduceSetAroundMessages(INITIAL_STATE, 1, around, false, false).hasMore.get(1)).toBe(
      false,
    );
  });

  describe("resync splice", () => {
    const loaded = range(1, 30);

    it("keeps loaded rows above a window that has more before it, taking the known hasMore", () => {
      const prev = state(loaded, { hasMore: new Map([[1, false]]) });
      const next = reduceSetAroundMessages(prev, 1, [resp(15), resp(16)], true, false, true);
      expect(ids(next).slice(0, 3)).toEqual([1, 2, 3]);
      expect(next.hasMore.get(1)).toBe(false);
    });

    it("takes hasMoreBefore from the window when nothing above was known", () => {
      const next = reduceSetAroundMessages(
        state(loaded),
        1,
        [resp(15), resp(16)],
        true,
        false,
        true,
      );
      expect(next.hasMore.get(1)).toBe(true);
    });

    it("drops loaded rows above the window when nothing more lies before it", () => {
      const next = reduceSetAroundMessages(
        state(loaded),
        1,
        [resp(15), resp(16)],
        false,
        false,
        true,
      );
      expect(ids(next)[0]).toBe(15);
    });

    it("keeps loaded rows below a window that stays detached", () => {
      const next = reduceSetAroundMessages(
        state(loaded),
        1,
        [resp(15), resp(16)],
        false,
        true,
        true,
      );
      expect(ids(next)).toEqual([15, 16, ...Array.from({ length: 14 }, (_, i) => i + 17)]);
      expect(next.detachedChannels.has(1)).toBe(true);
    });

    it("drops loaded rows below a window that reaches the tail only if it covers them", () => {
      const next = reduceSetAroundMessages(
        state(loaded),
        1,
        [resp(15), resp(16)],
        false,
        false,
        true,
      );
      // Reattached: live rows newer than the window survive as carried rows.
      expect(ids(next)).toEqual([15, 16, ...Array.from({ length: 14 }, (_, i) => i + 17)]);
      expect(next.detachedChannels.has(1)).toBe(false);
    });

    it("is not a splice without the flag or with an empty window", () => {
      expect(ids(reduceSetAroundMessages(state(loaded), 1, [resp(15)], true, true, false))).toEqual(
        [15],
      );
      expect(ids(reduceSetAroundMessages(state(loaded), 1, [], true, true, true))).toEqual([]);
    });

    it("trims the oldest rows when the spliced window passes the cap and reports more above", () => {
      const prev = state(range(1, MAX_MESSAGES_PER_CHANNEL), {
        hasMore: new Map([[1, false]]),
      });
      const window = Array.from({ length: 20 }, (_, i) => resp(MAX_MESSAGES_PER_CHANNEL + 1 + i));
      const next = reduceSetAroundMessages(prev, 1, window, true, true, true);
      expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
      expect(ids(next)[0]).toBe(21);
      expect(next.hasMore.get(1)).toBe(true);
    });

    it("does not report more above when the splice stayed within the cap", () => {
      const next = reduceSetAroundMessages(
        state(range(1, 10), { hasMore: new Map([[1, false]]) }),
        1,
        [resp(5)],
        true,
        true,
        true,
      );
      expect(next.hasMore.get(1)).toBe(false);
    });
  });
});

describe("window invalidation details", () => {
  it("clearing a channel that only has a loaded flag still forgets the flag", () => {
    const prev: MessagesState = { ...INITIAL_STATE, loadedChannels: new Set([3, 4]) };
    const next = reduceClearChannelContent(prev, 3);
    expect(next).not.toBe(prev);
    expect([...next.loadedChannels]).toEqual([4]);
    expect(next.messagesByChannel.has(3)).toBe(false);
  });

  it("clearing a channel with rows but no loaded flag still forgets the rows", () => {
    const prev = state([row({ id: 1 })]);
    const next = reduceClearChannelContent(prev, 1);
    expect(next).not.toBe(prev);
    expect(next.messagesByChannel.has(1)).toBe(false);
  });

  it("clearing keeps other channels' rows, flags and detachment", () => {
    const prev: MessagesState = {
      ...INITIAL_STATE,
      messagesByChannel: new Map([
        [1, [row({ id: 1 })]],
        [2, [row({ id: 2, channelId: 2 })]],
      ]),
      loadedChannels: new Set([1, 2]),
      detachedChannels: new Set([1, 2]),
      hasMore: new Map([
        [1, true],
        [2, true],
      ]),
    };
    const next = reduceClearChannelContent(prev, 1);
    expect(next.messagesByChannel.get(2)).toBe(prev.messagesByChannel.get(2));
    expect([...next.detachedChannels]).toEqual([2]);
    expect(prev.detachedChannels.has(1)).toBe(true);
  });

  it("reattaching returns prev by identity for an attached channel and keeps other channels loaded", () => {
    const prev = state([row({ id: 1 })], {
      loadedChannels: new Set([1, 2]),
      detachedChannels: new Set([1, 2]),
    });
    const next = reduceReattachToPresent(prev, 1);
    expect([...next.loadedChannels]).toEqual([2]);
    expect(prev.loadedChannels.has(1)).toBe(true);
    expect(reduceReattachToPresent(INITIAL_STATE, 1)).toBe(INITIAL_STATE);
  });

  it("invalidating one channel leaves the others' flags and does not touch the old state", () => {
    const prev = state([], { loadedChannels: new Set([1, 2]) });
    const next = reduceInvalidateChannelMessageWindow(prev, 1);
    expect([...next.loadedChannels]).toEqual([2]);
    expect(prev.loadedChannels.has(1)).toBe(true);
  });
});

describe("reduceAppendNewerMessages", () => {
  it("returns prev by identity for an attached window", () => {
    const prev = state([row({ id: 1 })]);
    expect(reduceAppendNewerMessages(prev, 1, afterPage(2, 3), true)).toBe(prev);
  });

  it("appends the page below the newest delivered row, oldest first, unsent rows last", () => {
    const prev = detached([row({ id: 1 }), row({ id: 2 }), pending]);
    const next = reduceAppendNewerMessages(prev, 1, afterPage(3, 5), true);
    expect(ids(next)).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it("skips page rows the window already holds or passed", () => {
    const prev = detached([row({ id: 3 }), row({ id: 5 })]);
    const next = reduceAppendNewerMessages(prev, 1, afterPage(2, 7), true);
    expect(ids(next)).toEqual([3, 5, 6, 7]);
  });

  it("starts from zero for a window with only unsent rows", () => {
    const next = reduceAppendNewerMessages(detached([pending]), 1, afterPage(1, 2), true);
    expect(ids(next)).toEqual([1, 2, 0]);
  });

  it("reattaches when the page reached the newest message", () => {
    const prev = detached([row({ id: 1 })], { detachedChannels: new Set([1, 2]) });
    const done = reduceAppendNewerMessages(prev, 1, afterPage(2, 3), false);
    expect([...done.detachedChannels]).toEqual([2]);
    const more = reduceAppendNewerMessages(prev, 1, afterPage(2, 3), true);
    expect([...more.detachedChannels].toSorted()).toEqual([1, 2]);
    expect(prev.detachedChannels.has(1)).toBe(true);
  });

  it("leaves hasMore alone while nothing was trimmed", () => {
    const prev = detached([row({ id: 1 })], { hasMore: new Map([[1, false]]) });
    const next = reduceAppendNewerMessages(prev, 1, afterPage(2, 3), true);
    expect(next.hasMore.get(1)).toBe(false);
    expect(
      reduceAppendNewerMessages(detached([row({ id: 1 })]), 1, afterPage(2, 3), true).hasMore.has(
        1,
      ),
    ).toBe(false);
  });

  it("drops the oldest rows past the cap and reports more above", () => {
    const prev = detached(range(1, MAX_MESSAGES_PER_CHANNEL), { hasMore: new Map([[1, false]]) });
    const next = reduceAppendNewerMessages(
      prev,
      1,
      afterPage(MAX_MESSAGES_PER_CHANNEL + 1, MAX_MESSAGES_PER_CHANNEL + 3),
      true,
    );
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(4);
    expect(ids(next).at(-1)).toBe(MAX_MESSAGES_PER_CHANNEL + 3);
    expect(next.hasMore.get(1)).toBe(true);
  });

  it("a window exactly at the cap after the append is not trimmed", () => {
    const prev = detached(range(1, MAX_MESSAGES_PER_CHANNEL - 2));
    const next = reduceAppendNewerMessages(
      prev,
      1,
      afterPage(MAX_MESSAGES_PER_CHANNEL - 1, MAX_MESSAGES_PER_CHANNEL),
      true,
    );
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(1);
    expect(next.hasMore.has(1)).toBe(false);
  });

  it("works for a channel with no rows yet", () => {
    const next = reduceAppendNewerMessages(
      { ...INITIAL_STATE, detachedChannels: new Set([1]) },
      1,
      afterPage(1, 2),
      false,
    );
    expect(ids(next)).toEqual([1, 2]);
  });
});

describe("reduceMergeTailMessages", () => {
  it("returns prev by identity for a detached window", () => {
    const prev = state([row({ id: 1 })], { detachedChannels: new Set([1]) });
    expect(reduceMergeTailMessages(prev, 1, [resp(2)])).toBe(prev);
  });

  it("returns prev by identity when the page holds nothing new", () => {
    const prev = attached([row({ id: 1 }), row({ id: 2 })]);
    expect(reduceMergeTailMessages(prev, 1, [resp(1), resp(2)])).toBe(prev);
    expect(reduceMergeTailMessages(prev, 1, [])).toBe(prev);
  });

  it("slots a missed row between delivered ones by id and keeps unsent rows last", () => {
    const prev = attached([row({ id: 1 }), row({ id: 5 }), pending]);
    const next = reduceMergeTailMessages(prev, 1, [resp(3), resp(5), resp(6)]);
    expect(ids(next)).toEqual([1, 3, 5, 6, 0]);
  });

  it("does not take an unsent row for a delivered one with the same id", () => {
    const prev = attached([pending]);
    const next = reduceMergeTailMessages(prev, 1, [resp(0)]);
    expect(ids(next)).toEqual([0, 0]);
  });

  it("keeps only the newest rows past the cap", () => {
    const prev = attached(range(2, MAX_MESSAGES_PER_CHANNEL + 1));
    const next = reduceMergeTailMessages(prev, 1, [resp(MAX_MESSAGES_PER_CHANNEL + 2)]);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(3);
    expect(ids(next).at(-1)).toBe(MAX_MESSAGES_PER_CHANNEL + 2);
  });

  it("keeps a window exactly at the cap whole", () => {
    const prev = attached(range(2, MAX_MESSAGES_PER_CHANNEL));
    const next = reduceMergeTailMessages(prev, 1, [resp(1)]);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(1);
  });

  it("builds a window for a channel with no rows", () => {
    const next = reduceMergeTailMessages(INITIAL_STATE, 1, [resp(2), resp(1)]);
    expect(ids(next)).toEqual([1, 2]);
  });
});

describe("reducePrependMessages details", () => {
  it("keeps detachment that was already set, and other channels' flags", () => {
    const prev = state([row({ id: 5 })], {
      detachedChannels: new Set([1, 2]),
      hasMore: new Map([[2, true]]),
    });
    const next = reducePrependMessages(prev, 1, page(4, 3), false);
    expect([...next.detachedChannels].toSorted()).toEqual([1, 2]);
    expect(next.hasMore.get(2)).toBe(true);
    expect(next.hasMore.get(1)).toBe(false);
  });

  it("starts a window for a channel with no rows", () => {
    expect(ids(reducePrependMessages(INITIAL_STATE, 1, page(2, 1), true))).toEqual([1, 2]);
  });

  it("an exactly full window is not trimmed or detached", () => {
    const window = range(100, 100 + MAX_MESSAGES_PER_CHANNEL - 4);
    const next = reducePrependMessages(state(window), 1, page(2, 1), true);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL - 1);
    expect(next.detachedChannels.has(1)).toBe(false);
    const exact = reducePrependMessages(state(window), 1, page(3, 1), true);
    expect(ids(exact)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(exact.detachedChannels.has(1)).toBe(false);
  });
});

describe("reduceSetMessages row comparison", () => {
  it("treats a nickname only a live row carries as unchanged", () => {
    const cached = row({
      id: 4,
      user: { id: 1, username: "me", avatar: null, display_name: "Me!" },
    });
    const next = reduceSetMessages(state([cached]), 1, [resp(4)], false);
    expect(next.messagesByChannel.get(1)?.[0]).toBe(cached);
  });

  it("replaces a row whose list became a plain object, and the other way round", () => {
    const cached = row({ id: 4 });
    const asObject = { ...resp(4), mentions: {} } as unknown as MessageResponse;
    const withList = row({ id: 4, mentions: [] });
    const next = reduceSetMessages(state([withList]), 1, [asObject], false);
    expect(next.messagesByChannel.get(1)?.[0]).not.toBe(withList);
    const withObject = row({ id: 4, mentions: {} as unknown as readonly number[] });
    const back = reduceSetMessages(state([withObject]), 1, [{ ...resp(4), mentions: [] }], false);
    expect(back.messagesByChannel.get(1)?.[0]).not.toBe(withObject);
    expect(cached.id).toBe(4);
  });

  it("replaces a row whose text became an object or the other way round", () => {
    const blank = row({ id: 4, content: "" });
    const asObject = { ...resp(4), content: {} } as unknown as MessageResponse;
    expect(
      reduceSetMessages(state([blank]), 1, [asObject], false).messagesByChannel.get(1)?.[0],
    ).not.toBe(blank);
    const objectRow = row({ id: 4, content: {} as unknown as string });
    expect(
      reduceSetMessages(state([objectRow]), 1, [resp(4, "")], false).messagesByChannel.get(1)?.[0],
    ).not.toBe(objectRow);
  });
});

describe("reduceSetMessages page edges", () => {
  it("a page of exactly the cap reports no more above when the server says none", () => {
    const next = reduceSetMessages(INITIAL_STATE, 1, page(MAX_MESSAGES_PER_CHANNEL, 1), false);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(next.hasMore.get(1)).toBe(false);
  });

  it("replaces the window unless a splice is asked for", () => {
    const prev = state(range(5, 25), { loadWatermark: new Map([[1, 25]]) });
    expect(ids(reduceSetMessages(prev, 1, page(30, 20), true))[0]).toBe(20);
  });

  it("the page's copy replaces a row with the same id whatever that row's state", () => {
    const stuck = row({
      id: 5,
      status: "failed",
      errorCode: "SLOW_MODE",
      correlationId: "c-5",
      poll: { ...poll(9), selfVersion: 9 },
    });
    const withPoll: MessageResponse = { ...resp(5), poll: poll(3) };
    const next = reduceSetMessages(state([stuck]), 1, [withPoll], false);
    expect(ids(next)).toEqual([5]);
    expect(next.messagesByChannel.get(1)?.[0]?.status).toBe("sent");
    expect(next.messagesByChannel.get(1)?.[0]?.poll?.results.version).toBe(3);
  });

  it("keeps the head only for a splice: a plain merge past the cap trims from the top", () => {
    const next = reduceSetMessages(
      state([pending]),
      1,
      page(MAX_MESSAGES_PER_CHANNEL, 1),
      false,
      false,
      1,
    );
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(2);
    expect(ids(next).at(-1)).toBe(0);
    expect(next.detachedChannels.has(1)).toBe(false);
  });

  it("keeping the head carries every unsent row once, wherever it lands", () => {
    const second = row({ status: "pending", correlationId: "c-2", content: "second" });
    // The older rows and the page fill all but one slot; two unsent rows follow.
    const top = MAX_MESSAGES_PER_CHANNEL - 1;
    const prev = state([...range(1, top), pending, second], {
      loadWatermark: new Map([[1, top]]),
      hasMore: new Map([[1, true]]),
    });
    const next = reduceSetMessages(prev, 1, page(top, top - 3), true, true, 1);
    const rows = next.messagesByChannel.get(1) ?? [];
    expect(rows).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 1);
    expect(rows.slice(0, 3).map((m) => m.id)).toEqual([1, 2, 3]);
    expect(rows.slice(-3).map((m) => m.correlationId)).toEqual([null, "c-1", "c-2"]);
    expect(next.detachedChannels.has(1)).toBe(true);
  });
});

describe("reduceSetAroundMessages edges", () => {
  const around = [resp(10), resp(11), resp(12)];

  it("does not duplicate the window's newest row when a live copy of it is loaded", () => {
    const next = reduceSetAroundMessages(state([row({ id: 12 })]), 1, around, false, false);
    expect(ids(next)).toEqual([10, 11, 12]);
  });

  it("a splice keeps unsent rows once, not also as older or newer history", () => {
    const loaded = range(1, 30);
    const detachedSplice = reduceSetAroundMessages(
      state([...loaded, pending]),
      1,
      [resp(15), resp(16)],
      true,
      true,
      true,
    );
    expect(ids(detachedSplice).filter((id) => id === 0)).toHaveLength(1);
    const attachedSplice = reduceSetAroundMessages(
      state([...loaded, pending]),
      1,
      [resp(15), resp(16)],
      true,
      false,
      true,
    );
    expect(ids(attachedSplice).filter((id) => id === 0)).toHaveLength(1);
  });

  it("only a spliced window is trimmed to the cap: a plain one keeps unsent rows past it", () => {
    const full = Array.from({ length: MAX_MESSAGES_PER_CHANNEL }, (_, i) => resp(i + 1));
    const next = reduceSetAroundMessages(state([pending]), 1, full, false, false);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL + 1);
    expect(ids(next).at(-1)).toBe(0);
  });

  it("a splice that lands exactly on the cap is not trimmed and claims nothing more above", () => {
    const prev = state(range(1, MAX_MESSAGES_PER_CHANNEL - 5), { hasMore: new Map([[1, false]]) });
    const window = Array.from({ length: 10 }, (_, i) => resp(MAX_MESSAGES_PER_CHANNEL - 5 - 4 + i));
    const next = reduceSetAroundMessages(prev, 1, window, true, true, true);
    expect(ids(next)).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(ids(next)[0]).toBe(1);
    expect(next.hasMore.get(1)).toBe(false);
  });
});
