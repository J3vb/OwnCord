/**
 * Where an avatar's bytes come from. An uploaded avatar is stored at full size
 * (up to 1024 px) but drawn in 32-40 px slots, so a surface asks the server for
 * its small preview (`/api/v1/files/{id}/thumb?size=N`) and only a person
 * pointing at an animated one pays for the original.
 *
 *  - List surfaces (members, messages, DMs, voice, the user bar) take the
 *    128 px preview, profile cards and popups the 256 px one.
 *  - Only an own-server `/api/v1/files/{id}` URL has a preview; an external URL
 *    or a data: URI is fetched as it is.
 *  - A failed preview request falls back to the original URL.
 *  - The server marks the preview of an animated GIF; that one stays a still
 *    and the original is fetched when its row is hovered or focused. A preview
 *    that is not marked never fetches the original.
 */

import { motionReduced, bindAnimatedImage, type AnimationMode } from "@lib/ui/animatedStill";
import { fetchImageAsObjectUrl, smallThumbnailUrl } from "../messaging/content/attachments";

/** The preview sizes the server keeps: list rows, and profile surfaces. */
export type AvatarThumbSize = 128 | 256;

/** The URL to fetch first for `resolved`: its small preview, else itself. */
export function avatarFetchUrl(resolved: string, size: AvatarThumbSize): string {
  return smallThumbnailUrl(resolved, size) ?? resolved;
}

/** Fetch the avatar at `resolved` as a blob: URL, from its preview at `size`
 *  when it has one and from the original when that fails. */
export function fetchAvatarObjectUrl(
  resolved: string,
  size: AvatarThumbSize,
): Promise<string | null> {
  const first = avatarFetchUrl(resolved, size);
  if (first === resolved) return fetchImageAsObjectUrl(resolved);
  return fetchImageAsObjectUrl(first).then((objectUrl) =>
    objectUrl === null ? fetchImageAsObjectUrl(resolved) : objectUrl,
  );
}

/**
 * Play `originalUrl` over `still` (a preview already on `img`) as `mode` says:
 * the original is fetched the first time its row is hovered or focused, or at
 * once for an avatar that always plays (never under reduced motion, where the
 * still is all that shows). A failed fetch leaves the still.
 */
export function playOriginalOnEngage(
  img: HTMLImageElement,
  still: string,
  originalUrl: string,
  mode: AnimationMode,
): void {
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    void fetchImageAsObjectUrl(originalUrl).then((original) => {
      if (original !== null) bindAnimatedImage(img, original, still, mode);
    });
  };
  if (mode === "always") {
    if (!motionReduced()) start();
    return;
  }
  const target = mode.hover;
  if (target.matches(":hover") || target.matches(":focus-within")) {
    start();
    return;
  }
  target.addEventListener("pointerenter", start, { once: true });
  target.addEventListener("focusin", start, { once: true });
}
