/**
 * App zoom (Discord-style): the webview's own zoom, never CSS `zoom`.
 *
 * CSS `zoom` on <html> skews `clientX`/`clientY` and so every menu and popup
 * position; the native webview zoom scales the page the way a browser does.
 * This module owns the level list, the stored choice and a controller that
 * serialises native calls. The native operation is injected (`ZoomHost`), so
 * nothing here imports the platform registry.
 */

import { loadPref, savePref } from "@lib/prefs/preferences";
import { createLogger } from "@lib/logger";

const log = createLogger("zoom");

/** The zoom levels, in percent, lowest first. */
export const ZOOM_LEVELS: readonly number[] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
import { DEFAULT_ZOOM, ZOOM_PREF_KEY } from "./zoomKeys";

export { DEFAULT_ZOOM, ZOOM_PREF_KEY };

/** The part of the platform window contract zoom needs. */
export interface ZoomHost {
  setZoom(scale: number): Promise<boolean>;
}

function nearestIndex(value: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_LEVELS.length; i++) {
    if (Math.abs((ZOOM_LEVELS[i] ?? 0) - value) < Math.abs((ZOOM_LEVELS[best] ?? 0) - value)) {
      best = i;
    }
  }
  return best;
}

/** The level nearest `value`; anything that is not a finite number is 100. */
export function snapZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ZOOM;
  return ZOOM_LEVELS[nearestIndex(value)] ?? DEFAULT_ZOOM;
}

/** One level up (1) or down (-1) from `current`, clamped at the ends. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const next = nearestIndex(current) + direction;
  const clamped = Math.min(Math.max(next, 0), ZOOM_LEVELS.length - 1);
  return ZOOM_LEVELS[clamped] ?? DEFAULT_ZOOM;
}

/** The index of a level in `ZOOM_LEVELS` (the settings slider's position). */
export function zoomIndex(level: number): number {
  return nearestIndex(level);
}

/**
 * The stored level. A value that is not exactly one of the levels (a hand-edit,
 * a corrupted entry, a future build's level) is not trusted: it is 100.
 */
export function loadZoom(): number {
  const stored = loadPref<number>(ZOOM_PREF_KEY, DEFAULT_ZOOM);
  return ZOOM_LEVELS.includes(stored) ? stored : DEFAULT_ZOOM;
}

export interface ZoomController {
  /** The level the user has asked for (what the slider shows). */
  current(): number;
  /** Apply the stored level; a failure leaves the stored value alone. */
  applyStored(): Promise<void>;
  /** Ask for a level (snapped). Resolves once the native zoom has caught up. */
  set(level: number): Promise<void>;
  step(direction: 1 | -1): Promise<void>;
  reset(): Promise<void>;
  /** Call `listener` with the level whenever it changes; ends with `signal`. */
  subscribe(listener: (level: number) => void, signal: AbortSignal): void;
}

/**
 * The requested level changes at once (so rapid key presses accumulate), and a
 * single pump walks the native zoom to it, always toward the newest request.
 * A level is saved only after the native zoom took it; when the native side
 * fails, the request falls back to the last level that worked.
 */
export function createZoomController(host: ZoomHost): ZoomController {
  let applied = DEFAULT_ZOOM;
  let wanted = loadZoom();
  let pumping: Promise<void> | null = null;
  const listeners = new Set<(level: number) => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(wanted);
      } catch (err) {
        log.warn("zoom listener failed", { error: String(err) });
      }
    }
  };

  const callHost = async (level: number): Promise<boolean> => {
    try {
      return await host.setZoom(level / 100);
    } catch (err) {
      log.warn("zoom failed", { error: String(err) });
      return false;
    }
  };

  // Started only when a call is due, so it always awaits before `finally`
  // clears `pumping` in the same tick as its last check.
  const pump = async (): Promise<void> => {
    try {
      await drain();
    } finally {
      pumping = null;
    }
  };

  const drain = async (): Promise<void> => {
    while (applied !== wanted) {
      const target = wanted;
      // oxlint-disable-next-line no-await-in-loop -- native zooms must run one at a time, in order
      const ok = await callHost(target);
      if (!ok) {
        // Fall back to what the webview really shows; later requests retry.
        if (wanted === target) {
          wanted = applied;
          notify();
        }
        if (applied === wanted) return;
        continue;
      }
      applied = target;
      savePref(ZOOM_PREF_KEY, applied);
    }
  };

  const run = (): Promise<void> => {
    if (pumping === null) {
      if (applied === wanted) return Promise.resolve();
      pumping = pump();
    }
    return pumping;
  };

  const set = (level: number): Promise<void> => {
    const next = snapZoom(level);
    if (next !== wanted) {
      wanted = next;
      notify();
    }
    return run();
  };

  return {
    current: () => wanted,
    applyStored: () => {
      wanted = loadZoom();
      notify();
      return run();
    },
    set,
    step: (direction) => set(stepZoom(wanted, direction)),
    reset: () => set(DEFAULT_ZOOM),
    subscribe(listener, signal) {
      if (signal.aborted) return;
      listeners.add(listener);
      signal.addEventListener("abort", () => listeners.delete(listener), { once: true });
    },
  };
}
