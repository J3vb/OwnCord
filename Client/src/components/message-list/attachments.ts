/**
 * File attachment rendering and image caching (memory + IndexedDB).
 * Also owns the server host state and URL resolution used by other modules.
 */

import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { observeMedia } from "@lib/media-visibility";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { formatByteSize } from "@lib/connectionStats";
import { ensureHttpProxy } from "@lib/httpProxy";
import { getToken } from "@stores/auth.store";
import { bracketBareIPv6Host } from "@lib/ws";
import { desktop } from "../../platform/desktop";
import type {
  ExternalContentResult,
  ExternalImageSource,
} from "../../platform/contracts/externalContent";

const log = createLogger("attachments");
import type { Attachment } from "@lib/types";
import { openImageLightbox } from "./media";

/** Cached value of the animateGifs preference. Invalidated on pref change
 *  (same pattern as roleColors in formatting.ts). */
let animateGifsPref = loadPref<boolean>("animateGifs", true);
window.addEventListener("owncord:pref-change", ((e: CustomEvent<{ key: string }>) => {
  if (e.detail.key === "animateGifs") {
    animateGifsPref = loadPref<boolean>("animateGifs", true);
  }
}) as EventListener);

// -- Server host state --------------------------------------------------------

/** Module-level server host for resolving relative attachment URLs. */
let serverHost: string | null = null;

/** Set the server host (called once from MainPage on connect).
 *  Strips a trailing default-HTTPS ":443" and lowercases, mirroring
 *  normalizeHostForCertCompare in lib/ws.ts and cert_store_key in
 *  src-tauri/src/tofu.rs — config hosts are stored verbatim (e.g.
 *  "Example.COM:443") but WHATWG URL drops the default port for https:,
 *  so isServerUrl's host comparison must normalize the same way or a
 *  ":443"-suffixed host never matches its own resolved URLs.
 *
 *  Only strip the trailing ":443" when what's left is unambiguously a host
 *  (no remaining colon) or a bracketed IPv6 literal (ends in "]", as in
 *  "[::1]:443") — otherwise a bare IPv6 literal whose final hextet is "443"
 *  (e.g. "fd00::443") would have that hextet eaten as if it were a port,
 *  same guard as tofu.rs::cert_store_key (OC-0215).
 *
 *  A bare (unbracketed) IPv6 literal is then wrapped in brackets so it forms
 *  a parseable authority: resolveServerUrl interpolates serverHost directly
 *  into a URL, and WHATWG's URL.host is always the bracketed form for IPv6,
 *  so isServerUrl's comparison also needs the bracketed form to ever match
 *  (OC-0241). */
export function setServerHost(host: string): void {
  const withoutPort =
    host.endsWith(":443") && (!host.slice(0, -4).includes(":") || host.slice(0, -4).endsWith("]"))
      ? host.slice(0, -4)
      : host;
  serverHost = bracketBareIPv6Host(withoutPort).toLowerCase();
}

/** Resolve a potentially relative URL to a full URL using the server host. */
export function resolveServerUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (serverHost !== null) {
    return `https://${serverHost}${url}`;
  }
  return url;
}

// -- Helpers ------------------------------------------------------------------

export function formatFileSize(bytes: number): string {
  return formatByteSize(bytes, 1024, "KB", 1);
}

/** Strip any `; codecs=…` parameters and normalise case before matching. */
function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether the attachment should render as an inline <img>.
 *  image/svg+xml is excluded: an SVG can carry script, and it is the one image
 *  type the data-URI allowlist already refuses — inlining it only ever produced
 *  a permanently-loading placeholder, so it belongs on the download chip. */
export function isImageMime(mime: string): boolean {
  const base = baseMime(mime);
  return base.startsWith("image/") && base !== "image/svg+xml";
}

/** Container MIME types we are willing to hand to a <video> element.
 *  An allowlist, not a `video/` prefix test: an unknown container gets the
 *  download chip rather than a player that silently fails to decode. */
const INLINE_VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/ogg"]);

