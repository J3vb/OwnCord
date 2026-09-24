/**
 * Link preview / Open Graph tag rendering — fetches and displays OG metadata
 * (title, description, image) for generic URLs as compact link cards.
 */

import { createElement, setText } from "@lib/dom";
import { observeMedia } from "@lib/media-visibility";
import { createLogger } from "@lib/logger";
import {
  isExternalGif,
  loadExternalImage,
  previewExternal,
  recoverEvictedImage,
} from "./attachments";
import { admitDerived } from "../../features/content-consent/external";
import { contentText as t } from "../../i18n/content";
import type {
  ExternalContentFailure,
  ExternalImageHandle,
} from "../../platform/contracts/externalContent";

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

/** A typed preview view state: the meta when the broker answered, or the
 *  refusal class that replaced it. Nothing collapses a refusal into an empty
 *  success (B9-9). */
type OgLoad =
  | { readonly ok: true; readonly meta: OgMeta }
  | { readonly ok: false; readonly failure: ExternalContentFailure };

/** Cache for OG metadata to avoid re-fetching on re-render. Cleared on page
 *  teardown (MainPage) as well as by the manual "clear cache" action, so one
 *  server's previews are never shown on the next. */
const ogCache = new Map<string, OgLoad>();
/** In-flight fetch promises keyed by URL — concurrent callers share the same promise. */
const ogInFlight = new Map<string, Promise<OgLoad>>();
/** Previews re-asked for after the broker forgot their image handle — at most
 *  once per URL until the next cache clear, shared by every embed of it. */
const ogReasked = new Map<string, Promise<OgLoad>>();
let embedCacheGeneration = 0;

export function clearEmbedCaches(): void {
  embedCacheGeneration += 1;
  ogCache.clear();
  ogInFlight.clear();
  ogReasked.clear();
}

// -- OG fetch -----------------------------------------------------------------

/** Fetch OG metadata for a URL through the external-content broker, which
 *  owns the whole destination policy (resolved-address classification,
 *  redirects, time/byte/type ceilings) and parses the page natively — the
 *  renderer never sees the body. Concurrent requests for the same URL share
 *  the same in-flight promise. A refusal is kept as its failure class, never
 *  flattened into an empty success (B9-9). */
function fetchOgMeta(url: string): Promise<OgLoad> {
  const generation = embedCacheGeneration;
  const cached = ogCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  // Return the existing in-flight promise so all callers get the real result.
  const existing = ogInFlight.get(url);
  if (existing !== undefined) return existing;

  log.debug("fetchOgMeta START", url.slice(0, 100));
  const promise = (async (): Promise<OgLoad> => {
    const result = await previewExternal(url);
    let load: OgLoad;
    if (result.ok) {
      // The preview image belongs to the same consented item as its page.
      if (result.value.image !== null) {
        admitDerived(`url:${url}`, `handle:${result.value.image}`);
      }
      load = {
        ok: true,
        meta: {
          title: result.value.title,
          description: result.value.description,
          image: result.value.image,
          siteName: result.value.siteName,
        },
      };
    } else {
      log.debug("fetchOgMeta refused", { failure: result.failure });
      load = { ok: false, failure: result.failure };
    }
    // A cache clear while this was in flight means the answer belongs to a
    // session that is gone: hand it to this caller, but never cache it.
    if (generation === embedCacheGeneration) ogCache.set(url, load);
    return load;
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

/** Drop a URL's cached preview (and in-flight answer) so an explicit retry
 *  re-asks the broker rather than replaying the refusal. */
function clearOgEntry(url: string): void {
  ogCache.delete(url);
  ogInFlight.delete(url);
}

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

  // The failure line + bounded retry live outside the description element so a
  // refusal never reads as a loaded description (B9-9).
  const statusEl = createElement("div", { class: "msg-embed-status", role: "status" });
  statusEl.hidden = true;
  const retryEl = createElement("button", {
    type: "button",
    class: "messages-retry-btn msg-embed-retry",
  });
  setText(retryEl, t("preview.retry"));
  retryEl.setAttribute("aria-label", t("preview.retry"));
  retryEl.hidden = true;
  content.appendChild(statusEl);
  content.appendChild(retryEl);
  wrap.dataset.embedState = "loading";
  wrap.setAttribute("aria-busy", "true");

  const apply = (load: OgLoad): void => {
    wrap.removeAttribute("aria-busy");
    delete wrap.dataset.embedFailure;
    if (load.ok) {
      wrap.dataset.embedState = "loaded";
      statusEl.hidden = true;
      retryEl.hidden = true;
      applyOgMeta(load.meta, titleEl, descEl, hostEl, imageWrap, url, displayHost);
      return;
    }
    wrap.dataset.embedState = "failed";
    wrap.dataset.embedFailure = load.failure;
    setText(titleEl, displayHost);
    descEl.style.display = "none";
    setText(statusEl, t("preview.failed"));
    statusEl.hidden = false;
    // A refusal is not retryable by policy or type; only a transient
    // "unavailable" answer is worth re-asking (B9-9).
    const retryable = load.failure === "unavailable";
    retryEl.hidden = !retryable;
  };

  // Check cache first for instant render
  const cached = ogCache.get(url);
  if (cached !== undefined) {
    apply(cached);
  } else {
    // Show URL as fallback title while loading
    setText(titleEl, displayHost);
    void fetchOgMeta(url).then(apply);
  }

  retryEl.addEventListener("click", () => {
    statusEl.hidden = true;
    retryEl.hidden = true;
    wrap.dataset.embedState = "loading";
    wrap.setAttribute("aria-busy", "true");
    clearOgEntry(url);
    void fetchOgMeta(url).then(apply);
  });

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
      clearOgEntry(url);
      fresh = fetchOgMeta(url);
      ogReasked.set(url, fresh);
    }
    void fresh.then((next) => {
      if (next.ok && next.meta.image !== null) {
        showOgImage(next.meta, next.meta.image, imageWrap, url, false);
      }
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
