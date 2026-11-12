/** Undoing the optimistic order of a channel drop whose save was rejected. */

import { channelsStore, updateChannel, updateChannelPosition } from "@stores/channels.store";
import type { ChannelReorderData } from "./channelSidebarTypes";

export interface ReorderOutcome {
  failed: boolean;
  /** A rejected entry was the one that also changed category. */
  movedFailed: boolean;
  /** The first rejection's reason. */
  failure: unknown;
}

/**
 * Roll `entry` back to its previous position, and previous category, only if
 * no channel_update broadcast arrived for that channel since the request
 * started (the server broadcasts before it answers, so a broadcast means the
 * write landed) and it still shows the optimistic value. Only the broadcast
 * counts: unread/mention badge mutations also replace the channel object but
 * confirm nothing.
 */
function rollBackReorder(entry: ChannelReorderData, touched: ReadonlySet<number>): void {
  const stored = channelsStore.getState().channels.get(entry.channelId);
  if (
    touched.has(entry.channelId) ||
    stored === undefined ||
    stored.position !== entry.newPosition ||
    (entry.category !== undefined &&
      (stored.categoryId ?? 0) !== (entry.category.next.categoryId ?? 0))
  ) {
    return;
  }
  if (entry.category === undefined) {
    updateChannelPosition(entry.channelId, entry.previousPosition);
    return;
  }
  const prev = entry.category.previous;
  updateChannel({
    id: entry.channelId,
    position: entry.previousPosition,
    category_id: prev.categoryId ?? 0,
    category: prev.category ?? "",
    category_position: prev.categoryPosition ?? 0,
  });
}

/** Roll back every rejected entry of `reorders`; `results` is in the same order. */
export function rollBackRejectedReorders(
  results: readonly PromiseSettledResult<unknown>[],
  reorders: readonly ChannelReorderData[],
  touched: ReadonlySet<number>,
): ReorderOutcome {
  const outcome: ReorderOutcome = { failed: false, movedFailed: false, failure: undefined };
  results.forEach((result, i) => {
    const entry = reorders[i];
    if (result.status !== "rejected" || entry === undefined) return;
    if (!outcome.failed) outcome.failure = result.reason;
    outcome.failed = true;
    outcome.movedFailed = outcome.movedFailed || entry.category !== undefined;
    rollBackReorder(entry, touched);
  });
  return outcome;
}
