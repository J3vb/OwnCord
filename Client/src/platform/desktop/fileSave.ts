/**
 * Desktop file save: the native surface behind the `FileSaver` contract — the
 * OS save dialog and the write that follows it.
 *
 * Lifted verbatim from `message-list/attachments.ts` (B7-4): the dialog still
 * receives `{ defaultPath }` and the file still receives the caller's bytes.
 * The dialog itself is the security boundary — the destination is the user's
 * choice, not ours.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { FileSaver } from "../contracts/fileSave";

export const fileSaver: FileSaver = {
  pickSaveLocation: (suggestedName) => save({ defaultPath: suggestedName }),
  writeFile: (path, data) => writeFile(path, data),
};