/** Container MIME types we are willing to hand to an <audio> element.
 *  Includes the common aliases servers emit for MP3 and WAV. */
const INLINE_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
]);

/** Whether the attachment should render as an inline <video> player.
 *  image/svg+xml can never reach here — SVG stays excluded from every inline
 *  path because it can carry script. */
export function isVideoMime(mime: string): boolean {
  return INLINE_VIDEO_MIMES.has(baseMime(mime));
}

/** Whether the attachment should render as an inline <audio> player. */
export function isAudioMime(mime: string): boolean {
  return INLINE_AUDIO_MIMES.has(baseMime(mime));
}

export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image cache: memory + IndexedDB for persistence across restarts
// ---------------------------------------------------------------------------

/** In-memory cache for instant re-render (LRU eviction at CACHE_MAX). */
const memoryCache = new Map<string, string>();
const CACHE_MAX = 200;
let attachmentCacheGeneration = 0;

/** `host#userId` of the account whose server content these caches hold
 *  (B7-13). null while signed out: the durable store is neither read nor
 *  written, so nothing crosses from one profile or account to the next. */
let cacheScope: string | null = null;

/**
 * Point the server-content caches at the signed-in account. A change drops
 * the in-memory caches and prunes every durable entry outside the new scope,
 * so a switch leaves no previous server's or account's bytes on disk while
 * the same account keeps its entries across restarts.
 */
export function setAttachmentCacheScope(scope: string | null): void {
  if (scope === cacheScope) return;
  cacheScope = scope;
  clearAttachmentCaches();
  if (scope !== null) void idbPrune(scope, true);
}

/**
 * Delete every durable entry of `scope` — a self-deleted account's images
 * (B7-15c). Call it after auth has cleared, so the scope is no longer armed
 * and no late write can land behind the prune.
 */
export function pruneAttachmentCacheScope(scope: string): Promise<void> {
  return idbPrune(scope, false);
}

/** Durable-store key: the scope, then the URL. */
function idbKey(scope: string, url: string): string {
  return `${scope}|${url}`;
}

export function clearAttachmentCaches(): void {
  attachmentCacheGeneration += 1;
  memoryCache.clear();
  inFlight.clear();
  for (const objectUrl of mediaObjectUrls.values()) {
    revokeObjectUrl(objectUrl);
  }
  mediaObjectUrls.clear();
  mediaInFlight.clear();
}

/** Safe MIME types allowed in data: URIs — blocks script injection via crafted Content-Type. */
// Note: image/svg+xml is intentionally excluded — SVGs can execute JS if
// loaded in <object>, <embed>, or <iframe> contexts. Only raster formats
// are considered safe for data: URI rendering via <img>.
const SAFE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
]);

/** Sanitize a Content-Type header value for use in a data: URI. */
function sanitizeContentType(raw: string): string {
  const mime = raw.split(";")[0]?.trim() ?? "";
  return SAFE_MIME_TYPES.has(mime) ? raw : "application/octet-stream";
}

/** Check if a URL points to the configured OwnCord server. */
function isServerUrl(url: string): boolean {
  if (serverHost === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.host === serverHost;
  } catch {
    return false;
  }
}

/** An absolute http(s) URL on some host other than the configured server —
 *  content the external-content broker, not the TOFU proxy, fetches. */
