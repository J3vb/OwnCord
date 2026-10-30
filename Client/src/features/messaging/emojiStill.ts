/**
 * "Animate emoji" (Settings → Text & Images): when it is off, a custom emoji
 * shows its first frame instead of playing.
 *
 * GIF autoplay (`animateGifs`) is read by the message-list media code, which
 * freezes a GIF behind a play button. An emoji is inline text-sized art with
 * no controls, so it gets the same capture without the button: the animated
 * bytes are loaded once, drawn to a canvas, and the PNG of frame one replaces
 * the source. A static emoji passes through the same path and looks the same.
 */

import { loadPref } from "../../lib/prefs/preferences";

/** Whether custom emoji should animate. Read at render, so a new message follows the switch. */
export function animateEmojiEnabled(): boolean {
  return loadPref<boolean>("animateEmoji", true);
}

/** The first frame of a loaded image as a PNG data URL, or null when it cannot be drawn. */
export function captureStill(img: HTMLImageElement): string | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w === 0 || h === 0) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Point `img` at `objectUrl`, then swap in its first frame once it has loaded.
 * If a frame cannot be captured the emoji keeps the loaded source, so it still
 * shows (animated) rather than going blank.
 */
export function showStillFrame(img: HTMLImageElement, objectUrl: string): void {
  const cached = stills.get(objectUrl);
  if (cached !== undefined) {
    img.src = cached;
    return;
  }
  // The listener lives on the image itself and goes with it.
  img.addEventListener(
    "load",
    () => {
      const still = captureStill(img);
      if (still === null || img.src === still) return;
      rememberStill(objectUrl, still);
      img.src = still;
    },
    { once: true },
  );
  img.src = objectUrl;
}

// One capture per loaded emoji source, so a picker or a busy channel encodes
// each emoji once. Bounded; the oldest entry goes first.
const MAX_STILLS = 256;
const stills = new Map<string, string>();

function rememberStill(objectUrl: string, still: string): void {
  stills.delete(objectUrl);
  stills.set(objectUrl, still);
  if (stills.size > MAX_STILLS) {
    const oldest = stills.keys().next().value;
    if (oldest !== undefined) stills.delete(oldest);
  }
}

/** Test seam: forget every cached still. */
export function clearStillCache(): void {
  stills.clear();
}
