/**
 * Intrinsic image size from a file's first bytes (PNG IHDR, GIF logical
 * screen, JPEG SOF, WebP VP8/VP8L/VP8X), so a row can reserve its box before
 * the image decodes. Pure: works on a `Uint8Array`, never touches the DOM.
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** How much of a file the sniffer reads: a JPEG's SOF can sit behind an
 *  EXIF/ICC block of tens of kilobytes, every other format needs under 40 bytes. */
export const HEADER_SNIFF_BYTES = 64 * 1024;

/** Larger than any real picture; a header claiming more is corrupt or hostile. */
const MAX_DIMENSION = 32768;

function accept(width: number, height: number): ImageSize | null {
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function sniffPng(b: Uint8Array): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length, "IHDR", width, height.
  if (b.length < 24 || b[0] !== 0x89 || !ascii(b, 1, "PNG") || !ascii(b, 12, "IHDR")) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return accept(v.getUint32(16), v.getUint32(20));
}

function sniffGif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !(ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return accept(v.getUint16(6, true), v.getUint16(8, true));
}

/** SOF markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function sniffJpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    // Standalone markers (no length): TEM, RSTn.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / scan: no frame header seen
    const length = v.getUint16(at + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (at + 9 > b.length) return null;
      return accept(v.getUint16(at + 7), v.getUint16(at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function sniffWebp(b: Uint8Array): ImageSize | null {
  if (b.length < 25 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    // Lossy: frame tag, start code 9d 01 2a, then 14-bit width and height.
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return accept((b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    // Lossless: signature 0x2f, then 14-bit (width - 1) and (height - 1).
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return accept((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8X")) {
    // Extended: 24-bit (canvas width - 1) and (canvas height - 1).
    if (b.length < 30) return null;
    const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
    const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
    return accept(w, h);
  }
  return null;
}

/** The size a file's header declares, or null when the format is unknown, the
 *  header is cut short, or the size is zero or absurd. */
export function sniffImageSize(bytes: Uint8Array): ImageSize | null {
  return sniffPng(bytes) ?? sniffGif(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
}

/** `sniffImageSize` over a blob's first 64 KB. Null when the blob cannot be
 *  read (a host without `Blob.arrayBuffer`) as well as when the header is
 *  unrecognised: the caller keeps its fallback box either way. */
export async function sniffImageBlob(blob: Blob): Promise<ImageSize | null> {
  try {
    const head = await blob.slice(0, HEADER_SNIFF_BYTES).arrayBuffer();
    return sniffImageSize(new Uint8Array(head));
  } catch {
    return null;
  }
}
