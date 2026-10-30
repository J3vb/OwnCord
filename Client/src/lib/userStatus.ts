/**
 * Selected presence status — the single client-side source of truth.
 *
 * Both status surfaces (the settings Account tab and the UserBar picker) read
 * and write through here, so they can't drift apart, and consumers such as the
 * notification service can ask "is the user in Do Not Disturb?" without
 * reaching into a store that only tracks *other* members' presence.
 *
 * Since phase 6 this also records *who* chose the status. The auto-idle timer
 * needs to flip a user to idle after ten quiet minutes and back to online when
 * they return — but it must never undo a status the user picked by hand. A
 * manually chosen Idle stays idle when they start typing again, and a manually
 * chosen Do Not Disturb or Invisible is never touched at all. Storing the
 * origin alongside the value is what makes those two cases distinguishable;
 * the timer alone cannot tell them apart.
 */

import type { UserStatus } from "./types";
import { loadPref, onPrefChange, savePref } from "./prefs/preferences";

export const USER_STATUS_PREF_KEY = "userStatus";
/** Where the current status came from. Separate key so an older client's
 *  saved status keeps working (absent = treated as a manual choice). */
export const USER_STATUS_ORIGIN_PREF_KEY = "userStatusOrigin";

/** Who chose the current status. */
export type StatusOrigin = "manual" | "auto";

/**
 * Statuses a user can pick.
 *
 * "offline" is deliberately absent: it used to be the "appear offline" option,
 * and "invisible" replaced it in phase 6 precisely because the server cannot
 * tell a chosen "offline" from a dropped connection. A stored "offline" from
 * an older client is migrated to "invisible" on read, which is what the user
 * meant when they picked it.
 */
const VALID_STATUSES: readonly UserStatus[] = ["online", "idle", "dnd", "invisible"];

function isUserStatus(value: string): value is UserStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

/** The status the user last selected, defaulting to "online". */
export function loadUserStatus(): UserStatus {
  const raw = loadPref<string>(USER_STATUS_PREF_KEY, "online");
  // Migration: "offline" was this client's old spelling of "appear offline".
  if (raw === "offline") return "invisible";
  return isUserStatus(raw) ? raw : "online";
}

/** Whether the current status was set by the user or by the idle timer. */
export function loadUserStatusOrigin(): StatusOrigin {
  return loadPref<string>(USER_STATUS_ORIGIN_PREF_KEY, "manual") === "auto" ? "auto" : "manual";
}

/**
 * Persist the selected status and notify same-window listeners.
 * `origin` defaults to "manual" — everything that is not the idle timer is a
 * deliberate choice, and defaulting the other way would let a UI surface
 * silently mark a real choice as revocable.
 */
export function saveUserStatus(status: UserStatus, origin: StatusOrigin = "manual"): void {
  // Any status write ends a running timer: a manual change replaces it, the
  // timer's own revert is its end, and a caller that wants a new timer arms
  // it after this call (saveStatusTimer).
  clearStatusTimer();
  savePref(USER_STATUS_ORIGIN_PREF_KEY, origin);
  savePref(USER_STATUS_PREF_KEY, status);
}

/**
 * Run `onChange` whenever the selected status changes anywhere in this window.
 * Returns an unsubscribe function.
 */
export function onUserStatusChange(
  onChange: (status: UserStatus) => void,
  options?: { signal?: AbortSignal },
): () => void {
  return onPrefChange([USER_STATUS_PREF_KEY], () => onChange(loadUserStatus()), options?.signal);
}

// ---------------------------------------------------------------------------
// Custom status text
// ---------------------------------------------------------------------------

export const CUSTOM_STATUS_PREF_KEY = "customStatus";

/** Server-side cap on users.custom_status. Mirrored here so the input can
 *  bound itself instead of learning about it from a rejected send. */
export const MAX_CUSTOM_STATUS_LEN = 128;

/** The custom status line the user last set, "" when none. */
export function loadCustomStatus(): string {
  const raw = loadPref<string>(CUSTOM_STATUS_PREF_KEY, "");
  return typeof raw === "string" ? raw.slice(0, MAX_CUSTOM_STATUS_LEN) : "";
}

/** Persist the custom status line locally. The server is the authority; this
 *  is only so the input renders the right text before `ready` arrives. */
export function saveCustomStatus(text: string): void {
  savePref(CUSTOM_STATUS_PREF_KEY, text.slice(0, MAX_CUSTOM_STATUS_LEN));
}

// ---------------------------------------------------------------------------
// Status timers (Idle / Do Not Disturb / Invisible "for 1 hour")
// ---------------------------------------------------------------------------

/** Where a running timer is kept, next to the status it belongs to, so an app
 *  restart inside the window still reverts when it ends. Client-side only: the
 *  server never hears of it and just sees the revert to Online. */
export const STATUS_TIMER_PREF_KEY = "userStatusTimer";

/** The statuses a timer may be put on. Online has nothing to revert to. */
export type TimedStatus = "idle" | "dnd" | "invisible";

export interface StatusTimer {
  readonly status: TimedStatus;
  /** Epoch milliseconds the status reverts to Online. */
  readonly until: number;
}

export function isTimedStatus(status: UserStatus): status is TimedStatus {
  return status === "idle" || status === "dnd" || status === "invisible";
}

/** The stored timer, or null when there is none or it is malformed. Does not
 *  judge whether it still matches the current status or has expired. */
export function loadStatusTimer(): StatusTimer | null {
  const raw = loadPref<Record<string, unknown> | null>(STATUS_TIMER_PREF_KEY, null);
  if (raw === null || typeof raw !== "object") return null;
  const { status, until } = raw;
  if (typeof status !== "string" || !isUserStatus(status) || !isTimedStatus(status)) return null;
  if (typeof until !== "number" || !Number.isFinite(until)) return null;
  return { status, until };
}

/** Put a timer on the current status. Call after saveUserStatus, which
 *  clears any earlier one. */
export function saveStatusTimer(status: TimedStatus, until: number): void {
  savePref(STATUS_TIMER_PREF_KEY, { status, until });
}

/** Forget the timer. A no-op (and no event) when none is stored. */
export function clearStatusTimer(): void {
  if (loadPref<unknown>(STATUS_TIMER_PREF_KEY, null) === null) return;
  savePref(STATUS_TIMER_PREF_KEY, null);
}

/** Run `onChange` whenever the stored timer is set or cleared in this window. */
export function onStatusTimerChange(
  onChange: (timer: StatusTimer | null) => void,
  options?: { signal?: AbortSignal },
): () => void {
  return onPrefChange([STATUS_TIMER_PREF_KEY], () => onChange(loadStatusTimer()), options?.signal);
}
