// The host side of `nativeFiles`, loaded on the first Linux drag or paste:
// parsing the host's file lists and reading each file by its token.
import { createLogger } from "@lib/logger";
import { ipcBytes } from "./ipcBytes";
import { tryInvoke } from "./nativeInvoke";
import type { NativeFile, NativeFileDrag } from "../contracts/nativeFiles";

const log = createLogger("native-files");

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
};

/** The type a picked file of this name would carry; empty when unknown. */
export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? "";
}

interface StagedFile {
  token: number;
  name: string;
  size: number;
}

function isStagedFile(raw: unknown): raw is StagedFile {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r["token"] === "number" &&
    typeof r["name"] === "string" &&
    r["name"] !== "" &&
    typeof r["size"] === "number" &&
    r["size"] >= 0
  );
}

function toNativeFiles(raw: unknown): NativeFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isStagedFile).map(({ token, name, size }) => ({
    name,
    size,
    async read(): Promise<File> {
      const result = await tryInvoke<ArrayBuffer | number[]>("read_staged_file", { token });
      if (!result.ok) throw result.error;
      return new File([ipcBytes(result.value)], name, { type: mimeForName(name) });
    },
  }));
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The host's drag event as the page sees it; null for anything malformed. */
export function parseDrag(raw: unknown, zoom: number): NativeFileDrag | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r["kind"] === "leave") return { kind: "leave" };
  const x = finite(r["x"]);
  const y = finite(r["y"]);
  if (x === null || y === null) return null;
  const at = { x: x / zoom, y: y / zoom };
  if (r["kind"] === "over") return { kind: "over", ...at };
  if (r["kind"] === "drop") return { kind: "drop", ...at, files: toNativeFiles(r["files"]) };
  return null;
}

/** The files on the clipboard; empty when it holds none or the read failed. */
export async function readClipboardFiles(): Promise<NativeFile[]> {
  const result = await tryInvoke<unknown>("clipboard_files");
  if (!result.ok) {
    log.warn("clipboard file read failed", { error: result.error.message });
    return [];
  }
  return toNativeFiles(result.value);
}
