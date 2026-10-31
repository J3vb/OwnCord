/**
 * The attachment-cache helpers a profile banner needs, handed to
 * `paintBanner` by the popup, the DM panel and the Account card. Kept apart
 * from `banner.ts` so that module does not load the attachment cache.
 */

import type { BannerImages } from "./banner";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "../messaging/content/attachments";
import { avatarStill } from "./avatar";

/** A banner's still is drawn no larger than its widest surface at 2x. */
const BANNER_STILL_SIDE = 1200;

export const bannerImages: BannerImages = {
  fetch: (url) => fetchImageAsObjectUrl(url),
  resolve: (path) => resolveServerUrl(path),
  recover: (img, url) => recoverEvictedImage(img, { url }),
  still: (objectUrl) => avatarStill(objectUrl, BANNER_STILL_SIDE),
};
