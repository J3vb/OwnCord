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
import { authStore, getToken } from "@stores/auth.store";
import { bracketBareIPv6Host } from "@lib/ws";
import { desktop } from "../../platform/desktop";
import { isVoiceAttachment, renderVoicePlayer } from "../../features/voice-messages/player";
import type {
  ExternalContentResult,
  ExternalImageSource,
  ExternalPreview,
} from "../../platform/contracts/externalContent";

const log = createLogger("attachments");
import type { Attachment } from "@lib/types";
import { externalAllowed, setExternalConsentScope } from "../../features/content-consent/external";
import { mediaControlsText } from "../../i18n/mediaControls";
import { messagingText } from "../../i18n/messaging";
import { isSpoilerFilename } from "../../features/messaging/spoilerAttachment";
import { messageStatusText } from "../../i18n/messageStatus";
import { clearStillCache } from "../../features/messaging/emojiStill";
import { clearAnimatedStills } from "@lib/animatedStill";
import { registerSessionReset } from "@lib/sessionRegistry";
import { sniffImageBlob } from "@lib/imageHeader";
import {
  ATTACHMENT_BOX_MAX_H,
  blobImageSize,
  fitImageBox,
  getImageBox,
  imageSizeGeneration,
  rememberBlobSize,
  setImageBox,
  type ImageBox,
} from "./image-sizes";
import type { ImageMenuTarget } from "./image-menu";
import { highlightCode, resolveLanguage } from "./syntax-highlight";
import {
  clearTextPreviewCache,
  isTextPreviewable,
  renderTextPreview,
  type TextPreviewDeps,
} from "../../features/messaging/textPreview";

/** One image of a message's lightbox sequence. `url` is the resolved server URL. */
export interface LightboxGalleryItem {
  readonly url: string;
  readonly filename: string;
  readonly mime: string;
}

/** The images of the clicked message, for the viewer's previous/next arrows. */
export interface LightboxGallery {
  readonly items: readonly LightboxGalleryItem[];
  readonly index: number;
  /** True once the message was deleted; checked when the viewer opens. */
  readonly isGone?: () => boolean;
  /** Calls `onGone` when the message is deleted; returns the unsubscribe. */
  readonly watch?: (onGone: () => void) => () => void;
  /** The message's row, for focus when the viewer closes over a deletion. */
  readonly row?: () => Element | null;
}

/** What the viewer shows now: Download, Open original, the image menu and
 *  eviction recovery all read this at use time, never at bind time. */
export interface LightboxCurrent {
  readonly external: ExternalImageSource | undefined;
  readonly alt: string;
}

/** What the lazy gallery module drives (3A-10c). */
export interface LightboxHandle {
  readonly overlay: HTMLElement;
  readonly img: HTMLImageElement;
  /** Tab cycle, in order; the gallery puts its arrows first. */
  readonly controls: HTMLButtonElement[];
  readonly signal: AbortSignal;
  setCurrent(current: LightboxCurrent): void;
  /** Resets zoom and pan and ends a drag in progress. */
  resetView(): void;
  closeMenu(): void;
  /** True while the image menu is open; it owns the arrow keys. */
  isImageMenuOpen(): boolean;
  /** Passed in so the lazy gallery module imports only types from here. */
  fetchImageAsObjectUrl(url: string): Promise<string | null>;
  thumbnailUrl(fileUrl: string, mime: string): string;
  close(): void;
}

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
const INLINE_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/3gpp",
  "video/x-m4v",
  "video/x-matroska",
]);

/** Video extensions trusted only when the server could not type the file
 *  (a .mov stored before it learned QuickTime, a .3gp it still stores as
 *  generic). A player that cannot decode one falls back to the download chip.
 *  .avi is deliberately absent: the engines do not read it. */
const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "webm", "mkv", "3gp", "ogv"]);

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

/** Whether the attachment should render as an inline <video> player: by its
 *  MIME type, or by its extension when that type is the generic one. */
