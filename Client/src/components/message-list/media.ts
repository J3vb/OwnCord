/**
 * Image and video rendering — YouTube embeds, direct image URLs,
 * inline image rendering, lightbox overlay, and URL embed orchestration.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import klipyWatermark from "../../assets/KLIPY Light with logo.svg";
import { createLogger } from "@lib/logger";
import { observeMedia } from "@lib/media-visibility";
import { loadPref } from "@components/settings/helpers";
import {
  clearExternalImageCache,
  fetchExternalImage,
  isSafeUrl,
  loadExternalImage,
  openImageLightbox,
  previewExternal,
  recoverEvictedImage,
  renderFailureStatus,
} from "./attachments";
import {
  admitDerived,
  EXTERNAL_CONSENT_PREF,
  externalAllowed,
  externalConsentChoice,
  requestExternalItem,
  resetExternalConsent,
} from "../../features/content-consent/external";
import { renderConcealedItem } from "../../features/content-consent/concealed";
import { externalConsentText } from "../../i18n/externalConsent";
import { contentText } from "../../i18n/content";
import {
  CODE_BLOCK_REGEX,
  INLINE_CODE_REGEX,
  MASKED_LINK_REGEX,
  stripUrlTrailingPunctuation,
  URL_REGEX,
} from "./content-parser";
import { clearEmbedCaches, renderGenericLinkPreview } from "./embeds";
import type { ExternalContentFailure } from "../../platform/contracts/externalContent";

// The lightbox lives in attachments.ts, which renders attachment images and
// must not import this module (that import was a cycle); re-exported here for
// existing importers.
export { closeActiveLightbox, openImageLightbox } from "./attachments";

const log = createLogger("media");

// Cached embed/media preferences — read once and invalidated on pref change
// instead of hitting localStorage for every rendered message (same pattern as
// roleColors in formatting.ts and developerMode in renderers.ts).
let showEmbedsPref = loadPref<boolean>("showEmbeds", true);
let inlineMediaPref = loadPref<boolean>("inlineMedia", true);
let showLinkPreviewsPref = loadPref<boolean>("showLinkPreviews", true);
let animateGifsPref = loadPref<boolean>("animateGifs", true);
window.addEventListener("owncord:pref-change", ((e: CustomEvent<{ key: string }>) => {
  switch (e.detail.key) {
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
}) as EventListener);

/**
 * Cache of rendered image heights keyed by URL. When virtual scroll rebuilds
 * DOM elements, new images use the cached height as min-height instead of the
 * generic 200px estimate. This prevents height oscillation (200px → actual →
 * 200px → actual …) that causes infinite DOM rebuild loops.
 */
const imageHeightCache = new Map<string, number>();
const MAX_IMAGE_HEIGHT_CACHE = 500;
let mediaCacheGeneration = 0;

function cacheImageHeight(url: string, h: number): void {
  if (imageHeightCache.size >= MAX_IMAGE_HEIGHT_CACHE) {
    // Evict oldest entry (first inserted key)
    const firstKey = imageHeightCache.keys().next().value;
    if (firstKey !== undefined) imageHeightCache.delete(firstKey);
  }
  imageHeightCache.set(url, h);
}

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

// -- YouTube ------------------------------------------------------------------

/** Extract YouTube video ID from various YouTube URL formats. */
export function extractYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // youtube.com/watch?v=ID
    if (
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
      parsed.pathname === "/watch"
    ) {
      return parsed.searchParams.get("v");
    }
    // youtu.be/ID
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1);
      return id.length > 0 ? id : null;
    }
    // youtube.com/embed/ID
    if (
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
      parsed.pathname.startsWith("/embed/")
    ) {
      const id = parsed.pathname.slice(7);
      return id.length > 0 ? id : null;
    }
    // youtube.com/shorts/ID
    if (
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
      parsed.pathname.startsWith("/shorts/")
    ) {
      const id = parsed.pathname.slice(8);
      return id.length > 0 ? id : null;
    }
  } catch {
    // Invalid URL
  }
  return null;
}

let ytNoteSeq = 0;

