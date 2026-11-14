/**
 * Image and video rendering — YouTube embeds, direct image URLs,
 * inline image rendering, lightbox overlay, and URL embed orchestration.
 */

import { createElement } from "@lib/dom";
import klipyWatermark from "../../../assets/KLIPY Light with logo.svg";
import { createLogger } from "@lib/logger";
import { observeMedia } from "./mediaVisibility";
import { dataSaverActive } from "./dataSaver";
import { mediaName, renderDeferredMedia } from "./deferredMedia";
import { loadPref, onPrefChange } from "@lib/prefs/preferences";
import {
  bindImageMenu,
  clearExternalImageCache,
  fetchExternalImage,
  isSafeUrl,
  loadExternalImage,
  openImageLightbox,
  recoverEvictedImage,
  renderFailureStatus,
  saveImageBytes,
} from "./attachments";
import {
  EXTERNAL_CONSENT_PREF,
  externalAllowed,
  externalConsentChoice,
  requestExternalItem,
  resetExternalConsent,
} from "../../content-consent/external";
import { renderConcealedItem } from "../../content-consent/concealed";
import { contentText } from "../../../i18n/content";
import {
  CODE_BLOCK_REGEX,
  INLINE_CODE_REGEX,
  MASKED_LINK_REGEX,
  ANGLE_URL_REGEX,
  SPOILER_REGEX,
  stripUrlTrailingPunctuation,
  URL_REGEX,
} from "./contentParser";
import {
  blobImageSize,
  fitImageBox,
  getImageBox,
  imageSizeGeneration,
  setImageBox,
  type ImageBox,
} from "./imageSizes";
import { clearMediaCaches, extractYouTubeId, renderYouTubeEmbed } from "./mediaYouTube";
import { clearEmbedCaches, focusMessageLink, renderGenericLinkPreview } from "./embeds";
import { renderServerLinkCard } from "./serverLinkCard";
import { cardForUrl, cardThumbnailUrl, isImageOnlyCard } from "./serverPreviews";
import type { LinkPreviewCard } from "@lib/types";
import type { ExternalContentFailure } from "../../../platform/contracts/externalContent";

// The lightbox lives in attachments.ts, which renders attachment images and
// must not import this module (that import was a cycle); re-exported here for
// existing importers.
export { closeActiveLightbox, openImageLightbox } from "./attachments";
export { clearMediaCaches, extractYouTubeId, renderYouTubeEmbed };

const log = createLogger("media");

// Cached embed/media preferences — read once and invalidated on pref change
// instead of hitting localStorage for every rendered message (same pattern as
// roleColors in formatting.ts and developerMode in renderers.ts).
let showEmbedsPref = loadPref<boolean>("showEmbeds", true);
let inlineMediaPref = loadPref<boolean>("inlineMedia", true);
let showLinkPreviewsPref = loadPref<boolean>("showLinkPreviews", true);
let animateGifsPref = loadPref<boolean>("animateGifs", true);
onPrefChange(
  ["showEmbeds", "inlineMedia", "showLinkPreviews", "animateGifs", EXTERNAL_CONSENT_PREF],
  (key) => {
    switch (key) {
      case "showEmbeds":
        showEmbedsPref = loadPref<boolean>("showEmbeds", true);
        if (!showEmbedsPref) resetExternalConsent();
        break;
      case "inlineMedia":
        inlineMediaPref = loadPref<boolean>("inlineMedia", true);
        if (!inlineMediaPref) resetExternalConsent();
        break;
      case "showLinkPreviews":
        showLinkPreviewsPref = loadPref<boolean>("showLinkPreviews", true);
        if (!showLinkPreviewsPref) resetExternalConsent();
        break;
      case "animateGifs":
        animateGifsPref = loadPref<boolean>("animateGifs", true);
        break;
      case EXTERNAL_CONSENT_PREF:
        // Revoked (Q3: a Text & Images toggle turned off, or the reset): drop
        // every fetched byte and late answer before re-concealing.
        if (externalConsentChoice() === null) {
          clearEmbedCaches();
          clearMediaCaches();
          clearExternalImageCache();
        }
        refreshExternalItems();
        break;
    }
  },
);

/** Check if a URL originates from the Klipy CDN. */
function isKlipyUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "klipy.com" || hostname.endsWith(".klipy.com");
  } catch {
    return false;
  }
}

/** Check if a URL points to an animated GIF. */
function isGifUrl(url: string): boolean {
  try {
    const pathname = new URL(url, "https://placeholder").pathname.toLowerCase();
    return pathname.endsWith(".gif");
  } catch {
    return false;
  }
}

