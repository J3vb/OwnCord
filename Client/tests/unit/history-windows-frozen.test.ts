/**
 * Pins historyWindows.ts's setMessages and setAroundMessages reducers to a
 * frozen copy of the implementation they had before they were split into
 * named steps. The copy below is deliberately verbatim and must not be edited
 * to follow the live code.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { MessageResponse } from "../../src/lib/types";
import {
  MAX_MESSAGES_PER_CHANNEL,
  messageResponseToMessage,
} from "../../src/features/messaging/messageModel";
import type { Message, MessagesState } from "../../src/features/messaging/messageModel";
import { isUnreconciledEcho } from "../../src/features/messaging/echoReconcile";
import { mergeMessagePoll } from "../../src/lib/pollState";
import {
  reduceSetMessages,
  reduceSetAroundMessages,
} from "../../src/features/messaging/historyWindows";

// ---- Frozen copy -------------------------------------------------------------

/** Fields only a live chat_message row carries (the user's role and nickname,
 *  the echoed client_message_id); history never sends them, so their absence
 *  from a refetched row is not a change. */
const LIVE_ONLY_KEYS = new Set(["clientMessageId", "role", "display_name"]);

/** The keys of `o` that count toward sameValue. */
function present(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] != null && !LIVE_ONLY_KEYS.has(k));
}

