/**
 * Server and external image caching (memory + IndexedDB), media and file
 * links, and the external-content broker for images.
 *
 * This file is the facade: the caches live beside it in attachmentObjectUrls
 * (the shared LRU and generation counter), attachmentServerFetch,
 * attachmentIdb, attachmentImages, attachmentMedia and attachmentExternal.
 * What a cache clear and an account switch touch is decided here.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { assignCacheScope, getCacheScope, idbPrune } from "./attachmentIdb";
import { clearAttachmentCaches } from "./attachmentCacheState";

export { IMAGE_DB_MAX_BYTES, openCacheDb } from "./attachmentIdb";
export {
  IMAGE_CACHE_MAX_BYTES,
  imageCache,
  missingImages,
  videoDims,
  VIDEO_DIMS_CAP,
  clearAttachmentCaches,
} from "./attachmentCacheState";
export type { FileLink } from "./attachmentCacheState";
export { fetchImageAsObjectUrl, cachedImageBytes, recoverEvictedImage } from "./attachmentImages";
export { fetchMediaAsObjectUrl, getFileLink } from "./attachmentMedia";
export {
  isServerUrl,
  isExternalUrl,
  thumbnailUrl,
  shownImageUrl,
  isTrustedServerUrl,
  fetchServerFile,
} from "./attachmentServerFetch";
export {
  EXTERNAL_IMAGE_CACHE_MAX,
  EXTERNAL_IMAGE_CACHE_MAX_BYTES,
  externalPartition,
  clearExternalImageCache,
  externalKey,
  previewExternal,
  isExternalGif,
  fetchExternalImage,
  loadExternalImage,
} from "./attachmentExternal";
export type { ImageLoadOptions } from "./attachmentExternal";

/**
 * Point the server-content caches at the signed-in account. A change drops
 * the in-memory caches and prunes every durable entry outside the new scope,
 * so a switch leaves no previous server's or account's bytes on disk while
 * the same account keeps its entries across restarts.
 */
export function setAttachmentCacheScope(scope: string | null): void {
  if (scope === getCacheScope()) return;
  assignCacheScope(scope);
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
