/**
 * Whether picking another server asks first. Shared by the server rail, the
 * quick switcher and Settings > Advanced; kept apart from the dialog so the
 * Settings tab does not pull the confirm chunk in.
 */

import { loadPref, savePref } from "@lib/prefs/preferences";

export const CONFIRM_SERVER_SWITCH_PREF = "confirmServerSwitch";
export const CONFIRM_SERVER_SWITCH_DEFAULT = true;

export function shouldConfirmServerSwitch(): boolean {
  return loadPref<boolean>(CONFIRM_SERVER_SWITCH_PREF, CONFIRM_SERVER_SWITCH_DEFAULT);
}

export function setConfirmServerSwitch(on: boolean): void {
  savePref(CONFIRM_SERVER_SWITCH_PREF, on);
}
