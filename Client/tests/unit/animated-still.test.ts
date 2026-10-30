import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  animatedStill,
  bindAnimatedImage,
  clearAnimatedStills,
  isAnimatedImage,
} from "../../src/lib/ui/animatedStill";

const bytes = (...parts: Array<string | number[]>): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
};

/** A GIF with `frames` 1x1 images and no global colour table. */
function gif(frames: number, opts: { loopExtension?: boolean } = {}): Uint8Array {
  const image = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
  const parts: Array<string | number[]> = ["GIF89a", [1, 0, 1, 0, 0, 0, 0]];
  if (opts.loopExtension === true) {
    parts.push([0x21, 0xff, 0x0b], "NETSCAPE2.0", [0x03, 0x01, 0x00, 0x00, 0x00]);
  }
  for (let i = 0; i < frames; i++) {
    parts.push([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00], image);
  }
  parts.push([0x3b]);
  return bytes(...parts);
}

function webp(flags: number): Uint8Array {
  return bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [
    10,
    0,
    0,
    0,
    flags,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function png(chunks: string[]): Uint8Array {
  const parts: Array<string | number[]> = [[0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]];
  for (const type of chunks) parts.push([0, 0, 0, 1], type, [0], [0, 0, 0, 0]);
  return bytes(...parts);
}

describe("isAnimatedImage", () => {
  it("finds a second frame in a GIF, and not in a one-frame GIF with a loop extension", () => {
    expect(isAnimatedImage(gif(2))).toBe(true);
    expect(isAnimatedImage(gif(1))).toBe(false);
    expect(isAnimatedImage(gif(1, { loopExtension: true }))).toBe(false);
    expect(isAnimatedImage(gif(3, { loopExtension: true }))).toBe(true);
  });

  it("reads WebP's animation flag", () => {
    expect(isAnimatedImage(webp(0x02))).toBe(true);
    expect(isAnimatedImage(webp(0x10))).toBe(false);
    expect(isAnimatedImage(bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0]))).toBe(false);
  });

  it("treats a PNG as animated only when acTL comes before IDAT", () => {
    expect(isAnimatedImage(png(["IHDR", "acTL", "IDAT", "IEND"]))).toBe(true);
    expect(isAnimatedImage(png(["IHDR", "IDAT", "acTL", "IEND"]))).toBe(false);
    expect(isAnimatedImage(png(["IHDR", "IDAT", "IEND"]))).toBe(false);
  });

  it("never reads past a truncated file", () => {
    const full = gif(2);
    for (let n = 0; n < full.length - 1; n++) {
      expect(() => isAnimatedImage(full.slice(0, n))).not.toThrow();
    }
    expect(isAnimatedImage(new Uint8Array())).toBe(false);
    expect(isAnimatedImage(bytes("JPEG"))).toBe(false);
  });
});

