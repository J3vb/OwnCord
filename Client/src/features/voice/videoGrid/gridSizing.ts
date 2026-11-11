/**
 * Video grid sizing: each tile in the grid layout takes the place and size
 * `packTiles` gives it, drawn in the shape of its own picture.
 */
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import {
  CALL_BAR_SPACE,
  CALL_BAR_SPACE_PHONE,
  CALL_BAR_SPACE_VIEWS_ABOVE,
  VIEWS_ABOVE_PX,
  sizeOf,
  type CellEntry,
} from "./gridShared";
import { packTiles, type PackTile, type TileSize } from "./packLayout";
import type { GridState, GridApi } from "./gridState";

/** The shape of a tile whose picture has no size yet, and of an avatar tile. */
const DEFAULT_ASPECT = 16 / 9;

/** A picture whose shape moved less than this share is not worth a re-pack. */
const ASPECT_TOLERANCE = 0.02;

/** The size a tile asks for: a screen share is large, anything else medium. */
export function tileSizeOf(entry: CellEntry | undefined): TileSize {
  return entry?.config?.isScreenshare === true ? "large" : "medium";
}

/** Width over height of what a video shows, or the default before it has a size. */
export function aspectOf(video: HTMLVideoElement): number {
  const { width, height } = sizeOf(video);
  return width > 0 && height > 0 ? width / height : DEFAULT_ASPECT;
}

/** Whether `next` differs from `last` by more than the tolerance. */
export function aspectMoved(last: number | undefined, next: number): boolean {
  return last === undefined || Math.abs(next - last) / last > ASPECT_TOLERANCE;
}

/** Leave the grid layout's places and sizes behind: the focus layout. */
export function clearTileLayout(tiles: readonly HTMLElement[]): void {
  for (const el of tiles) {
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.style.height = "";
    el.classList.remove("video-cell--no-room");
  }
}

export function createGridSizing(st: GridState, api: GridApi) {
  /** The aspect each tile was last packed with. */
  const packedAspect = new WeakMap<HTMLElement, number>();

  /** The room the call view's control bar takes below the tiles. */
  function barSpaceOf(viewsAbove: boolean): number {
    if (st.callBar === null) return 0;
    if (isPhoneLayout()) return CALL_BAR_SPACE_PHONE;
    return viewsAbove ? CALL_BAR_SPACE_VIEWS_ABOVE : CALL_BAR_SPACE;
  }

  /** The shown tiles in layout order, with what the packer needs of each. */
  function packInput(): { el: HTMLDivElement; tile: PackTile }[] {
    const byEl = new Map<HTMLElement, CellEntry>();
    for (const entry of st.cells.values()) byEl.set(entry.el, entry);
    return api.shownTiles().map((el, id) => {
      const entry = byEl.get(el);
      const aspect = entry === undefined ? DEFAULT_ASPECT : aspectOf(entry.video);
      return { el, tile: { id, aspect, size: tileSizeOf(entry) } };
    });
  }

  /** Place the tiles of the grid layout; the focus layout sizes by CSS. */
  function applyGridSizes(): void {
    if (st.root === null) return;
    const { width: cw, height: ch } = st.root.getBoundingClientRect();
    const viewsAbove = st.callBar !== null && !isPhoneLayout() && cw > 0 && cw <= VIEWS_ABOVE_PX;
    st.root.classList.toggle("video-grid--views-above", viewsAbove);
    const input = packInput();
    // Tiles go absolute only once there is a size to place them in.
    const packed = st.focusedTileId === null && input.length > 0 && cw > 0 && ch > 0;
    st.root.classList.toggle("video-grid--packed", packed);
    if (!packed) return;

    // The bar sits below the tiles, so the tiles start at the top.
    const rects = packTiles(
      cw,
      ch - barSpaceOf(viewsAbove),
      input.map((i) => i.tile),
    );
    input.forEach(({ el, tile }, i) => {
      packedAspect.set(el, tile.aspect);
      const rect = rects[i];
      el.classList.toggle("video-cell--no-room", rect === undefined || rect.w <= 0);
      if (rect === undefined) return;
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      el.style.width = `${rect.w}px`;
      el.style.height = `${rect.h}px`;
    });
  }

  /** Pack again when a tile's picture changes shape (a rotated phone, a new
   *  share), owned by the tile. */
  function watchTileShape(entry: CellEntry): void {
    const onShape = (): void => {
      if (aspectMoved(packedAspect.get(entry.el), aspectOf(entry.video))) api.scheduleResize();
    };
    const opts = { signal: entry.listeners.signal };
    entry.video.addEventListener("resize", onShape, opts);
    entry.video.addEventListener("loadedmetadata", onShape, opts);
  }

  return { applyGridSizes, watchTileShape };
}
