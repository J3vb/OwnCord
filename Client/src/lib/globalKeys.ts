/**
 * Helpers for the Wayland portal global-keys setup: the preference that
 * remembers an earlier successful bind, the function-key capture the portal
 * path restricts push to talk to, and reading a bind rejection's code.
 *
 * Pure and platform-blind: the UI picks the portal flow from
 * `globalShortcuts.status().backend`, and these helpers only shape its data.
 */

import type { GlobalKeysErrorCode, GlobalKeysStatus } from "../platform/contracts/globalShortcuts";
import { loadPref, savePref } from "./preferences";

/** Set after a portal bind returned a trigger, so the next start can restore it. */
export const GLOBAL_KEYS_PORTAL_BOUND_PREF = "globalKeysPortalBound";

/** The Windows VK of F1; F1-F24 are consecutive from it. */
const VK_F1 = 0x70;

export function portalBoundBefore(): boolean {
  return loadPref<boolean>(GLOBAL_KEYS_PORTAL_BOUND_PREF, false);
}

export function markPortalBound(): void {
  savePref(GLOBAL_KEYS_PORTAL_BOUND_PREF, true);
}

/** Forget an earlier bind, so the next start does not reopen the dialog. */
export function clearPortalBound(): void {
  savePref(GLOBAL_KEYS_PORTAL_BOUND_PREF, false);
}

/** Whether the portal reports any bound trigger. */
export function anyTriggerBound(status: GlobalKeysStatus): boolean {
  const { ptt, mute, deafen } = status.triggers;
  return ptt !== null || mute !== null || deafen !== null;
}

/**
 * Whether the portal holds our shortcuts: it reports a bound trigger, or it
 * lists all three without naming any key (xdg-desktop-portal-hyprland; the
 * keys live in the compositor's config).
 */
export function portalHoldsShortcuts(status: GlobalKeysStatus): boolean {
  return anyTriggerBound(status) || status.triggersUnnamed;
}

/**
 * The VK for `F1`..`F24` from a `KeyboardEvent.code`, else null. A portal
 * shortcut is grabbed by the desktop in every app, so push to talk is only
 * suggested on function keys (Space, Ctrl and the like would be eaten
 * everywhere, and modifiers and mouse buttons cannot be portal triggers).
 */
export function functionKeyVk(code: string): number | null {
  const m = /^F([1-9]|1\d|2[0-4])$/.exec(code);
  return m === null ? null : VK_F1 + Number(m[1]) - 1;
}

/** The code of a rejected bind or configure; `unknown` for anything else. */
export function globalKeysErrorCode(err: unknown): GlobalKeysErrorCode {
  if (err instanceof Error && "code" in err) return (err as { code: GlobalKeysErrorCode }).code;
  return "unknown";
}
