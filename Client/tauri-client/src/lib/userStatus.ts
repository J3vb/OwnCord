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
import { loadPref, savePref } from "./preferences";

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
  const handler = (e: Event): void => {
    const detail = (e as CustomEvent<{ key?: string }>).detail;
    if (detail?.key !== USER_STATUS_PREF_KEY) return;
    onChange(loadUserStatus());
  };
  window.addEventListener("owncord:pref-change", handler, { signal: options?.signal });
  return () => {
    window.removeEventListener("owncord:pref-change", handler);
  };
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
