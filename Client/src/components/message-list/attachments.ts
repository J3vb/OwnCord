/**
 * File attachment rendering and image caching (memory + IndexedDB).
 * Also owns the server host state and URL resolution used by other modules.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { observeMedia } from "@lib/media-visibility";
import { loadPref } from "@lib/preferences";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/toast";
import { formatByteSize } from "@lib/connectionStats";
import { ensureHttpProxy } from "@lib/httpProxy";
import { getToken } from "@stores/auth.store";
import { bracketBareIPv6Host } from "@lib/ws";
import { desktop } from "../../platform/desktop";
import type {
  ExternalContentResult,
  ExternalImageSource,
  ExternalPreview,
} from "../../platform/contracts/externalContent";

const log = createLogger("attachments");
import type { Attachment } from "@lib/types";
import { externalAllowed, setExternalConsentScope } from "../../features/content-consent/external";
import { mediaControlsText } from "../../i18n/mediaControls";
import { messageStatusText } from "../../i18n/messageStatus";

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
  setExternalConsentScope(serverHost);
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
// Server content caches: blob: URLs in memory, Blobs in IndexedDB
// ---------------------------------------------------------------------------

function createObjectUrl(blob: Blob): string | null {
  // jsdom (and any non-browser host) may not implement the object-URL API.
  if (typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(blob);
}

function revokeObjectUrl(objectUrl: string): void {
  if (typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(objectUrl);
}

/** blob: URLs by source URL, least recently used first, bounded by the bytes
 *  their Blobs pin (and optionally by count). An evicted URL is revoked; an
 *  image still showing it recovers through `recoverEvictedImage`. One entry
 *  larger than the budget stays until the next arrives. */
class ObjectUrlCache {
  private readonly entries = new Map<string, { objectUrl: string; bytes: number }>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Map order is the recency order: a read moves the entry to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.objectUrl;
  }

  holds(objectUrl: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.objectUrl === objectUrl) return true;
    }
    return false;
  }

  set(key: string, objectUrl: string, bytes: number): void {
    this.drop(key);
    this.entries.set(key, { objectUrl, bytes });
    this.bytes += bytes;
    while (
      this.entries.size > 1 &&
      (this.bytes > this.maxBytes || this.entries.size > this.maxEntries)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  clear(): void {
    for (const key of this.entries.keys()) this.drop(key);
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    revokeObjectUrl(entry.objectUrl);
  }
}

/** What server images may pin in memory as blob: URLs, for instant re-render. */
export const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** What the durable image store may hold, so it persists across restarts
 *  without growing forever. */
export const IMAGE_DB_MAX_BYTES = 256 * 1024 * 1024;
const imageCache = new ObjectUrlCache(IMAGE_CACHE_MAX_BYTES);
/** Server images the server definitely refused (missing, gone, forbidden).
 *  Asking again on every mount only repeated the answer — each one was
 *  fetched twice in the audit's channel-switch run (DP-56). Retry and a cache
 *  clear ask again. */
const missingImages = new Set<string>();
const DEFINITE_FAILURES = new Set([403, 404, 410]);
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
  imageCache.clear();
  missingImages.clear();
  inFlight.clear();
  mediaCache.clear();
  mediaInFlight.clear();
}

/** Safe MIME types allowed as a server Blob's type — blocks script injection via crafted Content-Type. */
// Note: image/svg+xml is intentionally excluded — SVGs can execute JS if
// loaded in <object>, <embed>, or <iframe> contexts. Only raster formats
// are considered safe for blob: URL rendering via <img>.
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

/** Sanitize a Content-Type header value for use as a Blob's type. */
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
  // i18n-exempt: internal guard, logged by the caller, never rendered
  if (!isServerUrl(url)) throw new Error("external URLs are fetched only through the broker");
  const parsed = new URL(url);
  const origin = await ensureHttpProxy(parsed.host);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token !== null) {
    // i18n-exempt: HTTP wire header value, never rendered
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

/** A durable entry: the image, its size, and when it was last read. */
interface StoredImage {
  blob: Blob;
  bytes: number;
  used: number;
}

/** False for an entry written before images were stored as Blobs (a data:
 *  URI string): a read treats it as a miss and the next write drops it. */
function isStoredImage(value: unknown): value is StoredImage {
  const entry = value as Partial<StoredImage> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    entry.blob instanceof Blob &&
    typeof entry.bytes === "number"
  );
}

