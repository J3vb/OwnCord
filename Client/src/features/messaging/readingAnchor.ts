// The message the reader is looking at: the topmost message row of the mounted
// message list. A full-ready resync refetches a detached window around it
// (P2-T4), and the dispatcher holds no handle on the list, so the list
// registers its lookup here while it is mounted.

type AnchorLookup = (channelId: number) => number | null;

let lookup: AnchorLookup | null = null;

/** Register the mounted list's lookup. The returned function unregisters it,
 *  unless a newer list has registered since. */
export function registerReadingAnchor(fn: AnchorLookup): () => void {
  lookup = fn;
  return () => {
    if (lookup === fn) lookup = null;
  };
}

/** The id of the topmost visible message in `channelId`'s mounted list, or null. */
export function readingAnchor(channelId: number): number | null {
  return lookup?.(channelId) ?? null;
}
