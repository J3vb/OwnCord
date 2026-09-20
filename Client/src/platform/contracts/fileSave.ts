/**
 * No-seam: both operations sit inside `downloadFile`, a private function in
 * `message-list/attachments.ts` — there is no exported function to bind a
 * legacy suite against yet. The suite lands with the seam in B7-4 (proposed).
 */
export interface FileSaver {
  /** Prompt the user to choose a save location, pre-filled with
   *  `suggestedName`. Resolves null when the user cancels. */
  pickSaveLocation(suggestedName: string): Promise<string | null>;
  /** Write `data` to `path` on disk. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
}
