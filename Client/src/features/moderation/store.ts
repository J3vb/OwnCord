/**
 * The Moderation Center's invalidation signals (B9-11, B9-17). mod_queue says
 * only that a report or an appeal changed; these keep counters and no queue,
 * evidence, report or appeal data, so the open view re-reads the server and
 * nothing private outlives it.
 */

import { createStore } from "@lib/store";

/** Bumped by every report-queue frame. */
export const modQueueStore = createStore<number>(0);

export function noteQueueChange(): void {
  modQueueStore.setState((rev) => rev + 1);
}

/** Bumped by every appeal-queue frame. */
export const modAppealStore = createStore<number>(0);

export function noteAppealChange(): void {
  modAppealStore.setState((rev) => rev + 1);
}
