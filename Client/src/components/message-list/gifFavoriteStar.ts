import { createElement } from "@lib/dom";
import { isAllowedGifUrl } from "@lib/gifProvider";
import {
  gifFavoritesAvailable,
  isGifFavorite,
  toggleGifFavorite,
} from "@stores/gifFavorites.store";
import { gifFavoritesText } from "../../i18n/gifFavorites";

/** Star that saves a Klipy GIF from a message to the user's favorites. */
function renderFavoriteStar(url: string): HTMLButtonElement {
  const star = createElement("button", { type: "button", class: "msg-gif-fav" });
  const sync = (): void => {
    const on = isGifFavorite(url);
    star.setAttribute("aria-pressed", String(on));
    star.setAttribute("aria-label", gifFavoritesText(on ? "unfavorite" : "favorite"));
    star.classList.toggle("on", on);
    star.hidden = !gifFavoritesAvailable() && document.activeElement !== star;
    star.textContent = on ? "\u2605" : "\u2606";
  };
  sync();
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleGifFavorite({ url, preview_url: url, title: "" }).then(sync);
  });
  // The saved list can load after this message rendered; re-read it when the
  // viewer reaches for the star rather than holding a store subscription.
  star.addEventListener("pointerenter", sync);
  star.addEventListener("focus", sync);
  star.addEventListener("blur", sync);
  return star;
}

/** The inline-image decorator: a star on allowed GIFs while favorites work. */
export function gifFavoriteStar(url: string): HTMLButtonElement | null {
  return isAllowedGifUrl(url) && gifFavoritesAvailable() ? renderFavoriteStar(url) : null;
}
