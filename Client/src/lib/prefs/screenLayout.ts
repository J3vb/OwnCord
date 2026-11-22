/**
 * The Screen layout preference (Command Deck preview).
 *
 * Two values are in play. The STORED value is what the user picked and what
 * the Appearance row shows. The RUNNING value is what `applyStoredAppearance()`
 * computed at load and what the rest of the app obeys until the next reload,
 * so a pick never changes the layout under a live session.
 *
 * `lib/` cannot import `features/developer-mode` or `features/voice/native`,
 * so the Developer mode pref is read directly and Android is detected through
 * `hostPlatform`.
 */

import { isAndroidHost } from "../hostPlatform";
import { loadPref, savePref } from "./preferences";

export type ScreenLayout = "classic" | "deck";

export const SCREEN_LAYOUT_PREF = "screenLayout";

/** Whether the preview can run here: Developer mode on, and not the Android app. */
export function screenLayoutAvailable(): boolean {
  return loadPref<boolean>("developerMode", false) && !isAndroidHost();
}

/** The stored choice, as the row shows it: `"deck"` only when stored as such,
 *  whatever Developer mode or the platform say. Never rewrites the stored value. */
export function loadStoredScreenLayout(): ScreenLayout {
  return loadPref<string>(SCREEN_LAYOUT_PREF, "classic") === "deck" ? "deck" : "classic";
}

/** The layout a load should run: the stored choice, gated on `screenLayoutAvailable()`. */
export function loadScreenLayout(): ScreenLayout {
  return loadStoredScreenLayout() === "deck" && screenLayoutAvailable() ? "deck" : "classic";
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
