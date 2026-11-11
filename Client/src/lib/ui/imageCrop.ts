/**
 * Centre-crop a picked image to an aspect ratio, scale it down and re-encode it
 * for an upload the server limits to 1 MiB (group DM icon: 1:1 at 512; profile
 * banner: 5:2 at 1200). Canvas work stays out of the main chunk because both
 * callers load it lazily.
 *
 * Nothing here throws: a decode, canvas or encode failure becomes the text to
 * show.
 */

import { accountText } from "../../i18n/account";

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** The server refuses an upload over 1 MiB. */
const MAX_BYTES = 1024 * 1024;

export interface CropSpec {
  /** Width over height of the result, for example 1 or 2.5. */
  readonly aspect: number;
  /** The result is never wider than this (and never upscaled). */
  readonly maxWidth: number;
  /** Name of the produced file, without the extension. */
  readonly fileBase: string;
}

export type CropResult =
  { readonly ok: true; readonly file: File } | { readonly ok: false; readonly error: string };

interface DecodedImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly release: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage | null> {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    }
    return await new Promise<DecodedImage | null>((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.addEventListener(
        "load",
        () =>
          resolve({
            source: img,
            width: img.naturalWidth,
            height: img.naturalHeight,
            release: () => URL.revokeObjectURL(url),
          }),
        { once: true },
      );
      img.addEventListener(
        "error",
        () => {
          URL.revokeObjectURL(url);
          resolve(null);
        },
        { once: true },
      );
      img.src = url;
    });
  } catch {
    return null;
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, 0.9);
    } catch {
      resolve(null);
    }
  });
}

interface CropGeometry {
  readonly cropW: number;
  readonly cropH: number;
  readonly outW: number;
  readonly outH: number;
}

/** The largest rectangle of the wanted shape that fits inside the picture, and its scaled size. */
function cropGeometry(image: DecodedImage, spec: CropSpec): CropGeometry {
  const wide = image.width / image.height > spec.aspect;
  const cropW = wide ? Math.max(1, Math.round(image.height * spec.aspect)) : image.width;
  const cropH = wide ? image.height : Math.max(1, Math.round(image.width / spec.aspect));
  const outW = Math.min(cropW, spec.maxWidth);
  const outH = outW === cropW ? cropH : Math.max(1, Math.round(outW / spec.aspect));
  return { cropW, cropH, outW, outH };
}

/** Size `canvas` and draw the centred crop onto it; false when it has no 2D context. */
function drawCrop(canvas: HTMLCanvasElement, image: DecodedImage, g: CropGeometry): boolean {
  canvas.width = g.outW;
  canvas.height = g.outH;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return false;
  ctx.drawImage(
    image.source,
    Math.floor((image.width - g.cropW) / 2),
    Math.floor((image.height - g.cropH) / 2),
    g.cropW,
    g.cropH,
    0,
    0,
    g.outW,
    g.outH,
  );
  return true;
}

/** PNG first; when it is over the limit try WebP, then JPEG. */
async function encodeUnderLimit(canvas: HTMLCanvasElement): Promise<Blob | null> {
  let blob = await canvasBlob(canvas, "image/png");
  if (blob !== null && blob.size > MAX_BYTES) blob = await canvasBlob(canvas, "image/webp");
  if (blob !== null && blob.size > MAX_BYTES) blob = await canvasBlob(canvas, "image/jpeg");
  return blob;
}

/** The result for an encoded blob: its file, or the too-large message. */
function cropResultOf(blob: Blob, spec: CropSpec): CropResult {
  if (blob.size > MAX_BYTES) {
    return {
      ok: false,
      error: accountText("avatar.tooLarge", { kb: String(MAX_BYTES / 1024) }),
    };
  }
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
  return { ok: true, file: new File([blob], `${spec.fileBase}.${ext}`, { type: blob.type }) };
}

/**
 * Centre-crop `file` to `spec.aspect`, cap it at `spec.maxWidth` and encode it:
 * PNG, or WebP, then JPEG, when the PNG is over the server's 1 MiB limit.
 */
export async function cropImage(file: File, spec: CropSpec): Promise<CropResult> {
  const unreadable = { ok: false, error: accountText("avatar.unreadable") } as const;
  if (!ACCEPTED_TYPES.has(file.type)) {
    return { ok: false, error: accountText("avatar.notImage") };
  }
  const image = await decodeImage(file);
  if (image === null) return unreadable;
  let canvas: HTMLCanvasElement | null = null;
  try {
    if (image.width <= 0 || image.height <= 0) return unreadable;
    canvas = document.createElement("canvas");
    if (!drawCrop(canvas, image, cropGeometry(image, spec))) return unreadable;
    // A browser that cannot encode a type (WebKit has no WebP) answers with
    // PNG, so the file is named and typed from what came back, not from what
    // was asked for.
    const blob = await encodeUnderLimit(canvas);
    return blob === null ? unreadable : cropResultOf(blob, spec);
  } catch {
    return unreadable;
  } finally {
    // Free the pixel buffer now rather than when the GC gets to it.
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
    image.release();
  }
}
