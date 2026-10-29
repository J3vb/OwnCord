/**
 * Group DM icon upload: pick a picture, centre-crop it to a square,
 * scale it down and send it. Loaded lazily from the DM row menu, so the canvas
 * work and its copy stay out of the main page chunk.
 *
 * Nothing here throws: a decode, canvas or network failure becomes the text to
 * show. The store is never written; the `dm_channel_open` the server sends to
 * every member (a 204 included) carries the new icon.
 */

import type { ApiClient } from "@lib/api";
import { cropImage, type CropResult } from "@lib/imageCrop";
import { groupActionErrorText } from "./groupMembers";

/** A group icon is drawn at most ~40 px; 512 keeps it sharp on dense screens. */
const MAX_EDGE = 512;

export type GroupIconCrop = CropResult;

/**
 * Centre-crop `file` to a square of at most 512x512 and encode it: PNG, or
 * WebP, then JPEG, when the PNG is over the server's 1 MiB limit.
 */
export function cropGroupIcon(file: File): Promise<GroupIconCrop> {
  return cropImage(file, { aspect: 1, maxWidth: MAX_EDGE, fileBase: "group-icon" });
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
