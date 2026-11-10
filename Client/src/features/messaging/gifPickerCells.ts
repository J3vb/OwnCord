// The GIF picker's grid cells: one cell per GIF, its favorite star, and the
// star toggle. Never sets innerHTML with user content.

import { createElement } from "@lib/dom";
import type { GifResult } from "@lib/media/gifProvider";
import type { PickerImages } from "./pickerImages";
import { isGifFavorite, toggleGifFavorite } from "@stores/gifFavorites.store";
import { fetchExternalImage, recoverEvictedImage } from "./content/attachments";
import { admitDerived, GIF_PICKER_ITEM } from "../content-consent/external";
import { messagingText } from "../../i18n/messaging";
import { gifFavoritesText } from "../../i18n/gifFavorites";

export function setStarState(star: HTMLElement, on: boolean): void {
  star.setAttribute("aria-pressed", String(on));
  star.setAttribute("aria-label", gifFavoritesText(on ? "unfavorite" : "favorite"));
  star.classList.toggle("on", on);
  star.textContent = on ? "\u2605" : "\u2606";
}

/** Star/unstar the GIF a grid cell shows. */
export async function toggleCell(cell: HTMLElement): Promise<void> {
  const url = cell.dataset.fullUrl;
  if (url === undefined) return;
  await toggleGifFavorite({
    url,
    preview_url: cell.dataset.previewUrl ?? url,
    title: cell.dataset.title ?? "",
  });
}

export function appendCells(
  grid: HTMLElement,
  gifs: readonly GifResult[],
  images: PickerImages,
): void {
  for (const gif of gifs) {
    const item = createElement("div", {
      class: "gp-item",
      role: "option",
      // Same fallback as the img alt below — an untitled GIF still needs a
      // pronounceable accessible name.
      "aria-label": gif.title || messagingText("gif.itemLabel"),
      // Read by the delegated click handler on gridArea (see mount-time
      // listener above) instead of a per-cell listener.
      "data-full-url": gif.fullUrl,
      "data-preview-url": gif.url,
      "data-title": gif.title,
      "aria-keyshortcuts": "F",
    });
    // Klipy's CDN is still an external host: the thumbnail arrives through
    // the external-content broker, not as a URL the webview loads itself.
    const img = createElement("img", {
      class: "gp-img",
      alt: gif.title || messagingText("gif.itemLabel"),
      loading: "lazy",
    });
    admitDerived(GIF_PICKER_ITEM, `url:${gif.url}`);
    recoverEvictedImage(img, { url: gif.url });
    images.observe(img, () => fetchExternalImage({ url: gif.url }));
    item.appendChild(img);
    const star = createElement("button", {
      type: "button",
      class: "gp-star",
      tabindex: "-1",
    });
    setStarState(star, isGifFavorite(gif.fullUrl));
    item.appendChild(star);

    grid.appendChild(item);
  }
}