export function isVideoAttachment(att: Pick<Attachment, "mime" | "filename">): boolean {
  if (isVideoMime(att.mime)) return true;
  const base = baseMime(att.mime);
  if (base !== "" && base !== "application/octet-stream") return false;
  const dot = att.filename.lastIndexOf(".");
  return dot > 0 && VIDEO_EXTENSIONS.has(att.filename.slice(dot + 1).toLowerCase());
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
const imageCache = new ObjectUrlCache(IMAGE_CACHE_MAX_BYTES, Number.POSITIVE_INFINITY, true);
/** Server images the server definitely refused (missing, gone, forbidden).
 *  Asking again on every mount only repeated the answer — each one was
 *  fetched twice in the audit's channel-switch run (DP-56). Retry and a cache
 *  clear ask again. */
const missingImages = new Set<string>();
/** Bounds the set above: one entry per refused URL would otherwise grow for
 *  the whole session. Oldest dropped first. */
const MISSING_IMAGES_MAX = 1000;
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

/** The server's bounded preview of an image file (P4-08), or the file itself
 *  on a server that does not advertise thumbnails or for a type the server
 *  passes through unchanged (only JPEG and PNG are scaled). */
export function thumbnailUrl(fileUrl: string, mime: string): string {
  if (
    authStore.getState().uploadPolicy?.thumbnails !== true ||
    (mime !== "image/jpeg" && mime !== "image/png") ||
    !isServerUrl(fileUrl)
  ) {
    return fileUrl;
  }
  const parsed = new URL(fileUrl);
  if (!/^\/api\/v1\/files\/[^/]+$/.test(parsed.pathname)) return fileUrl;
  parsed.pathname += "/thumb";
  return parsed.toString();
}

/** Report whether a URL targets the configured OwnCord server host. */
export function isTrustedServerUrl(url: string): boolean {
  return isServerUrl(url);
}

/**
 * Server content routes that legitimately require the session bearer token:
 * attachments (channel ACLs) and custom emoji (authenticated so an emoji is
 * not a tracking pixel). A server-host URL outside these is fetched without
 * credentials — otherwise a same-host URL someone put in a field the client
 * renders, such as an avatar, makes every viewer issue an authenticated
 * request to an arbitrary path on the server's own origin.
 */
const TOKEN_BEARING_ROUTES = ["/api/v1/files/", "/api/v1/emoji/"];

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
 * Server URLs only. An external URL is never fetched directly (B7-16): images
 * go through the external-content broker (`fetchExternalImage`), and anything
 * else is refused here rather than handed to a general-purpose client.
 */
async function fetchServerFile(
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

/** What the text preview borrows from this module (it cannot import it). */
const textPreviewDeps: TextPreviewDeps = {
  fetchFile: fetchServerFile,
  buildFileMeta,
  buildDownloadButton,
  renderFileChip,
  highlight: (code, tag) => highlightCode(code, resolveLanguage(tag)),
};

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

/** Delete every durable entry outside `scope` (including pre-B7-13 keys) when
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
 *  content only (B7-16). */
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
    // nothing and lets an animated avatar read its frames (WP 8.7).
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
 *  blob:), so this is how an animated avatar learns it has frames (WP 8.7). */
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
const videoDims = new Map<string, readonly [number, number]>();
const VIDEO_DIMS_CAP = 500;

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
// File links (WP 8.11): a <video> streams from a server-minted link
// ---------------------------------------------------------------------------

/** A source a media element can load with no Authorization header. */
interface FileLink {
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
function getFileLink(url: string, fresh = false): Promise<FileLink | null> {
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
// Broker-fetched content belongs to the server it was fetched for (B7-16).
void registerSessionReset("attachments:external-images", clearExternalImageCache, {
  phase: "cache",
}); // app-lifetime

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
  // B9-8: nothing is fetched for an item the viewer has not consented to.
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
  const playLabel = btn.getAttribute("aria-label") ?? "";
  btn.appendChild(createIcon("play", 20));
  const setLoading = (loading: boolean): void => {
    btn.disabled = loading;
    btn.replaceChildren(createIcon(loading ? "loader" : "play", 20));
    if (loading) {
      btn.setAttribute("aria-busy", "true");
      btn.setAttribute(
        "aria-label",
        messageStatusText("file.loadingNamed", { filename: att.filename }),
      );
      wrap.setAttribute("aria-busy", "true");
    } else {
      btn.removeAttribute("aria-busy");
      btn.setAttribute("aria-label", playLabel);
      wrap.removeAttribute("aria-busy");
    }
  };
  btn.addEventListener("click", () => {
    // The whole clip downloads first on this path, so say so: a big file
    // would otherwise look like a dead button.
    setLoading(true);
    void fetchMediaAsObjectUrl(resolvedUrl).then((objectUrl) => {
      if (objectUrl === null) {
        // The download chip stays; the player is dimmed, never shown as loading.
        wrap.classList.add("msg-media-failed");
        setLoading(false);
        return;
      }
      wrap.removeAttribute("aria-busy");
      wrap.classList.remove("msg-media-failed");
      btn.remove();
      player.hidden = false;
      player.controls = true;
      player.src = objectUrl;
      if (!wrap.isConnected) return;
      void player.play().catch((err: unknown) => {
        // Playback refused (an autoplay policy): the controls are there to press.
        log.debug("Media playback refused", { error: String(err) });
      });
    });
  });
  return btn;
}

/** Replace `wrap` with `next`, handing keyboard focus on if `wrap` held it. */
function swapKeepingFocus(wrap: HTMLElement, next: HTMLElement): void {
  const hadFocus = wrap.contains(document.activeElement);
  wrap.replaceWith(next);
  if (hadFocus) next.querySelector<HTMLElement>(".msg-file-download")?.focus();
}

/** Largest box an inline video is drawn in, in CSS pixels: the cap an inline
 *  image is shown at (400 wide by the reserved box, 300 tall by CSS). */
const VIDEO_MAX_W = 400;
const VIDEO_MAX_H = 300;
/** Narrowest player, so the play and download buttons and the native controls
 *  still fit a tiny or very tall clip. */
const VIDEO_MIN_W = 120;

/** Size the player to the clip's own shape, scaled down to the video box, so
 *  a small or portrait video gets no black bars. Below VIDEO_MIN_W the player
 *  is widened, and a box that would then pass VIDEO_MAX_H is letterboxed. The
 *  width is a ceiling: a narrow column still shrinks it, keeping the ratio. */
function sizeVideo(video: HTMLVideoElement, w: number, h: number): void {
  const scale = Math.min(1, VIDEO_MAX_W / w, VIDEO_MAX_H / h);
  const scaled = Math.round(w * scale);
  const width = Math.max(VIDEO_MIN_W, scaled);
  const fits = scaled >= VIDEO_MIN_W || (width * h) / w <= VIDEO_MAX_H;
  video.style.width = `${width}px`;
  video.style.aspectRatio = fits ? `${w} / ${h}` : `${width} / ${VIDEO_MAX_H}`;
}

/** The audio row a picture-less clip becomes keeps streaming from the link,
 *  so it gets the same recovery as the player: one fresh link, then the play
 *  button's download path. */
function watchAudioLink(
  att: Attachment,
  resolvedUrl: string,
  row: HTMLElement,
  audio: HTMLAudioElement,
): void {
  const downloadPath = (): void => {
    audio.removeAttribute("src");
    audio.load();
    audio.hidden = true;
    audio.controls = false;
    row.querySelector(".msg-file-meta")?.appendChild(buildPlayButton(att, resolvedUrl, row, audio));
  };
  audio.addEventListener(
    "error",
    () => {
      const at = audio.currentTime;
      const wasPlaying = !audio.paused;
      void getFileLink(resolvedUrl, true).then((link) => {
        if (link === null) {
          downloadPath();
          return;
        }
        // A second failure is the download path's to settle.
        audio.addEventListener("error", downloadPath, { once: true });
        audio.addEventListener(
          "loadedmetadata",
          () => {
            audio.currentTime = at;
            if (wasPlaying && row.isConnected) {
              void audio.play().catch((err: unknown) => {
                log.debug("Media playback refused", { error: String(err) });
              });
            }
          },
          { once: true },
        );
        audio.src = link.src;
      });
    },
    { once: true },
  );
}

/** MediaError.code for "the stream arrived and could not be decoded". Every
 *  other code, a refused request included, is ambiguous, so it earns the
 *  fresh-link retry before the clip is called unplayable. */
const MEDIA_ERR_DECODE = 3;
/** A link that fails again within this long of its replacement is not
 *  replaced a second time: the clip goes to the blob path. */
const VIDEO_RELINK_COOLDOWN_MS = 60_000;

/** Inline <video> player, capped to the same box as an image and sized to the
 *  clip's real shape once it is known (server dimensions, an earlier play, or
 *  the metadata). The source is a server-minted link, so the engine streams
 *  with Range requests and shows the first frame before play. When a link
 *  cannot be had (an older server, a failed request), or keeps failing, the
 *  play button downloads the clip through the authenticated fetch instead.
 *  A clip the engine cannot decode becomes the download chip, never a broken
 *  player. */
function renderVideoAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-image msg-video" });

  const video = createElement("video", { preload: "metadata" });
  video.setAttribute("aria-label", att.filename);
  const known =
    att.width != null && att.height != null && att.width > 0 && att.height > 0
      ? ([att.width, att.height] as const)
      : videoDims.get(att.id);
  if (known !== undefined) sizeVideo(video, known[0], known[1]);
  const unplayable = (): void => {
    const chip = renderFileChip(att, resolvedUrl);
    const note = createElement("div", { class: "msg-file-note", role: "status" });
    setText(note, messageStatusText("file.cannotPlay"));
    chip.querySelector(".msg-file-meta")?.appendChild(note);
    swapKeepingFocus(wrap, chip);
  };

  // "link": streaming from a minted link. "blob": the play button's download
  // path (also the state before any link has arrived).
  let source: "link" | "blob" = "blob";
  let playButton: HTMLButtonElement | null = null;
  let relinking = false;
  let lastRelinkAt = Number.NEGATIVE_INFINITY;
  let resumeAt = 0;
  let resumePlaying = false;

  const useBlobPath = (): void => {
    source = "blob";
    video.removeAttribute("src");
    video.load();
    video.controls = false;
    if (playButton === null) {
      playButton = buildPlayButton(att, resolvedUrl, wrap, video);
      video.after(playButton);
    }
  };
  const useLink = (link: FileLink): void => {
    source = "link";
    video.controls = true;
    video.src = link.src;
  };
  const recoverLink = (): void => {
    // A decode failure on a link that delivered bytes is the clip, not the link.
    if (video.error?.code === MEDIA_ERR_DECODE) {
      unplayable();
      return;
    }
    if (relinking) return;
    // A 403 (expired or voided link) and an undecodable clip both surface as
    // an unsupported-source error. Replace the link once before concluding;
    // after that the blob path decides, which can tell the two apart.
    if (Date.now() - lastRelinkAt < VIDEO_RELINK_COOLDOWN_MS) {
      useBlobPath();
      return;
    }
    lastRelinkAt = Date.now();
    relinking = true;
    resumeAt = video.currentTime;
    resumePlaying = !video.paused;
    void getFileLink(resolvedUrl, true).then((link) => {
      relinking = false;
      if (link === null) useBlobPath();
      else useLink(link);
    });
  };
  video.addEventListener("error", () => {
    if (source === "link") recoverLink();
    else unplayable();
  });
  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      sizeVideo(video, video.videoWidth, video.videoHeight);
      if (!videoDims.has(att.id) && videoDims.size >= VIDEO_DIMS_CAP) {
        const oldest = videoDims.keys().next().value;
        if (oldest !== undefined) videoDims.delete(oldest);
      }
      videoDims.set(att.id, [video.videoWidth, video.videoHeight]);
      if (resumeAt > 0) {
        video.currentTime = resumeAt;
        if (resumePlaying && wrap.isConnected) {
          void video.play().catch((err: unknown) => {
            log.debug("Media playback refused", { error: String(err) });
          });
        }
        resumeAt = 0;
      }
      return;
    }
    // No picture (audio-only, or a codec the engine lacks): keep playing as audio.
    const src = video.src;
    const wasPlaying = !video.paused;
    video.pause();
    video.removeAttribute("src");
    video.load();
    const row = renderAudioAttachment(att, resolvedUrl);
    const audio = row.querySelector("audio") as HTMLAudioElement;
    row.querySelector(".msg-media-play")?.remove();
    audio.hidden = false;
    audio.controls = true;
    audio.src = src;
    if (source === "link") watchAudioLink(att, resolvedUrl, row, audio);
    const note = createElement("div", { class: "msg-file-note", role: "status" });
    setText(note, messageStatusText("file.noPicture"));
    row.querySelector(".msg-file-meta")?.appendChild(note);
    swapKeepingFocus(wrap, row);
    if (wasPlaying && row.isConnected) {
      void audio.play().catch((err: unknown) => {
        log.debug("Media playback refused", { error: String(err) });
      });
    }
  });
  wrap.appendChild(video);

  const overlay = createElement("div", { class: "msg-media-overlay" });
  overlay.appendChild(buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(overlay);

  // Mint on render, not on play: the link is what lets the engine fetch the
  // first frame. The play button appears only if there is no link to stream.
  void getFileLink(resolvedUrl).then((link) => {
    if (link === null) useBlobPath();
    else useLink(link);
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
  audio.hidden = true;
  audio.setAttribute("aria-label", att.filename);
  appendChildren(info, buildPlayButton(att, resolvedUrl, wrap, audio), audio);

  appendChildren(inner, info, buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(inner);

  return wrap;
}

/** The generic download chip: icon, filename, size and download button. */
function renderFileChip(att: Attachment, resolvedUrl: string): HTMLDivElement {
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

/** Whether `att` renders as an inline image, so it belongs in its message's
 *  lightbox sequence (3A-10c). The same test `renderAttachment` applies. */
export function isGalleryImage(att: Attachment): boolean {
  return isImageMime(att.mime) && isSafeUrl(resolveServerUrl(att.url)) && !isVideoAttachment(att);
}

/** Cover an inline image or video until the reader asks for it (6.12). The
 *  cover is a button over the blurred media, and while it is up nothing under
 *  it takes input: a capture-phase guard on the box stops the lightbox, the
 *  keyboard open, the image menu and the play button, and `inert` takes the
 *  media out of the tab order, including media that arrives after the first
 *  paint. The revealed state is this element's alone: a re-render covers it
 *  again, and nothing is stored. */
function coverSpoiler(wrap: HTMLDivElement): HTMLDivElement {
  let covered = true;
  wrap.classList.add("msg-spoiler-att");
  const cover = createElement("button", {
    class: "msg-spoiler-cover",
    type: "button",
    "aria-label": messagingText("spoiler.reveal"),
  });
  cover.appendChild(
    createElement(
      "span",
      { class: "msg-spoiler-cover-label" },
      messagingText("spoiler.attachment"),
    ),
  );

  const setInert = (on: boolean): void => {
    for (const child of wrap.children) {
      if (child !== cover) child.toggleAttribute("inert", on);
    }
  };
  const observer = new MutationObserver(() => setInert(true));
  const guard = (e: Event): void => {
    if (!covered || (e.target instanceof Node && cover.contains(e.target))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of ["click", "dblclick", "auxclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(type, guard, { capture: true });
  }

  cover.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    covered = false;
    observer.disconnect();
    setInert(false);
    cover.remove();
    wrap.classList.add("revealed");
    // The cover held focus: hand it to something focusable so the keyboard
    // keeps its place. A still-loading image has nothing yet, so the box itself.
    let target = wrap.querySelector<HTMLElement>("img[tabindex], .msg-media-play, video[controls]");
    if (target === null) {
      wrap.tabIndex = -1;
      target = wrap;
    }
    target.focus();
  });

  wrap.appendChild(cover);
  setInert(true);
  observer.observe(wrap, { childList: true });
  return wrap;
}

export function renderAttachment(att: Attachment, gallery?: LightboxGallery): HTMLDivElement {
  const node = renderAttachmentContent(att, gallery);
  // Only an inline image or video is covered; a file chip or audio row shows no picture.
  return isSpoilerFilename(att.filename) && node.classList.contains("msg-image")
    ? coverSpoiler(node)
    : node;
}

function renderAttachmentContent(att: Attachment, gallery?: LightboxGallery): HTMLDivElement {
  const resolvedUrl = resolveServerUrl(att.url);
  const inlineable = isSafeUrl(resolvedUrl);
  // A voice message (WP 8.9) is recognised by its metadata, whatever MIME the server sniffed.
  if (inlineable && isVoiceAttachment(att)) {
    return renderVoicePlayer(att, resolvedUrl, {
      fetchMedia: fetchMediaAsObjectUrl,
      downloadButton: () => buildDownloadButton(att, resolvedUrl),
    });
  }
  if (inlineable && isVideoAttachment(att)) {
    return renderVideoAttachment(att, resolvedUrl);
  }
  if (inlineable && isAudioMime(att.mime)) {
    return renderAudioAttachment(att, resolvedUrl);
  }
  if (isImageMime(att.mime) && inlineable) {
    const wrap = createElement("div", { class: "msg-image" });
    // The row shows the server's preview; the lightbox loads the full file.
    const inlineUrl = thumbnailUrl(resolvedUrl, att.mime);

    // Reserve space using server-provided dimensions to prevent layout shift.
    // An old attachment has none: it takes the box remembered for its URL, or
    // the size its header declares once the bytes arrive, or 200px until then.
    const serverBox =
      att.width != null && att.height != null
        ? fitImageBox(att.width, att.height, ATTACHMENT_BOX_MAX_H)
        : null;
    const reserve = (box: ImageBox): void => {
      wrap.style.minHeight = "";
      wrap.style.width = `${box.w}px`;
      wrap.style.height = `${box.h}px`;
    };
    // A reset between mount and load must not write this URL into the new session.
    const generation = imageSizeGeneration();
    const rememberedBox = serverBox === null ? getImageBox(inlineUrl) : undefined;
    if (serverBox !== null) reserve(serverBox);
    else if (rememberedBox !== undefined) reserve(rememberedBox);
    else wrap.style.minHeight = "200px";

    function attachLightbox(img: HTMLImageElement): void {
      // Keyboard-operable like an inline image (B9-9): focus it and Enter or
      // Space opens the lightbox, the Menu key or Shift+F10 the image menu.
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute(
        "aria-label",
        messageStatusText("file.openImage", { filename: att.filename }),
      );
      img.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        img.click();
      });
      img.addEventListener("click", () => {
        openImageLightbox(img.src, att.filename, { url: resolvedUrl }, gallery);
      });
    }

    const isGif = att.mime === "image/gif";

    // Without server dimensions, settle the box on the real size once it is
    // known (a header the sniffer could not read) so a rebuild starts there.
    const clearReservation = (img: HTMLImageElement): void => {
      if (serverBox !== null) return;
      const actual = fitImageBox(img.naturalWidth, img.naturalHeight, ATTACHMENT_BOX_MAX_H);
      const reserved = getImageBox(inlineUrl);
      if (actual !== null) {
        // Decoded and oriented by the browser: the measured box beats a sniffed one.
        if (
          reserved === undefined ||
          reserved.measured !== true ||
          reserved.w !== actual.w ||
          reserved.h !== actual.h
        ) {
          reserve(actual);
          setImageBox(inlineUrl, { ...actual, measured: true }, generation);
        }
        return;
      }
      if (reserved !== undefined) return;
      // No intrinsic size reported: keep the measured height as the minimum.
      wrap.style.minHeight = "";
      const h = wrap.offsetHeight;
      if (h > 0) wrap.style.minHeight = `${h}px`;
    };

    const buildImage = (objectUrl: string): HTMLImageElement => {
      const img = createElement("img", {
        src: objectUrl,
        alt: att.filename,
        decoding: "async",
      });
      recoverEvictedImage(img, { url: inlineUrl });
      attachLightbox(img);
      bindImageMenu({
        img,
        link: null,
        // The row may show a thumbnail or a frozen GIF frame; copy the file.
        full: () => fetchImageAsObjectUrl(resolvedUrl),
        save: () => downloadFile(resolvedUrl, att.filename),
      });
      img.addEventListener(
        "load",
        () => {
          clearReservation(img);
          if (isGif) observeMedia(img, img.src, wrap, !animateGifsPref);
        },
        { once: true },
      );
      return img;
    };

    // Check cache first for instant render
    const cached = imageCache.get(inlineUrl);
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
        void fetchImageAsObjectUrl(inlineUrl, { sniff: serverBox === null }).then((objectUrl) => {
          if (objectUrl !== null) {
            const sniffed = serverBox === null ? blobImageSize(objectUrl) : undefined;
            const exact =
              sniffed === undefined
                ? null
                : fitImageBox(sniffed.width, sniffed.height, ATTACHMENT_BOX_MAX_H);
            if (exact !== null) {
              // A measured box from an earlier load wins over the header's reading.
              const held = setImageBox(inlineUrl, exact, generation);
              reserve(held ?? exact);
            }
            const img = buildImage(objectUrl);
            current.replaceWith(img);
            current = img;
          } else {
            const failure = renderFailureStatus(
              messageStatusText("file.imageFailed"),
              messageStatusText("file.retry"),
              () => {
                // Retry asks the server again, even after a definite refusal.
                missingImages.delete(inlineUrl);
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
  if (inlineable && isServerUrl(resolvedUrl) && isTextPreviewable(att)) {
    return renderTextPreview(att, resolvedUrl, textPreviewDeps);
  }
  return renderFileChip(att, resolvedUrl);
}

/** Download a file via Tauri HTTP plugin and save to disk with native dialog.
 *  `fs:allow-write-file` is statically scoped to `$APPLOG` (nothing covers app
 *  data); the save dialog grants the one path the user chose at runtime, so the
 *  dialog itself is the boundary for the download. */
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

// -- Image menu ---------------------------------------------------------------

type ImageMenuModule = typeof import("./image-menu");
/** Set once the lazy menu module has loaded, so teardown can close its menu. */
let imageMenuModule: ImageMenuModule | null = null;

function loadImageMenu(): Promise<ImageMenuModule> {
  return import("./image-menu").then((m) => {
    imageMenuModule = m;
    return m;
  });
}

/** Save an image whose bytes are already in the webview. */
export function saveImageBytes(src: string, url: string): Promise<void> {
  return loadImageMenu().then((m) => m.saveImageBytes(src, url));
}

/**
 * Open the image menu (Copy Image, Copy Link, Open Link, Save Image) on
 * right-click of `target.img`, or on the Menu key / Shift+F10 when the image
 * has focus (they fire `contextmenu` with no pointer position). `signal`, when
 * given, closes the menu with its owner (the lightbox).
 */
export function bindImageMenu(target: ImageMenuTarget, signal?: AbortSignal): void {
  const { img } = target;
  img.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // A hidden image is still loading or refused: nothing to copy.
      if (img.hidden || !img.hasAttribute("src")) return;
      let { clientX: x, clientY: y } = e;
      if (x === 0 && y === 0) {
        const rect = img.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
      loadImageMenu().then(
        (m) => m.openImageMenu(x, y, target, signal),
        (err: unknown) => log.warn("Image menu failed to load", { error: String(err) }),
      );
    },
    signal !== undefined ? { signal } : undefined,
  );
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
  imageMenuModule?.closeImageMenu();
}

/** Open a full-screen lightbox overlay with zoom and pan. */
export function openImageLightbox(
  src: string,
  alt: string,
  external?: ExternalImageSource,
  gallery?: LightboxGallery,
): void {
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
  // The image on show; a gallery step replaces it (3A-10c).
  let current: LightboxCurrent = { external, alt };
  const sourceOf = (c: LightboxCurrent): string | null =>
    c.external !== undefined && "url" in c.external ? c.external.url : null;
  // Only a public address opens in the system browser; a server attachment's
  // address needs the session token, which the browser would not have.
  const originalOf = (c: LightboxCurrent): string | null => {
    const url = sourceOf(c);
    return url !== null && isExternalUrl(url) ? url : null;
  };
  if (external !== undefined) {
    recoverEvictedImage(
      img,
      () => current.external ?? { url: "" },
      undefined,
      () => current,
    );
  }
  // `src` can be the server's thumbnail (P4-08): show it at once, then the
  // full file. A server image shown in full is a memory-cache hit here.
  if (external !== undefined && "url" in external && isServerUrl(external.url)) {
    const opened = current;
    void fetchImageAsObjectUrl(external.url).then((full) => {
      // A gallery step since the open owns the picture now.
      if (current !== opened) return;
      if (full !== null && img.isConnected && img.src !== full) img.src = full;
    });
  }
  imgWrap.appendChild(img);
  overlay.appendChild(imgWrap);

  // Top-right toolbar: Close, Download and (external images only) Open
  // original, left to right with Close in the corner.
  const toolbar = createElement("div", { class: "image-lightbox-toolbar" });
  const lightboxButton = (
    cls: string,
    label: string,
    icon: "x" | "download" | "external-link",
  ): HTMLButtonElement => {
    const btn = createElement("button", {
      class: cls,
      type: "button",
      "aria-label": label,
      title: label,
    });
    btn.appendChild(createIcon(icon, 20));
    toolbar.appendChild(btn);
    return btn;
  };
  const downloadBtn = lightboxButton(
    "image-lightbox-action",
    mediaControlsText("lightbox.download"),
    "download",
  );
  const openBtn =
    originalOf(current) === null
      ? null
      : lightboxButton(
          "image-lightbox-action",
          mediaControlsText("lightbox.openOriginal"),
          "external-link",
        );
  const closeBtn = lightboxButton("image-lightbox-close", mediaControlsText("lightbox.close"), "x");
  // DOM order is the visual order left to right, and so the Tab order.
  const controls: HTMLButtonElement[] =
    openBtn === null ? [downloadBtn, closeBtn] : [downloadBtn, openBtn, closeBtn];

  overlay.appendChild(toolbar);

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
    // A right-click opens the image menu; only the primary button pans.
    if (e.button !== 0) return;
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

  // One save path for the menu's Save Image and the Download button. It reads
  // the current image once, at the click, so a step cannot redirect it.
  const save = (): Promise<void> => {
    const c = current;
    const sourceUrl = sourceOf(c);
    const shown = img.src;
    if (sourceUrl !== null && isServerUrl(sourceUrl)) return downloadFile(sourceUrl, c.alt);
    if (sourceUrl === null) return saveImageBytes(shown, "");
    // The broker's bytes, not img.src: a lightbox opened from a frozen GIF
    // shows a one-frame preview.
    return fetchExternalImage({ url: sourceUrl }).then((bytes) =>
      saveImageBytes(bytes ?? shown, sourceUrl),
    );
  };
  bindImageMenu(
    {
      img,
      get link() {
        return originalOf(current);
      },
      // img may still show the thumbnail or a frozen GIF frame it opened with.
      get full() {
        const sourceUrl = sourceOf(current);
        return sourceUrl === null
          ? undefined
          : isServerUrl(sourceUrl)
            ? () => fetchImageAsObjectUrl(sourceUrl)
            : () => fetchExternalImage({ url: sourceUrl });
      },
      save,
    },
    disposable.signal,
  );

  // aria-disabled, not disabled: a disabled button drops focus and with it the
  // Tab cycle, which keys off the focused control.
  let saving = false;
  downloadBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (saving) return;
    saving = true;
    const filename = current.alt;
    downloadBtn.setAttribute("aria-disabled", "true");
    save()
      .catch((err: unknown) => {
        log.error("Lightbox download failed", { filename, error: String(err) });
        showToast(messageStatusText("file.downloadFailed", { filename }), "error");
      })
      .finally(() => {
        saving = false;
        downloadBtn.removeAttribute("aria-disabled");
      });
  });
  openBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const originalUrl = originalOf(current);
    if (originalUrl === null) return;
    desktop.urlOpener.open(originalUrl).catch((err: unknown) => {
      log.warn("Open original image failed", { error: String(err) });
      showToast(mediaControlsText("lightbox.openFailed"), "error");
    });
  });

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
    // The Menu key / Shift+F10 open the image's menu from whichever toolbar
    // button has focus, centred on the image.
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    }
    if (e.key === "Tab") {
      // Contain focus in the dialog: Tab cycles through its toolbar buttons.
      e.preventDefault();
      const at = controls.findIndex((c) => c === document.activeElement);
      const step = e.shiftKey ? -1 : 1;
      const next = at === -1 ? (e.shiftKey ? controls.length - 1 : 0) : at + step;
      controls[(next + controls.length) % controls.length]?.focus();
    }
    // Ctrl/Cmd with these keys zooms the whole app, not the image.
    if (e.ctrlKey || e.metaKey) return;
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
  closeBtn.focus();

  // Two or more images: the arrows, counter and stepping load on demand, so a
  // single-image open never pays for them.
  if (gallery !== undefined && gallery.items.length > 1) {
    const handle: LightboxHandle = {
      overlay,
      img,
      controls,
      signal: disposable.signal,
      setCurrent: (next) => {
        current = next;
      },
      resetView: () => {
        isDragging = false;
        overlay.classList.remove("dragging");
        resetZoom();
      },
      closeMenu: () => imageMenuModule?.closeImageMenu(),
      // The menu's own class (image-menu.ts MENU_CLASS): asked of the DOM so it
      // holds even before the lazy menu module has loaded.
      isImageMenuOpen: () => document.querySelector(".image-context-menu") !== null,
      fetchImageAsObjectUrl,
      thumbnailUrl,
      close,
    };
    import("./lightbox-gallery").then(
      (m) => {
        if (!disposable.signal.aborted) m.attachLightboxGallery(gallery, handle);
      },
      (err: unknown) => log.warn("Lightbox gallery failed to load", { error: String(err) }),
    );
  }
}
