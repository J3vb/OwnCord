/**
 * Blocks store — holds DM block state so the composer can gate on it.
 * Immutable state updates only.
 *
 * Two directions, per channels-members-dms.md §3.2:
 *  - blockedByMe:   recipient userIds the local user has blocked (authoritative,
 *                   from GET /blocks). Shows "You've blocked this user…".
 *  - blockedByThem: recipient userIds whose DM refused a send (the server returns
 *                   a generic FORBIDDEN, so this is learned from a refused send,
 *                   not revealed up front). Shows the neutral "You can't message…".
 *                   Cleared on every ready so a fresh session re-evaluates.
 */

import { createStore } from "@lib/store";

/** Shown when the local user is the blocker. */
export const BLOCKED_BY_ME_REASON = "You've blocked this user. Unblock to send messages.";
/** Neutral reason for the blocking direction — never reveals the block explicitly. */
export const BLOCKED_BY_THEM_REASON = "You can't message this user right now.";

export interface BlocksState {
  readonly blockedByMe: ReadonlySet<number>;
  readonly blockedByThem: ReadonlySet<number>;
}

const INITIAL: BlocksState = {
  blockedByMe: new Set(),
  blockedByThem: new Set(),
};

export const blocksStore = createStore<BlocksState>(INITIAL);

/** Replace the blocked-by-me set (from GET /blocks). */
export function setBlockedByMe(userIds: readonly number[]): void {
  blocksStore.setState((prev) => ({ ...prev, blockedByMe: new Set(userIds) }));
}

/** Mark (or unmark) a user as blocked by the local user (after PUT/DELETE /blocks). */
export function setUserBlockedByMe(userId: number, blocked: boolean): void {
  blocksStore.setState((prev) => {
    if (prev.blockedByMe.has(userId) === blocked) return prev;
    const next = new Set(prev.blockedByMe);
    if (blocked) next.add(userId);
    else next.delete(userId);
    return { ...prev, blockedByMe: next };
  });
}

/** Mark (or unmark) a recipient as having refused our DM. */
export function setUserBlockedByThem(userId: number, blocked: boolean): void {
  blocksStore.setState((prev) => {
    if (prev.blockedByThem.has(userId) === blocked) return prev;
    const next = new Set(prev.blockedByThem);
    if (blocked) next.add(userId);
    else next.delete(userId);
    return { ...prev, blockedByThem: next };
  });
}

/** Clear all blocked-by-them state (called on ready — stale after reconnect). */
export function clearBlockedByThem(): void {
  blocksStore.setState((prev) =>
    prev.blockedByThem.size === 0 ? prev : { ...prev, blockedByThem: new Set() },
  );
}

/**
 * The composer disable reason for a DM with `recipientId`, or null if unblocked.
 * blockedByMe takes precedence so the user always sees that they are the blocker.
 */
export function dmComposerBlockReason(state: BlocksState, recipientId: number): string | null {
  if (state.blockedByMe.has(recipientId)) return BLOCKED_BY_ME_REASON;
  if (state.blockedByThem.has(recipientId)) return BLOCKED_BY_THEM_REASON;
  return null;
}
