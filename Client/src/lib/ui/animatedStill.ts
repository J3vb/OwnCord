/**
 * Animated avatars and banners: a GIF, animated WebP or animated PNG
 * shows its first frame until its row is hovered, and never plays under
 * reduced motion.
 *
 * The client makes the still itself, the way custom emoji do
 * (`features/messaging/emojiStill.ts`): the server stores one file. The still
 * is a PNG data URL of frame one, scaled down to the largest side the surface
 * draws, so it pins no blob: URL and needs no revoking.
 */

/** Whether `bytes` (the whole file) is an image with more than one frame. */
export function isAnimatedImage(bytes: Uint8Array): boolean {
  if (startsWith(bytes, 0, "GIF8")) return isAnimatedGif(bytes);
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) {
    // Extended format: the flags byte follows the VP8X fourcc and its size;
    // bit 1 is the animation flag.
    return startsWith(bytes, 12, "VP8X") && bytes.length > 20 && ((bytes[20] ?? 0) & 0x02) !== 0;
  }
  if (startsWith(bytes, 0, "\x89PNG")) return isAnimatedPng(bytes);
  return false;
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (bytes.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Skip a run of GIF data sub-blocks starting at `at`; the offset after the
 *  terminator, or -1 when the file ends first. */
function skipSubBlocks(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i < bytes.length) {
    const size = bytes[i] ?? 0;
    if (size === 0) return i + 1;
    i += size + 1;
  }
  return -1;
}

/** A GIF is animated when it holds a second image (a looping extension alone
 *  is not enough: some encoders write one on a single frame). */
function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13) return false;
  const screenFlags = bytes[10] ?? 0;
  let i = 13;
  if ((screenFlags & 0x80) !== 0) i += 3 << ((screenFlags & 0x07) + 1);
  let images = 0;
  while (i < bytes.length) {
    const block = bytes[i];
    if (block === 0x3b) return false;
    if (block === 0x21) {
      // Extension: introducer, label, then sub-blocks.
      i = skipSubBlocks(bytes, i + 2);
    } else if (block === 0x2c) {
      images++;
      if (images > 1) return true;
      if (i + 10 > bytes.length) return false;
      const imageFlags = bytes[i + 9] ?? 0;
      i += 10;
      if ((imageFlags & 0x80) !== 0) i += 3 << ((imageFlags & 0x07) + 1);
      // The LZW minimum code size byte, then the image data.
      i = skipSubBlocks(bytes, i + 1);
    } else {
      return false;
    }
    if (i < 0) return false;
  }
  return false;
}

/** An APNG names itself with an acTL chunk before its first IDAT. */
function isAnimatedPng(bytes: Uint8Array): boolean {
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length =
      (((bytes[i] ?? 0) << 24) |
        ((bytes[i + 1] ?? 0) << 16) |
        ((bytes[i + 2] ?? 0) << 8) |
        (bytes[i + 3] ?? 0)) >>>
      0;
    if (startsWith(bytes, i + 4, "acTL")) return true;
    if (startsWith(bytes, i + 4, "IDAT")) return false;
    i += 12 + length;
  }
  return false;
}

/** Whether motion is reduced right now (the OS setting or the app toggle,
 *  both of which land on this class: `lib/ui/osMotion.ts`). */
export function motionReduced(): boolean {
  return document.documentElement.classList.contains("reduced-motion");
}

/** Frame one of the image at `src`, at most `maxSide` px on its longer side,
 *  as a PNG data URL; null when it cannot be decoded or drawn. An image's
 *  first `load` is its first frame, which is what is drawn. */
export function captureFirstFrame(src: string, maxSide: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener(
      "load",
      () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w === 0 || h === 0) {
          resolve(null);
          return;
        }
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        try {
          const ctx = canvas.getContext("2d");
          if (ctx === null) {
            resolve(null);
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(null);
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      },
      { once: true },
    );
    img.addEventListener("error", () => resolve(null), { once: true });
    img.src = src;
  });
}

