/**
 * No-seam: both operations sit inside `downloadFile`, a private function in
 * `features/messaging/content/attachments.ts` — there is no exported function to bind a
 * legacy suite against yet. The suite lands with the seam.
 */

/** Where the host put a file when it chose the place itself: the Android app
 *  has no save dialog, so images go to Pictures/OwnCord and the rest to
 *  Downloads; on Android 9 the file goes to the share sheet instead. */
export type SavedTo = "pictures" | "downloads" | "shared";

export interface FileSaver {
  /** Prompt the user to choose a save location, pre-filled with
   *  `suggestedName`. Resolves null when the user cancels. Where there is no
   *  dialog it resolves `suggestedName`, and `writeFile` picks the place. */
  pickSaveLocation(suggestedName: string): Promise<string | null>;
  /** Write `data` to `path` on disk. Resolves where the host put the file
   *  when it chose the place, for a "Saved to" notice; null when the user
   *  or the browser chose it. */
  writeFile(path: string, data: Uint8Array): Promise<SavedTo | null>;
}
