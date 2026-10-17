/**
 * Group DM icon upload (WP 3B-11b): pick a picture, centre-crop it to a square,
 * scale it down and send it. Loaded lazily from the DM row menu, so the canvas
 * work and its copy stay out of the main page chunk.
 *
 * Nothing here throws: a decode, canvas or network failure becomes the text to
 * show. The store is never written; the `dm_channel_open` the server sends to
 * every member (a 204 included) carries the new icon.
 */

import type { ApiClient } from "@lib/api";
import { accountText } from "../../i18n/account";
import { groupActionErrorText } from "./groupMembers";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** The server refuses an upload over 1 MiB. */
const MAX_BYTES = 1024 * 1024;
/** A group icon is drawn at most ~40 px; 512 keeps it sharp on dense screens. */
const MAX_EDGE = 512;

export type GroupIconCrop =
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
      const bitmap = await createImageBitmap(file);
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

/**
 * Centre-crop `file` to a square of at most 512x512 and encode it: PNG, or
 * WebP when the PNG is over the server's 1 MiB limit.
 */
export async function cropGroupIcon(file: File): Promise<GroupIconCrop> {
  const unreadable = { ok: false, error: accountText("avatar.unreadable") } as const;
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return { ok: false, error: accountText("avatar.notImage") };
  }
  const image = await decodeImage(file);
  if (image === null) return unreadable;
  try {
    if (image.width <= 0 || image.height <= 0) return unreadable;
    const side = Math.min(image.width, image.height);
    const edge = Math.min(side, MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return unreadable;
    ctx.drawImage(
      image.source,
      Math.floor((image.width - side) / 2),
      Math.floor((image.height - side) / 2),
      side,
      side,
      0,
      0,
      edge,
      edge,
    );
    let blob = await canvasBlob(canvas, "image/png");
    let name = "group-icon.png";
    if (blob !== null && blob.size > MAX_BYTES) {
      blob = await canvasBlob(canvas, "image/webp");
      name = "group-icon.webp";
    }
    if (blob === null) return unreadable;
    if (blob.size > MAX_BYTES) {
      return {
        ok: false,
        error: accountText("avatar.tooLarge", { kb: String(MAX_BYTES / 1024) }),
      };
    }
    return { ok: true, file: new File([blob], name, { type: blob.type }) };
  } catch {
    return unreadable;
  } finally {
    image.release();
  }
}

/** Open the system file picker; null when cancelled. */
export function pickGroupIconFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPTED_TYPES.join(",");
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/** Crop and upload a group's icon. Resolves to null on success, else the text to show. */
export async function uploadGroupIcon(
  api: ApiClient,
  channelId: number,
  file: File,
): Promise<string | null> {
  const cropped = await cropGroupIcon(file);
  if (!cropped.ok) return cropped.error;
  try {
    // 200 and 204 are both success; the dm_channel_open that follows is the state.
    await api.uploadGroupDmIcon(channelId, cropped.file);
    return null;
  } catch (err) {
    return groupActionErrorText(err, "icon");
  }
}

/** Remove a group's icon. Resolves to null on success, else the text to show. */
export async function removeGroupIcon(api: ApiClient, channelId: number): Promise<string | null> {
  try {
    await api.removeGroupDmIcon(channelId);
    return null;
  } catch (err) {
    return groupActionErrorText(err, "icon");
  }
}