function isExternalUrl(url: string): boolean {
  if (isServerUrl(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Report whether a URL targets the configured OwnCord server host. */
export function isTrustedServerUrl(url: string): boolean {
  return isServerUrl(url);
}

/**
 * Fetch a file from the OwnCord server through the Rust HTTP TOFU proxy's
 * loopback origin (cert-pinned) with the session bearer token attached —
 * /api/v1/files/{id} enforces channel ACLs, so an unauthenticated request
 * would 401. The token is only ever sent to the configured server host.
 *
 * Server URLs only. An external URL is never fetched directly (B7-16): images
 * go through the external-content broker (`fetchExternalImage`), and anything
 * else is refused here rather than handed to a general-purpose client.
 */
async function fetchServerFile(url: string): Promise<Response> {
  if (!isServerUrl(url)) throw new Error("external URLs are fetched only through the broker");
  const parsed = new URL(url);
  const origin = await ensureHttpProxy(parsed.host);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return desktop.http.fetch(`${origin}${parsed.pathname}${parsed.search}`, { headers });
}

/** In-flight fetch promises to prevent duplicate concurrent requests. */
const inFlight = new Map<string, Promise<string | null>>();

/** IndexedDB database name and store. */
const IDB_NAME = "owncord-image-cache";
const IDB_STORE = "images";
const IDB_VERSION = 1;

/** Open (or create) the IndexedDB database. */
export function openCacheDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => resolve(req.result);
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function closeDbAfterTransaction(tx: IDBTransaction, db: IDBDatabase): void {
  const close = (): void => db.close();
  // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
  tx.oncomplete = close;
  // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
  tx.onabort = close;
  // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
  tx.onerror = close;
}

/** Delete every durable entry outside `scope` (including pre-B7-13 keys) when
 *  `keep` is true, or every entry inside it when false. */
async function idbPrune(scope: string, keep: boolean): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    closeDbAfterTransaction(tx, db);
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAllKeys();
    const prefix = idbKey(scope, "");
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    req.onsuccess = () => {
      for (const key of req.result) {
        const inside = typeof key === "string" && key.startsWith(prefix);
        if (inside !== keep) store.delete(key);
      }
    };
  } catch {
    db.close();
  }
}

/** Read a cached data URL from IndexedDB by its scoped key. */
async function idbGet(key: string): Promise<string | null> {
  const db = await openCacheDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      closeDbAfterTransaction(tx, db);
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onerror = () => resolve(null);
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** Write a data URL to IndexedDB under `scope`, unless the scope moved on
 *  while the database opened — a late write would outlive the prune. */
async function idbPut(scope: string, url: string, dataUrl: string): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  if (scope !== cacheScope) {
    db.close();
    return;
  }
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    closeDbAfterTransaction(tx, db);
    tx.objectStore(IDB_STORE).put(dataUrl, idbKey(scope, url));
  } catch {
    db.close();
    // IndexedDB full or unavailable — ignore
  }
}

/** Convert a Uint8Array to a base64 string. */
export function uint8ToBase64(bytes: Uint8Array): string {
  // Process in chunks to avoid call stack overflow on large files
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** Fetch an image and return a URL an `<img>` can show. Server images come
 *  back as a data: URI through memory → IndexedDB → the TOFU proxy; an
 *  external image comes back as a `blob:` URL from the broker and never
 *  enters those two caches, which hold server content only (B7-16). */
export function fetchImageAsDataUrl(url: string): Promise<string | null> {
  if (isExternalUrl(url)) return fetchExternalImage({ url });
  const generation = attachmentCacheGeneration;
  const scope = cacheScope;

  // 1. Memory cache (instant)
  const cached = memoryCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  // 2. Deduplicate concurrent requests for the same URL
  const existing = inFlight.get(url);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<string | null> => {
    // 3. IndexedDB cache (persists across restarts)
    const idbCached = scope === null ? null : await idbGet(idbKey(scope, url));
    if (idbCached !== null) {
      if (generation !== attachmentCacheGeneration) return null;
      if (memoryCache.size >= CACHE_MAX) {
        const firstKey = memoryCache.keys().next().value;
        if (firstKey !== undefined) memoryCache.delete(firstKey);
      }
      memoryCache.set(url, idbCached);
      return idbCached;
    }

    // 4. Network fetch through the Rust HTTP TOFU proxy (cert-pinned, same
    // trust store as the WS proxy). Responses are only used as image data,
    // never executed.
    try {
      const res = await fetchServerFile(url);
      if (!res.ok) return null;

      const rawCt = res.headers.get("content-type") ?? "";
      const contentType = sanitizeContentType(rawCt);
      const buffer = await res.arrayBuffer();
      const base64 = uint8ToBase64(new Uint8Array(buffer));
      const dataUrl = `data:${contentType};base64,${base64}`;

      if (generation !== attachmentCacheGeneration) {
        return null;
      }

      // Store in both caches (LRU eviction)
      if (memoryCache.size >= CACHE_MAX) {
        const firstKey = memoryCache.keys().next().value;
        if (firstKey !== undefined) memoryCache.delete(firstKey);
      }
      memoryCache.set(url, dataUrl);
      if (scope !== null) void idbPut(scope, url, dataUrl);

      return dataUrl;
    } catch (err) {
      log.error("Failed to fetch attachment image", { url, error: String(err) });
      return null;
    }
  })();

  inFlight.set(url, promise);
  void promise.finally(() => {
    if (inFlight.get(url) === promise) {
      inFlight.delete(url);
    }
  });

  return promise;
}

