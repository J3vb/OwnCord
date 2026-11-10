// Who hears about a failed Mark Unread: the mounted lists, which drop the NEW line
// the mark drew, and the page's notice. Owns both registries; readState.ts
// calls announceMarkUnreadFailure once it has put the pointer back.

const markUnreadFailListeners = new Set<(channelId: number) => void>();

/**
 * Be told when a Mark Unread for any channel failed and its pointer was put
 * back (see `failMarkUnread`), so a mounted list can drop the NEW line the
 * mark drew. Returns the unsubscribe. A `read_state` that answers the mark
 * never notifies: the line stays.
 */
export function onMarkUnreadFailed(listener: (channelId: number) => void): () => void {
  markUnreadFailListeners.add(listener);
  return () => {
    markUnreadFailListeners.delete(listener);
  };
}

/** What to tell the user when a Mark Unread did not happen. */
export type MarkUnreadNotice = "rateLimited" | "notFound" | "failed";

let unreadNotice: ((notice: MarkUnreadNotice) => void) | null = null;

/** Register how a failed Mark Unread is shown (the page's, like the sender). */
export function setMarkUnreadNotice(next: ((notice: MarkUnreadNotice) => void) | null): void {
  unreadNotice = next;
}

/** Tell every list, then the page, that a Mark Unread for `channelId` did not happen. */
export function announceMarkUnreadFailure(channelId: number, notice: MarkUnreadNotice): void {
  for (const listener of markUnreadFailListeners) listener(channelId);
  unreadNotice?.(notice);
}