// -- Direct images ------------------------------------------------------------

/** Check if a URL points directly to an image or GIF file. */
export function isDirectImageUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(gif|png|jpg|jpeg|webp)$/.test(pathname);
  } catch {
    return false;
  }
}

/** Host shown in an external image's accessible name and alt text. */
function displayHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Decorates every inline image; the main page registers the GIF favorite star,
 *  so its store and copy stay out of the lazy chunk that shares this module. */
let imageDecorator: ((url: string) => HTMLElement | null) | null = null;
export function setInlineImageDecorator(fn: ((url: string) => HTMLElement | null) | null): void {
  imageDecorator = fn;
}

/** Render a direct image/GIF URL as an inline image with lightbox. */
export function renderInlineImage(url: string, tapped = false): HTMLDivElement {
  if (!tapped && dataSaverActive()) {
    return renderDeferredMedia(mediaName(url), () => renderInlineImage(url, true));
  }
  // Reserve the box a previous render (this session or an earlier one) or a
  // header sniff measured; otherwise 200px until the bytes say. Either way a
  // virtual-scroll rebuild starts at the right height and nothing shifts on load.
  const host = displayHost(url);

  const wrap = createElement("div", { class: "msg-image" });
  const reserveFallback = (): void => {
    wrap.style.cssText = "max-width: 400px; min-height: 200px;";
  };
  const reserve = (box: ImageBox): void => {
    wrap.style.cssText = `width: ${box.w}px; max-width: 100%; aspect-ratio: ${box.w} / ${box.h};`;
  };
  // A reset between mount and load must not write this URL into the new session.
  const generation = imageSizeGeneration();
  const cachedBox = getImageBox(url);
  if (cachedBox !== undefined) reserve(cachedBox);
  else reserveFallback();

  // No src yet: the bytes come from the external-content broker as a
  // same-origin blob: URL, never from the webview loading `url` itself.
  const img = createElement("img", {
    alt: contentText("image.alt", { host }),
    decoding: "async",
    style: "max-width: 100%; max-height: 350px; border-radius: 4px; cursor: pointer;",
  });
  // Hidden until its bytes load: a loading or refused image is neither shown
  // nor reachable as a control, so it can never open an empty lightbox.
  img.hidden = true;
  wrap.appendChild(img);

  if (isKlipyUrl(url)) {
    const watermark = createElement("img", {
      class: "klipy-watermark",
      src: klipyWatermark,
      alt: "",
      "aria-hidden": "true",
    });
    wrap.appendChild(watermark);
  }

  const extra = imageDecorator?.(url);
  if (extra) wrap.appendChild(extra);

  // The failure line and its bounded retry sit beside the image; the image is
  // hidden, not discarded, so retry can reuse it and tests keep one element.
  const failure = renderFailureStatus(
    contentText("image.failed"),
    contentText("image.retry"),
    () => {
      if (wrap.dataset.mediaState !== "loading") load();
    },
  );
  failure.hidden = true;
  wrap.appendChild(failure);
  const retry = failure.querySelector("button")!;

  // On failure: clear min-height so the wrapper collapses instead of
  // holding a 200px empty reservation that can oscillate with virtual scroll.
  const showFailure = (kind: ExternalContentFailure): void => {
    log.error("Image failed to load", { url, failure: kind });
    wrap.style.cssText = "max-width: 400px;";
    // A refusal (blocked destination, wrong type, oversized, expired) is kept
    // distinct from a loaded image; the failure line never reads as success.
    wrap.dataset.mediaState = "failed";
    img.hidden = true;
    // Only a transient "unavailable" answer is worth re-asking.
    retry.hidden = kind !== "unavailable";
    retry.removeAttribute("aria-disabled");
    failure.hidden = false;
  };
  recoverEvictedImage(img, { url });
  // Bytes that fail to decode, or an evicted image the broker can no longer
  // re-fetch, land in the same typed failed state.
  img.addEventListener("error", () => showFailure("unavailable"));

  // On load: the reserved box already holds the image, so nothing is measured
  // (no forced layout) unless the file disagrees with it, which happens for a
  // header the sniffer could not read or an EXIF-rotated JPEG; then the real
  // size replaces the box. Once per load: a GIF freeze/unfreeze changes src and
  // would re-run it. load() re-arms it for a retry.
  const onLoad = (): void => {
    log.debug("Image loaded", { url: url.slice(0, 80), naturalH: img.naturalHeight });
    // A retry that succeeds hands keyboard focus from the retry to the image.
    const refocus = failure.contains(document.activeElement);
    wrap.dataset.mediaState = "loaded";
    img.hidden = false;
    failure.hidden = true;
    const actual = fitImageBox(img.naturalWidth, img.naturalHeight);
    const reserved = getImageBox(url);
    if (actual !== null) {
      // The decoded size is oriented by the browser: it is the measured box,
      // and replaces a sniffed one (an EXIF-rotated header reads swapped).
      if (
        reserved === undefined ||
        reserved.measured !== true ||
        reserved.w !== actual.w ||
        reserved.h !== actual.h
      ) {
        reserve(actual);
        setImageBox(url, { ...actual, measured: true }, generation);
      }
    } else if (reserved === undefined) {
      // No intrinsic size (a host that does not report one): measure the box.
      wrap.style.minHeight = "";
      const measured = fitImageBox(wrap.offsetWidth, wrap.offsetHeight);
      if (measured !== null) setImageBox(url, { ...measured, measured: true }, generation);
    }
    if (refocus) img.focus();
  };
  img.addEventListener("load", onLoad, { once: true });

  // Observe GIFs for visibility-based freeze/unfreeze + play/pause button.
  // When the animateGifs pref is disabled, start frozen so the first frame is
  // shown by default; the user can still click the play button to animate.
  // The blob: source is same-origin, so the freeze canvas stays untainted.
  if (isGifUrl(url)) {
    img.addEventListener(
      "load",
      () => {
        observeMedia(img, img.src, wrap, !animateGifsPref);
      },
      { once: true },
    );
  }

  // The image is a keyboard-operable control, not pointer-only: focus
  // it and Enter/Space open the same lightbox a click does.
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  img.setAttribute("aria-label", contentText("image.open", { host }));
  img.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    img.click();
  });
  img.addEventListener("click", () => {
    openImageLightbox(img.src, contentText("image.alt", { host }), { url });
  });
  // Save asks the broker for the bytes again rather than reading img.src: a
  // frozen GIF shows a one-frame data: URL there, and the save keeps the
  // animation.
  bindImageMenu({
    img,
    link: url,
    full: () => fetchExternalImage({ url }),
    save: () => fetchExternalImage({ url }).then((src) => saveImageBytes(src ?? img.src, url)),
    share: () =>
      fetchExternalImage({ url }).then((src) => saveImageBytes(src ?? img.src, url, "share")),
  });

  function load(): void {
    // A retry rechecks consent and the current partition: a revoked grant
    // makes loadExternalImage refuse again with nothing fetched.
    // A visible retry stays mounted (and focused) while it re-asks.
    wrap.dataset.mediaState = "loading";
    const box = getImageBox(url);
    if (box !== undefined) reserve(box);
    else reserveFallback();
    retry.setAttribute("aria-disabled", "true");
    if (img.hasAttribute("src")) img.removeAttribute("src");
    img.addEventListener("load", onLoad, { once: true });
    void loadExternalImage({ url }, { sniff: true }).then((result) => {
      if (!result.ok) {
        showFailure(result.failure);
        return;
      }
      // The sniffed size reserves the exact box before the first byte decodes.
      const sniffed = blobImageSize(result.value);
      const exact = sniffed === undefined ? null : fitImageBox(sniffed.width, sniffed.height);
      if (exact !== null) {
        // A measured box from an earlier load wins over the header's reading.
        const held = setImageBox(url, exact, generation);
        reserve(held ?? exact);
      }
      img.src = result.value;
    });
  }

  load();

  return wrap;
}