// ---------------------------------------------------------------------------
// Media (video/audio) sources
// ---------------------------------------------------------------------------

/** Resolved blob: URLs keyed by attachment URL, so re-rendering a row (virtual
 *  scroll rebuilds the window constantly) reuses one download. */
const mediaObjectUrls = new Map<string, string>();
/** In-flight media fetches, deduplicated the same way images are. */
const mediaInFlight = new Map<string, Promise<string | null>>();
/** FIFO cap mirroring memoryCache's CACHE_MAX, kept far lower: each entry
 *  pins a whole video/audio Blob (not a small base64 thumbnail string), so an
 *  unbounded map here quietly holds every clip ever viewed in the session. */
const MEDIA_CACHE_MAX = 20;

function createObjectUrl(blob: Blob): string | null {
  // jsdom (and any non-browser host) may not implement the object-URL API.
  if (typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(blob);
}

function revokeObjectUrl(objectUrl: string): void {
  if (typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(objectUrl);
}

/**
 * Fetch a video/audio attachment through the same authenticated,
 * cert-pinned path images use (fetchServerFile attaches the session bearer
 * token, which /api/v1/files/{id} requires) and hand back a blob: URL.
 *
 * Deliberately not the image path: a data: URI means base64-inflating the whole
 * file into a string and parking it in the LRU + IndexedDB caches, which is
 * fine for a 200 KB thumbnail and ruinous for a 50 MB video. The Content-Type
 * goes through the same allowlist so a crafted header cannot turn a
 * permission-checked download into an executable type.
 */
export function fetchMediaAsObjectUrl(url: string): Promise<string | null> {
  const generation = attachmentCacheGeneration;

  const cached = mediaObjectUrls.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = mediaInFlight.get(url);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<string | null> => {
    try {
      const res = await fetchServerFile(url);
      if (!res.ok) return null;
      const contentType = sanitizeContentType(res.headers.get("content-type") ?? "");
      const buffer = await res.arrayBuffer();
      const objectUrl = createObjectUrl(new Blob([buffer], { type: contentType }));
      if (objectUrl === null) return null;
      // A cache clear (channel switch, logout) during the fetch means this
      // blob belongs to a session that is gone — release it rather than
      // resurrecting it into the fresh cache.
      if (generation !== attachmentCacheGeneration) {
        revokeObjectUrl(objectUrl);
        return null;
      }
      if (mediaObjectUrls.size >= MEDIA_CACHE_MAX) {
        const firstKey = mediaObjectUrls.keys().next().value;
        if (firstKey !== undefined) {
          const evicted = mediaObjectUrls.get(firstKey);
          mediaObjectUrls.delete(firstKey);
          if (evicted !== undefined) revokeObjectUrl(evicted);
        }
      }
      mediaObjectUrls.set(url, objectUrl);
      return objectUrl;
    } catch (err) {
      log.error("Failed to fetch media attachment", { url, error: String(err) });
      return null;
    }
  })();

  mediaInFlight.set(url, promise);
  void promise.finally(() => {
    if (mediaInFlight.get(url) === promise) {
      mediaInFlight.delete(url);
    }
  });

  return promise;
}

// ---------------------------------------------------------------------------
// External images (B7-16): the broker's bytes as blob: URLs
// ---------------------------------------------------------------------------

/** Bumped by `clearExternalImageCache`. The broker partition names the server
 *  and this epoch, so after a teardown every request lands in a fresh
 *  partition and the native cache drops the previous one. */
let externalEpoch = 0;

/** The broker cache partition for content shown on the current server. */
export function externalPartition(): string {
  return `${serverHost ?? ""}#${externalEpoch}`;
}

/** blob: URLs for broker-fetched images, keyed by handle or URL. */
const externalObjectUrls = new Map<string, string>();
/** The subset of those URLs whose bytes are a GIF — the ones that get the
 *  freeze/play control. */
const externalGifUrls = new Set<string>();
const externalInFlight = new Map<string, Promise<ExternalContentResult<string>>>();
/** FIFO cap: these copies live in the webview, outside the broker's byte
 *  budget, so nothing else bounds them. Mirrors MEDIA_CACHE_MAX; higher
 *  because an image is far smaller than a clip. */
export const EXTERNAL_IMAGE_CACHE_MAX = 100;

/** Drop every broker-fetched image and move to a fresh broker partition.
 *  Called on page teardown and from the manual "clear cache" action. */
export function clearExternalImageCache(): void {
  externalEpoch += 1;
  // Name the fresh partition now rather than at the next preview: the broker
  // drops a partition's cache the moment another one is named, and an empty
  // URL is refused before any network work, so this costs one IPC call.
  void desktop.externalContent?.preview(externalPartition(), "");
  for (const objectUrl of externalObjectUrls.values()) {
    revokeObjectUrl(objectUrl);
  }
  externalObjectUrls.clear();
  externalGifUrls.clear();
  externalInFlight.clear();
}

/** Whether a URL from `fetchExternalImage` holds a GIF. */
export function isExternalGif(objectUrl: string): boolean {
  return externalGifUrls.has(objectUrl);
}

/** Re-request `img`'s image through the broker when the blob: URL it shows
 *  was revoked — by the FIFO cap or a cache clear — and a GIF unfreeze or a
 *  lazy load after scrolling back reloads the stale URL. Register it before any other
 *  error listener: a recovered load stops the error from reaching them. */
export function recoverEvictedImage(
  img: HTMLImageElement,
  source: ExternalImageSource,
  onExpired?: () => void,
): void {
  const recover = (event: Event): void => {
    if (!img.src.startsWith("blob:") || [...externalObjectUrls.values()].includes(img.src)) {
      return;
    }
    event.stopImmediatePropagation();
    void loadExternalImage(source).then((result) => {
      if (result.ok) {
        img.src = result.value;
        return;
      }
      img.removeEventListener("error", recover);
      if (result.failure === "expired-handle" && onExpired !== undefined) {
        onExpired();
        return;
      }
      img.dispatchEvent(new Event("error"));
    });
  };
  img.addEventListener("error", recover);
}

/** An external image, fetched by the broker and handed back as a same-origin
 *  `blob:` URL (so the GIF-freeze canvas stays untainted), or null when the
 *  broker refused it or could not fetch it. */
export function fetchExternalImage(source: ExternalImageSource): Promise<string | null> {
  return loadExternalImage(source).then((result) => (result.ok ? result.value : null));
}

/** `fetchExternalImage`, keeping the broker's failure class. */
export function loadExternalImage(
  source: ExternalImageSource,
): Promise<ExternalContentResult<string>> {
  const key = "handle" in source ? `handle:${source.handle}` : `url:${source.url}`;
  const cached = externalObjectUrls.get(key);
  if (cached !== undefined) return Promise.resolve({ ok: true, value: cached });
  const existing = externalInFlight.get(key);
  if (existing !== undefined) return existing;

  const epoch = externalEpoch;
  const promise = (async (): Promise<ExternalContentResult<string>> => {
    const result = await desktop.externalContent.image(externalPartition(), source);
    if (!result.ok) {
      log.debug("External image refused", { failure: result.failure });
      return result;
    }
    const objectUrl = createObjectUrl(result.value);
    if (objectUrl === null) return { ok: false, failure: "unavailable" };
    if (epoch !== externalEpoch) {
      revokeObjectUrl(objectUrl);
      return { ok: false, failure: "unavailable" };
    }
    if (externalObjectUrls.size >= EXTERNAL_IMAGE_CACHE_MAX) {
      const firstKey = externalObjectUrls.keys().next().value;
      if (firstKey !== undefined) {
        const evicted = externalObjectUrls.get(firstKey);
        externalObjectUrls.delete(firstKey);
        if (evicted !== undefined) {
          externalGifUrls.delete(evicted);
          revokeObjectUrl(evicted);
        }
      }
    }
    externalObjectUrls.set(key, objectUrl);
    if (result.value.type === "image/gif") externalGifUrls.add(objectUrl);
    return { ok: true, value: objectUrl };
  })();

  externalInFlight.set(key, promise);
  void promise.finally(() => {
    if (externalInFlight.get(key) === promise) externalInFlight.delete(key);
  });
  return promise;
}

// -- Attachment rendering -----------------------------------------------------

/** The filename + size + download row shared by the audio player and the
 *  generic file chip. */
function buildFileMeta(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const info = createElement("div", { class: "msg-file-meta" });
  const nameEl = createElement("div", { class: "msg-file-name" }, att.filename);
  nameEl.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  const sizeEl = createElement("div", { class: "msg-file-size" }, formatFileSize(att.size));
  appendChildren(info, nameEl, sizeEl);
  return info;
}

/** The circular download button used by every non-image attachment shape. */
function buildDownloadButton(att: Attachment, resolvedUrl: string): HTMLButtonElement {
  const btn = createElement("button", {
    class: "msg-file-download",
    title: "Download",
    "aria-label": `Download ${att.filename}`,
  });
  btn.appendChild(createIcon("download", 16));
  btn.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  return btn;
}

/** Inline <video> player. Sized by the same .msg-image box as images so a
 *  video never blows the message column out; the source arrives asynchronously
 *  because it needs the session token attached. */
function renderVideoAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-image msg-video" });

  const video = createElement("video", { preload: "metadata" });
  video.controls = true;
  video.setAttribute("aria-label", att.filename);
  wrap.appendChild(video);

  const overlay = createElement("div", { class: "msg-media-overlay" });
  overlay.appendChild(buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(overlay);

  void fetchMediaAsObjectUrl(resolvedUrl).then((objectUrl) => {
    if (objectUrl !== null) {
      video.src = objectUrl;
    } else {
      wrap.classList.add("msg-media-failed");
    }
  });

  return wrap;
}

/** Inline <audio> player: a compact row carrying the player plus the same
 *  filename / size / download affordances as the file chip. */
function renderAudioAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-file msg-audio" });
  const inner = createElement("div", { class: "msg-file-inner" });

  const info = buildFileMeta(att, resolvedUrl);
  const audio = createElement("audio", { preload: "metadata" });
  audio.controls = true;
  audio.setAttribute("aria-label", att.filename);
  info.appendChild(audio);

  appendChildren(inner, info, buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(inner);

  void fetchMediaAsObjectUrl(resolvedUrl).then((objectUrl) => {
    if (objectUrl !== null) {
      audio.src = objectUrl;
    } else {
      wrap.classList.add("msg-media-failed");
    }
  });

  return wrap;
}

export function renderAttachment(att: Attachment): HTMLDivElement {
  const resolvedUrl = resolveServerUrl(att.url);
  const inlineable = isSafeUrl(resolvedUrl);
  if (inlineable && isVideoMime(att.mime)) {
    return renderVideoAttachment(att, resolvedUrl);
  }
  if (inlineable && isAudioMime(att.mime)) {
    return renderAudioAttachment(att, resolvedUrl);
  }
  if (isImageMime(att.mime) && inlineable) {
    const wrap = createElement("div", { class: "msg-image" });

    // Reserve space using server-provided dimensions to prevent layout shift.
    if (att.width != null && att.height != null && att.width > 0 && att.height > 0) {
      const maxW = 400,
        maxH = 350;
      const scale = Math.min(1, maxW / att.width, maxH / att.height);
      const w = Math.round(att.width * scale);
      const h = Math.round(att.height * scale);
      wrap.style.width = `${w}px`;
      wrap.style.height = `${h}px`;
    } else {
      // Fallback for old attachments without dimensions — use placeholder height.
      wrap.style.minHeight = "200px";
    }

    function attachLightbox(img: HTMLImageElement): void {
      img.addEventListener("click", () => {
        openImageLightbox(img.src, att.filename, { url: resolvedUrl });
      });
    }

    const isGif = att.mime === "image/gif";

    // Clear min-height reservation and cache the natural height so virtual
    // scroll rebuilds don't oscillate between estimated and actual heights.
    // Measure synchronously to avoid rAF race with ResizeObserver.
    const clearReservation = (): void => {
      wrap.style.minHeight = "";
      const h = wrap.offsetHeight;
      if (h > 0 && att.width == null) {
        // Only cache for fallback path (no server-provided dimensions).
        // Set min-height to prevent oscillation on virtual scroll rebuild.
        wrap.style.minHeight = `${h}px`;
      }
    };

    // Check cache first for instant render
    const cached = memoryCache.get(resolvedUrl);
    if (cached !== undefined) {
      const img = createElement("img", {
        src: cached,
        alt: att.filename,
      });
      attachLightbox(img);
      img.addEventListener(
        "load",
        () => {
          clearReservation();
          if (isGif) observeMedia(img, cached, wrap, !animateGifsPref);
        },
        { once: true },
      );
      wrap.appendChild(img);
    } else {
      // Show loading placeholder, then replace with image
      const placeholder = createElement("div", { class: "placeholder-img loading" }, att.filename);
      wrap.appendChild(placeholder);

      void fetchImageAsDataUrl(resolvedUrl).then((dataUrl) => {
        if (dataUrl !== null) {
          const img = createElement("img", {
            src: dataUrl,
            alt: att.filename,
          });
          recoverEvictedImage(img, { url: resolvedUrl });
          attachLightbox(img);
          img.addEventListener(
            "load",
            () => {
              clearReservation();
              if (isGif) observeMedia(img, dataUrl, wrap, !animateGifsPref);
            },
            { once: true },
          );
          placeholder.replaceWith(img);
        } else {
          placeholder.classList.remove("loading");
        }
      });
    }

    return wrap;
  }
  const wrap = createElement("div", { class: "msg-file" });
  const inner = createElement("div", { class: "msg-file-inner" });
  const icon = createElement("div", { class: "msg-file-icon" });
  icon.appendChild(createIcon("file-text", 20));
  appendChildren(
    inner,
    icon,
    buildFileMeta(att, resolvedUrl),
    buildDownloadButton(att, resolvedUrl),
  );
  wrap.appendChild(inner);
  return wrap;
}

/** Download a file via Tauri HTTP plugin and save to disk with native dialog.
 *  NOTE: This requires fs:allow-write-file with path "**" in capabilities because
 *  the user chooses the save location via the native OS dialog — the destination is
 *  not under our control. The dialog itself is the security boundary. */
async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    // Show native save dialog with suggested filename
    const filePath = await desktop.fileSaver.pickSaveLocation(filename);
    if (filePath === null) return; // User cancelled

    // Fetch file data — server downloads go through the cert-pinned HTTP proxy
    // with the session bearer token (the files endpoint requires auth).
    const res = await fetchServerFile(url);
    if (!res.ok) {
      log.error("Download failed", { filename, status: res.status });
      alert(`Download failed: server returned ${res.status}`);
      return;
    }

    const buffer = await res.arrayBuffer();
    await desktop.fileSaver.writeFile(filePath, new Uint8Array(buffer));
  } catch (err) {
    log.error("Download failed", { filename, error: String(err) });
    alert(`Download failed for ${filename} — check logs for details`);
  }
}