/** Read a cached image from IndexedDB by its scoped key, marking it read. */
async function idbGet(key: string): Promise<Blob | null> {
  const db = await openCacheDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      closeDbAfterTransaction(tx, db);
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => {
        const entry: unknown = req.result;
        if (!isStoredImage(entry)) {
          resolve(null);
          return;
        }
        store.put({ ...entry, used: Date.now() }, key);
        resolve(entry.blob);
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onerror = () => resolve(null);
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** Write an image to IndexedDB under `scope`, unless the scope moved on
 *  while the database opened — a late write would outlive the prune. The
 *  same transaction then drops the least recently read entries until the
 *  store fits IMAGE_DB_MAX_BYTES, and any pre-Blob entry outright. */
async function idbPut(scope: string, url: string, blob: Blob): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  if (scope !== cacheScope) {
    db.close();
    return;
  }
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    closeDbAfterTransaction(tx, db);
    const store = tx.objectStore(IDB_STORE);
    const entry: StoredImage = { blob, bytes: blob.size, used: Date.now() };
    store.put(entry, idbKey(scope, url));
    const keys = store.getAllKeys();
    const values = store.getAll();
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    values.onsuccess = () => {
      const stored: { key: IDBValidKey; entry: StoredImage }[] = [];
      let total = 0;
      keys.result.forEach((key, i) => {
        const value: unknown = values.result[i];
        if (isStoredImage(value)) {
          stored.push({ key, entry: value });
          total += value.bytes;
        } else {
          store.delete(key);
        }
      });
      for (const { key, entry: old } of stored.toSorted((a, b) => a.entry.used - b.entry.used)) {
        if (total <= IMAGE_DB_MAX_BYTES) break;
        store.delete(key);
        total -= old.bytes;
      }
    };
  } catch {
    db.close();
    // IndexedDB full or unavailable — ignore
  }
}

/** Fetch an image and return a `blob:` URL an `<img>` can show. Server images
 *  come through memory → IndexedDB → the TOFU proxy; an external image comes
 *  from the broker and never enters those two caches, which hold server
 *  content only (B7-16). */
export function fetchImageAsObjectUrl(url: string): Promise<string | null> {
  if (isExternalUrl(url)) return fetchExternalImage({ url });
  const generation = attachmentCacheGeneration;
  const scope = cacheScope;

  // 1. Memory cache (instant), and what the server already refused
  const cached = imageCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  if (missingImages.has(url)) return Promise.resolve(null);

  // 2. Deduplicate concurrent requests for the same URL
  const existing = inFlight.get(url);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<string | null> => {
    // 3. IndexedDB cache (persists across restarts), then the network
    const stored = scope === null ? null : await idbGet(idbKey(scope, url));
    const blob = stored ?? (await fetchImageBlob(url, generation));
    if (blob === null || generation !== attachmentCacheGeneration) return null;
    const objectUrl = createObjectUrl(blob);
    if (objectUrl === null) return null;
    imageCache.set(url, objectUrl, blob.size);
    if (stored === null && scope !== null) void idbPut(scope, url, blob);
    return objectUrl;
  })();

  inFlight.set(url, promise);
  void promise.finally(() => {
    if (inFlight.get(url) === promise) {
      inFlight.delete(url);
    }
  });

  return promise;
}

/** 4. Network fetch through the Rust HTTP TOFU proxy (cert-pinned, same trust
 *  store as the WS proxy). The bytes are only ever shown as an image, never
 *  executed, and their type goes through the allowlist. */
