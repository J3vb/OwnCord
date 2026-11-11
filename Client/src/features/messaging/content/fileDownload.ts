/** Saving and sharing a file's bytes: the download behind every file button. */

import { showToast } from "@lib/ui/toast";
import { announceSaved } from "@lib/ui/savedNotice";
import { desktop } from "../../../platform/desktop";
import { messageStatusText } from "../../../i18n/messageStatus";
import { fileTransferText } from "../../../i18n/fileTransfer";
import { fetchServerFile } from "./attachmentCache";
import { log } from "./attachmentUrls";

/** What a file button does with the bytes: save them, or (where the host
 *  has a share sheet) hand them to another app. */
export type FileAction = "save" | "share";

export function failedText(action: FileAction, filename: string): string {
  return action === "share"
    ? fileTransferText("shareFailed", { filename })
    : messageStatusText("file.downloadFailed", { filename });
}

/** Saves and shares in flight, by action and URL: a second tap while the first
 *  still runs does nothing, so a slow download is not saved twice. */
const inFlight = new Set<string>();

/** Download a file via Tauri HTTP plugin and save to disk with native dialog,
 *  or open the share sheet on it. `fs:allow-write-file` is statically scoped
 *  to `$APPLOG` (nothing covers app data); the save dialog grants the one path
 *  the user chose at runtime, so the dialog itself is the boundary for the
 *  download. The Android app has no dialog: the host saves into shared
 *  storage and a toast says where. */
export async function downloadFile(
  url: string,
  filename: string,
  action: FileAction = "save",
): Promise<void> {
  const key = `${action} ${url}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    // The dialog opens before the fetch, so it answers the click at once.
    const filePath = action === "save" ? await desktop.fileSaver.pickSaveLocation(filename) : null;
    if (action === "save" && filePath === null) return; // User cancelled

    // Fetch file data — server downloads go through the cert-pinned HTTP proxy
    // with the session bearer token (the files endpoint requires auth).
    const res = await fetchServerFile(url);
    if (!res.ok) {
      log.error("Download failed", { filename, status: res.status });
      showToast(messageStatusText("file.downloadHttpFailed", { status: res.status }), "error");
      return;
    }

    const data = new Uint8Array(await res.arrayBuffer());
    if (filePath === null) await desktop.shareSheet.shareFile(filename, data);
    else announceSaved(await desktop.fileSaver.writeFile(filePath, data), filename);
  } catch (err) {
    log.error(action === "share" ? "Share failed" : "Download failed", {
      filename,
      error: String(err),
    });
    showToast(failedText(action, filename), "error");
  } finally {
    inFlight.delete(key);
  }
}
