/**
 * Auto-idle: flip to Idle after ten quiet minutes, back to Online on the first
 * sign of life.
 *
 * Entirely client-side. The server has no idea whether anyone is at the
 * keyboard, and giving it one would mean a heartbeat carrying activity data it
 * has no other use for; the client already knows, and a presence_update is the
 * message that already says so.
 *
 * The rule that makes this safe to leave running is narrow: it only ever moves
 * a status the *timer itself* is responsible for.
 *
 *  - Manually chosen Idle, Do Not Disturb and Invisible are never touched.
 *    Someone who set Do Not Disturb to be left alone would be dragged back to
 *    Online by their own mouse otherwise, which is the opposite of what they
 *    asked for.
 *  - Only a manual Online becomes an automatic Idle, and only an automatic
 *    Idle becomes Online again. A manual Idle is a statement, not a timeout.
 *
 * Input listening is throttled to one bookkeeping call per second: mousemove
 * fires hundreds of times a second and the timer's resolution is minutes, so
 * anything finer is pure cost.
 */

import type { UserStatus } from "./types";
import { loadUserStatus, loadUserStatusOrigin, saveUserStatus } from "./userStatus";

/** How long without input before the status flips to idle. Discord's number. */
export const AUTO_IDLE_DELAY_MS = 10 * 60 * 1000;

/** Minimum gap between two activity bookkeeping runs. */
export const ACTIVITY_THROTTLE_MS = 1000;

/** Events that count as "the user is here". */
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;

export interface AutoIdleOptions {
  /** Called when the timer decides the status should change. The caller sends
   *  the presence_update and updates its own stores — this module owns the
   *  decision, not the transport. */
  readonly onStatusChange: (status: UserStatus) => void;
  /** Injected in tests. Defaults to `window`. */
  readonly target?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Injected in tests. Defaults to AUTO_IDLE_DELAY_MS. */
  readonly delayMs?: number;
}

export interface AutoIdleController {
  /** Report activity explicitly (e.g. after sending a message). */
  notifyActivity(): void;
  /** Stop listening and cancel the pending timer. */
  destroy(): void;
}

/**
 * Whether the timer may move the status right now, and to what.
 *
 * Exported because it is the entire policy, and a policy worth testing is
 * worth testing without a DOM and a ten-minute clock.
 */
export function nextAutoStatus(
  current: UserStatus,
  origin: "manual" | "auto",
  idle: boolean,
): UserStatus | null {
  if (idle) {
    // Only a manual Online is eligible to become automatically idle. An
    // already-idle status (either origin) has nowhere to go, and dnd/invisible
    // are deliberate.
    return current === "online" && origin === "manual" ? "idle" : null;
  }
  // Coming back: only undo what the timer itself did.
  return current === "idle" && origin === "auto" ? "online" : null;
}

/**
 * Start the idle watcher. Returns a controller; call `destroy` on teardown.
 */
export function startAutoIdle(options: AutoIdleOptions): AutoIdleController {
  const target = options.target ?? window;
  const delayMs = options.delayMs ?? AUTO_IDLE_DELAY_MS;
  const ac = new AbortController();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastActivityRun = 0;
  let destroyed = false;
  /** True while the timer is the reason the status is idle. Kept in memory so
   *  the hot path (one mousemove per pixel) is a boolean check rather than a
   *  preference read. Seeded from the persisted status/origin so a session
   *  that starts already auto-idle (app restart, MainPage remount) can still
   *  be un-idled by activity — otherwise the latch starts false and apply(false)
   *  is unreachable until the user manually reselects a status. */
  let idleByTimer = loadUserStatus() === "idle" && loadUserStatusOrigin() === "auto";

  function apply(idle: boolean): void {
    const next = nextAutoStatus(loadUserStatus(), loadUserStatusOrigin(), idle);
    if (next === null) return;
    // The timer's writes are marked "auto" so a later return-to-activity knows
    // it is undoing its own work rather than a choice the user made.
    saveUserStatus(next, idle ? "auto" : "manual");
    idleByTimer = idle;
    options.onStatusChange(next);
  }

  function arm(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (destroyed) return;
      apply(true);
      // Re-check: apply() invokes options.onStatusChange synchronously, and a
      // caller reacting to that (e.g. tearing down the page) may call
      // destroy() from inside it. `timer` is already null at this point, so
      // destroy()'s clearTimeout would be a no-op — the re-check below is
      // what actually stops a synchronous destroy from being undone.
      if (destroyed) return;
      // Keep watching even when this firing changed nothing (already idle,
      // or dnd/invisible/manual-idle made it a no-op): a status change made
      // through a surface that produces no DOM activity event — the OS tray's
      // Status submenu calls saveUserStatus() directly — can make the status
      // eligible again without ever calling arm() itself. Re-arming here is
      // the one place that covers every such surface at once.
      arm();
    }, delayMs);
  }

  function onActivity(): void {
    if (destroyed) return;
    // Coming back is handled first and unthrottled: the very first event after
    // an idle flip has to restore Online even though it lands inside the
    // throttle window that follows.
    if (idleByTimer) {
      apply(false);
      idleByTimer = false;
      lastActivityRun = Date.now();
      arm();
      return;
    }
    const now = Date.now();
    if (now - lastActivityRun < ACTIVITY_THROTTLE_MS) return;
    lastActivityRun = now;
    arm();
  }

  for (const evt of ACTIVITY_EVENTS) {
    target.addEventListener(evt, onActivity, { passive: true, signal: ac.signal });
  }
  arm();

  return {
    notifyActivity(): void {
      onActivity();
    },
    destroy(): void {
      destroyed = true;
      ac.abort();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
