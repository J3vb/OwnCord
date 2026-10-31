/**
 * Server and external image caching (memory + IndexedDB), media and file
 * links, and the external-content broker for images.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { ensureHttpProxy } from "@lib/net/httpProxy";
import { authStore, getToken } from "@stores/auth.store";
import { desktop } from "../../platform/desktop";
import type {
  ExternalContentResult,
  ExternalImageSource,
  ExternalPreview,
} from "../../platform/contracts/externalContent";
import { externalAllowed } from "../../features/content-consent/external";
import { clearStillCache } from "../../features/messaging/emojiStill";
import { clearAnimatedStills } from "@lib/ui/animatedStill";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { sniffImageBlob } from "@lib/ui/imageHeader";
import { rememberBlobSize } from "./imageSizes";
import { clearTextPreviewCache } from "../../features/messaging/textPreview";
import { isConvertedImageMime, log, serverHost } from "./attachmentUrls";

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

/** The blob: URLs a mounted element still depends on: every connected visible
 *  `<img>` showing one, and every connected tracked GIF's animated source
 *  (`data-media-src`: its `<img>` shows the frozen still, but unfreezing needs
 *  the original). Read only when a
 *  cache is over its cap, so the scan costs nothing on a hit. */
function liveBlobUrls(): Set<string> {
  const live = new Set<string>();
  if (typeof document === "undefined") return live;
  for (const img of document.querySelectorAll("img")) {
    // A hidden image (a failed or refused load) shows nothing, so it pins nothing.
    if (img.hidden) continue;
    for (const src of [img.getAttribute("src"), img.dataset["mediaSrc"]]) {
      if (src !== undefined && src !== null && src.startsWith("blob:")) live.add(src);
    }
  }
  return live;
}

/** blob: URLs by source URL, least recently used first, bounded by the bytes
 *  their Blobs pin (and optionally by count). An evicted URL is revoked; an
 *  image still showing it recovers through `recoverEvictedImage`. One entry
 *  larger than the budget stays until the next arrives. With `keepMounted`, a
 *  URL a mounted `<img>` still shows is never evicted (the cap then bounds the
 *  unreferenced part), so a window wider than the cache is not re-fetched. */
