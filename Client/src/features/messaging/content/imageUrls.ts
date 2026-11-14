/** URL tests for direct images, GIFs and the GIF picker's CDN. */

/** Check if a URL points directly to an image or GIF file. */
export function isDirectImageUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(gif|png|jpg|jpeg|webp)$/.test(pathname);
  } catch {
    return false;
  }
}

/** Check if a URL originates from the Klipy CDN. */
export function isKlipyUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "klipy.com" || hostname.endsWith(".klipy.com");
  } catch {
    return false;
  }
}

/** A direct image on the GIF provider's CDN: what the GIF picker sends. */
export function isGifPickerImage(url: string): boolean {
  return isKlipyUrl(url) && isDirectImageUrl(url);
}

/** Check if a URL points to an animated GIF. */
export function isGifUrl(url: string): boolean {
  try {
    const pathname = new URL(url, "https://placeholder").pathname.toLowerCase();
    return pathname.endsWith(".gif");
  } catch {
    return false;
  }
}
