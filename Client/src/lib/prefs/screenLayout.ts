/**
 * The Screen layout preference (Command Deck or Classic).
 *
 * Two values are in play. The STORED value is what the user picked and what
 * the Appearance row shows. The RUNNING value is what `applyStoredAppearance()`
 * computed at load and what the rest of the app obeys until the next reload,
 * so a pick never changes the layout under a live session.
 */

import { loadPref, savePref } from "./preferences";

export type ScreenLayout = "classic" | "deck";

export const SCREEN_LAYOUT_PREF = "screenLayout";

/** The stored choice, as the row shows it: `"deck"` only when stored as such.
 *  Never rewrites the stored value. */
export function loadStoredScreenLayout(): ScreenLayout {
  return loadPref<string>(SCREEN_LAYOUT_PREF, "classic") === "deck" ? "deck" : "classic";
}

/** The layout a load should run: the stored choice, on every platform. */
export function loadScreenLayout(): ScreenLayout {
  return loadStoredScreenLayout();
}

export function saveScreenLayout(value: ScreenLayout): void {
  savePref(SCREEN_LAYOUT_PREF, value);
}

let running: ScreenLayout = "classic";

/** The layout this load is running: what `applyStoredAppearance()` last set. */
export function runningScreenLayout(): ScreenLayout {
  return running;
}

export function setRunningScreenLayout(value: ScreenLayout): void {
  running = value;
}