// One answer per loaded source and size: the still, or null for a picture
// that does not move. Bounded; the oldest entry goes first. Cleared with the
// image caches, whose blob: URLs are its keys.
const MAX_STILLS = 256;
const stills = new Map<string, Promise<string | null>>();

/**
 * The still for the image at `objectUrl`, or null when it is not animated (or
 * its first frame could not be drawn: it then plays, rather than going blank).
 * `readBytes` hands over the file's bytes, or null when they are not at hand.
 */
export function animatedStill(
  objectUrl: string,
  maxSide: number,
  readBytes: () => Promise<Uint8Array | null>,
): Promise<string | null> {
  const key = `${maxSide}|${objectUrl}`;
  const known = stills.get(key);
  if (known !== undefined) return known;
  const pending = (async (): Promise<string | null> => {
    const bytes = await readBytes();
    if (bytes === null || !isAnimatedImage(bytes)) return null;
    return captureFirstFrame(objectUrl, maxSide);
  })().catch(() => null);
  stills.set(key, pending);
  if (stills.size > MAX_STILLS) {
    const oldest = stills.keys().next().value;
    if (oldest !== undefined) stills.delete(oldest);
  }
  return pending;
}

/** Forget every still (the image caches were cleared). */
export function clearAnimatedStills(): void {
  stills.clear();
}

/** When an animated picture plays: while `hover` (its row) is pointed at or
 *  focused, or always. Neither plays under reduced motion. */
export type AnimationMode = { readonly hover: HTMLElement } | "always";

/**
 * Show `still` on `img` and play `animatedUrl` as `mode` says, following the
 * reduced-motion setting live. Listeners on a hover row that outlives the
 * image, and the motion observer, drop themselves the first time they find
 * the image detached.
 */
export function bindAnimatedImage(
  img: HTMLImageElement,
  animatedUrl: string,
  still: string,
  mode: AnimationMode,
): void {
  let animated = animatedUrl;
  // Keeps the animated source loadable while the image is mounted: the image
  // cache does not evict a URL a mounted image names here.
  img.dataset["mediaSrc"] = animated;
  // An evicted source is reloaded under a new blob: URL
  // (recoverEvictedImage); follow it, so the next hover plays that one.
  img.addEventListener("load", () => {
    if (img.src.startsWith("blob:") && img.src !== animated) {
      animated = img.src;
      img.dataset["mediaSrc"] = animated;
    }
  });
  const play = (): void => {
    if (!motionReduced() && img.src !== animated) img.src = animated;
  };
  const stop = (): void => {
    if (img.src !== still) img.src = still;
  };
  const target = mode === "always" ? null : mode.hover;
  // The row may already be hovered or focused when the still arrives.
  const engaged = (): boolean =>
    target === null || target.matches(":hover") || target.matches(":focus-within");
  const settle = (): void => {
    if (motionReduced() || !engaged()) stop();
    else play();
  };
  settle();

  // The image may be bound before it is mounted, so only an image that was
  // connected and then left the document counts as gone.
  let seenConnected = img.isConnected;
  const gone = (): boolean => {
    if (img.isConnected) {
      seenConnected = true;
      return false;
    }
    return seenConnected;
  };
  const motion = new MutationObserver(() => {
    if (gone()) {
      motion.disconnect();
      return;
    }
    settle();
  });
  motion.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  if (target === null) return;
  const handlers: Array<[string, () => void]> = [];
  const on = (type: string, fn: () => void): void => {
    const handler = (): void => {
      if (img.isConnected) {
        fn();
        return;
      }
      for (const [t, h] of handlers) target.removeEventListener(t, h);
      motion.disconnect();
    };
    handlers.push([type, handler]);
    target.addEventListener(type, handler);
  };
  on("pointerenter", play);
  on("pointerleave", stop);
  on("focusin", play);
  on("focusout", () => {
    if (!target.matches(":hover")) stop();
  });
}