/** Deep equality over plain data; null, undefined and live-only properties
 *  count as absent and key order is ignored, so a live-built row equals its
 *  REST twin. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = present(x);
  return keys.length === present(y).length && keys.every((k) => sameValue(x[k], y[k]));
}

/** setMessages' reducer: merge a newest-first REST page into the channel's window. */
function frozenSetMessages(
  prev: MessagesState,
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
  splice = false,
  anchorId: number | null = null,
): MessagesState {
  const converted = messages.map(messageResponseToMessage).toReversed();
  const trimmed =
    converted.length > MAX_MESSAGES_PER_CHANNEL
      ? converted.slice(converted.length - MAX_MESSAGES_PER_CHANNEL)
      : converted;
  const previous = prev.messagesByChannel.get(channelId) ?? [];
  const snapshotIds = new Set(trimmed.map((m) => m.id));
  const maxSnapshotId = trimmed.reduce((max, m) => Math.max(max, m.id), 0);
  // A "sent" row survives only if it arrived after the fetch actually
  // started — maxSnapshotId alone can't tell that apart from "the snapshot
  // was empty" (id > 0 is vacuously true for a purged/empty page's own
  // default of 0). The watermark setChannelLoading recorded at fetch start
  // is the floor: a row already present then is stale once an empty/smaller
  // page comes back, while a live broadcast that landed mid-fetch (id above
  // the watermark) is still newer than either bound and survives either way.
  const carryFloor = Math.max(maxSnapshotId, prev.loadWatermark?.get(channelId) ?? 0);
  // A pending/OFFLINE-failed row whose chat_send_ok ack was lost to the same
  // disconnect that forced this resync would otherwise survive forever
  // (its id stays 0, so it can never collide with the real id above) while
  // the fresh snapshot already carries its persisted echo — drop it rather
  // than show both. Each snapshot row is consumed by at most one carried
  // row so two genuinely distinct sends with identical text each keep a row.
  const consumedEchoes = new Set<number>();
  const carried = previous.filter((m) => {
    if (snapshotIds.has(m.id)) return false;
    if (m.status === "sent") return m.id > carryFloor;
    const echoIdx = trimmed.findIndex((s, i) => !consumedEchoes.has(i) && isUnreconciledEcho(m, s));
    if (echoIdx === -1) return true;
    consumedEchoes.add(echoIdx);
    return false;
  });
  // A row nothing changed keeps its object, so the list can keep its DOM row
  // and the whole array can be returned as-is when nothing changed at all.
  const cachedById = new Map(previous.filter((m) => m.status === "sent").map((m) => [m.id, m]));
  // A page fetched before a newer poll update must not roll that poll back.
  const snapshot = trimmed.map((fetched) => {
    const cached = cachedById.get(fetched.id);
    const m = mergeMessagePoll(cached, fetched);
    return cached !== undefined && sameValue(cached, m) ? cached : m;
  });
  // A resync splice keeps the loaded rows older than the page when the page
  // reaches back to what was loaded at fetch start, so nothing is missing
  // between them. A gap, or a page that is the whole channel, replaces.
  const minSnapshotId = trimmed[0]?.id ?? 0;
  const older =
    splice &&
    hasMore &&
    trimmed.length > 0 &&
    minSnapshotId <= (prev.loadWatermark?.get(channelId) ?? 0)
      ? previous.filter((m) => m.status === "sent" && m.id < minSnapshotId)
      : [];
  let merged: readonly Message[] = [...older, ...snapshot, ...carried];
  const overflow = merged.length - MAX_MESSAGES_PER_CHANNEL;
  const mergeTrimmed = overflow > 0;
  // A splice that would trim the reader's anchor off the top keeps the head
  // instead and detaches, as prependMessages does, so the reader stays put.
  const anchorIdx = anchorId === null ? -1 : merged.findIndex((m) => m.id === anchorId);
  const keepHead = mergeTrimmed && older.length > 0 && anchorIdx !== -1 && anchorIdx < overflow;
  if (keepHead) {
    const cut = merged.slice(MAX_MESSAGES_PER_CHANNEL).filter((m) => m.status !== "sent");
    merged = [...merged.slice(0, MAX_MESSAGES_PER_CHANNEL), ...cut];
  } else if (mergeTrimmed) {
    merged = merged.slice(overflow);
  }
  if (merged.length === previous.length && merged.every((m, i) => m === previous[i])) {
    merged = previous;
  }

  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, merged);

  const updatedLoaded = new Set(prev.loadedChannels);
  updatedLoaded.add(channelId);

  const updatedHasMore = new Map(prev.hasMore);
  updatedHasMore.set(
    channelId,
    (older.length > 0 ? (prev.hasMore.get(channelId) ?? hasMore) : hasMore) ||
      converted.length > MAX_MESSAGES_PER_CHANNEL ||
      (mergeTrimmed && !keepHead),
  );

  const updatedLoadState = new Map(prev.historyLoadState);
  updatedLoadState.delete(channelId);

  // Loading the plain tail reattaches: this *is* the live end, unless the
  // trim above cut it off again.
  const updatedDetached = new Set(prev.detachedChannels);
  if (keepHead) {
    updatedDetached.add(channelId);
  } else {
    updatedDetached.delete(channelId);
  }

  // The watermark's job ends here — it was consumed as carryFloor above.
  const updatedWatermark = new Map(prev.loadWatermark ?? []);
  updatedWatermark.delete(channelId);

  return {
    ...prev,
    messagesByChannel: updatedMessages,
    loadedChannels: updatedLoaded,
    hasMore: updatedHasMore,
    historyLoadState: updatedLoadState,
    detachedChannels: updatedDetached,
    loadWatermark: updatedWatermark,
  };
}

