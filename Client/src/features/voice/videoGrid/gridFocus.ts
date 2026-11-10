/** The focus layout's two areas: the focused tile and the strip of the rest. */
import type { GridState } from "./gridState";

/** Put the focused tile in the main area. */
export function seatFocusedTile(st: GridState, mainArea: HTMLElement, focusedId: number): void {
  const focusedEntry = st.cells.get(focusedId);
  if (focusedEntry === undefined) {
    mainArea.replaceChildren();
    return;
  }
  focusedEntry.el.classList.add("focused");
  focusedEntry.el.classList.remove("thumb");
  if (focusedEntry.el.parentNode !== mainArea) mainArea.replaceChildren(focusedEntry.el);
}

/** Every other tile goes to the strip: streams, then the avatar tiles. */
export function fillThumbStrip(
  st: GridState,
  stripArea: HTMLElement,
  focusedId: number,
  tiles: readonly HTMLElement[],
): void {
  for (const [id, entry] of st.cells) {
    if (id === focusedId) continue;
    entry.el.classList.remove("focused");
    entry.el.classList.add("thumb");
    stripArea.appendChild(entry.el);
  }
  for (const el of tiles) {
    if (!el.classList.contains("video-cell--avatar")) continue;
    el.classList.add("thumb");
    stripArea.appendChild(el);
  }
}