/** Cache for YouTube video titles to avoid re-fetching on every re-render (LRU at 200). */
const ytTitleCache = new Map<string, string>();
const YT_TITLE_CACHE_MAX = 200;

export function clearMediaCaches(): void {
  mediaCacheGeneration += 1;
  imageHeightCache.clear();
  ytTitleCache.clear();
}

/** Strict pattern for YouTube video IDs (alphanumeric, hyphens, underscores). */
const YOUTUBE_ID_RE = /^[\w-]{1,20}$/;

/** Render a YouTube embed player with title header. */
export function renderYouTubeEmbed(videoId: string, originalUrl: string): HTMLDivElement {
  // Validate videoId to prevent injection into iframe src / img src.
  if (!YOUTUBE_ID_RE.test(videoId)) {
    const fallback = createElement("div", { class: "msg-embed" });
    const link = createElement("a", {
      href: originalUrl,
      target: "_blank",
      rel: "noopener noreferrer",
    });
    setText(link, originalUrl);
    fallback.appendChild(link);
    return fallback;
  }
  const wrap = createElement("div", { class: "msg-embed msg-embed-youtube" });

  // Header: channel name + video title
  const header = createElement("div", { class: "msg-embed-yt-header" });
  const channelLabel = createElement("div", { class: "msg-embed-host" }, "YouTube");
  const titleLink = createElement("a", {
    class: "msg-embed-yt-title",
    href: originalUrl,
    target: "_blank",
    rel: "noopener noreferrer",
  });

  const cached = ytTitleCache.get(videoId);
  if (cached !== undefined) {
    setText(titleLink, cached);
  } else {
    setText(titleLink, "Loading...");
    const generation = mediaCacheGeneration;
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    admitDerived(`url:${originalUrl}`, `url:${oembedUrl}`);
    // The broker fetches and parses the oEmbed document and hands back only
    // its title — the renderer never reads the JSON.
    void previewExternal(oembedUrl).then((result) => {
      if (generation !== mediaCacheGeneration) {
        setText(titleLink, "YouTube Video");
        return;
      }
      const title = (result.ok ? result.value.title : null) ?? "YouTube Video";
      if (ytTitleCache.size >= YT_TITLE_CACHE_MAX) {
        const firstKey = ytTitleCache.keys().next().value;
        if (firstKey !== undefined) ytTitleCache.delete(firstKey);
      }
      ytTitleCache.set(videoId, title);
      setText(titleLink, title);
    });
  }

  appendChildren(header, channelLabel, titleLink);
  wrap.appendChild(header);

  // Thumbnail container with play button overlay
  const thumbWrap = createElement("div", { class: "msg-embed-yt-player" });
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  const thumb = createElement("img", {
    class: "msg-embed-thumb",
    alt: "YouTube video",
    loading: "lazy",
  });
  admitDerived(`url:${originalUrl}`, `url:${thumbUrl}`);
  recoverEvictedImage(thumb, { url: thumbUrl });
  void fetchExternalImage({ url: thumbUrl }).then((src) => {
    if (src !== null) thumb.src = src;
  });

  // Playback is a separate deliberate act (B9-8): the frame talks to YouTube
  // itself, outside the broker's byte-fetch boundary, and the note says so.
  const note = createElement(
    "div",
    { class: "msg-embed-link-desc", id: `yt-note-${videoId}-${++ytNoteSeq}` },
    externalConsentText("youtube.note"),
  );
  header.appendChild(note);
  const playBtn = createElement("button", {
    type: "button",
    class: "msg-embed-play",
    "aria-label": externalConsentText("youtube.play"),
    "aria-describedby": note.id,
  });
  playBtn.appendChild(createIcon("play", 24));

  appendChildren(thumbWrap, thumb, playBtn);
  wrap.appendChild(thumbWrap);

  // On click (or Enter/Space on the play button), replace with the player
  thumbWrap.addEventListener(
    "click",
    () => {
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      iframe.setAttribute("allowfullscreen", "");
      iframe.setAttribute("allow", "autoplay; encrypted-media");
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-presentation allow-popups",
      );
      iframe.className = "msg-embed-iframe";
      iframe.title = externalConsentText("youtube.frame");
      const hadFocus = thumbWrap.contains(document.activeElement);
      thumbWrap.replaceChildren(iframe);
      if (hadFocus) iframe.focus();
    },
    { once: true },
  );

  return wrap;
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

