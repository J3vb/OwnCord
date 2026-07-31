/**
 * Selected presence status — the single client-side source of truth.
 *
 * Both status surfaces (the settings Account tab and the UserBar picker) read
 * and write through here, so they can't drift apart, and consumers such as the
 * notification service can ask "is the user in Do Not Disturb?" without
 * reaching into a store that only tracks *other* members' presence.
 */

import type { UserStatus } from "./types";
import { loadPref, savePref } from "./preferences";

export const USER_STATUS_PREF_KEY = "userStatus";

const VALID_STATUSES: readonly UserStatus[] = ["online", "idle", "dnd", "offline"];

function isUserStatus(value: string): value is UserStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

/** The status the user last selected, defaulting to "online". */
export function loadUserStatus(): UserStatus {
  const raw = loadPref<string>(USER_STATUS_PREF_KEY, "online");
  return isUserStatus(raw) ? raw : "online";
}

/** Persist the selected status and notify same-window listeners. */
export function saveUserStatus(status: UserStatus): void {
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
