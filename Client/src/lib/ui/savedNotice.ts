// The "Saved to" toast for a save whose place the host chose (the Android app
// has no save dialog). A save to a place the user picked needs no notice.
import type { SavedTo } from "../../platform/contracts/fileSave";
import { fileTransferText } from "../../i18n/fileTransfer";
import { showToast } from "./toast";

export function announceSaved(where: SavedTo | null, filename: string): void {
  if (where === "pictures") showToast(fileTransferText("savedToPictures"), "success");
  else if (where === "downloads")
    showToast(fileTransferText("savedToDownloads", { filename }), "success");
}
