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
import { isSafeUrl, isTrustedServerUrl } from "./attachments";

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
/** In-flight fetch promises keyed by URL — concurrent callers share the same promise. */
const ogInFlight = new Map<string, Promise<OgMeta>>();
let embedCacheGeneration = 0;

export function clearEmbedCaches(): void {
  embedCacheGeneration += 1;
  ogCache.clear();
  ogInFlight.clear();
}

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

// -- SSRF protection ----------------------------------------------------------

/** Block link previews to private/internal IP ranges to prevent SSRF.
 *  The connected OwnCord server host is NOT blocked (it's trusted). */
function parseIPv4Literal(hostname: string): readonly [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isIPv6Literal = h.includes(":");
  const ipv4 = parseIPv4Literal(h);

  // Block localhost variants and unspecified address
  if (h === "localhost") return true;

  if (isIPv6Literal) {
    if (h === "::" || h === "::1") return true;
    // IPv6 private ranges: fc00::/7 (fc.. and fd..), link-local fe80::/10.
    if (h.startsWith("fc") || h.startsWith("fd") || /^fe[89ab]/.test(h)) return true;
    if (h.startsWith("ff")) return true;
    if (h.startsWith("2001:db8")) return true;
    // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x).
    if (h.startsWith("::ffff:")) return true;
    return false;
  }

  if (ipv4 !== null) {
    const [first, second] = ipv4;
    // Block loopback, unspecified, RFC1918, link-local, CGNAT, and benchmarking ranges.
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 192 && second === 0) return true;
    if (first === 192 && second === 0 && ipv4[2] === 2) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first === 198 && second === 51 && ipv4[2] === 100) return true;
    if (first === 203 && second === 0 && ipv4[2] === 113) return true;
    if (first >= 224) return true;
  }

  return false;
}

function isBlockedForPreview(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (isTrustedServerUrl(parsed.toString())) {
      return false;
    }
    return isPrivateHost(parsed.hostname);
  } catch {
    return true; // Malformed URLs are blocked
  }
}

// -- OG fetch -----------------------------------------------------------------

const EMPTY_OG: OgMeta = { title: null, description: null, image: null, siteName: null };

/** Fetch OG metadata for a URL using the Tauri native HTTP client (no CORS).
 *  Concurrent requests for the same URL share the same in-flight promise. */
function fetchOgMeta(url: string): Promise<OgMeta> {
  const generation = embedCacheGeneration;
  const cached = ogCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  // Return the existing in-flight promise so all callers get the real result.
  const existing = ogInFlight.get(url);
  if (existing !== undefined) return existing;

  // Block link previews to internal/private hosts to prevent SSRF
  if (isBlockedForPreview(url)) {
    log.debug("fetchOgMeta blocked (private host)", url.slice(0, 100));
    ogCache.set(url, EMPTY_OG);
    return Promise.resolve(EMPTY_OG);
  }

  log.debug("fetchOgMeta START", url.slice(0, 100));
  const promise = (async (): Promise<OgMeta> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const fetchOpts: RequestInit = {
        signal: controller.signal,
        headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
      };
      if (isTrustedServerUrl(url)) {
        (fetchOpts as RequestInit & { danger?: { acceptInvalidCerts: boolean; acceptInvalidHostnames: boolean } }).danger = { acceptInvalidCerts: true, acceptInvalidHostnames: false };
      }
      const res = await tauriFetch(url, fetchOpts);
      clearTimeout(timer);

      if (!res.ok) {
        if (generation !== embedCacheGeneration) {
          return EMPTY_OG;
        }
        ogCache.set(url, EMPTY_OG);
        return EMPTY_OG;
      }

      // Only parse HTML responses (skip binary, JSON, etc.)
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        if (generation !== embedCacheGeneration) {
          return EMPTY_OG;
        }
        ogCache.set(url, EMPTY_OG);
        return EMPTY_OG;
      }

      const html = await res.text();
      // Only parse the first 50KB to avoid parsing huge pages
      const meta = parseOgTags(html.slice(0, 50_000));
      if (generation !== embedCacheGeneration) {
        return EMPTY_OG;
      }
      ogCache.set(url, meta);
      return meta;
    } catch {
      if (generation !== embedCacheGeneration) {
        return EMPTY_OG;
      }
      ogCache.set(url, EMPTY_OG);
      return EMPTY_OG;
    }
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
    if (isSafeUrl(imgSrc) && !isBlockedForPreview(imgSrc)) {
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
        (img).addEventListener("load", () => {
          observeMedia(img, imgSrc, imageWrap);
        }, { once: true });
      }
      imageWrap.appendChild(img);
      imageWrap.style.display = "";
    }
  }
}
