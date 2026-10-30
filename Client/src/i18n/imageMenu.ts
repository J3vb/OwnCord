import { defineCatalog } from "./format";

/** The chat image right-click menu (message-list/imageMenu.ts). Its own
 *  catalog so the copy loads with that lazy module, not at startup. */
export const imageMenuText = defineCatalog("imageMenu", {
  copy: "Copy Image",
  copyLink: "Copy Link",
  openLink: "Open Link",
  save: "Save Image",
  copied: "Image copied",
  copyFailed: "Couldn't copy the image",
  linkCopied: "Link copied",
  linkCopyFailed: "Couldn't copy the link",
  openFailed: "Couldn't open the link",
  saveFailed: "Couldn't save the image",
});
