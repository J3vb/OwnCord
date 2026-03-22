/**
 * OS reduced-motion sync — managed listener with safe re-registration.
 * Extracted to its own module to avoid circular dependencies between
 * SettingsOverlay and AccessibilityTab.
 */

let ac: AbortController | null = null;

/** Enable or disable the OS reduced-motion sync listener. Safe to call multiple times. */
export function syncOsMotionListener(enabled: boolean): void {
  // Tear down any previous listener
  if (ac !== null) {
    ac.abort();
    ac = null;
  }
  if (!enabled) return;

  ac = new AbortController();
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.documentElement.classList.toggle("reduced-motion", mq.matches);
  mq.addEventListener("change", (e: MediaQueryListEvent) => {
    document.documentElement.classList.toggle("reduced-motion", e.matches);
  }, { signal: ac.signal });
}
