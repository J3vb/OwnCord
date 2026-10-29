/**
 * The Moderation Center's invalidation signals. mod_queue says
 * only that a report or an appeal changed; these keep counters and no queue,
 * evidence, report or appeal data, so the open view re-reads the server and
 * nothing private outlives it.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/sessionRegistry";
import type { MemberTimeoutEntry } from "@lib/types";

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

/**
 * Who is timed out right now (user id -> expiry), as the server last said.
 * `null` means this server publishes no view (an older one), so a
 * menu cannot tell and offers both Timeout and Remove Timeout. A moderator
 * holds every entry; anyone else only their own. Presence of an entry is the
 * answer: the server re-sends on expiry, so the clock is never compared.
 */
export const memberTimeoutsStore = createStore<ReadonlyMap<number, string> | null>(null);

/** Replace the map wholesale; `undefined` (no field on the wire) stores `null`. */
export function setMemberTimeouts(list: readonly MemberTimeoutEntry[] | undefined): void {
  memberTimeoutsStore.setState(() =>
    list === undefined ? null : new Map(list.map((e) => [e.user_id, e.expires_at])),
  );
}

/** Forget the last server's view on sign-out or server switch. */
export function resetMemberTimeouts(): void {
  memberTimeoutsStore.setState(() => null);
}

// App-lifetime: a profile switch must not carry one server's timeouts into the next.
void registerSessionReset("moderation:timeouts", resetMemberTimeouts);
