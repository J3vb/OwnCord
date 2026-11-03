import { defineCatalog } from "./format";

/** Save and share notices: where the Android app put a saved file, and a
 *  share that failed. Its own catalog so the copy loads with the attachment
 *  and lightbox code, not at startup. */
export const fileTransferText = defineCatalog("fileTransfer", {
  savedToPictures: "Saved to Pictures/OwnCord",
  savedToDownloads: "Saved {filename} to Downloads",
  shareFailed: "Couldn't share {filename}",
});
