// History-window reducers for the messages store: first-page load state,
// the REST page merge, around-windows detached from the live tail, window
// invalidation and infinite-scroll prepends. Pure (prev, input) => next
// functions, extracted from stores/messages.store.ts, whose mutators wrap each
// in messagesStore.setState and keep the documented contracts. Returning
// `prev` by identity when nothing changed is behavior: selector subscriptions
// compare with ===.
import type { MessageResponse } from "../../lib/types";
import { MAX_MESSAGES_PER_CHANNEL, messageResponseToMessage } from "./messageModel";
import type { MessagesState } from "./messageModel";
import { isUnreconciledEcho } from "./echoReconcile";

/** setChannelLoading's reducer. */
export function reduceSetChannelLoading(prev: MessagesState, channelId: number): MessagesState {
  const updated = new Map(prev.historyLoadState);
  updated.set(channelId, "loading");
  const existing = prev.messagesByChannel.get(channelId) ?? [];
  const currentMaxId = existing.reduce((max, m) => Math.max(max, m.id), 0);
  const updatedWatermark = new Map(prev.loadWatermark ?? []);
  updatedWatermark.set(channelId, currentMaxId);
  return { ...prev, historyLoadState: updated, loadWatermark: updatedWatermark };
}

/** setChannelLoadError's reducer. */
export function reduceSetChannelLoadError(prev: MessagesState, channelId: number): MessagesState {
  const updated = new Map(prev.historyLoadState);
  updated.set(channelId, "error");
  return { ...prev, historyLoadState: updated };
}

/** setMessages' reducer: merge a newest-first REST page into the channel's window. */
export function reduceSetMessages(
  prev: MessagesState,
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
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
  let merged = carried.length > 0 ? [...trimmed, ...carried] : trimmed;
  const mergeTrimmed = merged.length > MAX_MESSAGES_PER_CHANNEL;
  if (mergeTrimmed) {
    merged = merged.slice(merged.length - MAX_MESSAGES_PER_CHANNEL);
  }

  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, merged);

  const updatedLoaded = new Set(prev.loadedChannels);
  updatedLoaded.add(channelId);

  const updatedHasMore = new Map(prev.hasMore);
  updatedHasMore.set(
    channelId,
    hasMore || converted.length > MAX_MESSAGES_PER_CHANNEL || mergeTrimmed,
  );

  const updatedLoadState = new Map(prev.historyLoadState);
  updatedLoadState.delete(channelId);

  // Loading the plain tail always reattaches: this *is* the live end.
  const updatedDetached = new Set(prev.detachedChannels);
  updatedDetached.delete(channelId);

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
export function reduceSetAroundMessages(
  prev: MessagesState,
  channelId: number,
  messages: readonly MessageResponse[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): MessagesState {
  const converted = messages.map(messageResponseToMessage);
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
  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, carried.length > 0 ? [...trimmed, ...carried] : trimmed);

  const updatedLoaded = new Set(prev.loadedChannels);
  updatedLoaded.add(channelId);

  const updatedHasMore = new Map(prev.hasMore);
  updatedHasMore.set(channelId, hasMoreBefore);

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

/** invalidateLoadedMessageWindows' reducer. */
export function reduceInvalidateLoadedMessageWindows(prev: MessagesState): MessagesState {
  if (prev.loadedChannels.size === 0) return prev;
  const updatedMessages = new Map(prev.messagesByChannel);
  for (const channelId of prev.loadedChannels) {
    const existing = updatedMessages.get(channelId);
    if (existing === undefined) continue;
    const carried = existing.filter((m) => m.status !== "sent");
    if (carried.length > 0) {
      updatedMessages.set(channelId, carried);
    } else {
      updatedMessages.delete(channelId);
    }
  }
  return {
    ...prev,
    messagesByChannel: updatedMessages,
    loadedChannels: new Set(),
    hasMore: new Map(),
    detachedChannels: new Set(),
  };
}

/** invalidateChannelMessageWindow's reducer. */
export function reduceInvalidateChannelMessageWindow(
  prev: MessagesState,
  channelId: number,
): MessagesState {
  if (!prev.loadedChannels.has(channelId)) return prev;
  const updatedLoaded = new Set(prev.loadedChannels);
  updatedLoaded.delete(channelId);
  return { ...prev, loadedChannels: updatedLoaded };
}

/** reattachToPresent's reducer. */
export function reduceReattachToPresent(prev: MessagesState, channelId: number): MessagesState {
  if (!prev.detachedChannels.has(channelId)) return prev;
  const updatedLoaded = new Set(prev.loadedChannels);
  updatedLoaded.delete(channelId);
  return { ...prev, loadedChannels: updatedLoaded };
}

/** prependMessages' reducer: add an older newest-first page above the window. */
export function reducePrependMessages(
  prev: MessagesState,
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): MessagesState {
  const converted = messages.map(messageResponseToMessage).toReversed();
  const existing = prev.messagesByChannel.get(channelId) ?? [];
  let combined = [...converted, ...existing];
  // Keep the OLDEST rows (start of array) when the cap is exceeded: the
  // user is scrolling up, so the fetched page must survive — trimming it
  // would make every cap-hit prepend a content-identical no-op that
  // refetches the same page forever. Dropped "sent" rows are restored via
  // the detached-window machinery ("Jump to Present"), mirroring
  // setAroundMessages' window semantics — but pending/failed rows in the
  // tail are the only copy of the user's composed text, so they are carried
  // across the trim exactly as every other window-replacing writer does.
  const wasTrimmed = combined.length > MAX_MESSAGES_PER_CHANNEL;
  if (wasTrimmed) {
    const kept = combined.slice(0, MAX_MESSAGES_PER_CHANNEL);
    const carried = combined.slice(MAX_MESSAGES_PER_CHANNEL).filter((m) => m.status !== "sent");
    combined = carried.length > 0 ? [...kept, ...carried] : kept;
  }
  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, combined);

  const updatedHasMore = new Map(prev.hasMore);
  // Trimming drops rows below the window, never above it, so "more above"
  // is exactly what the server said.
  updatedHasMore.set(channelId, hasMore);

  const updatedDetached = new Set(prev.detachedChannels);
  if (wasTrimmed) {
    updatedDetached.add(channelId);
  }

  return {
    ...prev,
    messagesByChannel: updatedMessages,
    hasMore: updatedHasMore,
    detachedChannels: updatedDetached,
  };
}
