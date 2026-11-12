/**
 * The upload handle behind a composer chip, and the clipboard test that tells a
 * pasted file list from text.
 */
import { Disposable } from "@lib/disposable";
import type { MessageInputOptions, DraftUpload } from "../MessageInput";

/** Start uploading `file`, after `before` when given; the returned upload
 *  outlives any one chip. */
export function startUpload(
  upload: NonNullable<MessageInputOptions["onUploadFile"]>,
  file: File,
  before?: Promise<void>,
): DraftUpload {
  const owner = new Disposable();
  let settledAt: number | undefined;
  let fraction: number | null = null;
  const onProgress = (f: number): void => {
    fraction = f;
    handle.onProgress?.(f);
  };
  const result =
    before === undefined
      ? upload(file, owner.signal, onProgress)
      : before.then(() => {
          owner.signal.throwIfAborted();
          return upload(file, owner.signal, onProgress);
        });
  // Also keeps a rejection in a draft that is never restored from
  // surfacing as unhandled; whichever chip follows the upload reads it.
  result.then(
    () => (settledAt = Date.now()),
    () => {},
  );
  const handle: DraftUpload = {
    filename: file.name,
    file,
    owner,
    get settledAt() {
      return settledAt;
    },
    get fraction() {
      return fraction;
    },
    onProgress: null,
    refreshing: null,
    result,
  };
  return handle;
}

/** Clipboard text a file manager writes for copied files: nothing, or one
 *  file URI or absolute path per line. */
export function looksLikeFileList(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return text === "";
  // "/home/me/a.png", never a slash command such as "/shrug".
  return lines.every((l) => l.startsWith("file://") || /^\/[^/\s][^/]*\/./.test(l));
}
