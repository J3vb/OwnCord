import { defineCatalog } from "./format";

/** Rich-content loading, failure and media-control copy (B9-9): the typed
 *  view states a link preview, an external image and the GIF picker show once
 *  the viewer has consented. User/server data (a host, a filename) passes
 *  through parameters; provider names are attribution, not translation. */
export const contentText = defineCatalog("content", {
  "preview.failed": "Preview unavailable",
  "preview.retry": "Retry preview",
  "image.failed": "Image unavailable",
  "image.retry": "Retry image",
  "image.alt": "Image from {host}",
  "image.open": "Open image from {host}",
  "gif.failed": "Couldn't load GIFs",
  "gif.retry": "Retry",
  "youtube.title.loading": "Loading...",
  "youtube.title.fallback": "YouTube Video",
  "youtube.thumbAlt": "YouTube video",
});
