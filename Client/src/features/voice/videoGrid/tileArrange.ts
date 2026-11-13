/**
 * A tile's size and pin as the viewer sees them: the three sizes with their
 * names, and the rows the tile menu offers to change them.
 */
import { createMenuItem } from "@lib/ui/contextMenu";
import type { IconName } from "@lib/icons";
import { voiceText as t } from "../../../i18n/voice";
import type { TileSize } from "./packLayout";

export const TILE_SIZES: readonly TileSize[] = ["small", "medium", "large"];

const SIZE_KEY = {
  small: "tile.sizeSmall",
  medium: "tile.sizeMedium",
  large: "tile.sizeLarge",
} as const;

export function tileSizeText(size: TileSize): string {
  return t(SIZE_KEY[size]);
}

/** What the tile menu shows and does for the tile's size and pin. */
export interface TileMenuArrange {
  readonly size: TileSize;
  readonly pinned: boolean;
  readonly onSize: (size: TileSize) => void;
  readonly onPin: () => void;
}

/** Small, Medium and Large (the current one checked), then Pin or Unpin. */
export function appendArrangeRows(
  menu: HTMLElement,
  arrange: TileMenuArrange,
  close: () => void,
): void {
  const row = (label: string, action: string, icon: IconName, run: () => void): HTMLElement => {
    const item = createMenuItem(label, "context-menu-item", { icon });
    item.setAttribute("data-action", action);
    item.addEventListener("click", () => {
      close();
      run();
    });
    return item;
  };
  for (const size of TILE_SIZES) {
    const item = row(tileSizeText(size), `size-${size}`, `size-${size}`, () =>
      arrange.onSize(size),
    );
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(arrange.size === size));
    menu.append(item);
  }
  menu.append(
    row(
      arrange.pinned ? t("tile.unpin") : t("tile.pin"),
      "pin",
      arrange.pinned ? "pin-off" : "pin",
      arrange.onPin,
    ),
  );
}
