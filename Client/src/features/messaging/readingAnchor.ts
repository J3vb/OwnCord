// The message the reader is looking at: the topmost message row of the mounted
// message list. A full-ready resync refetches a detached window around it
// (P2-T4), and the dispatcher holds no handle on the list, so the list
// registers its lookup here while it is mounted.

type AnchorLookup = (channelId: number) => number | null;

// Every mounted list registers, so a second list (a thread panel beside the
// channel) never evicts the first. Registration order is kept: the newest wins.
const lookups = new Set<AnchorLookup>();

/** Register the mounted list's lookup. The returned function unregisters only
 *  this registration. */
export function registerReadingAnchor(fn: AnchorLookup): () => void {
  lookups.add(fn);
  return () => {
    lookups.delete(fn);
  };
}

/** The id of the topmost visible message in `channelId`'s mounted list, or null.
 *  A list answers null for a channel that is not its own, so the newest list
 *  that does answer is the one showing `channelId`. */
export function readingAnchor(channelId: number): number | null {
  let found: number | null = null;
  for (const lookup of lookups) found = lookup(channelId) ?? found;
  return found;
}
