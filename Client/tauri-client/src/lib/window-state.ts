/**
 * Window state persistence — saves/restores window position and size.
 * Uses Tauri IPC commands backed by tauri-plugin-store.
 */

import { createLogger } from "./logger";

const log = createLogger("window-state");

export interface WindowState {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
}

const STORAGE_KEY = "windowState";
const SAVE_DEBOUNCE_MS = 500;

/** Minimum horizontal overlap (physical px) required with some monitor. */
const MIN_VISIBLE_WIDTH = 100;
/** Allow the title bar to sit slightly above a monitor's top edge. */
const TITLEBAR_TOP_TOLERANCE = 8;
/** The title bar must be at least this far above a monitor's bottom edge. */
const TITLEBAR_GRAB_MARGIN = 40;

interface MonitorRect {
  readonly position: { x: number; y: number };
  readonly size: { width: number; height: number };
}

/**
 * Check whether a saved window rect is reachable on one of the given
 * monitors: enough horizontal overlap to grab, and the title bar row within
 * the monitor's vertical range. All values are physical pixels.
 */
export function isRectOnScreen(monitors: readonly MonitorRect[], rect: WindowState): boolean {
  return monitors.some((m) => {
    const overlapX =
      Math.min(rect.x + rect.width, m.position.x + m.size.width) - Math.max(rect.x, m.position.x);
    const titleBarReachable =
      rect.y >= m.position.y - TITLEBAR_TOP_TOLERANCE &&
      rect.y <= m.position.y + m.size.height - TITLEBAR_GRAB_MARGIN;
    return overlapX >= MIN_VISIBLE_WIDTH && titleBarReachable;
  });
}

const invokePromise: Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> = import("@tauri-apps/api/core")
  .then((m) => m.invoke)
  .catch((err) => {
    log.warn("Tauri core API not available for window state", err);
    return null;
  });

/**
 * Save the current window state to the Tauri settings store.
 */
async function saveState(state: WindowState): Promise<void> {
  const invoke = await invokePromise;
  if (!invoke) return;
  try {
    await invoke("save_settings", { key: STORAGE_KEY, value: state });
  } catch (err) {
    log.error("Failed to save window state", { error: String(err) });
  }
}

/**
 * Load the previously saved window state.
 */
async function loadState(): Promise<WindowState | null> {
  const invoke = await invokePromise;
  if (!invoke) return null;
  try {
    const all = (await invoke("get_settings")) as Record<string, unknown>;
    const raw = all[STORAGE_KEY];
    if (raw && typeof raw === "object") {
      const s = raw as Record<string, unknown>;
      if (
        typeof s.x === "number" &&
        typeof s.y === "number" &&
        typeof s.width === "number" &&
        typeof s.height === "number" &&
        typeof s.maximized === "boolean" &&
        Number.isFinite(s.x) &&
        Number.isFinite(s.y) &&
        Number.isFinite(s.width) &&
        Number.isFinite(s.height) &&
        s.width >= 1 &&
        s.height >= 1
      ) {
        return {
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
          maximized: s.maximized,
        };
      }
    }
    return null;
  } catch (err) {
    log.error("Failed to load window state", { error: String(err) });
    return null;
  }
}

/**
 * Check whether the saved rect is visible on a connected monitor. Fails open:
 * if monitors cannot be queried, restore proceeds as before.
 */
async function isSavedRectVisible(
  tauriWindow: typeof import("@tauri-apps/api/window"),
  saved: WindowState,
): Promise<boolean> {
  let monitors: MonitorRect[];
  try {
    monitors = await tauriWindow.availableMonitors();
  } catch (err) {
    log.warn("Could not query monitors; restoring window state unchecked", {
      error: String(err),
    });
    return true;
  }
  if (monitors.length === 0) return true;
  return isRectOnScreen(monitors, saved);
}

/**
 * Initialize window state persistence.
 * Restores saved position/size on startup and listens for changes.
 * Returns a cleanup function.
 */
export async function initWindowState(): Promise<() => void> {
  let tauriWindow: typeof import("@tauri-apps/api/window") | undefined;
  try {
    tauriWindow = await import("@tauri-apps/api/window");
  } catch {
    return () => {};
  }

  const win = tauriWindow.getCurrentWindow();
  const cleanups: Array<() => void> = [];

  // Restore saved state
  const saved = await loadState();
  if (saved !== null) {
    try {
      if (saved.maximized) {
        await win.maximize();
        log.info("Restored window state (maximized)");
      } else if (await isSavedRectVisible(tauriWindow, saved)) {
        const pos = new tauriWindow.PhysicalPosition(saved.x, saved.y);
        const size = new tauriWindow.PhysicalSize(saved.width, saved.height);
        await win.setPosition(pos);
        await win.setSize(size);
        log.info("Restored window state", {
          x: saved.x,
          y: saved.y,
          width: saved.width,
          height: saved.height,
        });
      } else {
        // Saved rect is not reachable on any connected monitor (e.g. a
        // disconnected display) — keep the default centered placement.
        log.warn("Saved window position is off-screen; using default placement", {
          x: saved.x,
          y: saved.y,
          width: saved.width,
          height: saved.height,
        });
      }
    } catch (err) {
      log.warn("Failed to restore window state", { error: String(err) });
    }
  }

  // Debounced save on move/resize
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function debouncedSave(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      void (async () => {
        try {
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          const maximized = await win.isMaximized();
          await saveState({
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized,
          });
        } catch {
          // Window may have been closed during save
        }
      })();
    }, SAVE_DEBOUNCE_MS);
  }

  try {
    const unlistenMoved = await win.onMoved(() => debouncedSave());
    cleanups.push(unlistenMoved);
  } catch {
    // onMoved may not be available
  }

  try {
    const unlistenResized = await win.onResized(() => debouncedSave());
    cleanups.push(unlistenResized);
  } catch {
    // onResized may not be available
  }

  return () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
