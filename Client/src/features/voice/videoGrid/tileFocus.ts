/**
 * Focus on a tile is a pin in the packed grid: the tile is pinned and every
 * other tile is drawn Small. What the viewer had chosen before is kept here
 * and put back when focus ends. These functions only change the grid's state;
 * the caller lays the tiles out again.
 */
import type { GridState } from "./gridState";

/** Pin `tileId` and draw the others Small, keeping the earlier arrangement.
 *  Focus already on another tile gives that one's arrangement back first. */
export function enterFocus(st: GridState, tileId: number): void {
  if (st.focusedTileId === tileId && st.focusSaved !== null) return;
  leaveFocus(st);
  st.focusSaved = { sizes: new Map(st.tileSizes), pinned: new Set(st.pinned) };
  st.focusedTileId = tileId;
  st.pinned.clear();
  st.pinned.add(tileId);
  for (const id of st.cells.keys()) if (id !== tileId) st.tileSizes.set(id, "small");
}

/** Put back the sizes and pins the tiles had before focus. A tile that is
 *  gone since gets no entry. */
export function leaveFocus(st: GridState): void {
  const saved = st.focusSaved;
  st.focusSaved = null;
  st.focusedTileId = null;
  if (saved === null) return;
  st.tileSizes.clear();
  st.pinned.clear();
  for (const [id, size] of saved.sizes) if (st.cells.has(id)) st.tileSizes.set(id, size);
  for (const id of saved.pinned) if (st.cells.has(id)) st.pinned.add(id);
}

/** A tile that arrives during focus is drawn Small like the rest. */
export function drawSmallInFocus(st: GridState, tileId: number): void {
  if (st.focusSaved !== null && tileId !== st.focusedTileId) st.tileSizes.set(tileId, "small");
}

/** A size or pin the viewer chose for another tile during focus is theirs to
 *  keep: it goes into what focus gives back. */
export function keepChoiceThroughFocus(st: GridState, tileId: number): void {
  const saved = st.focusSaved;
  if (saved === null || tileId === st.focusedTileId) return;
  const size = st.tileSizes.get(tileId);
  if (size === undefined) saved.sizes.delete(tileId);
  else saved.sizes.set(tileId, size);
  if (st.pinned.has(tileId)) saved.pinned.add(tileId);
  else saved.pinned.delete(tileId);
}
