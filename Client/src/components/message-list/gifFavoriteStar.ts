import { createElement } from "@lib/dom";
import { isAllowedGifUrl } from "@lib/media/gifProvider";
import {
  gifFavoritesAvailable,
  gifFavoritesStore,
  isGifFavorite,
  toggleGifFavorite,
} from "@stores/gifFavorites.store";
import { gifFavoritesText } from "../../i18n/gifFavorites";

function syncStar(star: HTMLButtonElement): void {
  const on = isGifFavorite(star.dataset.url ?? "");
  star.setAttribute("aria-pressed", String(on));
  star.setAttribute("aria-label", gifFavoritesText(on ? "unfavorite" : "favorite"));
  star.classList.toggle("on", on);
  star.hidden = !gifFavoritesAvailable() && document.activeElement !== star;
  star.textContent = on ? "\u2605" : "\u2606";
}

// One subscription for every rendered star: the saved list can change from the
// picker or finish loading after a message rendered, and a filled star is
// always visible.
// Never unsubscribed: module-level, one listener for the whole app.
void gifFavoritesStore.subscribe(() => {
  for (const star of document.querySelectorAll<HTMLButtonElement>(".msg-gif-fav")) syncStar(star);
});

/** Star that saves a Klipy GIF from a message to the user's favorites. */
function renderFavoriteStar(url: string): HTMLButtonElement {
  const star = createElement("button", { type: "button", class: "msg-gif-fav" });
  star.dataset.url = url;
  const sync = (): void => syncStar(star);
  sync();
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleGifFavorite({ url, preview_url: url, title: "" }).then(sync);
  });
  star.addEventListener("pointerenter", sync);
  star.addEventListener("focus", sync);
  star.addEventListener("blur", sync);
  return star;
}

/** The inline-image decorator: a star on allowed GIFs while favorites work. */
export function gifFavoriteStar(url: string): HTMLButtonElement | null {
  return isAllowedGifUrl(url) && gifFavoritesAvailable() ? renderFavoriteStar(url) : null;
}