class ObjectUrlCache {
  private readonly entries = new Map<
    string,
    { objectUrl: string; bytes: number; blob: Blob | undefined }
  >();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
    private readonly keepMounted = false,
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
    return this.blobOf(objectUrl) !== null;
  }

  /** The Blob behind a held URL (undefined when it was not kept), or null
   *  when the URL is not held. */
  blobOf(objectUrl: string): Blob | undefined | null {
    for (const entry of this.entries.values()) {
      if (entry.objectUrl === objectUrl) return entry.blob;
    }
    return null;
  }

  set(key: string, objectUrl: string, bytes: number, blob?: Blob): void {
    this.drop(key);
    this.entries.set(key, { objectUrl, bytes, blob });
    this.bytes += bytes;
    if (!this.overCap()) return;
    const live = this.keepMounted ? liveBlobUrls() : null;
    for (const [oldKey, entry] of this.entries) {
      if (!this.overCap()) break;
      // The entry just added stays even when it alone is over.
      if (oldKey === key) continue;
      if (live?.has(entry.objectUrl) === true) continue;
      this.drop(oldKey);
    }
  }

  private overCap(): boolean {
    return (
      this.entries.size > 1 && (this.bytes > this.maxBytes || this.entries.size > this.maxEntries)
    );
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
export const imageCache = new ObjectUrlCache(IMAGE_CACHE_MAX_BYTES, Number.POSITIVE_INFINITY, true);
/** Server images the server definitely refused (missing, gone, forbidden).
 *  Asking again on every mount only repeated the answer — each one was
 *  fetched twice in the audit's channel-switch run. Retry and a cache
 *  clear ask again. */
export const missingImages = new Set<string>();
/** Bounds the set above: one entry per refused URL would otherwise grow for
 *  the whole session. Oldest dropped first. */
const MISSING_IMAGES_MAX = 1000;
const DEFINITE_FAILURES = new Set([403, 404, 410]);
let attachmentCacheGeneration = 0;

/** `host#userId` of the account whose server content these caches hold.
 *  null while signed out: the durable store is neither read nor
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
 * Delete every durable entry of `scope` — a self-deleted account's images.
 * Call it after auth has cleared, so the scope is no longer armed
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
  videoDims.clear();
  fileLinks.clear();
  fileLinkInFlight.clear();
  fileLinkRefused.clear();
  clearStillCache();
  clearAnimatedStills();
  clearTextPreviewCache();
}
// The image/video/audio caches pin blob: URLs; they end with the session.
void registerSessionReset("attachments:caches", clearAttachmentCaches, { phase: "cache" }); // app-lifetime

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
  "video/ogg",
  "video/quicktime",
  "video/3gpp",
  "video/x-m4v",
  "video/x-matroska",
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
export function isServerUrl(url: string): boolean {
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
export function isExternalUrl(url: string): boolean {
  if (isServerUrl(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The server's bounded preview of an image file, or the file itself
 *  on a server that does not advertise thumbnails or for a type the server
 *  passes through unchanged (only JPEG and PNG are scaled). A HEIC, HEIF or
 *  TIFF always takes the preview: the file itself is not an image to a webview. */
export function thumbnailUrl(fileUrl: string, mime: string): string {
  if (
    authStore.getState().uploadPolicy?.thumbnails !== true ||
    (mime !== "image/jpeg" && mime !== "image/png" && !isConvertedImageMime(mime)) ||
    !isServerUrl(fileUrl)
  ) {
    return fileUrl;
  }
  const parsed = new URL(fileUrl);
  if (!/^\/api\/v1\/files\/[^/]+$/.test(parsed.pathname)) return fileUrl;
  parsed.pathname += "/thumb";
  return parsed.toString();
}

/** The URL whose bytes a webview can show in full: the file itself, or for a
 *  HEIC, HEIF or TIFF its JPEG preview. */
export function shownImageUrl(fileUrl: string, mime: string): string {
  return isConvertedImageMime(mime) ? thumbnailUrl(fileUrl, mime) : fileUrl;
}

/** Report whether a URL targets the configured OwnCord server host. */
export function isTrustedServerUrl(url: string): boolean {
  return isServerUrl(url);
}

/**
 * Server content routes that legitimately require the session bearer token:
 * attachments (channel ACLs), custom emoji and stickers (authenticated so an
 * emoji or sticker is not a tracking pixel). A server-host URL outside these is fetched without
 * credentials — otherwise a same-host URL someone put in a field the client
 * renders, such as an avatar, makes every viewer issue an authenticated
 * request to an arbitrary path on the server's own origin.
 */
const TOKEN_BEARING_ROUTES = ["/api/v1/files/", "/api/v1/emoji/", "/api/v1/stickers/"];

function isTokenBearingServerPath(pathname: string): boolean {
  return TOKEN_BEARING_ROUTES.some((route) => pathname.startsWith(route));
}

/**
 * Fetch a file from the OwnCord server through the Rust HTTP TOFU proxy's
 * loopback origin (cert-pinned) with the session bearer token attached —
 * /api/v1/files/{id} enforces channel ACLs, so an unauthenticated request
 * would 401. The token is only ever sent to the configured server host, and
 * only for the server's own content routes.
 *
 * Server URLs only. An external URL is never fetched directly: images
 * go through the external-content broker (`fetchExternalImage`), and anything
 * else is refused here rather than handed to a general-purpose client.
 */
export async function fetchServerFile(
  url: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  // i18n-exempt: internal guard, logged by the caller, never rendered
  if (!isServerUrl(url)) throw new Error("external URLs are fetched only through the broker");
  const parsed = new URL(url);
  const origin = await ensureHttpProxy(parsed.host);
  const headers: Record<string, string> = { ...extraHeaders };
  const token = getToken();
  if (token !== null && isTokenBearingServerPath(parsed.pathname)) {
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
const IDB_VERSION = 2;
/** Index on an entry's last-read time, so eviction walks oldest first. */
const IDB_USED_INDEX = "used";

/** The one shared connection. It is dropped, and the next call reopens, when
 *  the browser closes it or another tab upgrades the database. */
let cacheDbOpen: Promise<IDBDatabase | null> | null = null;
let cacheDbHandle: IDBDatabase | null = null;
/** Bytes held by the store, counted once per connection by `seedCacheTotal`
 *  and kept by each write. A prune or a failed transaction drops the seed so
 *  the next write counts again. */
let cacheTotal = 0;
let cacheSeed: Promise<boolean> | null = null;

function dropCacheDb(db: IDBDatabase): void {
  db.close();
  if (cacheDbHandle !== db) return;
  cacheDbOpen = null;
  cacheDbHandle = null;
  cacheSeed = null;
}

/** Open (or create) the IndexedDB database, once; later calls share it. */
export function openCacheDb(): Promise<IDBDatabase | null> {
  if (cacheDbOpen !== null) return cacheDbOpen;
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.objectStoreNames.contains(IDB_STORE)
          ? req.transaction!.objectStore(IDB_STORE)
          : db.createObjectStore(IDB_STORE);
        if (!store.indexNames.contains(IDB_USED_INDEX)) {
          store.createIndex(IDB_USED_INDEX, "used");
        }
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => {
        const db = req.result;
        cacheDbHandle = db;
        // oxlint-disable-next-line prefer-add-event-listener -- IDBDatabase does not support addEventListener
        db.onversionchange = () => dropCacheDb(db);
        // oxlint-disable-next-line prefer-add-event-listener -- IDBDatabase does not support addEventListener
        db.onclose = () => dropCacheDb(db);
        resolve(db);
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  cacheDbOpen = opening;
  void opening.then((db) => {
    if (db === null && cacheDbOpen === opening) cacheDbOpen = null;
  });
  return opening;
}

/** Resolves when `tx` ends: true if it completed, false if it aborted. Never rejects. */
function transactionEnded(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
    tx.oncomplete = () => resolve(true);
    // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
    tx.onabort = () => resolve(false);
    // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
    tx.onerror = () => resolve(false);
  });
}

/** Count the stored bytes with one cursor pass, dropping any pre-Blob entry on
 *  the way. Resolves false when the pass failed; the next write counts again. */
function seedCacheTotal(db: IDBDatabase): Promise<boolean> {
  const seed = new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const req = tx.objectStore(IDB_STORE).openCursor();
      let sum = 0;
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor === null) return;
        const value: unknown = cursor.value;
        if (isStoredImage(value)) sum += value.bytes;
        else cursor.delete();
        cursor.continue();
      };
      void transactionEnded(tx).then((ok) => {
        if (cacheSeed === seed) {
          if (ok) cacheTotal = sum;
          else cacheSeed = null;
        }
        resolve(ok);
      });
    } catch {
      dropCacheDb(db);
      resolve(false);
    }
  });
  if (cacheDbHandle === db) cacheSeed = seed;
  return seed;
}

