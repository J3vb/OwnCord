/**
 * Window-state off-screen guard.
 *
 * Window geometry (size / position / maximized) is persisted and restored by
 * `tauri-plugin-window-state` on the Rust side. That plugin does NOT validate
 * the restored position against the current monitor layout, so this module adds
 * the one thing it lacks: if the restored window landed off every connected
 * monitor (e.g. it was last closed on a display that is now disconnected),
 * re-center it so it can't become unreachable.
 */

import { createLogger } from "./logger";

const log = createLogger("window-state");

/** A window rectangle in physical pixels. */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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
 * Check whether a window rect is reachable on one of the given monitors:
 * enough horizontal overlap to grab, and the title bar row within the
 * monitor's vertical range. All values are physical pixels.
 */
export function isRectOnScreen(monitors: readonly MonitorRect[], rect: WindowRect): boolean {
  return monitors.some((m) => {
    const overlapX =
      Math.min(rect.x + rect.width, m.position.x + m.size.width) - Math.max(rect.x, m.position.x);
    const titleBarReachable =
      rect.y >= m.position.y - TITLEBAR_TOP_TOLERANCE &&
      rect.y <= m.position.y + m.size.height - TITLEBAR_GRAB_MARGIN;
    return overlapX >= MIN_VISIBLE_WIDTH && titleBarReachable;
  });
}

/**
 * After `tauri-plugin-window-state` restores the window, re-center it if it
 * landed off-screen. Fire-and-forget; a no-op outside Tauri. Fails open: if
 * monitors can't be queried the plugin's placement is left untouched.
 */
export async function initWindowState(): Promise<void> {
  let tauriWindow: typeof import("@tauri-apps/api/window");
  try {
    tauriWindow = await import("@tauri-apps/api/window");
  } catch {
    return;
  }

  const win = tauriWindow.getCurrentWindow();
  try {
    // A maximized window fills a monitor by definition — nothing to correct.
    if (await win.isMaximized()) return;

    let monitors: MonitorRect[];
    try {
      monitors = await tauriWindow.availableMonitors();
    } catch (err) {
      log.warn("Could not query monitors; leaving restored window as-is", {
        error: String(err),
      });
      return;
    }
    if (monitors.length === 0) return;

    const pos = await win.outerPosition();
    const size = await win.outerSize();
    const rect: WindowRect = { x: pos.x, y: pos.y, width: size.width, height: size.height };

    if (!isRectOnScreen(monitors, rect)) {
      log.warn("Restored window is off-screen; re-centering", rect);
      await win.center();
    }
  } catch (err) {
    log.warn("Window-state off-screen check failed", { error: String(err) });
  }
}