// -- URL extraction and embed orchestration -----------------------------------

/** Extract all URLs from a message content string. */
export function extractUrls(content: string): string[] {
  // Skip URLs inside code blocks, and inside masked links: `[text](url)` is a
  // deliberate act of hiding the address, so it gets no embed either. The
  // same goes for `||spoilers||`: a hidden address must not be previewed, and
  // for `<https://…>`, which is how an author asks for no embed.
  const withoutCodeBlocks = content
    .replace(CODE_BLOCK_REGEX, "")
    .replace(INLINE_CODE_REGEX, "")
    .replace(MASKED_LINK_REGEX, "")
    .replace(SPOILER_REGEX, "")
    .replace(ANGLE_URL_REGEX, "");
  const matches = withoutCodeBlocks.match(URL_REGEX);
  // Strip the same trailing sentence punctuation the linkifier strips (see
  // stripUrlTrailingPunctuation), so the embed pipeline and the rendered
  // anchor agree on exactly the same URL.
  return (matches ?? []).map(stripUrlTrailingPunctuation);
}

/** True when the message is nothing but one image or GIF link that renders
 *  inline, such as a pick from the GIF picker. The image stands in for the
 *  link, so the row hides the address text, as Discord does. */
export function isLoneImageEmbed(content: string): boolean {
  const trimmed = content.trim();
  if (!inlineMediaPref || !isDirectImageUrl(trimmed) || !isSafeUrl(trimmed)) return false;
  const urls = extractUrls(trimmed);
  return urls.length === 1 && urls[0] === trimmed;
}