describe("animatedStill", () => {
  afterEach(() => {
    clearAnimatedStills();
    vi.restoreAllMocks();
  });

  it("is null for a still picture and does not draw it", async () => {
    const read = vi.fn(async () => gif(1));
    expect(await animatedStill("blob:a", 256, read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("is null when the bytes are not at hand, or reading them throws", async () => {
    expect(await animatedStill("blob:b", 256, async () => null)).toBeNull();
    expect(
      await animatedStill("blob:c", 256, () => {
        throw new Error("gone");
      }),
    ).toBeNull();
  });

  it("asks once per source and size", async () => {
    const read = vi.fn(async () => gif(1));
    await Promise.all([animatedStill("blob:d", 256, read), animatedStill("blob:d", 256, read)]);
    await animatedStill("blob:d", 1200, read);
    expect(read).toHaveBeenCalledTimes(2);
    clearAnimatedStills();
    await animatedStill("blob:d", 256, read);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("bindAnimatedImage", () => {
  const STILL = "data:image/png;base64,c3RpbGw=";
  let row: HTMLDivElement;
  let img: HTMLImageElement;

  beforeEach(() => {
    document.documentElement.classList.remove("reduced-motion");
    row = document.createElement("div");
    img = document.createElement("img");
    row.appendChild(img);
    document.body.appendChild(row);
  });

  afterEach(() => {
    row.remove();
    document.documentElement.classList.remove("reduced-motion");
    vi.restoreAllMocks();
  });

  it("shows the still and plays while its row is hovered", () => {
    bindAnimatedImage(img, "blob:anim", STILL, { hover: row });
    expect(img.src).toBe(STILL);
    expect(img.dataset["mediaSrc"]).toBe("blob:anim");
    row.dispatchEvent(new Event("pointerenter"));
    expect(img.src).toBe("blob:anim");
    row.dispatchEvent(new Event("pointerleave"));
    expect(img.src).toBe(STILL);
  });

  it("plays on keyboard focus inside the row", () => {
    bindAnimatedImage(img, "blob:anim", STILL, { hover: row });
    row.dispatchEvent(new Event("focusin"));
    expect(img.src).toBe("blob:anim");
    row.dispatchEvent(new Event("focusout"));
    expect(img.src).toBe(STILL);
  });

  it("stays still on hover under reduced motion, read at hover time", () => {
    bindAnimatedImage(img, "blob:anim", STILL, { hover: row });
    document.documentElement.classList.add("reduced-motion");
    row.dispatchEvent(new Event("pointerenter"));
    expect(img.src).toBe(STILL);
    document.documentElement.classList.remove("reduced-motion");
    row.dispatchEvent(new Event("pointerenter"));
    expect(img.src).toBe("blob:anim");
  });

  it("plays at once in always mode, except under reduced motion", () => {
    bindAnimatedImage(img, "blob:anim", STILL, "always");
    expect(img.src).toBe("blob:anim");
    const other = document.createElement("img");
    document.documentElement.classList.add("reduced-motion");
    bindAnimatedImage(other, "blob:anim", STILL, "always");
    expect(other.src).toBe(STILL);
  });

  it("switches a playing image to its still when motion becomes reduced, and back", async () => {
    bindAnimatedImage(img, "blob:anim", STILL, "always");
    expect(img.src).toBe("blob:anim");
    document.documentElement.classList.add("reduced-motion");
    await Promise.resolve();
    expect(img.src).toBe(STILL);
    document.documentElement.classList.remove("reduced-motion");
    await Promise.resolve();
    expect(img.src).toBe("blob:anim");
  });

  it("stops a hovered image when motion becomes reduced", async () => {
    vi.spyOn(row, "matches").mockImplementation((sel) => sel === ":hover");
    bindAnimatedImage(img, "blob:anim", STILL, { hover: row });
    expect(img.src).toBe("blob:anim");
    document.documentElement.classList.add("reduced-motion");
    await Promise.resolve();
    expect(img.src).toBe(STILL);
  });

  it("plays at once when its row is already hovered or focused", () => {
    vi.spyOn(row, "matches").mockImplementation((sel) => sel === ":focus-within");
    bindAnimatedImage(img, "blob:anim", STILL, { hover: row });
    expect(img.src).toBe("blob:anim");
  });

  it("stops following motion changes once the image is gone", async () => {
    bindAnimatedImage(img, "blob:anim", STILL, "always");
    img.remove();
    document.documentElement.classList.add("reduced-motion");
    await Promise.resolve();
    expect(img.src).toBe("blob:anim");
  });

  it("follows a source reloaded after eviction, so the next hover plays it", () => {
    bindAnimatedImage(img, "blob:old", STILL, { hover: row });
    row.dispatchEvent(new Event("pointerenter"));
    // recoverEvictedImage points the image at a fresh URL for the same file.
    img.src = "blob:new";
    img.dispatchEvent(new Event("load"));
    expect(img.dataset["mediaSrc"]).toBe("blob:new");
    row.dispatchEvent(new Event("pointerleave"));
    expect(img.src).toBe(STILL);
    row.dispatchEvent(new Event("pointerenter"));
    expect(img.src).toBe("blob:new");
  });

  it("drops its row listeners once the image is gone", () => {
    bindAnimatedImage(img, "blob:anim", STILL, { hover: row });
    img.remove();
    row.dispatchEvent(new Event("pointerenter"));
    expect(img.src).toBe(STILL);
    // Re-attached later, the binding is already gone: nothing replays.
    row.appendChild(img);
    row.dispatchEvent(new Event("pointerenter"));
    expect(img.src).toBe(STILL);
  });
});