/** Delete every durable entry outside `scope` (including keys from before entries were scoped) when
 *  `keep` is true, or every entry inside it when false. */
async function idbPrune(scope: string, keep: boolean): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  cacheSeed = null;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const ended = transactionEnded(tx);
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
    await ended;
  } catch {
    dropCacheDb(db);
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

/** How stale an entry's read time gets before a read refreshes it. The
 *  refresh rewrites the whole record, Blob included, so the eviction order
 *  is only approximately least recently read. */
const IDB_TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

/** Refresh an entry's read time, unless it went away since it was read. */
function idbTouch(db: IDBDatabase, key: string): void {
  const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
  const req = store.get(key);
  // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
  req.onsuccess = () => {
    const entry: unknown = req.result;
    if (isStoredImage(entry)) store.put({ ...entry, used: Date.now() }, key);
  };
}

/** Read a cached image from IndexedDB by its scoped key, marking it read
 *  when its read time is stale. */
async function idbGet(key: string): Promise<Blob | null> {
  const db = await openCacheDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => {
        const entry: unknown = req.result;
        if (!isStoredImage(entry)) {
          resolve(null);
          return;
        }
        if (Date.now() - entry.used >= IDB_TOUCH_AFTER_MS) {
          try {
            idbTouch(db, key);
          } catch {
            // The database closed first — the read time stays stale
          }
        }
        resolve(entry.blob);
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onerror = () => resolve(null);
    } catch {
      dropCacheDb(db);
      resolve(null);
    }
  });
}

/** Walk the entries oldest-read first, deleting until the store fits
 *  IMAGE_DB_MAX_BYTES again. Stops if the count was dropped meanwhile. */
