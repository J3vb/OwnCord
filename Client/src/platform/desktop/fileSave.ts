/**
 * Desktop file save: the native surface behind the `FileSaver` contract — the
 * OS save dialog and the write that follows it.
 *
 * Lifted verbatim from `features/messaging/content/attachments.ts`: the dialog still
 * receives `{ defaultPath }` and the file still receives the caller's bytes.
 * The dialog itself is the security boundary — the destination is the user's
 * choice, not ours.
 *
 * The Android app has no save dialog: the suggested name stands in for the
 * location, and the host puts the file in shared storage (`androidFiles.ts`).
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { isAndroidHost } from "@lib/hostPlatform";
import type { FileSaver } from "../contracts/fileSave";

export const fileSaver: FileSaver = {
  pickSaveLocation: (suggestedName) =>
    isAndroidHost() ? Promise.resolve(suggestedName) : save({ defaultPath: suggestedName }),
  writeFile: async (path, data) => {
    if (isAndroidHost()) return (await import("./androidFiles")).saveToPhone(path, data);
    await writeFile(path, data);
    return null;
  },
};