async function fetchImageBlob(url: string, generation: number): Promise<Blob | null> {
  try {
    const res = await fetchServerFile(url);
    if (!res.ok) {
      if (DEFINITE_FAILURES.has(res.status) && generation === attachmentCacheGeneration) {
        missingImages.add(url);
      }
      return null;
    }
    const type = sanitizeContentType(res.headers.get("content-type") ?? "");
    return new Blob([await res.arrayBuffer()], { type });
  } catch (err) {
    log.error("Failed to fetch attachment image", { url, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Media (video/audio) sources
// ---------------------------------------------------------------------------

/** Each entry pins a whole video/audio Blob, so the cap is in bytes as well as
 *  count: an unbounded map here quietly holds every clip played this session. */
const MEDIA_CACHE_MAX = 20;
const MEDIA_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** Resolved blob: URLs keyed by attachment URL, so re-rendering a row (virtual
 *  scroll rebuilds the window constantly) reuses one download. */
const mediaCache = new ObjectUrlCache(MEDIA_CACHE_MAX_BYTES, MEDIA_CACHE_MAX);
/** In-flight media fetches, deduplicated the same way images are. */
const mediaInFlight = new Map<string, Promise<string | null>>();

/**
 * Fetch a video/audio attachment through the same authenticated,
 * cert-pinned path images use (fetchServerFile attaches the session bearer
 * token, which /api/v1/files/{id} requires) and hand back a blob: URL.
 *
 * Deliberately not the image path: that one parks the bytes in IndexedDB too,
 * which is fine for a screenshot and ruinous for a 50 MB video. The Content-Type
 * goes through the same allowlist so a crafted header cannot turn a
 * permission-checked download into an executable type.
 */
export function fetchMediaAsObjectUrl(url: string): Promise<string | null> {
  const generation = attachmentCacheGeneration;

  const cached = mediaCache.get(url);
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
      mediaCache.set(url, objectUrl, buffer.byteLength);
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

/** The broker cache and consent admission key for an image source. */
export function externalKey(source: ExternalImageSource): string {
  return "handle" in source ? `handle:${source.handle}` : `url:${source.url}`;
}

/** A link preview (or oEmbed title) through the broker, refused before any
 *  network work unless the viewer consented to `url` (B9-8). */
export function previewExternal(url: string): Promise<ExternalContentResult<ExternalPreview>> {
  if (!externalAllowed(externalKey({ url }))) {
    return Promise.resolve({ ok: false, failure: "unavailable" });
  }
  return desktop.externalContent.preview(externalPartition(), url);
}

/** Whether a URL from `fetchExternalImage` holds a GIF. */
export function isExternalGif(objectUrl: string): boolean {
  return externalGifUrls.has(objectUrl);
}

/** Whether a blob: URL is one an image cache still holds (not revoked). */
function isLiveImageUrl(objectUrl: string): boolean {
  return imageCache.holds(objectUrl) || [...externalObjectUrls.values()].includes(objectUrl);
}

/** Load `source` again the way it first came: a server image through its own
 *  caches and the TOFU proxy, anything else through the broker. */
function reloadImage(source: ExternalImageSource): Promise<ExternalContentResult<string>> {
  if (!("url" in source) || !isServerUrl(source.url)) return loadExternalImage(source);
  return fetchImageAsObjectUrl(source.url).then((value): ExternalContentResult<string> =>
    value === null ? { ok: false, failure: "unavailable" } : { ok: true, value },
  );
}

/** Re-request `img`'s image when the blob: URL it shows was revoked — by a
 *  cache's eviction or a clear — and a GIF unfreeze or a lazy load after
 *  scrolling back reloads the stale URL. Register it before any other
 *  error listener: a recovered load stops the error from reaching them. */
export function recoverEvictedImage(
  img: HTMLImageElement,
  source: ExternalImageSource,
  onExpired?: () => void,
): void {
  const recover = (event: Event): void => {
    if (!img.src.startsWith("blob:") || isLiveImageUrl(img.src)) return;
    event.stopImmediatePropagation();
    void reloadImage(source).then((result) => {
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
  const key = externalKey(source);
  // B9-8: nothing is fetched for an item the viewer has not consented to.
  if (!externalAllowed(key)) return Promise.resolve({ ok: false, failure: "unavailable" });
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

// -- Failure + retry ----------------------------------------------------------

/** The typed failure line shared by the embed, image and picker renderers
 *  (B9-9): a status message plus a bounded, explicitly labelled retry. The
 *  caller owns what retry does, so a retry always rechecks the current consent
 *  and partition rather than replaying a stale answer. */
export function renderFailureStatus(
  message: string,
  retryLabel: string,
  onRetry: () => void,
): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-media-fallback" });
  const status = createElement("span", { class: "msg-media-fallback-text", role: "status" });
  setText(status, message);
  const retry = createElement("button", {
    class: "messages-retry-btn msg-media-retry",
    type: "button",
    "aria-label": retryLabel,
  });
  setText(retry, retryLabel);
  retry.addEventListener("click", onRetry);
  appendChildren(wrap, status, retry);
  return wrap;
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
    title: messageStatusText("file.download"),
    "aria-label": messageStatusText("file.downloadNamed", { filename: att.filename }),
  });
  btn.appendChild(createIcon("download", 16));
  btn.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  return btn;
}

/** The play button that stands in for a player until the viewer asks for the
 *  clip, so a row that only scrolls past downloads nothing (DP-16; the whole
 *  file on the first play, D2 (a)). Native controls are inert without a
 *  source, so they arrive with it. A failed download keeps the button:
 *  pressing it again retries. */
function buildPlayButton(
  att: Attachment,
  resolvedUrl: string,
  wrap: HTMLElement,
  player: HTMLMediaElement,
): HTMLButtonElement {
  const btn = createElement("button", {
    class: "msg-media-play",
    type: "button",
    "aria-label": messageStatusText("file.playNamed", { filename: att.filename }),
  });
  btn.appendChild(createIcon("play", 20));
  btn.addEventListener("click", () => {
    btn.disabled = true;
    void fetchMediaAsObjectUrl(resolvedUrl).then((objectUrl) => {
      if (objectUrl === null) {
        // The download chip stays; the player is dimmed, never shown as loading.
        wrap.classList.add("msg-media-failed");
        btn.disabled = false;
        return;
      }
      wrap.classList.remove("msg-media-failed");
      btn.remove();
      player.hidden = false;
      player.controls = true;
      player.src = objectUrl;
      void player.play().catch((err: unknown) => {
        // Playback refused (an autoplay policy): the controls are there to press.
        log.debug("Media playback refused", { error: String(err) });
      });
    });
  });
  return btn;
}

/** Inline <video> player. Sized by the same .msg-image box as images so a
 *  video never blows the message column out; the source arrives on play
 *  because it needs the session token attached. */
function renderVideoAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-image msg-video" });

  const video = createElement("video", { preload: "metadata" });
  video.setAttribute("aria-label", att.filename);
  appendChildren(wrap, video, buildPlayButton(att, resolvedUrl, wrap, video));

  const overlay = createElement("div", { class: "msg-media-overlay" });
  overlay.appendChild(buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(overlay);

  return wrap;
}

/** Inline <audio> player: a compact row carrying the player plus the same
 *  filename / size / download affordances as the file chip. */
function renderAudioAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-file msg-audio" });
  const inner = createElement("div", { class: "msg-file-inner" });

  const info = buildFileMeta(att, resolvedUrl);
  const audio = createElement("audio", { preload: "metadata" });
  audio.hidden = true;
  audio.setAttribute("aria-label", att.filename);
  appendChildren(info, buildPlayButton(att, resolvedUrl, wrap, audio), audio);

  appendChildren(inner, info, buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(inner);

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

    const buildImage = (objectUrl: string): HTMLImageElement => {
      const img = createElement("img", {
        src: objectUrl,
        alt: att.filename,
      });
      recoverEvictedImage(img, { url: resolvedUrl });
      attachLightbox(img);
      img.addEventListener(
        "load",
        () => {
          clearReservation();
          if (isGif) observeMedia(img, objectUrl, wrap, !animateGifsPref);
        },
        { once: true },
      );
      return img;
    };

    // Check cache first for instant render
    const cached = imageCache.get(resolvedUrl);
    if (cached !== undefined) {
      wrap.appendChild(buildImage(cached));
    } else {
      // Show loading placeholder, then replace with image. On failure the
      // placeholder becomes a typed failure line with a bounded retry, like the
      // external-media path — a silently un-"loading" filename box reads as
      // still-loading forever (F14).
      const placeholder = createElement("div", { class: "placeholder-img loading" }, att.filename);
      wrap.appendChild(placeholder);
      let current: Element = placeholder;

      const attempt = (): void => {
        void fetchImageAsObjectUrl(resolvedUrl).then((objectUrl) => {
          if (objectUrl !== null) {
            const img = buildImage(objectUrl);
            current.replaceWith(img);
            current = img;
          } else {
            const failure = renderFailureStatus(
              messageStatusText("file.imageFailed"),
              messageStatusText("file.retry"),
              () => {
                // Retry asks the server again, even after a definite refusal.
                missingImages.delete(resolvedUrl);
                attempt();
              },
            );
            current.replaceWith(failure);
            current = failure;
          }
        });
      };
      attempt();
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
      showToast(messageStatusText("file.downloadHttpFailed", { status: res.status }), "error");
      return;
    }

    const buffer = await res.arrayBuffer();
    await desktop.fileSaver.writeFile(filePath, new Uint8Array(buffer));
  } catch (err) {
    log.error("Download failed", { filename, error: String(err) });
    showToast(messageStatusText("file.downloadFailed", { filename }), "error");
  }
}

// -- Lightbox -----------------------------------------------------------------

// Store the cleanup function for the active lightbox so rapid reopens
// properly remove document-level listeners from the previous instance.
let activeLightboxClose: (() => void) | null = null;

/** Close the active lightbox, if any. Called on page teardown (logout, page
 *  swap) so an open overlay doesn't survive onto the next page with live
 *  document listeners and a revoked blob URL. */
export function closeActiveLightbox(): void {
  activeLightboxClose?.();
}

/** Open a full-screen lightbox overlay with zoom and pan. */
export function openImageLightbox(src: string, alt: string, external?: ExternalImageSource): void {
  // Close any existing lightbox (including its document listeners)
  if (activeLightboxClose !== null) {
    activeLightboxClose();
    activeLightboxClose = null;
  }

  // Focus moves into the lightbox on open and back to the opener on close
  // (B9-9); captured before the overlay takes focus.
  const opener = document.activeElement;
  const overlay = createElement("div", { class: "image-lightbox" });
  // A modal surface: named so a screen reader announces it, and tabbable
  // itself so the Tab cycle never escapes to the page behind it.
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", alt);
  overlay.tabIndex = -1;

  const imgWrap = createElement("div", { class: "image-lightbox-wrap" });
  const img = createElement("img", { src, alt });
  if (external !== undefined) recoverEvictedImage(img, external);
  imgWrap.appendChild(img);
  overlay.appendChild(imgWrap);

  const closeBtn = createElement("button", {
    class: "image-lightbox-close",
    "aria-label": mediaControlsText("lightbox.close"),
  });
  closeBtn.appendChild(createIcon("x", 20));
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
    disposable.destroy();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    if (activeLightboxClose === close) activeLightboxClose = null;
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

  // Use a Disposable for cleanup of document-level listeners to prevent leaks
  const disposable = new Disposable();
  document.addEventListener("mousemove", onMove, { signal: disposable.signal });
  document.addEventListener("mouseup", onUp, { signal: disposable.signal });

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      // Contain focus in the dialog: its close button is the only Tab stop.
      e.preventDefault();
      closeBtn.focus();
    }
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
  document.addEventListener("keydown", onKey, { signal: disposable.signal });

  activeLightboxClose = close;
  document.body.appendChild(overlay);
  // The close button is the one Tab stop, so the lightbox holds a single
  // focusable control whose Escape/Tab behaviour never leaks behind it.
  closeBtn.focus();
}
