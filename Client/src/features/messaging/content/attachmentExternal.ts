/**
 * External images: the broker's bytes as blob: URLs, with their own byte- and
 * count-bounded cache, in-flight dedupe and partition epoch.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";
import { sniffImageBlob } from "@lib/ui/imageHeader";
import { desktop } from "../../../platform/desktop";
import type {
  ExternalContentResult,
  ExternalImageSource,
  ExternalPreview,
} from "../../../platform/contracts/externalContent";
import { externalAllowed } from "../../content-consent/external";
import { rememberBlobSize } from "./imageSizes";
import { log, serverHost } from "./attachmentUrls";
import { createObjectUrl, liveBlobUrls, revokeObjectUrl } from "./attachmentObjectUrls";

/** `sniff`: read the file's header for its size, for a caller that has no
 *  dimensions of its own (a row reserving its box). Other callers skip the read. */
export interface ImageLoadOptions {
  readonly sniff?: boolean;
}

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
// Broker-fetched content belongs to the server it was fetched for.

/** Whether a blob: URL is one the broker-image cache still holds (not revoked). */
export function holdsExternalUrl(objectUrl: string): boolean {
  return [...externalObjectUrls.values()].some((entry) => entry.url === objectUrl);
}

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
