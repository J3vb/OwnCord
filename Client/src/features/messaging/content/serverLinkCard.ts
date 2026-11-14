/**
 * The link preview card drawn from a card the server built: the same card the
 * local fetch draws (embeds.ts), from stored text and a stored thumbnail, with
 * no broker call.
 */

import { createElement } from "@lib/dom";
import type { LinkPreviewCard } from "@lib/types";
import { recoverEvictedImage } from "./attachments";
import { dataSaverActive } from "./dataSaver";
import { mediaName, renderDeferredMedia } from "./deferredMedia";
import { applyCardText, createLinkCardShell, nonBlank, showWhenImageSettles } from "./embeds";
import { cardThumbnailUrl, loadCardThumbnail } from "./serverPreviews";

/** Show a server thumbnail in the card, resolving once it has loaded or failed.
 *  The bytes come from the memory and durable image caches or the server's own
 *  thumbnail route, never from the linked site. */
function showCardThumbnail(thumbUrl: string, alt: string, imageWrap: HTMLElement): Promise<void> {
  return loadCardThumbnail(thumbUrl).then((src) => {
    if (src === null) return undefined;
    const img = createElement("img", { class: "msg-embed-link-img", src, alt });
    recoverEvictedImage(img, { url: thumbUrl });
    img.addEventListener("error", () => {
      imageWrap.style.display = "none";
    });
    imageWrap.appendChild(img);
    imageWrap.style.display = "";
    if (img.complete && img.naturalWidth > 0) return undefined;
    return new Promise<void>((resolve) => {
      img.addEventListener("load", () => resolve(), { once: true });
      img.addEventListener("error", () => resolve(), { once: true });
    });
  });
}

/** Render the card the server built for `url`: the same card as the local
 *  fetch draws, from stored text and a stored thumbnail, with no broker call. */
export function renderServerLinkCard(card: LinkPreviewCard, url: string): HTMLDivElement {
  const deferImages = dataSaverActive();
  const shell = createLinkCardShell(url);
  const { wrap, hostEl, titleEl, descEl, imageWrap, displayHost } = shell;
  // A stored card has no failure or retry to show.
  shell.statusEl.remove();
  shell.retryEl.remove();
  const meta = {
    title: nonBlank(card.title ?? null),
    description: nonBlank(card.description ?? null),
    siteName: nonBlank(card.site_name ?? null),
  };
  const thumbUrl = cardThumbnailUrl(card);
  if (meta.title === null && meta.description === null && thumbUrl === null) {
    wrap.dataset.embedState = "empty";
    wrap.hidden = true;
    return wrap;
  }
  wrap.dataset.embedState = "loaded";
  applyCardText(meta, titleEl, descEl, hostEl, displayHost);
  if (thumbUrl === null) {
    shell.show();
    return wrap;
  }
  const alt = meta.title ?? "";
  if (deferImages) {
    imageWrap.style.display = "";
    imageWrap.appendChild(
      renderDeferredMedia(mediaName(url), () => {
        const image = createElement("div", { class: "msg-embed-link-image" });
        void showCardThumbnail(thumbUrl, alt, image);
        return image;
      }),
    );
    shell.show();
    return wrap;
  }
  showWhenImageSettles(shell, true, showCardThumbnail(thumbUrl, alt, imageWrap));
  return wrap;
}
