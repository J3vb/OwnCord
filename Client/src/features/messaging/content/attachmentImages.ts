/**
 * Server images: memory (blob: URLs) then IndexedDB then the TOFU proxy, with
 * in-flight dedupe, a bounded set of definite refusals, and recovery of an
 * `<img>` whose blob: URL a cache evicted.
 */

import { sniffImageBlob } from "@lib/ui/imageHeader";
import type {
  ExternalContentResult,
  ExternalImageSource,
} from "../../../platform/contracts/externalContent";
import { rememberBlobSize } from "./imageSizes";
import { log } from "./attachmentUrls";
import { createObjectUrl, currentGeneration, revokeObjectUrl } from "./attachmentObjectUrls";
import {
  fetchServerFile,
  isExternalUrl,
  isServerUrl,
  sanitizeContentType,
} from "./attachmentServerFetch";
import { imageCache, imageInFlight, missingImages } from "./attachmentCacheState";
import { getCacheScope, idbGet, idbKey, idbPut } from "./attachmentIdb";
import {
  fetchExternalImage,
  holdsExternalUrl,
  loadExternalImage,
  type ImageLoadOptions,
} from "./attachmentExternal";

/** Bounds `missingImages`: one entry per refused URL would otherwise grow for
 *  the whole session. Oldest dropped first. */
const MISSING_IMAGES_MAX = 1000;
const DEFINITE_FAILURES = new Set([403, 404, 410]);

/** Fetch an image and return a `blob:` URL an `<img>` can show. Server images
 *  come through memory → IndexedDB → the TOFU proxy; an external image comes
 *  from the broker and never enters those two caches, which hold server
 *  content only. */
export function fetchImageAsObjectUrl(
  url: string,
  opts?: ImageLoadOptions,
): Promise<string | null> {
  if (isExternalUrl(url)) return fetchExternalImage({ url }, opts);
  const generation = currentGeneration();
  const scope = getCacheScope();

  // 1. Memory cache (instant), and what the server already refused
  const cached = imageCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  if (missingImages.has(url)) return Promise.resolve(null);

  // 2. Deduplicate concurrent requests for the same URL
  const existing = imageInFlight.get(url);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<string | null> => {
    // 3. IndexedDB cache (persists across restarts), then the network
    const stored = scope === null ? null : await idbGet(idbKey(scope, url));
    const blob = stored ?? (await fetchImageBlob(url, generation));
    if (blob === null || generation !== currentGeneration()) return null;
    const objectUrl = createObjectUrl(blob);
    if (objectUrl === null) return null;
    if (opts?.sniff === true && stored === null) {
      rememberBlobSize(objectUrl, await sniffImageBlob(blob));
    }
    if (generation !== currentGeneration()) {
      revokeObjectUrl(objectUrl);
      return null;
    }
    // The Blob is pinned by its URL already; keeping the reference costs
    // nothing and lets an animated avatar read its frames.
    imageCache.set(url, objectUrl, blob.size, blob);
    if (stored === null && scope !== null) void idbPut(scope, url, blob);
    return objectUrl;
  })();

  imageInFlight.set(url, promise);
  void promise.finally(() => {
    if (imageInFlight.get(url) === promise) {
      imageInFlight.delete(url);
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
/** Remember a URL the server definitely refused, bounded to MISSING_IMAGES_MAX;
 *  a clear since the request started means the answer is for a gone session. */
function rememberMissingImage(url: string, status: number, generation: number): void {
  if (!DEFINITE_FAILURES.has(status) || generation !== currentGeneration()) return;
  missingImages.add(url);
  if (missingImages.size > MISSING_IMAGES_MAX) {
    const oldest = missingImages.values().next().value;
    if (oldest !== undefined) missingImages.delete(oldest);
  }
}

async function fetchImageBlob(url: string, generation: number): Promise<Blob | null> {
  try {
    const res = await fetchServerFile(url);
    if (!res.ok) {
      rememberMissingImage(url, res.status, generation);
      return null;
    }
    const type = sanitizeContentType(res.headers.get("content-type") ?? "");
    return new Blob([await res.arrayBuffer()], { type });
  } catch (err) {
    log.error("Failed to fetch attachment image", { url, error: String(err) });
    return null;
  }
}

/** Whether a blob: URL is one an image cache still holds (not revoked). */
function isLiveImageUrl(objectUrl: string): boolean {
  return imageCache.holds(objectUrl) || holdsExternalUrl(objectUrl);
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
