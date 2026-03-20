/**
 * File attachment rendering and image caching (memory + IndexedDB).
 * Also owns the server host state and URL resolution used by other modules.
 */

import {
  createElement,
  setText,
  appendChildren,
} from "@lib/dom";
import { observeMedia } from "@lib/media-visibility";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { Attachment } from "@lib/types";
import { openImageLightbox } from "./media";

// -- Server host state --------------------------------------------------------

/** Module-level server host for resolving relative attachment URLs. */
let _serverHost: string | null = null;

/** Set the server host (called once from MainPage on connect). */
export function setServerHost(host: string): void {
  _serverHost = host;
}

/** Resolve a potentially relative URL to a full URL using the server host. */
export function resolveServerUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (_serverHost !== null) {
    return `https://${_serverHost}${url}`;
  }
  return url;
}

// -- Helpers ------------------------------------------------------------------

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
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

/** In-memory cache for instant re-render. */
const memoryCache = new Map<string, string>();

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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Read a cached data URL from IndexedDB. */
async function idbGet(url: string): Promise<string | null> {
  const db = await openCacheDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(url);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Write a data URL to IndexedDB. */
async function idbPut(url: string, dataUrl: string): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(dataUrl, url);
  } catch {
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

/** Fetch an image and return a data: URI. Uses memory → IndexedDB → network. */
export function fetchImageAsDataUrl(url: string): Promise<string | null> {
  // 1. Memory cache (instant)
  const cached = memoryCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  // 2. Deduplicate concurrent requests for the same URL
  const existing = inFlight.get(url);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<string | null> => {
    // 3. IndexedDB cache (persists across restarts)
    const idbCached = await idbGet(url);
    if (idbCached !== null) {
      memoryCache.set(url, idbCached);
      return idbCached;
    }

    // 4. Network fetch via Tauri HTTP plugin
    try {
      const res = await tauriFetch(url, {
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false },
      } as RequestInit);
      if (!res.ok) return null;

      const contentType = res.headers.get("content-type") ?? "image/png";
      const buffer = await res.arrayBuffer();
      const base64 = uint8ToBase64(new Uint8Array(buffer));
      const dataUrl = `data:${contentType};base64,${base64}`;

      // Store in both caches
      memoryCache.set(url, dataUrl);
      void idbPut(url, dataUrl);

      return dataUrl;
    } catch (err) {
      console.error("Failed to fetch attachment image:", url, err);
      return null;
    }
  })();

  inFlight.set(url, promise);
  void promise.finally(() => inFlight.delete(url));

  return promise;
}

// -- Attachment rendering -----------------------------------------------------

export function renderAttachment(att: Attachment): HTMLDivElement {
  const resolvedUrl = resolveServerUrl(att.url);
  if (isImageMime(att.mime) && isSafeUrl(resolvedUrl)) {
    const wrap = createElement("div", { class: "msg-image" });

    function attachLightbox(img: HTMLImageElement): void {
      img.addEventListener("click", () => {
        openImageLightbox(img.src, att.filename);
      });
    }

    const isGif = att.mime === "image/gif";

    // Check cache first for instant render
    const cached = memoryCache.get(resolvedUrl);
    if (cached !== undefined) {
      const img = createElement("img", {
        src: cached,
        alt: att.filename,
      }) as HTMLImageElement;
      attachLightbox(img);
      if (isGif) {
        img.addEventListener("load", () => { observeMedia(img, cached, wrap); }, { once: true });
      }
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
          }) as HTMLImageElement;
          attachLightbox(img);
          if (isGif) {
            img.addEventListener("load", () => { observeMedia(img, dataUrl, wrap); }, { once: true });
          }
          placeholder.replaceWith(img);
        }
      });
    }

    return wrap;
  }
  const wrap = createElement("div", { class: "msg-file" });
  const inner = createElement("div", { class: "msg-file-inner" });
  const icon = createElement("div", { class: "msg-file-icon" }, "\uD83D\uDCC4");
  const nameEl = createElement("div", { class: "msg-file-name" }, att.filename);
  nameEl.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  const sizeEl = createElement("div", { class: "msg-file-size" }, formatFileSize(att.size));
  const info = createElement("div", {});
  appendChildren(info, nameEl, sizeEl);
  const downloadBtn = createElement("button", {
    class: "msg-file-download",
    title: "Download",
  }, "\u2B07");
  downloadBtn.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  appendChildren(inner, icon, info, downloadBtn);
  wrap.appendChild(inner);
  return wrap;
}

/** Download a file via Tauri HTTP plugin and save to disk with native dialog. */
async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    // Show native save dialog with suggested filename
    const filePath = await save({ defaultPath: filename });
    if (filePath === null) return; // User cancelled

    // Fetch file data
    const res = await tauriFetch(url, {
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false },
    } as RequestInit);
    if (!res.ok) return;

    const buffer = await res.arrayBuffer();
    await writeFile(filePath, new Uint8Array(buffer));
  } catch (err) {
    console.error("Download failed:", err);
  }
}
