/**
 * Turns a picked picture into a theme background: only PNG, JPEG or WebP,
 * decoded by the browser, shrunk and re-encoded on a canvas so what gets
 * stored is a small, fresh image and never the original file's bytes.
 */

import { MAX_BACKGROUND_CHARS, isBackgroundDataUrl } from "./customTheme";

export const MAX_BACKGROUND_FILE_BYTES = 15 * 1024 * 1024;

const ACCEPTED_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Longest edge and quality, tried in order until the result fits. */
const ATTEMPTS: readonly (readonly [number, number])[] = [
  [2560, 0.85],
  [1920, 0.8],
  [1280, 0.75],
];

export type BackgroundProblem = "type" | "tooBig" | "unreadable";

export type PreparedBackground =
  | { readonly ok: true; readonly image: string }
  | { readonly ok: false; readonly problem: BackgroundProblem };

export const BACKGROUND_ACCEPT = Array.from(ACCEPTED_TYPES).join(",");

/** The bitmap drawn at most `edge` pixels on its longest side, as a data URL. */
function encode(bitmap: ImageBitmap, edge: number, quality: number): string | null {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL("image/webp", quality);
  // A webview without a WebP encoder hands back PNG; JPEG is far smaller.
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", quality);
}

export async function prepareBackground(file: File): Promise<PreparedBackground> {
  if (!ACCEPTED_TYPES.has(file.type)) return { ok: false, problem: "type" };
  if (file.size > MAX_BACKGROUND_FILE_BYTES) return { ok: false, problem: "tooBig" };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  try {
    if (bitmap.width === 0 || bitmap.height === 0) return { ok: false, problem: "unreadable" };
    for (const [edge, quality] of ATTEMPTS) {
      const image = encode(bitmap, edge, quality);
      if (image === null) return { ok: false, problem: "unreadable" };
      if (image.length <= MAX_BACKGROUND_CHARS && isBackgroundDataUrl(image)) {
        return { ok: true, image };
      }
    }
    return { ok: false, problem: "tooBig" };
  } finally {
    bitmap.close();
  }
}
