/**
 * The followed-thread rows the sidebar and the unread badge draw.
 *
 * `threads.store` is a lazy chunk (most sessions never meet a thread), but the
 * sidebar and the badge are startup code. This small store is the seam: the
 * threads store publishes a plain-data projection of its follow map here after
 * every change, and startup code reads it without importing the lazy chunk.
 * Nothing else writes it. A session reset reaches it through the threads
 * store's own reset (it publishes the empty view).
 */

import { createStore } from "@lib/store";

/** One followed, open thread as a sidebar row draws it. */
export interface FollowedThreadRow {
  readonly id: number;
  readonly parentId: number;
  readonly name: string;
  readonly unread: number;
  readonly mentions: number;
  /** Time of the thread's last message (ms), 0 with none; the sort key. */
  readonly activityAt: number;
}

export interface FollowedThreadsView {
  /** Open followed threads by parent channel id, newest activity first. */
  readonly byParent: ReadonlyMap<number, readonly FollowedThreadRow[]>;
  /** The thread the side panel has open, or null. */
  readonly focusedId: number | null;
}

const EMPTY: FollowedThreadsView = { byParent: new Map(), focusedId: null };

export const followedThreadsStore = createStore<FollowedThreadsView>(EMPTY);

function sameRows(a: readonly FollowedThreadRow[], b: readonly FollowedThreadRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => {
      const o = b[i]!;
      return (
        r.id === o.id &&
        r.parentId === o.parentId &&
        r.name === o.name &&
        r.unread === o.unread &&
        r.mentions === o.mentions &&
        r.activityAt === o.activityAt
      );
    })
  );
}

function sameView(a: FollowedThreadsView, b: FollowedThreadsView): boolean {
  if (a.focusedId !== b.focusedId || a.byParent.size !== b.byParent.size) return false;
  for (const [parent, rows] of a.byParent) {
    const other = b.byParent.get(parent);
    if (other === undefined || !sameRows(rows, other)) return false;
  }
  return true;
}

/**
 * Replace the view. Called by `threads.store` only. An equal view is dropped,
 * so a history page or a change to an unrelated thread does not redraw the
 * sidebar.
 */
export function publishFollowedThreads(view: FollowedThreadsView): void {
  if (sameView(followedThreadsStore.getState(), view)) return;
  followedThreadsStore.setState(() => view);
}
