// The Android app's save and share (`src-tauri/src/files.rs`, `FilesPlugin.kt`).
// The bytes go to the host as the raw command body, the name in a header; the
// host stages them in its cache and Android takes them from there. Loaded on
// the first save or share, so the startup chunk carries none of it.
import { invokeOrThrow } from "./nativeInvoke";
import type { SavedTo } from "../contracts/fileSave";

/** Read by `files.rs`; a header value is ASCII only, so the name is encoded. */
const NAME_HEADER = "x-owncord-file-name";

interface SaveReply {
  readonly status: "saved" | "shared";
  readonly folder: "pictures" | "downloads";
}

function nameHeader(name: string): { headers: Record<string, string> } {
  // A lone surrogate (a broken emoji) would make encodeURIComponent throw.
  const wellFormed = name.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  return { headers: { [NAME_HEADER]: encodeURIComponent(wellFormed) } };
}

/** The file name a save path stands for: there is no dialog on Android, so
 *  the "path" is the suggested name, maybe with folders the host drops. */
function lastSegment(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Save into the phone's shared storage; resolves where the file went. */
export async function saveToPhone(path: string, data: Uint8Array): Promise<SavedTo> {
  const reply = await invokeOrThrow<SaveReply>("save_file", data, nameHeader(lastSegment(path)));
  return reply.status === "shared" ? "shared" : reply.folder;
}

export async function shareFile(name: string, data: Uint8Array): Promise<void> {
  await invokeOrThrow<null>("share_file", data, nameHeader(name));
}

export async function shareText(text: string): Promise<void> {
  await invokeOrThrow<null>("share_text", { text });
}
