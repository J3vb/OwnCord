import { defineCatalog } from "./format";

/** Copy for the always-loaded attachment/media controls (B9-9): the server
 *  media failure line and the lightbox. The full rich-content catalog
 *  (./content.ts) is read only once a preview or image is rendered, so it
 *  stays out of the startup chunk. */
export const mediaControlsText = defineCatalog("mediaControls", {
  "media.failed": "Media unavailable",
  "media.retry": "Retry",
  "lightbox.close": "Close image",
});
