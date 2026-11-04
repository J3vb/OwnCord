// The connect page's health refresh cadence: quick while the page is fresh,
// then slow, and quiet while nobody can see the rows.

import { setOwnedTimeout } from "@lib/dom";

/** Re-check interval for the first minute, and while ticks are being skipped. */
export const HEALTH_FAST_MS = 15_000;
/** How long the quick cadence lasts. */
export const HEALTH_FAST_WINDOW_MS = 60_000;
/** Re-check interval after the first minute. */
export const HEALTH_SLOW_MS = 60_000;

/**
 * Re-runs `check` every 15 s for the first minute, then every 60 s, until
 * `signal` aborts. A tick is skipped while the window is hidden or `busy()`
 * (a sign-in in flight covers the rows with its overlay). Skipped ticks keep
 * the 15 s timer but send nothing, so the rows refresh within 15 s of the
 * window being shown again, and the quick minute starts over from there.
 */
export function scheduleHealthChecks(
  signal: AbortSignal,
  check: () => void,
  busy: () => boolean,
): void {
  let fastUntil = Date.now() + HEALTH_FAST_WINDOW_MS;
  let skipped = false;
  const arm = (): void => {
    const delay = skipped || Date.now() < fastUntil ? HEALTH_FAST_MS : HEALTH_SLOW_MS;
    setOwnedTimeout(signal, tick, delay);
  };
  function tick(): void {
    if (document.hidden || busy()) {
      skipped = true;
    } else {
      if (skipped) fastUntil = Date.now() + HEALTH_FAST_WINDOW_MS;
      skipped = false;
      check();
    }
    arm();
  }
  arm();
}
