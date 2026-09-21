/**
 * Link preview / Open Graph tag rendering — fetches and displays OG metadata
 * (title, description, image) for generic URLs as compact link cards.
 */

import { createElement, setText } from "@lib/dom";
import { observeMedia } from "@lib/media-visibility";
import { createLogger } from "@lib/logger";
import {
  externalPartition,
  isExternalGif,
  loadExternalImage,
  recoverEvictedImage,
} from "./attachments";
import { desktop } from "../../platform/desktop";
import type { ExternalImageHandle } from "../../platform/contracts/externalContent";

const log = createLogger("embeds");

// -- OG metadata types --------------------------------------------------------

/** Open Graph metadata for a page, as the external-content broker reduced it.
 *  The image is an opaque broker handle, never a URL the renderer could load. */
export interface OgMeta {
  readonly title: string | null;
  readonly description: string | null;
  readonly image: ExternalImageHandle | null;
  readonly siteName: string | null;
}

// -- Caches -------------------------------------------------------------------

/** Cache for OG metadata to avoid re-fetching on re-render. Cleared on page
 *  teardown (MainPage) as well as by the manual "clear cache" action, so one
 *  server's previews are never shown on the next. */
const ogCache = new Map<string, OgMeta>();
/** In-flight fetch promises keyed by URL — concurrent callers share the same promise. */
const ogInFlight = new Map<string, Promise<OgMeta>>();
/** Previews re-asked for after the broker forgot their image handle — at most
 *  once per URL until the next cache clear, shared by every embed of it. */
const ogReasked = new Map<string, Promise<OgMeta>>();
let embedCacheGeneration = 0;

export function clearEmbedCaches(): void {
  embedCacheGeneration += 1;
  ogCache.clear();
  ogInFlight.clear();
  ogReasked.clear();
}

// -- OG fetch -----------------------------------------------------------------

const EMPTY_OG: OgMeta = { title: null, description: null, image: null, siteName: null };

/** Fetch OG metadata for a URL through the external-content broker, which
 *  owns the whole destination policy (resolved-address classification,
 *  redirects, time/byte/type ceilings) and parses the page natively — the
 *  renderer never sees the body. Concurrent requests for the same URL share
 *  the same in-flight promise. */
function fetchOgMeta(url: string): Promise<OgMeta> {
  const generation = embedCacheGeneration;
  const cached = ogCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  // Return the existing in-flight promise so all callers get the real result.
  const existing = ogInFlight.get(url);
  if (existing !== undefined) return existing;

  log.debug("fetchOgMeta START", url.slice(0, 100));
  const promise = (async (): Promise<OgMeta> => {
    const result = await desktop.externalContent.preview(externalPartition(), url);
    if (!result.ok) log.debug("fetchOgMeta refused", { failure: result.failure });
    const meta: OgMeta = result.ok
      ? {
          title: result.value.title,
          description: result.value.description,
          image: result.value.image,
          siteName: result.value.siteName,
        }
      : EMPTY_OG;
    // A cache clear while this was in flight means the answer belongs to a
    // session that is gone: hand it to this caller, but never cache it.
    if (generation === embedCacheGeneration) ogCache.set(url, meta);
    return meta;
  })();

  ogInFlight.set(url, promise);
  void promise.finally(() => {
    if (ogInFlight.get(url) === promise) {
      ogInFlight.delete(url);
    }
  });
  return promise;
}

// -- Link preview rendering ---------------------------------------------------

/** Render a link preview card with OG metadata (title, description, image). */
export function renderGenericLinkPreview(url: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-embed msg-embed-link" });

  let displayHost = "";
  try {
    displayHost = new URL(url).hostname;
  } catch {
    displayHost = url;
  }

  const content = createElement("div", { class: "msg-embed-link-content" });

  const hostEl = createElement("div", { class: "msg-embed-host" }, displayHost);
  content.appendChild(hostEl);

  const titleEl = createElement("a", {
    class: "msg-embed-link-title",
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
  });
  content.appendChild(titleEl);

  const descEl = createElement("div", { class: "msg-embed-link-desc" });
  content.appendChild(descEl);

  wrap.appendChild(content);

  // Image container (shown if og:image exists)
  const imageWrap = createElement("div", { class: "msg-embed-link-image" });
  imageWrap.style.display = "none";
  wrap.appendChild(imageWrap);

  // Check cache first for instant render
  const cached = ogCache.get(url);
  if (cached !== undefined) {
    applyOgMeta(cached, titleEl, descEl, hostEl, imageWrap, url, displayHost);
  } else {
    // Show URL as fallback title while loading
    setText(titleEl, displayHost);
    void fetchOgMeta(url).then((meta) => {
      applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, url, displayHost);
    });
  }

  return wrap;
}

/** Apply fetched OG metadata to the preview card elements. */
export function applyOgMeta(
  meta: OgMeta,
  titleEl: HTMLElement,
  descEl: HTMLElement,
  hostEl: HTMLElement,
  imageWrap: HTMLElement,
  url: string,
  displayHost: string,
): void {
  setText(titleEl, meta.title ?? displayHost);
  if (meta.siteName !== null) {
    setText(hostEl, meta.siteName);
  }
  if (meta.description !== null) {
    const desc =
      meta.description.length > 200 ? meta.description.slice(0, 197) + "..." : meta.description;
    setText(descEl, desc);
    descEl.style.display = "";
  } else {
    descEl.style.display = "none";
  }
  if (meta.image !== null) {
    showOgImage(meta, meta.image, imageWrap, url);
  }
}

/** Show a preview's image. The broker forgets old handles, so when one has
 *  expired the preview is asked for again — once per URL — for a fresh one. */
function showOgImage(
  meta: OgMeta,
  handle: ExternalImageHandle,
  imageWrap: HTMLElement,
  url: string,
  reask = true,
): void {
  const reaskPreview = (): void => {
    if (!reask) return;
    let fresh = ogReasked.get(url);
    if (fresh === undefined) {
      if (ogCache.get(url) === meta) ogCache.delete(url);
      fresh = fetchOgMeta(url);
      ogReasked.set(url, fresh);
    }
    void fresh.then((next) => {
      if (next.image !== null) showOgImage(next, next.image, imageWrap, url, false);
    });
  };
  // The image arrives as broker-fetched bytes (a same-origin blob: URL),
  // never as an og:image URL the webview would load behind the broker.
  const source = { handle };
  void loadExternalImage(source).then((result) => {
    if (!result.ok) {
      if (result.failure === "expired-handle") reaskPreview();
      return;
    }
    const src = result.value;
    const img = createElement("img", {
      class: "msg-embed-link-img",
      src,
      alt: meta.title ?? "",
      loading: "lazy",
    });
    recoverEvictedImage(img, source, () => {
      img.remove();
      imageWrap.style.display = "none";
      reaskPreview();
    });
    img.addEventListener("error", () => {
      imageWrap.style.display = "none";
    });
    // A GIF gets the freeze/play control; its blob: source is same-origin,
    // so the freeze canvas stays untainted.
    if (isExternalGif(src)) {
      img.addEventListener(
        "load",
        () => {
          observeMedia(img, src, imageWrap);
        },
        { once: true },
      );
    }
    imageWrap.appendChild(img);
    imageWrap.style.display = "";
  });
}
