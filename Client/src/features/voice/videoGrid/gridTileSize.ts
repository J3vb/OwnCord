/**
 * What the viewer chooses for a tile in the grid layout: a size (small,
 * medium or large) and a pin. Both are local and kept per tile id, so a
 * share that republishes keeps them and one that ends for good forgets them.
 * The tile's hover controls and its menu rows both go through here.
 */
import { createElement, appendChildren } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { voiceText } from "../../../i18n/voice";
import type { GridState, GridApi } from "./gridState";
import { tileSizeOf } from "./gridSizing";
import type { TileSize } from "./packLayout";
import { TILE_SIZES, tileSizeText } from "./tileArrange";
import { keepChoiceThroughFocus } from "./tileFocus";

const SIZE_ICON: Record<TileSize, IconName> = {
  small: "size-small",
  medium: "size-medium",
  large: "size-large",
};

const ARROW_STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** The selected radio is the one in the tab order; the pin shows its state. */
function syncGroup(group: Element, now: { size: TileSize; pinned: boolean }): void {
  for (const radio of group.querySelectorAll<HTMLElement>("[role='radio']")) {
    const on = radio.dataset["size"] === now.size;
    radio.setAttribute("aria-checked", String(on));
    radio.tabIndex = on ? 0 : -1;
  }
  group
    .querySelector("[data-tile-control='pin']")
    ?.setAttribute("aria-pressed", String(now.pinned));
}

export function createGridTileSize(st: GridState, api: GridApi) {
  /** The size and pin a tile is drawn with: a pinned tile is large. */
  function tileArrangement(tileId: number): { size: TileSize; pinned: boolean } {
    const pinned = st.pinned.has(tileId);
    if (pinned) return { size: "large", pinned };
    return { size: tileSizeOf(st.cells.get(tileId), st.tileSizes.get(tileId)), pinned };
  }

  /** Redraw the tile's controls to what it is now, and pack again. */
  function changed(tileId: number): void {
    const group = st.cells.get(tileId)?.el.querySelector(".video-tile-arrange");
    if (group !== null && group !== undefined) syncGroup(group, tileArrangement(tileId));
    api.scheduleResize();
  }

  /** Picking a size or unpinning the focused tile ends focus: the other
   *  tiles take their earlier sizes back first. */
  function endFocusOn(tileId: number): void {
    if (st.focusedTileId === tileId) api.setFocusedTile(null);
  }

  function setTileSize(tileId: number, size: TileSize): void {
    if (!st.cells.has(tileId)) return;
    endFocusOn(tileId);
    st.pinned.delete(tileId);
    st.tileSizes.set(tileId, size);
    keepChoiceThroughFocus(st, tileId);
    changed(tileId);
  }

  function toggleTilePin(tileId: number): void {
    if (!st.cells.has(tileId)) return;
    if (st.focusedTileId === tileId) {
      api.setFocusedTile(null);
      st.pinned.delete(tileId);
    } else if (!st.pinned.delete(tileId)) {
      st.pinned.add(tileId);
    }
    keepChoiceThroughFocus(st, tileId);
    changed(tileId);
  }

  function forgetTileSize(tileId: number): void {
    st.tileSizes.delete(tileId);
    st.pinned.delete(tileId);
    st.focusSaved?.sizes.delete(tileId);
    st.focusSaved?.pinned.delete(tileId);
  }

  function forgetTileSizes(): void {
    st.tileSizes.clear();
    st.pinned.clear();
    st.focusSaved = null;
  }

  /** Arrow keys move through the sizes and choose as they go. */
  function onSizeKey(e: KeyboardEvent, tileId: number): void {
    const step = ARROW_STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const at = TILE_SIZES.indexOf(tileArrangement(tileId).size);
    const next = TILE_SIZES[(at + step + TILE_SIZES.length) % TILE_SIZES.length];
    if (next === undefined) return;
    setTileSize(tileId, next);
    st.cells
      .get(tileId)
      ?.el.querySelector<HTMLElement>(`[data-tile-control='size-${next}']`)
      ?.focus();
  }

  function buildSizeRadio(tileId: number, size: TileSize): HTMLElement {
    const radio = createElement("button", {
      type: "button",
      class: "video-tile-btn",
      role: "radio",
      "aria-label": tileSizeText(size),
      title: tileSizeText(size),
      "data-size": size,
      "data-tile-control": `size-${size}`,
    });
    radio.appendChild(createIcon(SIZE_ICON[size], 18));
    radio.addEventListener("click", (e) => {
      e.stopPropagation();
      setTileSize(tileId, size);
    });
    radio.addEventListener("keydown", (e) => onSizeKey(e, tileId));
    return radio;
  }

  function buildTileArrange(tileId: number): HTMLElement {
    const group = createElement("div", { class: "video-tile-arrange" });
    const sizes = createElement("div", {
      class: "video-tile-arrange__sizes",
      role: "radiogroup",
      "aria-label": voiceText("tile.sizeGroup"),
    });
    for (const size of TILE_SIZES) sizes.appendChild(buildSizeRadio(tileId, size));
    const pin = createElement("button", {
      type: "button",
      class: "video-tile-btn",
      "aria-label": voiceText("tile.pin"),
      title: voiceText("tile.pin"),
      "data-tile-control": "pin",
    });
    pin.appendChild(createIcon("pin", 18));
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTilePin(tileId);
    });
    appendChildren(group, sizes, pin);
    group.hidden = isPhoneLayout();
    return group;
  }

  /** The hover controls are for the pointer and keyboard; a phone has the
   *  tile menu's rows. The layout can change under a running call. */
  function syncTileArrange(): void {
    const phone = isPhoneLayout();
    for (const [tileId, entry] of st.cells) {
      const group = entry.el.querySelector<HTMLElement>(".video-tile-arrange");
      if (group === null) continue;
      group.hidden = phone;
      syncGroup(group, tileArrangement(tileId));
    }
  }

  return {
    setTileSize,
    toggleTilePin,
    forgetTileSize,
    forgetTileSizes,
    tileArrangement,
    syncTileArrange,
    buildTileArrange,
  };
}
