/**
 * OS reduced-motion sync — managed listener with safe re-registration.
 * Extracted to its own module to avoid circular dependencies between
 * SettingsOverlay and AccessibilityTab.
 */

import { Disposable } from "./disposable";

let owner: Disposable | null = null;

/**
 * "Sync with OS" is on unless the user turns it off: the owner's Q1 decision
 * (B9-2) is that reduced motion is honoured from BOTH the OS setting and the
 * in-app toggle, so a fresh install must follow the OS.
 */
export const SYNC_OS_MOTION_DEFAULT = true;

/** The user's manual reducedMotion preference, stored by savePref as JSON. */
function manualPreference(): boolean {
  const raw = localStorage.getItem("owncord:settings:reducedMotion");
  if (raw === null) return false;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return false; // corrupted — default false
  }
}

/**
 * Enable or disable the OS reduced-motion sync listener. Safe to call multiple
 * times. Motion is reduced when the manual toggle is on, or when syncing and
 * the OS asks for it: either source can reduce motion, neither can force it
 * back on over the other.
 */
export function syncOsMotionListener(enabled: boolean): void {
  // Tear down any previous listener
  if (owner !== null) {
    owner.destroy();
    owner = null;
  }
  if (!enabled) {
    document.documentElement.classList.toggle("reduced-motion", manualPreference());
    return;
  }

  owner = new Disposable();
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const apply = (osReduces: boolean): void => {
    document.documentElement.classList.toggle("reduced-motion", osReduces || manualPreference());
  };
  apply(mq.matches);
  mq.addEventListener("change", (e: MediaQueryListEvent) => apply(e.matches), {
    signal: owner.signal,
  });
}