/** setAroundMessages' reducer: replace the window with an oldest-first around-window. */
function frozenSetAround(
  prev: MessagesState,
  channelId: number,
  messages: readonly MessageResponse[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
  splice = false,
): MessagesState {
  // A window fetched before a newer poll update must not roll that poll back.
  const loaded = new Map(
    (prev.messagesByChannel.get(channelId) ?? [])
      .filter((m) => m.poll !== undefined)
      .map((m) => [m.id, m]),
  );
  const converted = messages
    .map(messageResponseToMessage)
    .map((m) => mergeMessagePoll(loaded.get(m.id), m));
  // Defensive: the server caps a window at 100, so this never fires today.
  // If it ever does, keep the older head — dropping the newest end is what the
  // detached flag below already describes, whereas dropping the head would
  // silently move the window past the jump target.
  const trimmed =
    converted.length > MAX_MESSAGES_PER_CHANNEL
      ? converted.slice(0, MAX_MESSAGES_PER_CHANNEL)
      : converted;
  const previous = prev.messagesByChannel.get(channelId) ?? [];
  // Reattaches iff the window reaches the live tail with nothing stranded —
  // the exact negation of the detached condition below. Only then does the
  // window claim to BE "now", so only then may a live "sent" row newer than
  // it survive; a window that stays detached makes no such claim, and that
  // message is instead represented by the "Jump to Present" pill (plus the
  // unread bump) once it lands for real.
  const attached = !hasMoreAfter && trimmed.length === converted.length;
  const maxWindowId = trimmed.reduce((max, m) => Math.max(max, m.id), 0);
  const carried = previous.filter((m) => m.status !== "sent" || (attached && m.id > maxWindowId));
  // A resync splice is centred on a loaded row, so it overlaps the window:
  // keep the loaded rows above it, and below it while it stays detached.
  const splicing = splice && trimmed.length > 0;
  const minWindowId = trimmed[0]?.id ?? 0;
  const older =
    splicing && hasMoreBefore
      ? previous.filter((m) => m.status === "sent" && m.id < minWindowId)
      : [];
  const newer =
    splicing && !attached ? previous.filter((m) => m.status === "sent" && m.id > maxWindowId) : [];
  let merged: readonly Message[] =
    older.length + newer.length + carried.length > 0
      ? [...older, ...trimmed, ...newer, ...carried]
      : trimmed;
  const mergeTrimmed = splicing && merged.length > MAX_MESSAGES_PER_CHANNEL;
  if (mergeTrimmed) merged = merged.slice(merged.length - MAX_MESSAGES_PER_CHANNEL);
  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, merged);

  const updatedLoaded = new Set(prev.loadedChannels);
  updatedLoaded.add(channelId);

  const updatedHasMore = new Map(prev.hasMore);
  updatedHasMore.set(
    channelId,
    (older.length > 0 ? (prev.hasMore.get(channelId) ?? hasMoreBefore) : hasMoreBefore) ||
      mergeTrimmed,
  );

  const updatedLoadState = new Map(prev.historyLoadState);
  updatedLoadState.delete(channelId);

  const updatedDetached = new Set(prev.detachedChannels);
  if (attached) {
    updatedDetached.delete(channelId);
  } else {
    updatedDetached.add(channelId);
  }

  return {
    ...prev,
    messagesByChannel: updatedMessages,
    loadedChannels: updatedLoaded,
    hasMore: updatedHasMore,
    historyLoadState: updatedLoadState,
    detachedChannels: updatedDetached,
  };
}

// ---- Generators --------------------------------------------------------------

const CH = 7;

const userArb = fc.record({
  id: fc.integer({ min: 1, max: 3 }),
  username: fc.constantFrom("a", "b", "c"),
});

const pollArb = fc.record({
  question: fc.constant("q"),
  answers: fc.constant([]),
  allow_multiselect: fc.boolean(),
  expires_at: fc.constant("2030-01-01T00:00:00Z"),
  ended: fc.boolean(),
  ended_at: fc.constantFrom(null, "2030-01-01T00:00:00Z"),
  results: fc.record({
    version: fc.integer({ min: 0, max: 3 }),
    total_voters: fc.integer({ min: 0, max: 2 }),
    counts: fc.constant([]),
    me: fc.constantFrom([] as number[], [1]),
  }),
});

const contentArb = fc.constantFrom("hi", "hello", "x", "", "hi ");

function responseArb(id: number): fc.Arbitrary<MessageResponse> {
  return fc
    .record({
      user: userArb,
      content: contentArb,
      pinned: fc.boolean(),
      poll: fc.option(pollArb, { nil: undefined }),
    })
    .map(({ user, content, pinned, poll }) => ({
      id,
      channel_id: CH,
      user,
      content,
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned,
      edited_at: null,
      deleted: false,
      timestamp: "2024-01-01T00:00:00Z",
      mentions: [],
      mentions_everyone: false,
      ...(poll !== undefined && { poll: poll }),
    }));
}

/** Distinct ascending ids drawn from a small pool so pages overlap what is loaded. */
const idsArb = (max: number, pool = 60): fc.Arbitrary<number[]> =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: pool }), { maxLength: max })
    .map((a) => a.toSorted((x, y) => x - y));

const pageArb = (ids: fc.Arbitrary<number[]>): fc.Arbitrary<MessageResponse[]> =>
  ids.chain((list) => fc.tuple(...list.map(responseArb)).map((t) => t));

