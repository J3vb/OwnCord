/**
 * The server-content caches that one session reset empties: server images,
 * their in-flight fetches and refusals, media blob URLs and learnt video sizes,
 * and the minted file links. They live together so the one reset that owns
 * them sits beside them; attachmentImages and attachmentMedia fill them.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";
import { clearAnimatedStills } from "@lib/ui/animatedStill";
import { clearStillCache } from "../emojiStill";
import { clearTextPreviewCache } from "../textPreview";
import { ObjectUrlCache, bumpGeneration } from "./attachmentObjectUrls";

/** What server images may pin in memory as blob: URLs, for instant re-render. */
export const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const imageCache = new ObjectUrlCache(IMAGE_CACHE_MAX_BYTES, Number.POSITIVE_INFINITY, true);
/** Server images the server definitely refused (missing, gone, forbidden).
 *  Asking again on every mount only repeated the answer — each one was
 *  fetched twice in the audit's channel-switch run. Retry and a cache
 *  clear ask again. */
export const missingImages = new Set<string>();
/** In-flight fetch promises to prevent duplicate concurrent requests. */
export const imageInFlight = new Map<string, Promise<string | null>>();

/** Each entry pins a whole video/audio Blob, so the cap is in bytes as well as
 *  count: an unbounded map here quietly holds every clip played this session. */
const MEDIA_CACHE_MAX = 20;
const MEDIA_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** Resolved blob: URLs keyed by attachment URL, so re-rendering a row (virtual
 *  scroll rebuilds the window constantly) reuses one download. */
export const mediaCache = new ObjectUrlCache(MEDIA_CACHE_MAX_BYTES, MEDIA_CACHE_MAX);
/** In-flight media fetches, deduplicated the same way images are. */
export const mediaInFlight = new Map<string, Promise<string | null>>();

/** Real video sizes learnt on play, so a row rebuilt by the virtual list keeps
 *  the clip's shape instead of falling back to the 16:9 placeholder. */
export const videoDims = new Map<string, readonly [number, number]>();
export const VIDEO_DIMS_CAP = 500;

/** A source a media element can load with no Authorization header. */
export interface FileLink {
  /** Origin (the loopback proxy on desktop, the page's own in a browser) plus
   *  the server's link path. It carries a credential: never log it. */
  readonly src: string;
  readonly expiresAtMs: number;
}

/** Minted links by attachment URL; re-rendered rows reuse one. */
export const fileLinks = new Map<string, FileLink>();
/** In-flight mints, so rows showing the same clip share one request. */
export const fileLinkInFlight = new Map<string, Promise<FileLink | null>>();
/** Attachment URLs the server answered 404 or 405 for: a server without the
 *  route (or without the file). They go straight to the blob path. */
export const fileLinkRefused = new Set<string>();

export function clearAttachmentCaches(): void {
  bumpGeneration();
  imageCache.clear();
  missingImages.clear();
  imageInFlight.clear();
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
