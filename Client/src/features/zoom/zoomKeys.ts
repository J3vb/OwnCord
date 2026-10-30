/**
 * The zoom shortcuts and the startup hook. This file is in the startup chunk,
 * so it stays small and loads the controller (`zoom.ts` and the platform
 * binding) only when a zoom key is pressed or a non-default level is stored.
 */

import { loadPref } from "@lib/prefs/preferences";
import type { ZoomController } from "./zoom";

export const DEFAULT_ZOOM = 100;
export const ZOOM_PREF_KEY = "zoomLevel";

export type ZoomKeyAction = "in" | "out" | "reset";

/** What a key press asks of the zoom, or null when it is not a zoom key. */
export function zoomKeyAction(e: KeyboardEvent): ZoomKeyAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  // The numpad keys report "+", "-" and "0" too; Digit0 covers layouts where 0 is shifted.
  if (e.key === "=" || e.key === "+") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  return e.key === "0" || e.code === "Digit0" ? "reset" : null;
}

/**
 * Apply the stored zoom, and wire Ctrl/Cmd + `=`, `+` (also Shift) or numpad
 * plus to zoom in, `-` or numpad minus to zoom out and `0` to reset. They work
 * everywhere, like Discord, including while a text field has focus. The native
 * webview hotkeys stay off, so this is the only handler. `load` resolves the
 * controller; a load that fails is dropped, leaving the app unzoomed.
 */
export function startZoom(load: () => Promise<ZoomController>, signal: AbortSignal): void {
  const run = (act: (zoom: ZoomController) => Promise<void>): void => {
    load()
      .then(act)
      .catch(() => undefined);
  };
  if (loadPref<number>(ZOOM_PREF_KEY, DEFAULT_ZOOM) !== DEFAULT_ZOOM) {
    run((zoom) => zoom.applyStored());
  }
  document.addEventListener(
    "keydown",
    (e) => {
      const action = zoomKeyAction(e);
      if (action === null) return;
      e.preventDefault();
      run((zoom) => (action === "reset" ? zoom.reset() : zoom.step(action === "in" ? 1 : -1)));
    },
    { signal },
  );
}