const optimisticArb: fc.Arbitrary<Message> = fc
  .record({
    user: userArb,
    content: contentArb,
    status: fc.constantFrom<("pending" | "failed")[]>("pending", "failed"),
    errorCode: fc.constantFrom(null, "OFFLINE", "SLOW_MODE"),
    correlationId: fc.constantFrom(null, "c1", "c2"),
    clientMessageId: fc.constantFrom(undefined, "m1", "m2"),
  })
  .map(({ user, content, status, errorCode, correlationId, clientMessageId }) => ({
    id: 0,
    channelId: CH,
    user,
    content,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2024-01-01T00:00:00Z",
    status,
    correlationId,
    errorCode,
    ...(clientMessageId !== undefined && { clientMessageId }),
  }));

const loadedArb = (ids: fc.Arbitrary<number[]>): fc.Arbitrary<Message[]> =>
  fc
    .tuple(
      pageArb(ids).map((p) => p.map(messageResponseToMessage)),
      fc.array(optimisticArb, { maxLength: 4 }),
    )
    .map(([sent, opt]) => [...sent, ...opt]);

/** Sometimes a window at or past the cap so the trim branches run. */
const loadedIdsArb = fc.oneof(
  { weight: 9, arbitrary: idsArb(25) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(496, 500, 520)
      .map((n) => Array.from({ length: n }, (_, i) => i + 1)),
  },
);
const pageIdsArb = fc.oneof(
  { weight: 9, arbitrary: idsArb(25) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(300, 501, 520)
      .map((n) => Array.from({ length: n }, (_, i) => i + 100)),
  },
);

const stateArb: fc.Arbitrary<MessagesState> = fc
  .record({
    loaded: loadedArb(loadedIdsArb),
    hasMore: fc.option(fc.boolean(), { nil: undefined }),
    loadedFlag: fc.boolean(),
    loading: fc.boolean(),
    detached: fc.boolean(),
    watermark: fc.option(fc.integer({ min: 0, max: 60 }), { nil: undefined }),
  })
  .map(({ loaded, hasMore, loadedFlag, loading, detached, watermark }) => ({
    messagesByChannel: new Map([[CH, loaded]]),
    pendingSends: new Map(),
    loadedChannels: new Set(loadedFlag ? [CH] : []),
    hasMore: new Map(hasMore === undefined ? [] : [[CH, hasMore]]),
    historyLoadState: new Map(loading ? [[CH, "loading" as const]] : []),
    detachedChannels: new Set(detached ? [CH] : []),
    ...(watermark !== undefined && { loadWatermark: new Map([[CH, watermark]]) }),
  }));

/** Everything observable about a result, identity of the row objects included. */
function observe(prev: MessagesState, next: MessagesState): unknown {
  const before = prev.messagesByChannel.get(CH) ?? [];
  const after = next.messagesByChannel.get(CH) ?? [];
  return {
    next,
    sameList: after === before,
    rowSources: after.map((m) => before.indexOf(m)),
  };
}

const RUNS = { numRuns: 400 };

describe("history windows keep their pre-split behaviour", () => {
  it("setMessages matches the frozen copy", () => {
    fc.assert(
      fc.property(
        stateArb,
        pageIdsArb.chain((ids) => pageArb(fc.constant(ids.toReversed()))),
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }),
        (prev, page, hasMore, splice, anchor) => {
          const live = reduceSetMessages(prev, CH, page, hasMore, splice, anchor);
          const old = frozenSetMessages(prev, CH, page, hasMore, splice, anchor);
          expect(observe(prev, live)).toEqual(observe(prev, old));
        },
      ),
      RUNS,
    );
  }, 60_000);

  it("setAroundMessages matches the frozen copy", () => {
    fc.assert(
      fc.property(
        stateArb,
        pageIdsArb.chain((ids) => pageArb(fc.constant(ids))),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (prev, page, before, after, splice) => {
          const live = reduceSetAroundMessages(prev, CH, page, before, after, splice);
          const old = frozenSetAround(prev, CH, page, before, after, splice);
          expect(observe(prev, live)).toEqual(observe(prev, old));
        },
      ),
      RUNS,
    );
  }, 60_000);
});