function evictOldest(store: IDBObjectStore, seed: Promise<boolean>): void {
  if (cacheTotal <= IMAGE_DB_MAX_BYTES) return;
  const req = store.index(IDB_USED_INDEX).openCursor();
  // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor === null || cacheSeed !== seed || cacheTotal <= IMAGE_DB_MAX_BYTES) return;
    const value: unknown = cursor.value;
    cursor.delete();
    if (isStoredImage(value)) cacheTotal -= value.bytes;
    cursor.continue();
  };
}

/** Write an image to IndexedDB under `scope`, unless the scope moved on
 *  while the database opened — a late write would outlive the prune. The
 *  same transaction then drops the least recently read entries until the
 *  store fits IMAGE_DB_MAX_BYTES. */
async function idbPut(scope: string, url: string, blob: Blob): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  const seed = cacheSeed ?? seedCacheTotal(db);
  if (!(await seed)) return;
  if (scope !== cacheScope) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const entry: StoredImage = { blob, bytes: blob.size, used: Date.now() };
    store.put(entry, idbKey(scope, url));
    if (cacheSeed === seed) {
      cacheTotal += entry.bytes;
      evictOldest(store, seed);
    }
    void transactionEnded(tx).then((ok) => {
      if (!ok && cacheSeed === seed) cacheSeed = null;
    });
  } catch {
    dropCacheDb(db);
    // IndexedDB full or unavailable — ignore
  }
}

/** `sniff`: read the file's header for its size, for a caller that has no
 *  dimensions of its own (a row reserving its box). Other callers skip the read. */
export interface ImageLoadOptions {
  readonly sniff?: boolean;
}

/** Fetch an image and return a `blob:` URL an `<img>` can show. Server images
 *  come through memory → IndexedDB → the TOFU proxy; an external image comes
 *  from the broker and never enters those two caches, which hold server
 *  content only. */
