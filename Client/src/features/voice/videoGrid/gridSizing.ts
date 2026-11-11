/**
 * Video grid sizing: each tile in the grid layout takes the place and size
 * `packTiles` gives it, drawn in the shape of its own picture.
 */
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { SURFACE_RESIZE_EVENT } from "@lib/voice/videoSurface";
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
import { createPeopleStrip, isAvatarCell } from "./gridPeopleStrip";

/** The shape of a tile whose picture has no size yet, and of an avatar tile. */
const DEFAULT_ASPECT = 16 / 9;

/** A picture whose shape moved less than this share is not worth a re-pack. */
const ASPECT_TOLERANCE = 0.02;

/** The size a tile takes: the viewer's choice, else a screen share is large
 *  and anything else medium. */
export function tileSizeOf(entry: CellEntry | undefined, choice?: TileSize): TileSize {
  if (choice !== undefined) return choice;
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

export function createGridSizing(st: GridState, api: GridApi) {
  /** The aspect each tile was last packed with. */
  const packedAspect = new WeakMap<HTMLElement, number>();
  const peopleStrip = createPeopleStrip(st, api);

  /** The room the call view's control bar takes below the tiles. */
  function barSpaceOf(viewsAbove: boolean): number {
    if (st.callBar === null) return 0;
    if (isPhoneLayout()) return CALL_BAR_SPACE_PHONE;
    return viewsAbove ? CALL_BAR_SPACE_VIEWS_ABOVE : CALL_BAR_SPACE;
  }

  /** The shown tiles in layout order, with what the packer needs of each. */
  function packInput(shown: readonly HTMLDivElement[]): { el: HTMLDivElement; tile: PackTile }[] {
    const byEl = new Map<HTMLElement, [number, CellEntry]>();
    for (const [tileId, entry] of st.cells) byEl.set(entry.el, [tileId, entry]);
    // Pinned tiles go first, in the order they were pinned.
    const pinOrder = [...st.pinned];
    const rankOf = (el: HTMLElement): number => {
      const tileId = byEl.get(el)?.[0];
      const rank = tileId === undefined ? -1 : pinOrder.indexOf(tileId);
      return rank < 0 ? pinOrder.length : rank;
    };
    const ordered = shown.toSorted((a, b) => rankOf(a) - rankOf(b));
    return ordered.map((el, id) => {
      const [tileId, entry] = byEl.get(el) ?? [undefined, undefined];
      const aspect = entry === undefined ? DEFAULT_ASPECT : aspectOf(entry.video);
      const chosen = tileId === undefined ? undefined : st.tileSizes.get(tileId);
      // An avatar tile left in the packed area keeps to the others' size in focus.
      const size =
        entry === undefined && st.focusedTileId !== null ? "small" : tileSizeOf(entry, chosen);
      const pinned = tileId !== undefined && st.pinned.has(tileId);
      return { el, tile: { id, aspect, size, ...(pinned ? { pinned } : {}) } };
    });
  }

  /** Place the tiles: the packer sets each one's left, top, width and height. */
  function applyGridSizes(): void {
    if (st.root === null) return;
    const { width: cw, height: ch } = st.root.getBoundingClientRect();
    const viewsAbove = st.callBar !== null && !isPhoneLayout() && cw > 0 && cw <= VIEWS_ABOVE_PX;
    st.root.classList.toggle("video-grid--views-above", viewsAbove);
    api.syncTileArrange();
    const sized = cw > 0 && ch > 0;
    const shown = api.shownTiles();
    const barSpace = barSpaceOf(viewsAbove);
    // With a video tile on show the people leave the packed area for the strip.
    const space = peopleStrip.seat(cw, ch, shown, barSpace);
    const input = packInput(space.active ? shown.filter((el) => !isAvatarCell(el)) : shown);
    // Tiles go absolute only once there is a size to place them in.
    const packed = input.length > 0 && sized;
    st.root.classList.toggle("video-grid--packed", packed);
    if (!packed) return;
    peopleStrip.place(space, cw, ch, barSpace);

    // The bar sits below the tiles, so the tiles start at the top.
    const rects = packTiles(
      cw - space.w,
      ch - barSpace - space.h,
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
    // A canvas-drawn picture (Linux) reports its new size from inside the tile.
    entry.el.addEventListener(SURFACE_RESIZE_EVENT, onShape, opts);
  }

  return {
    applyGridSizes,
    watchTileShape,
    inPeopleStrip: peopleStrip.holds,
    keepFocus: peopleStrip.keepFocus,
    resetPeopleStrip: peopleStrip.reset,
  };
}
