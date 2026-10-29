/**
 * The attachment-cache helpers a profile banner needs (WP 6.11d), handed to
 * `paintBanner` by the popup, the DM panel and the Account card. They sit here
 * because `features/profiles/banner.ts` may not import `components/`.
 */

import type { BannerImages } from "../features/profiles/banner";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "./message-list/attachments";
import { avatarStill } from "./message-list/avatar";

/** A banner's still is drawn no larger than its widest surface at 2x. */
const BANNER_STILL_SIDE = 1200;

export const bannerImages: BannerImages = {
  fetch: (url) => fetchImageAsObjectUrl(url),
  resolve: (path) => resolveServerUrl(path),
  recover: (img, url) => recoverEvictedImage(img, { url }),
  still: (objectUrl) => avatarStill(objectUrl, BANNER_STILL_SIDE),
};