export function fetchImageAsObjectUrl(
  url: string,
  opts?: ImageLoadOptions,
): Promise<string | null> {
  if (isExternalUrl(url)) return fetchExternalImage({ url }, opts);
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
    if (opts?.sniff === true && stored === null) {
      rememberBlobSize(objectUrl, await sniffImageBlob(blob));
    }
    if (generation !== attachmentCacheGeneration) {
      revokeObjectUrl(objectUrl);
      return null;
    }
    // The Blob is pinned by its URL already; keeping the reference costs
    // nothing and lets an animated avatar read its frames.
    imageCache.set(url, objectUrl, blob.size, blob);
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

/** A reader for the bytes behind a blob: URL `fetchImageAsObjectUrl`
 *  returned, while the image cache still holds it; null when it does not. A
 *  blob: URL cannot be fetched back (the CSP's connect-src does not list
 *  blob:), so this is how an animated avatar learns it has frames. */
export function cachedImageBytes(objectUrl: string): (() => Promise<Uint8Array | null>) | null {
  const blob = imageCache.blobOf(objectUrl);
  if (blob === undefined || blob === null) return null;
  return () => blob.arrayBuffer().then((buf) => new Uint8Array(buf));
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
        if (missingImages.size > MISSING_IMAGES_MAX) {
          const oldest = missingImages.values().next().value;
          if (oldest !== undefined) missingImages.delete(oldest);
        }
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

/** Real video sizes learnt on play, so a row rebuilt by the virtual list keeps
 *  the clip's shape instead of falling back to the 16:9 placeholder. */
export const videoDims = new Map<string, readonly [number, number]>();
export const VIDEO_DIMS_CAP = 500;

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
// File links: a <video> streams from a server-minted link
// ---------------------------------------------------------------------------

/** A source a media element can load with no Authorization header. */
export interface FileLink {
  /** Origin (the loopback proxy on desktop, the page's own in a browser) plus
   *  the server's link path. It carries a credential: never log it. */
  readonly src: string;
  readonly expiresAtMs: number;
}

/** A link is replaced this long before the server expires it. */
const FILE_LINK_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Minted links by attachment URL; re-rendered rows reuse one. */
const fileLinks = new Map<string, FileLink>();
/** In-flight mints, so rows showing the same clip share one request. */
const fileLinkInFlight = new Map<string, Promise<FileLink | null>>();
/** Attachment URLs the server answered 404 or 405 for: a server without the
 *  route (or without the file). They go straight to the blob path. */
const fileLinkRefused = new Set<string>();

/** The attachment path a link can be minted for (not /thumb). */
const FILE_LINK_PATH = /^\/api\/v1\/files\/[^/]+$/;

async function requestFileLink(url: string): Promise<FileLink | null> {
  const generation = attachmentCacheGeneration;
  try {
    if (!isServerUrl(url)) return null;
    const parsed = new URL(url);
    if (!FILE_LINK_PATH.test(parsed.pathname)) return null;
    const token = getToken();
    if (token === null) return null;
    const origin = await ensureHttpProxy(parsed.host);
    const res = await desktop.http.fetch(`${origin}${parsed.pathname}/link`, {
      method: "POST",
      // i18n-exempt: HTTP wire header value, never rendered
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404 || res.status === 405) {
      if (generation === attachmentCacheGeneration) fileLinkRefused.add(url);
      return null;
    }
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const { path, expires_at: expiresAt } = body as { path?: unknown; expires_at?: unknown };
    const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (
      typeof path !== "string" ||
      !path.startsWith("/api/v1/files/") ||
      Number.isNaN(expiresAtMs)
    ) {
      return null;
    }
    // A cache clear (logout, server switch) during the request: the link
    // belongs to a session that is gone.
    if (generation !== attachmentCacheGeneration) return null;
    const link: FileLink = { src: `${origin}${path}`, expiresAtMs };
    fileLinks.set(url, link);
    return link;
  } catch (err) {
    // The error text is logged, never the URL: a link is a credential.
    log.warn("File link request failed", { error: String(err) });
    return null;
  }
}

/** A usable streaming source for a server attachment, or null when there is
 *  none (an older server, a refused or failed request) and the caller should
 *  use the blob path. `fresh` discards the held link first. */
export function getFileLink(url: string, fresh = false): Promise<FileLink | null> {
  if (fresh) fileLinks.delete(url);
  if (fileLinkRefused.has(url)) return Promise.resolve(null);
  const held = fileLinks.get(url);
  if (held !== undefined && held.expiresAtMs - Date.now() > FILE_LINK_REFRESH_MARGIN_MS) {
    return Promise.resolve(held);
  }
  // A fresh link is wanted because the one in flight (or just held) may be
  // the one that failed, so it does not join an earlier request.
  const existing = fresh ? undefined : fileLinkInFlight.get(url);
  if (existing !== undefined) return existing;
  const promise = requestFileLink(url);
  fileLinkInFlight.set(url, promise);
  void promise.finally(() => {
    if (fileLinkInFlight.get(url) === promise) fileLinkInFlight.delete(url);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// External images: the broker's bytes as blob: URLs
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
const externalObjectUrls = new Map<string, { url: string; bytes: number }>();
let externalBytes = 0;
/** The subset of those URLs whose bytes are a GIF — the ones that get the
 *  freeze/play control. */
const externalGifUrls = new Set<string>();
const externalInFlight = new Map<string, Promise<ExternalContentResult<string>>>();
/** LRU cap (URLs a mounted image shows are exempt): these copies live in the webview, outside the broker's byte
 *  budget, so nothing else bounds them. Mirrors MEDIA_CACHE_MAX; higher
 *  because an image is far smaller than a clip. */
export const EXTERNAL_IMAGE_CACHE_MAX = 100;
/** What those copies may pin in total: a broker image can be 16 MB, so the
 *  count cap alone allows ~1.6 GB of blob memory. Mirrors the server-image
 *  cache's budget. */
export const EXTERNAL_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

function externalOverCap(): boolean {
  return (
    externalObjectUrls.size > 1 &&
    (externalObjectUrls.size > EXTERNAL_IMAGE_CACHE_MAX ||
      externalBytes > EXTERNAL_IMAGE_CACHE_MAX_BYTES)
  );
}

/** Drop every broker-fetched image and move to a fresh broker partition.
 *  Run with the session reset and from the manual "clear cache" action. */
export function clearExternalImageCache(): void {
  externalEpoch += 1;
  // Name the fresh partition now rather than at the next preview: the broker
  // drops a partition's cache the moment another one is named, and an empty
  // URL is refused before any network work, so this costs one IPC call.
  void desktop.externalContent?.preview(externalPartition(), "");
  for (const entry of externalObjectUrls.values()) {
    revokeObjectUrl(entry.url);
  }
  externalObjectUrls.clear();
  externalBytes = 0;
  externalGifUrls.clear();
  externalInFlight.clear();
}
// Broker-fetched content belongs to the server it was fetched for.
void registerSessionReset("attachments:external-images", clearExternalImageCache, {
  phase: "cache",
}); // app-lifetime

/** The broker cache and consent admission key for an image source. */
export function externalKey(source: ExternalImageSource): string {
  return "handle" in source ? `handle:${source.handle}` : `url:${source.url}`;
}

/** A link preview (or oEmbed title) through the broker, refused before any
 *  network work unless the viewer consented to `url`. */
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
  return (
    imageCache.holds(objectUrl) ||
    [...externalObjectUrls.values()].some((entry) => entry.url === objectUrl)
  );
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
  source: ExternalImageSource | (() => ExternalImageSource),
  onExpired?: () => void,
  /** Identity of what `img` should show now; a reload that finishes after it
   *  changed (a lightbox gallery step) is dropped. */
  stillCurrent?: () => unknown,
): void {
  const recover = (event: Event): void => {
    if (!img.src.startsWith("blob:") || isLiveImageUrl(img.src)) return;
    event.stopImmediatePropagation();
    const started = stillCurrent?.();
    void reloadImage(typeof source === "function" ? source() : source).then((result) => {
      if (stillCurrent !== undefined && stillCurrent() !== started) return;
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
export function fetchExternalImage(
  source: ExternalImageSource,
  opts?: ImageLoadOptions,
): Promise<string | null> {
  return loadExternalImage(source, opts).then((result) => (result.ok ? result.value : null));
}

/** `fetchExternalImage`, keeping the broker's failure class. */
export function loadExternalImage(
  source: ExternalImageSource,
  opts?: ImageLoadOptions,
): Promise<ExternalContentResult<string>> {
  const key = externalKey(source);
  // Nothing is fetched for an item the viewer has not consented to.
  if (!externalAllowed(key)) return Promise.resolve({ ok: false, failure: "unavailable" });
  const cached = externalObjectUrls.get(key);
  if (cached !== undefined) {
    // Recency order is Map order: a hit moves the entry to the back.
    externalObjectUrls.delete(key);
    externalObjectUrls.set(key, cached);
    return Promise.resolve({ ok: true, value: cached.url });
  }
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
    // The header's size, read once per fetch, so the renderer reserves the
    // box before the first decode; callers sharing this fetch all see it.
    if (opts?.sniff === true) rememberBlobSize(objectUrl, await sniffImageBlob(result.value));
    if (epoch !== externalEpoch) {
      revokeObjectUrl(objectUrl);
      return { ok: false, failure: "unavailable" };
    }
    externalObjectUrls.set(key, { url: objectUrl, bytes: result.value.size });
    externalBytes += result.value.size;
    // Least recently used first. The entry just added stays even when it
    // alone is over, and so does any URL a mounted image still shows: the
    // caps bound the unreferenced part.
    if (externalOverCap()) {
      const live = liveBlobUrls();
      for (const [oldKey, evicted] of externalObjectUrls) {
        if (!externalOverCap()) break;
        if (oldKey === key || live.has(evicted.url)) continue;
        externalObjectUrls.delete(oldKey);
        externalBytes -= evicted.bytes;
        externalGifUrls.delete(evicted.url);
        revokeObjectUrl(evicted.url);
      }
    }
    if (result.value.type === "image/gif") externalGifUrls.add(objectUrl);
    return { ok: true, value: objectUrl };
  })();

  externalInFlight.set(key, promise);
  // then(f, f), not finally(f): finally would leave this side branch rejected
  // and unhandled when the broker call throws; callers still see the rejection.
  const forget = (): void => {
    if (externalInFlight.get(key) === promise) externalInFlight.delete(key);
  };
  void promise.then(forget, forget);
  return promise;
}

// -- Failure + retry ----------------------------------------------------------

/** The typed failure line shared by the embed, image and picker renderers:
 *  a status message plus a bounded, explicitly labelled retry. The
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
