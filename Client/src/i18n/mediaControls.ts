import { defineCatalog } from "./format";

/** Copy for the always-loaded media controls: the lightbox. The full
 *  rich-content catalog (./content.ts) is read only once a preview or image is
 *  rendered, so it stays out of the startup chunk. */
export const mediaControlsText = defineCatalog("mediaControls", {
  "lightbox.close": "Close image",
  "lightbox.download": "Download image",
  "lightbox.openOriginal": "Open original",
  "lightbox.prev": "Previous image",
  "lightbox.next": "Next image",
  "lightbox.position": "{index} of {total}",
  "lightbox.openFailed": "Couldn't open the image",
});
