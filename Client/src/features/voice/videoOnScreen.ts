/**
 * Whether a camera or a stream is on screen now: a live picture in a tile of
 * the video grid, in the mini-player or in a pop-out window. The video grid
 * reports it; the Android app keeps the screen on while it holds
 * (`backgroundCall.ts`).
 */

import { createStore } from "@lib/store";

/** How many video grids draw a live picture now. */
const drawing = createStore({ grids: 0 });

/** A grid starts drawing a live picture, or stops. A grid says each once:
 *  every start is taken back by its own stop. */
export function reportVideoOnScreen(on: boolean): void {
  drawing.setState((prev) => ({ grids: Math.max(0, prev.grids + (on ? 1 : -1)) }));
}

export function isVideoOnScreen(): boolean {
  return drawing.getState().grids > 0;
}

/** Call `listener` when the answer changes. Returns its stop. */
export function onVideoOnScreenChange(listener: (on: boolean) => void): () => void {
  return drawing.subscribeSelector((state) => state.grids > 0, listener);
}
