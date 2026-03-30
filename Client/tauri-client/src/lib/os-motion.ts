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
  if (!enabled) {
    // Restore the user's manual reducedMotion preference from settings.
    // Value is stored via JSON.stringify by savePref, so parse it safely.
    const raw = localStorage.getItem("owncord:settings:reducedMotion");
    let manual = false;
    if (raw !== null) {
      try { manual = JSON.parse(raw) === true; } catch { /* corrupted — default false */ }
    }
    document.documentElement.classList.toggle("reduced-motion", manual);
    return;
  }

  ac = new AbortController();
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.documentElement.classList.toggle("reduced-motion", mq.matches);
  mq.addEventListener("change", (e: MediaQueryListEvent) => {
    document.documentElement.classList.toggle("reduced-motion", e.matches);
  }, { signal: ac.signal });
}
