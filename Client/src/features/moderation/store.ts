/**
 * The Moderation Center's invalidation signal (B9-11). mod_queue says only
 * that a report changed; this keeps a counter and no queue, evidence or
 * report data, so the open view re-reads the server and nothing private
 * outlives it.
 */

import { createStore } from "@lib/store";

/** Bumped by every report-queue frame. */
export const modQueueStore = createStore<number>(0);

export function noteQueueChange(): void {
  modQueueStore.setState((rev) => rev + 1);
}