/** One URL's embed (YouTube player, inline image, link card), or null when
 *  it gets none. Concealed until the viewer consented to it. */
function renderUrlEmbed(url: string): HTMLElement | null {
  const ytId = extractYouTubeId(url);
  const isSafe = isSafeUrl(url);
  let render: () => HTMLElement;
  if (ytId !== null) {
    if (!showEmbedsPref) return null;
    render = () => renderYouTubeEmbed(ytId, url);
  } else if (isDirectImageUrl(url) && isSafe) {
    if (!inlineMediaPref) return null;
    render = () => renderInlineImage(url);
  } else if (isSafe) {
    if (!showLinkPreviewsPref) return null;
    render = () => renderGenericLinkPreview(url);
  } else {
    return null;
  }
  const loaded = externalAllowed(`url:${url}`);
  const el = loaded
    ? render()
    : renderConcealedItem(url, () => {
        void requestExternalItem(`url:${url}`).then((ok) => {
          if (ok) refreshExternalItems();
        });
      });
  el.dataset.externalUrl = url;
  el.dataset.externalLoaded = String(loaded);
  return el;
}

/** One URL's embed drawn from the card the server built for it, or null when
 *  it has no card or the viewer turned that kind of embed off. Nothing is
 *  fetched from the linked site, so no external-content consent applies. A link
 *  that is itself an image is not a page preview: it keeps the local fetch, its
 *  consent and its animation, whatever card the server holds. */
function renderServerEmbed(url: string, card: LinkPreviewCard | undefined): HTMLElement | null {
  if (isDirectImageUrl(url)) return renderUrlEmbed(url);
  if (card === undefined || !isSafeUrl(url)) return null;
  // An image-only card on a link with no image file name: the local fetch, as before.
  if (isImageOnlyCard(card)) return renderUrlEmbed(url);
  const ytId = extractYouTubeId(url);
  if (ytId !== null) {
    if (!showEmbedsPref) return null;
    return renderYouTubeEmbed(ytId, url, false, {
      title: card.title ?? null,
      thumbUrl: cardThumbnailUrl(card),
    });
  }
  if (!showLinkPreviewsPref) return null;
  return renderServerLinkCard(card, url);
}

/** Re-render every embed whose consent changed: load the newly admitted ones
 *  and conceal the revoked ones, keeping focus on the item it was in. */
function refreshExternalItems(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-external-url]")) {
    const url = el.dataset.externalUrl ?? "";
    if (String(externalAllowed(`url:${url}`)) === el.dataset.externalLoaded) continue;
    const hadFocus = el.contains(document.activeElement);
    const next = renderUrlEmbed(url);
    if (next === null) {
      const text = el.parentElement?.querySelector<HTMLElement>("[data-lone-image-text]");
      if (text != null) {
        text.hidden = false;
        text.style.display = "contents";
      }
      el.remove();
      continue;
    }
    el.replaceWith(next);
    if (hadFocus && next.hidden) {
      focusMessageLink(next, url);
    } else if (hadFocus) {
      const target = next.querySelector<HTMLElement>("a, button") ?? next;
      if (target === next) next.tabIndex = -1;
      target.focus();
    }
  }
}

/** The most embeds one message draws; further links stay plain text links. */
export const MAX_EMBEDS_PER_MESSAGE = 5;

/** Render URL embeds (YouTube players, generic link previews). `cards` are the
 *  server's cards for the message: a page link or video still in `content` is
 *  drawn from its card. Null means the server builds none, and each link is
 *  fetched locally (through the external-content broker, with the viewer's consent). */
export function renderUrlEmbeds(
  content: string,
  cards: readonly LinkPreviewCard[] | null = null,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let drawn = 0;
  for (const url of new Set(extractUrls(content))) {
    if (drawn >= MAX_EMBEDS_PER_MESSAGE) break;
    const el =
      cards === null ? renderUrlEmbed(url) : renderServerEmbed(url, cardForUrl(cards, url));
    if (el === null) continue;
    fragment.appendChild(el);
    drawn++;
  }
  return fragment;
}
