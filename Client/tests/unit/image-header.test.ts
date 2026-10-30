import { describe, expect, it } from "vitest";
import { HEADER_SNIFF_BYTES, sniffImageBlob, sniffImageSize } from "../../src/lib/ui/imageHeader";

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

function png(w: number, h: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    ...ascii("PNG"),
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii("IHDR"),
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
  ]);
}

function gif(w: number, h: number, version = "GIF89a"): Uint8Array {
  return Uint8Array.from([...ascii(version), ...le16(w), ...le16(h), 0x80, 0, 0]);
}

/** SOI, an APP1 block of `padding` bytes (EXIF), then a frame header. */
function jpeg(w: number, h: number, marker = 0xc0, padding = 0): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    ...be16(2 + padding),
    ...new Array<number>(padding).fill(0x45),
    0xff,
    0xc4,
    ...be16(4),
    0,
    0, // a DHT before the frame, skipped by length
    0xff,
    marker,
    ...be16(11),
    8,
    ...be16(h),
    ...be16(w),
    1,
    1,
    0x11,
    0,
  ]);
}

function riff(chunk: string, body: number[]): Uint8Array {
  return Uint8Array.from([
    ...ascii("RIFF"),
    ...be32(0),
    ...ascii("WEBP"),
    ...ascii(chunk),
    ...be32(body.length),
    ...body,
  ]);
}

const webpLossy = (w: number, h: number): Uint8Array =>
  riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);

function webpLossless(w: number, h: number): Uint8Array {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return riff("VP8L", [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, bits >>> 24]);
}

const webpExtended = (w: number, h: number): Uint8Array =>
  riff("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

describe("sniffImageSize", () => {
  it("reads a PNG IHDR", () => {
    expect(sniffImageSize(png(900, 500))).toEqual({ width: 900, height: 500 });
  });

  it("reads a GIF logical screen, both versions", () => {
    expect(sniffImageSize(gif(480, 360))).toEqual({ width: 480, height: 360 });
    expect(sniffImageSize(gif(3, 7, "GIF87a"))).toEqual({ width: 3, height: 7 });
  });

  it("reads a JPEG baseline and progressive frame past other segments", () => {
    expect(sniffImageSize(jpeg(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(sniffImageSize(jpeg(800, 1200, 0xc2))).toEqual({ width: 800, height: 1200 });
  });

  it("finds a JPEG frame behind a large EXIF block", () => {
    expect(sniffImageSize(jpeg(640, 480, 0xc0, 30_000))).toEqual({ width: 640, height: 480 });
  });

  it("reads WebP lossy, lossless and extended headers", () => {
    expect(sniffImageSize(webpLossy(320, 200))).toEqual({ width: 320, height: 200 });
    expect(sniffImageSize(webpLossless(1000, 16383))).toEqual({ width: 1000, height: 16383 });
    expect(sniffImageSize(webpExtended(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  it("ignores a header that declares zero or absurd dimensions", () => {
    expect(sniffImageSize(png(0, 10))).toBeNull();
    expect(sniffImageSize(png(10, 0))).toBeNull();
    expect(sniffImageSize(png(0xffffffff, 10))).toBeNull();
    expect(sniffImageSize(gif(0, 0))).toBeNull();
    expect(sniffImageSize(jpeg(0, 50))).toBeNull();
    expect(sniffImageSize(gif(40_000, 10))).toBeNull();
  });

  it("returns null for unknown, truncated and empty input", () => {
    expect(sniffImageSize(new Uint8Array())).toBeNull();
    expect(sniffImageSize(Uint8Array.from(ascii("<svg xmlns=")))).toBeNull();
    expect(sniffImageSize(png(10, 10).subarray(0, 20))).toBeNull();
    expect(sniffImageSize(jpeg(10, 10).subarray(0, 20))).toBeNull();
    expect(sniffImageSize(webpLossy(10, 10).subarray(0, 25))).toBeNull();
  });

  it("does not run past a scan with no frame header", () => {
    expect(sniffImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]))).toBeNull();
  });

  it("works on a view that does not start at the buffer's origin", () => {
    const shifted = new Uint8Array(40);
    shifted.set(png(77, 55), 7);
    expect(sniffImageSize(shifted.subarray(7))).toEqual({ width: 77, height: 55 });
  });
});

describe("sniffImageBlob", () => {
  it("reads only the first 64 KB of the blob", async () => {
    const calls: Array<[number | undefined, number | undefined]> = [];
    const header = png(30, 20);
    const blob = {
      slice: (start?: number, end?: number) => {
        calls.push([start, end]);
        return { arrayBuffer: () => Promise.resolve(header.buffer.slice(0)) };
      },
    } as unknown as Blob;
    expect(await sniffImageBlob(blob)).toEqual({ width: 30, height: 20 });
    expect(calls).toEqual([[0, HEADER_SNIFF_BYTES]]);
  });

  it("is null when the blob cannot be read", async () => {
    const blob = {
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }),
    } as unknown as Blob;
    expect(await sniffImageBlob(blob)).toBeNull();
    expect(await sniffImageBlob({} as Blob)).toBeNull();
  });
});