/** Render a direct image/GIF URL as an inline image with lightbox. */
export function renderInlineImage(url: string): HTMLDivElement {
  // Use cached height from a previous render if available, otherwise 200px.
  // This prevents height oscillation when virtual scroll rebuilds DOM.
  const cachedH = imageHeightCache.get(url);
  const minH = cachedH ?? 200;
  const host = displayHost(url);

  const wrap = createElement("div", {
    class: "msg-image",
    style: `max-width: 400px; min-height: ${minH}px;`,
  });

  // No src yet: the bytes come from the external-content broker as a
  // same-origin blob: URL, never from the webview loading `url` itself.
  const img = createElement("img", {
    alt: contentText("image.alt", { host }),
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
    wrap.style.minHeight = "";
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

  // On load: clear min-height reservation and cache the natural rendered
  // height so future virtual-scroll rebuilds start at the correct size.
  // Measure synchronously — deferring to rAF loses the race with
  // ResizeObserver which can rebuild the DOM before the rAF fires.
  img.addEventListener("load", () => {
    log.debug("Image loaded", { url: url.slice(0, 80), naturalH: img.naturalHeight });
    // A retry that succeeds hands keyboard focus from the retry to the image.
    const refocus = failure.contains(document.activeElement);
    wrap.style.minHeight = "";
    wrap.dataset.mediaState = "loaded";
    img.hidden = false;
    failure.hidden = true;
    const h = wrap.offsetHeight;
    if (h > 0) cacheImageHeight(url, h);
    if (refocus) img.focus();
  });

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

  // The image is a keyboard-operable control, not pointer-only (B9-9): focus
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

  function load(): void {
    // A retry rechecks consent and the current partition: a revoked grant
    // makes loadExternalImage refuse again with nothing fetched.
    // A visible retry stays mounted (and focused) while it re-asks.
    wrap.dataset.mediaState = "loading";
    wrap.style.minHeight = `${cachedH ?? 200}px`;
    retry.setAttribute("aria-disabled", "true");
    if (img.hasAttribute("src")) img.removeAttribute("src");
    void loadExternalImage({ url }).then((result) => {
      if (!result.ok) {
        showFailure(result.failure);
        return;
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
  // deliberate act of hiding the address, so it gets no embed either.
  const withoutCodeBlocks = content
    .replace(CODE_BLOCK_REGEX, "")
    .replace(INLINE_CODE_REGEX, "")
    .replace(MASKED_LINK_REGEX, "");
  const matches = withoutCodeBlocks.match(URL_REGEX);
  // Strip the same trailing sentence punctuation the linkifier strips (see
  // stripUrlTrailingPunctuation), so the embed pipeline and the rendered
  // anchor agree on exactly the same URL.
  return (matches ?? []).map(stripUrlTrailingPunctuation);
}

/** One URL's embed (YouTube player, inline image, link card), or null when
 *  it gets none. Concealed until the viewer consented to it (B9-8). */
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

/** Re-render every embed whose consent changed: load the newly admitted ones
 *  and conceal the revoked ones, keeping focus on the item it was in. */
function refreshExternalItems(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-external-url]")) {
    const url = el.dataset.externalUrl ?? "";
    if (String(externalAllowed(`url:${url}`)) === el.dataset.externalLoaded) continue;
    const hadFocus = el.contains(document.activeElement);
    const next = renderUrlEmbed(url);
    if (next === null) {
      el.remove();
      continue;
    }
    el.replaceWith(next);
    if (hadFocus) {
      const target = next.querySelector<HTMLElement>("a, button") ?? next;
      if (target === next) next.tabIndex = -1;
      target.focus();
    }
  }
}

/** Render URL embeds (YouTube players, generic link previews). */
export function renderUrlEmbeds(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const url of new Set(extractUrls(content))) {
    const el = renderUrlEmbed(url);
    if (el !== null) fragment.appendChild(el);
  }
  return fragment;
}
