/**
 * Status timers: Idle, Do Not Disturb or Invisible "for 1 hour", then back to
 * Online.
 *
 * Entirely client-side, like auto-idle (lib/autoIdle.ts): the server only ever
 * sees the status flip to Online when the time is up. The expiry is stored
 * beside the saved status (userStatus.ts), so an app restart inside the window
 * still ends it on time, and one that starts after the end reverts at once.
 *
 * The watcher is owned by the session (MainPage) and holds one timer at a
 * time. It only ever ends a timer it is looking at, and only while the saved
 * status is still the timed one:
 *
 *  - Any other status write (a manual pick here, in Settings or the tray, the
 *    idle watcher) clears the stored timer in `saveUserStatus`, so this module
 *    sees the change and stands down.
 *  - A status the *server* reports for us that differs from the timed one
 *    (another device changed it, or a reconnect handed back something else)
 *    cancels the timer too; the status stays as it now is on the server and
 *    nothing is sent.
 *  - The timer firing re-reads the stored timer and the saved status first, so
 *    it can never override a newer manual choice it has not heard about yet.
 */

import { Disposable } from "./disposable";
import { setOwnedTimeout } from "./dom";
import type { UserStatus } from "./types";
import {
  clearStatusTimer,
  loadStatusTimer,
  loadUserStatus,
  onStatusTimerChange,
  onUserStatusChange,
  saveUserStatus,
  type StatusTimer,
} from "./userStatus";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";

/** The longest delay a browser timer holds (a signed 32-bit millisecond count).
 *  A longer wait is slept in pieces. */
const MAX_TIMER_MS = 2_147_483_647;

export interface StatusTimerWatcherOptions {
  /** Send the revert. The watcher has already saved the new status; the caller
   *  owns the transport (the shared presence sender), as autoIdle's does. */
  readonly onRevert: (status: UserStatus) => void;
  /** Injected in tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface StatusTimerWatcher {
  /** Stop watching and cancel the pending timer. The stored timer stays, so
   *  the next session still ends it. */
  destroy(): void;
}

/** The server says our status is `reported`: end the timer if that is not
 *  the status it was set for. */
function onServerStatus(reported: UserStatus | null | undefined): void {
  // "offline" is what everyone is told about an invisible user, and what our
  // own entry reads while the socket is down: not a different choice.
  if (reported === null || reported === undefined || reported === "offline") return;
  const timer = loadStatusTimer();
  if (timer === null || reported === timer.status) return;
  clearStatusTimer();
}

export function startStatusTimerWatcher(options: StatusTimerWatcherOptions): StatusTimerWatcher {
  const now = options.now ?? Date.now;
  const disposable = new Disposable();
  /** Bumped by every arm and disarm: a timer whose generation is stale was
   *  superseded and does nothing when it fires. */
  let generation = 0;

  function disarm(): void {
    generation += 1;
  }

  function expire(timer: StatusTimer): void {
    disarm();
    const stored = loadStatusTimer();
    if (
      stored === null ||
      stored.status !== timer.status ||
      stored.until !== timer.until ||
      loadUserStatus() !== timer.status
    ) {
      return;
    }
    // Clears the stored timer too (saveUserStatus), and its event re-syncs us
    // to "nothing to watch".
    saveUserStatus("online");
    options.onRevert("online");
  }

  function sync(): void {
    disarm();
    const timer = loadStatusTimer();
    if (timer === null) return;
    if (loadUserStatus() !== timer.status) {
      // A leftover from a status that was changed without going through
      // saveUserStatus (an older client sharing the storage).
      clearStatusTimer();
      return;
    }
    const remaining = timer.until - now();
    if (remaining <= 0) {
      expire(timer);
      return;
    }
    const mine = generation;
    setOwnedTimeout(
      disposable.signal,
      () => {
        if (mine !== generation) return;
        if (remaining > MAX_TIMER_MS) sync();
        else expire(timer);
      },
      Math.min(remaining, MAX_TIMER_MS),
    );
  }

  disposable.addCleanup(onStatusTimerChange(sync, { signal: disposable.signal }));
  // A status written without a timer (saveUserStatus already cleared it) is
  // covered above; this keeps a stale stored timer from outliving a status
  // changed while the watcher is mid-flight.
  disposable.addCleanup(onUserStatusChange(sync, { signal: disposable.signal }));
  disposable.onStoreChange(
    membersStore,
    (s) => {
      const id = authStore.getState().user?.id;
      return id === undefined ? null : (s.members.get(id)?.status ?? null);
    },
    onServerStatus,
  );
  disposable.onStoreChange(authStore, (s) => s.user?.status ?? null, onServerStatus);
  // A laptop that slept through the end fires its timer late, or not at all
  // until it wakes; looking again on focus ends it as soon as the user is back.
  disposable.onEvent(window, "focus", sync);
  disposable.addCleanup(disarm);

  sync();

  return { destroy: () => disposable.destroy() };
}
