/**
 * Where the NEW divider goes for a rebuild: the latch that keeps it on one
 * message across window growth, and the three ways of finding the boundary
 * (the latched anchor, the read pointer, the unread count).
 */
import {
  getChannelMessages,
  getHistoryLoadState,
  isWindowDetached,
  type Message,
} from "@stores/messages.store";
import { firstUnreadIndex } from "./virtualItems";

/** The list state the divider latch reads and writes. */
export interface DividerLatch {
  newDividerAnchorId: number | null;
  newDividerDeferred: boolean;
  openAtDividerPending: boolean;
  readonly linePointer: number | undefined;
  readonly unreadOnOpen: number;
}

/** What the latch asks of the stores, read only at the point it is needed. */
export interface DividerEnv {
  /** The store keeps the deleted anchor as a tombstone. */
  isTombstone(anchorId: number): boolean;
  isDetached(): boolean;
  isHistoryLoading(): boolean;
}

export function storeDividerEnv(channelId: number): DividerEnv {
  return {
    isTombstone: (anchorId) =>
      getChannelMessages(channelId).some((m) => m.id === anchorId && m.deleted),
    isDetached: () => isWindowDetached(channelId),
    isHistoryLoading: () => getHistoryLoadState(channelId) === "loading",
  };
}

/** The first loaded message above the pointer, latched like the count-based
 *  one — except at the top of the window, where older history may still
 *  arrive above it and move the true boundary. */
function byPointer(latch: DividerLatch, messages: readonly Message[]): number {
  const idx = messages.findIndex((m) => m.id > (latch.linePointer ?? 0));
  if (idx > 0) latch.newDividerAnchorId = messages[idx]!.id;
  return idx;
}

/** The latched anchor's index, or null when the latch is open and the other
 *  ways of placing the line apply. */
function fromAnchor(
  latch: DividerLatch,
  messages: readonly Message[],
  env: DividerEnv,
): number | null {
  const anchorId = latch.newDividerAnchorId;
  if (anchorId === null) return null;
  const at = messages.findIndex((m) => m.id === anchorId);
  if (at === -1 && env.isTombstone(anchorId)) {
    // The anchor was deleted: the line moves to the first message after it,
    // or waits when there is none.
    const nextAt = messages.findIndex((m) => m.id > anchorId);
    if (nextAt === -1) return -1;
    latch.newDividerAnchorId = messages[nextAt]!.id;
    return nextAt;
  }
  if (at !== -1 || latch.linePointer === undefined) return at;
  // The anchor left the window (a jump): place the line again by pointer.
  latch.newDividerAnchorId = null;
  return null;
}

/** The boundary counted back from the end of the window, latched once the
 *  window is as long as the unread count and the row is a confirmed one. */
function byCount(latch: DividerLatch, messages: readonly Message[]): number {
  const idx = firstUnreadIndex(messages, latch.unreadOnOpen);
  const anchor = idx !== -1 ? messages[idx] : undefined;
  if (anchor !== undefined && anchor.id !== 0 && messages.length >= latch.unreadOnOpen) {
    latch.newDividerAnchorId = anchor.id;
  }
  return idx;
}

/**
 * Resolve the NEW divider's position for this rebuild. Prefers the latched
 * anchor id (stable across window growth); falls back to the count formula
 * only until an anchor exists, then latches it — skipping id 0 (an
 * unconfirmed optimistic row) since that id is not unique across pending
 * sends and would anchor to the wrong message once reconciled.
 *
 * Also skips latching while the window is shorter than unreadOnOpen: the
 * initial mount can render one live message before the async history
 * fetch resolves, and firstUnreadIndex's
 * `Math.max(0, ...)` clamp turns that 1-row window into index 0 just like a
 * real boundary would. Latching onto that message would glue the divider
 * to whatever happened to arrive first instead of the actual unread
 * boundary once the full window loads.
 */
export function resolveNewDividerIndex(
  latch: DividerLatch,
  messages: readonly Message[],
  env: DividerEnv,
): number {
  const anchored = fromAnchor(latch, messages, env);
  if (anchored !== null) return anchored;
  // An around-window centred on a jumped-to message is not the tail: counting
  // back from its end would mark an arbitrary row. Detachment is read here,
  // not at mount, because a cross-channel jump detaches after the mount.
  if (env.isDetached()) {
    latch.newDividerDeferred = false;
    // No divider will exist to open at, and a pending open left armed would
    // scroll the reader up to the line once the tail returns.
    latch.openAtDividerPending = false;
    // A pointer places the line inside the around-window too (never scrolled to).
    return latch.linePointer === undefined ? -1 : byPointer(latch, messages);
  }
  // A revisit renders the cached window while its tail is refetched.
  // Those rows predate what arrived while away, so counting back from their
  // end would mark messages already read; wait for the fetched tail.
  latch.newDividerDeferred = latch.unreadOnOpen > 0 && env.isHistoryLoading();
  if (latch.newDividerDeferred) return -1;
  if (latch.linePointer !== undefined) {
    // Only a channel that had unread when opened: with none, the first message
    // above the pointer is just the first live arrival.
    return latch.unreadOnOpen > 0 ? byPointer(latch, messages) : -1;
  }
  return byCount(latch, messages);
}
