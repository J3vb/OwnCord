/**
 * Image and video rendering — YouTube embeds, direct image URLs,
 * inline image rendering, lightbox overlay, and URL embed orchestration.
 */

import {
  createElement,
  setText,
  appendChildren,
} from "@lib/dom";
import { createLogger } from "@lib/logger";
import { observeMedia } from "@lib/media-visibility";
import { isSafeUrl } from "./attachments";
import { CODE_BLOCK_REGEX, INLINE_CODE_REGEX, URL_REGEX } from "./content-parser";
import { renderGenericLinkPreview } from "./embeds";

const log = createLogger("media");

/**
 * Cache of rendered image heights keyed by URL. When virtual scroll rebuilds
 * DOM elements, new images use the cached height as min-height instead of the
 * generic 200px estimate. This prevents height oscillation (200px → actual →
 * 200px → actual …) that causes infinite DOM rebuild loops.
 */
const imageHeightCache = new Map<string, number>();
const MAX_IMAGE_HEIGHT_CACHE = 500;

function cacheImageHeight(url: string, h: number): void {
  if (imageHeightCache.size >= MAX_IMAGE_HEIGHT_CACHE) {
    // Evict oldest entry (first inserted key)
    const firstKey = imageHeightCache.keys().next().value;
    if (firstKey !== undefined) imageHeightCache.delete(firstKey);
  }
  imageHeightCache.set(url, h);
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

/** Cache for YouTube video titles to avoid re-fetching on every re-render. */
const ytTitleCache = new Map<string, string>();

/** Strict pattern for YouTube video IDs (alphanumeric, hyphens, underscores). */
const YOUTUBE_ID_RE = /^[\w-]{1,20}$/;

/** Render a YouTube embed player with title header. */
export function renderYouTubeEmbed(videoId: string, originalUrl: string): HTMLDivElement {
  // Validate videoId to prevent injection into iframe src / img src.
  if (!YOUTUBE_ID_RE.test(videoId)) {
    const fallback = createElement("div", { class: "msg-embed" });
    const link = createElement("a", { href: originalUrl, target: "_blank", rel: "noopener noreferrer" });
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
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    fetch(oembedUrl, { signal: AbortSignal.timeout(5000) })
      .then((res) => (res.ok ? (res.json() as Promise<{ title?: string } | null>) : null))
      .then((data) => {
        const title = data?.title ?? "YouTube Video";
        ytTitleCache.set(videoId, title);
        setText(titleLink, title);
      })
      .catch(() => {
        ytTitleCache.set(videoId, "YouTube Video");
        setText(titleLink, "YouTube Video");
      });
  }

  appendChildren(header, channelLabel, titleLink);
  wrap.appendChild(header);

  // Thumbnail container with play button overlay
  const thumbWrap = createElement("div", { class: "msg-embed-yt-player" });
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  const thumb = createElement("img", {
    class: "msg-embed-thumb",
    src: thumbUrl,
    alt: "YouTube video",
    loading: "lazy",
  });

  const playBtn = createElement("div", { class: "msg-embed-play" }, "\u25B6");

  appendChildren(thumbWrap, thumb, playBtn);
  wrap.appendChild(thumbWrap);

  // On click thumbnail, replace with iframe player
  thumbWrap.addEventListener("click", () => {
    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("allow", "autoplay; encrypted-media");
    iframe.className = "msg-embed-iframe";
    thumbWrap.replaceChildren(iframe);
  }, { once: true });

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

/** Render a direct image/GIF URL as an inline image with lightbox. */
export function renderInlineImage(url: string): HTMLDivElement {
  // Use cached height from a previous render if available, otherwise 200px.
  // This prevents height oscillation when virtual scroll rebuilds DOM.
  const cachedH = imageHeightCache.get(url);
  const minH = cachedH ?? 200;

  const wrap = createElement("div", {
    class: "msg-image",
    style: `max-width: 400px; min-height: ${minH}px;`,
  });

  const attrs: Record<string, string> = {
    src: url,
    alt: "Image",
    style: "max-width: 100%; max-height: 350px; display: block; border-radius: 4px; cursor: pointer;",
  };
  // Enable CORS for GIFs so canvas capture works for freeze/unfreeze
  if (isGifUrl(url)) {
    attrs.crossorigin = "anonymous";
  }
  const img = createElement("img", attrs);

  // On load: clear min-height reservation and cache the natural rendered
  // height so future virtual-scroll rebuilds start at the correct size.
  // Measure synchronously — deferring to rAF loses the race with
  // ResizeObserver which can rebuild the DOM before the rAF fires.
  img.addEventListener("load", () => {
    log.info("Image loaded", { url: url.slice(0, 80), naturalW: (img as HTMLImageElement).naturalWidth, naturalH: (img as HTMLImageElement).naturalHeight });
    wrap.style.minHeight = "";
    const h = wrap.offsetHeight;
    if (h > 0) cacheImageHeight(url, h);
    log.debug("Image height cached", { url: url.slice(0, 80), h });
  }, { once: true });

  // On error: clear min-height so the wrapper collapses instead of
  // holding a 200px empty reservation that can oscillate with virtual scroll.
  img.addEventListener("error", () => {
    log.error("Image failed to load", { url });
    wrap.style.minHeight = "";
  }, { once: true });

  // Observe GIFs for visibility-based freeze/unfreeze + play/pause button
  if (isGifUrl(url)) {
    img.addEventListener("load", () => {
      log.debug("Calling observeMedia for GIF", { url: url.slice(0, 80) });
      observeMedia(img, url, wrap);
      log.debug("observeMedia complete");
    }, { once: true });
  }

  img.addEventListener("click", () => {
    openImageLightbox(url, "Image");
  });

  wrap.appendChild(img);
  return wrap;
}

// -- Lightbox -----------------------------------------------------------------

/** Open a full-screen lightbox overlay with zoom and pan. */
export function openImageLightbox(src: string, alt: string): void {
  const overlay = createElement("div", { class: "image-lightbox" });

  const imgWrap = createElement("div", { class: "image-lightbox-wrap" });
  const img = createElement("img", { src, alt }) as HTMLImageElement;
  imgWrap.appendChild(img);
  overlay.appendChild(imgWrap);

  const closeBtn = createElement("button", { class: "image-lightbox-close" }, "\u2715");
  overlay.appendChild(closeBtn);

  // Zoom & pan state
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  function applyTransform(): void {
    img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function resetZoom(): void {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  }

  function onMove(e: MouseEvent): void {
    if (!isDragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
  }

  function onUp(): void {
    if (isDragging) {
      isDragging = false;
      overlay.classList.remove("dragging");
    }
  }

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  // Mouse wheel zoom
  imgWrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    const newScale = Math.max(0.5, Math.min(10, scale + delta * scale));
    // Zoom towards cursor position
    const rect = img.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const factor = newScale / scale;
    panX = panX - cx * (factor - 1);
    panY = panY - cy * (factor - 1);
    scale = newScale;
    applyTransform();
  });

  // Single click to toggle zoom, with drag detection to avoid zoom on pan
  let clickStartX = 0;
  let clickStartY = 0;

  img.addEventListener("mousedown", (e) => {
    e.preventDefault();
    clickStartX = e.clientX;
    clickStartY = e.clientY;

    if (scale > 1.1) {
      // Zoomed in — start panning
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      panStartX = panX;
      panStartY = panY;
      overlay.classList.add("dragging");
    }
  });

  img.addEventListener("click", (e) => {
    e.stopPropagation();
    // Only toggle zoom if mouse didn't move (not a pan gesture)
    const dx = Math.abs(e.clientX - clickStartX);
    const dy = Math.abs(e.clientY - clickStartY);
    if (dx > 5 || dy > 5) return;

    if (scale > 1.1) {
      resetZoom();
    } else {
      // Zoom to 3x towards click position
      const rect = img.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      scale = 3;
      panX = -cx * 2;
      panY = -cy * 2;
      applyTransform();
    }
  });

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
    if (e.key === "+" || e.key === "=") {
      scale = Math.min(10, scale * 1.3);
      applyTransform();
    }
    if (e.key === "-") {
      scale = Math.max(0.5, scale / 1.3);
      applyTransform();
    }
    if (e.key === "0") resetZoom();
  }
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
}

// -- URL extraction and embed orchestration -----------------------------------

/** Extract all URLs from a message content string. */
export function extractUrls(content: string): string[] {
  // Skip URLs inside code blocks
  const withoutCodeBlocks = content.replace(CODE_BLOCK_REGEX, "").replace(INLINE_CODE_REGEX, "");
  const matches = withoutCodeBlocks.match(URL_REGEX);
  return matches ?? [];
}

/** Render URL embeds (YouTube players, generic link previews). */
export function renderUrlEmbeds(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const urls = extractUrls(content);
  log.debug("renderUrlEmbeds", { urlCount: urls.length, urls });
  const seen = new Set<string>();

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);

    // YouTube embed
    const ytId = extractYouTubeId(url);
    if (ytId !== null) {
      fragment.appendChild(renderYouTubeEmbed(ytId, url));
      continue;
    }

    // Direct image/GIF URL — render inline
    const isDirect = isDirectImageUrl(url);
    const isSafe = isSafeUrl(url);
    log.debug("URL classification", { url: url.slice(0, 80), isDirect, isSafe, isGif: isGifUrl(url) });
    if (isDirect && isSafe) {
      fragment.appendChild(renderInlineImage(url));
      continue;
    }

    // Generic URL preview (compact link card)
    if (isSafe) {
      log.debug("Falling through to generic link preview", { url: url.slice(0, 80) });
      fragment.appendChild(renderGenericLinkPreview(url));
    }
  }

  log.debug("renderUrlEmbeds complete");
  return fragment;
}
