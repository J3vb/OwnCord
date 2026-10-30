/**
 * Timed-mute expiry: pruning ended mutes and the page-owned watcher that does
 * it on a schedule. Split from `channel-mutes.ts` so the page loads it on
 * demand; whether a channel is muted is decided at read time in that module,
 * so nothing here is needed for the notify gates to be right.
 */

import { Disposable } from "../disposable";
import { setOwnedTimeout } from "../dom";
import {
  CHANNEL_MUTE_CHANGED,
  announceMuteChange,
  readMutedEntries,
  replaceMutedEntries,
} from "./channelMutes";

/** The longest a timed mute may have left. Only a clock set backwards can
 *  exceed it, and `pruneExpiredMutes` pulls such an entry back in. */
const MAX_MUTE_MS = 86_400_000;

/** The expiry watcher never sleeps longer than this, so a suspended machine or
 *  a moved clock leaves a stale dim for at most about a minute. */
const WATCH_CAP_MS = 60_000;

/**
 * Remove every mute that has ended by `now`, write once, announce each removed
 * id, and return them. A timed entry with more than a day left (only possible
 * after the clock moved back) is pulled in to `now` + 24 h, so a backward jump
 * can never stretch a mute past a day from now.
 */
export function pruneExpiredMutes(now: number): readonly number[] {
  const current = readMutedEntries();
  const removed: number[] = [];
  const next = new Map<number, number | null>();
  let changed = false;
  for (const [id, until] of current) {
    if (until === null) {
      next.set(id, null);
    } else if (until <= now) {
      removed.push(id);
      changed = true;
    } else if (until > now + MAX_MUTE_MS) {
      next.set(id, now + MAX_MUTE_MS);
      changed = true;
    } else {
      next.set(id, until);
    }
  }
  if (!changed) return [];
  replaceMutedEntries(next, now);
  for (const id of removed) announceMuteChange(id);
  return removed;
}

/** The soonest end among active timed mutes, or null when there is none. */
function nextMuteExpiry(): number | null {
  const now = Date.now();
  let soonest: number | null = null;
  for (const until of readMutedEntries().values()) {
    if (until !== null && until > now && (soonest === null || until < soonest)) soonest = until;
  }
  return soonest;
}

/**
 * Start the page-owned watcher that redraws the UI when a timed mute ends.
 * Returns its stop function. The watcher only prunes and announces; whether a
 * channel is muted is always decided by `isChannelMuted` at read time, so a
 * timer that never fires costs a stale dim for up to a minute and nothing else.
 *
 * Each arming owns its own child `Disposable`, so re-arming destroys the
 * previous timer. It re-arms on every mute change, and re-checks on window
 * focus and when the page becomes visible (a machine that slept through an
 * expiry). It checks once at start, for mutes that ended while closed.
 */
export function startMuteExpiryWatch(): () => void {
  const owner = new Disposable();
  let arm: Disposable | null = null;
  owner.addCleanup(() => arm?.destroy());

  const schedule = (): void => {
    arm?.destroy();
    arm = null;
    if (owner.signal.aborted) return;
    const next = nextMuteExpiry();
    if (next === null) return;
    arm = new Disposable();
    const delay = Math.min(Math.max(next - Date.now(), 0), WATCH_CAP_MS);
    setOwnedTimeout(arm.signal, check, delay);
  };
  const check = (): void => {
    pruneExpiredMutes(Date.now());
    schedule();
  };

  window.addEventListener(CHANNEL_MUTE_CHANGED, schedule, { signal: owner.signal });
  window.addEventListener("focus", check, { signal: owner.signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") check();
    },
    { signal: owner.signal },
  );
  check();
  return () => owner.destroy();
}
