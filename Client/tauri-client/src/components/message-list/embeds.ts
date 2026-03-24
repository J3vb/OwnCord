/**
 * Link preview / Open Graph tag rendering — fetches and displays OG metadata
 * (title, description, image) for generic URLs as compact link cards.
 */

import {
  createElement,
  setText,
} from "@lib/dom";
import { observeMedia } from "@lib/media-visibility";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createLogger } from "@lib/logger";
import { isSafeUrl } from "./attachments";

const log = createLogger("embeds");

// -- OG metadata types --------------------------------------------------------

/** Open Graph metadata extracted from a page. */
export interface OgMeta {
  readonly title: string | null;
  readonly description: string | null;
  readonly image: string | null;
  readonly siteName: string | null;
}

// -- Caches -------------------------------------------------------------------

/** Cache for OG metadata to avoid re-fetching on re-render. */
const ogCache = new Map<string, OgMeta>();
/** URLs currently being fetched (prevents duplicate requests). */
const ogInFlight = new Set<string>();

// -- OG tag parsing -----------------------------------------------------------

/** Escape special regex characters in a string for safe use in `new RegExp()`. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract Open Graph meta tags from raw HTML using regex (no DOM parser needed). */
export function parseOgTags(html: string): OgMeta {
  function getMetaContent(property: string): string | null {
    // Match both property="og:X" and name="og:X" patterns
    const escaped = escapeRegex(property);
    const regex = new RegExp(
      `<meta[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']` +
      `|<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
      "i",
    );
    const match = html.match(regex);
    if (match !== null) {
      return match[1] ?? match[2] ?? null;
    }
    return null;
  }

  // Fallback: extract <title> tag if no og:title
  function getTitle(): string | null {
    const og = getMetaContent("og:title");
    if (og !== null) return og;
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return titleMatch?.[1]?.trim() ?? null;
  }

  // Fallback: extract meta description if no og:description
  function getDescription(): string | null {
    const og = getMetaContent("og:description");
    if (og !== null) return og;
    return getMetaContent("description");
  }

  return {
    title: getTitle(),
    description: getDescription(),
    image: getMetaContent("og:image"),
    siteName: getMetaContent("og:site_name"),
  };
}

// -- OG fetch -----------------------------------------------------------------

/** Fetch OG metadata for a URL using the Tauri native HTTP client (no CORS). */
async function fetchOgMeta(url: string): Promise<OgMeta> {
  const cached = ogCache.get(url);
  if (cached !== undefined) return cached;

  // Return empty while in-flight to avoid duplicate requests
  if (ogInFlight.has(url)) {
    return { title: null, description: null, image: null, siteName: null };
  }

  log.debug("fetchOgMeta START", url.slice(0, 100));
  ogInFlight.add(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await tauriFetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false },
    } as RequestInit);
    clearTimeout(timer);

    if (!res.ok) {
      const empty: OgMeta = { title: null, description: null, image: null, siteName: null };
      ogCache.set(url, empty);
      return empty;
    }

    // Only parse HTML responses (skip binary, JSON, etc.)
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      const empty: OgMeta = { title: null, description: null, image: null, siteName: null };
      ogCache.set(url, empty);
      return empty;
    }

    const html = await res.text();
    // Only parse the first 50KB to avoid parsing huge pages
    const meta = parseOgTags(html.slice(0, 50_000));
    ogCache.set(url, meta);
    return meta;
  } catch {
    const empty: OgMeta = { title: null, description: null, image: null, siteName: null };
    ogCache.set(url, empty);
    return empty;
  } finally {
    ogInFlight.delete(url);
  }
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
    const desc = meta.description.length > 200
      ? meta.description.slice(0, 197) + "..."
      : meta.description;
    setText(descEl, desc);
    descEl.style.display = "";
  } else {
    descEl.style.display = "none";
  }
  if (meta.image !== null && meta.image.length > 0) {
    // Resolve relative image URLs
    let imgSrc = meta.image;
    if (imgSrc.startsWith("/")) {
      try {
        const base = new URL(url);
        imgSrc = `${base.origin}${imgSrc}`;
      } catch { /* keep as-is */ }
    }
    if (isSafeUrl(imgSrc)) {
      const isGif = imgSrc.toLowerCase().endsWith(".gif");
      const attrs: Record<string, string> = {
        class: "msg-embed-link-img",
        src: imgSrc,
        alt: meta.title ?? "",
        loading: "lazy",
      };
      if (isGif) {
        attrs.crossorigin = "anonymous";
      }
      const img = createElement("img", attrs);
      img.addEventListener("error", () => {
        imageWrap.style.display = "none";
      });
      if (isGif) {
        (img as HTMLImageElement).addEventListener("load", () => {
          observeMedia(img as HTMLImageElement, imgSrc, imageWrap);
        }, { once: true });
      }
      imageWrap.appendChild(img);
      imageWrap.style.display = "";
    }
  }
}
