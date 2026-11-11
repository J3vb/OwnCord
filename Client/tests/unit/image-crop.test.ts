import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cropImage } from "../../src/lib/ui/imageCrop";
import { cropGroupIcon } from "../../src/features/direct-messages/groupIcon";

const realBitmap = globalThis.createImageBitmap;
const drawImage = vi.fn();

function bitmap(width: number, height: number): void {
  globalThis.createImageBitmap = vi.fn(async () => ({
    width,
    height,
    close: vi.fn(),
  })) as unknown as typeof createImageBitmap;
}

const png = (): File => new File(["x"], "pic.png", { type: "image/png" });

beforeEach(() => {
  drawImage.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
    cb(new Blob(["p"], { type: "image/png" })),
  );
});
afterEach(() => {
  globalThis.createImageBitmap = realBitmap;
  vi.restoreAllMocks();
});

const banner = { aspect: 2.5, maxWidth: 1200, fileBase: "banner" } as const;

describe("cropImage", () => {
  it("5:2 crop at 1200x480", async () => {
    // A 3000x2000 picture: the widest 5:2 strip is 3000x1200, centred
    // vertically, scaled down to 1200x480.
    bitmap(3000, 2000);
    const out = await cropImage(png(), banner);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 400, 3000, 1200, 0, 0, 1200, 480);
    expect(out.ok && [out.file.name, out.file.type]).toEqual(["banner.png", "image/png"]);

    // A tall picture keeps its full width and loses the top and bottom.
    drawImage.mockReset();
    bitmap(1000, 3000);
    await cropImage(png(), banner);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 1300, 1000, 400, 0, 0, 1000, 400);

    // Already 5:2 and exactly the cap: drawn as is.
    drawImage.mockReset();
    bitmap(1200, 480);
    await cropImage(png(), banner);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1200, 480, 0, 0, 1200, 480);
  });

  it("never upscales a small picture", async () => {
    bitmap(500, 500);
    await cropImage(png(), banner);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 150, 500, 200, 0, 0, 500, 200);
  });

  it("square crop unchanged for group icon", async () => {
    bitmap(2000, 1000);
    const out = await cropGroupIcon(png());
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 500, 0, 1000, 1000, 0, 0, 512, 512);
    expect(out.ok && out.file.name).toBe("group-icon.png");

    drawImage.mockReset();
    bitmap(100, 100);
    await cropGroupIcon(png());
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 100, 0, 0, 100, 100);
  });

  it("refuses a type the server would refuse", async () => {
    const out = await cropImage(new File(["x"], "a.gif", { type: "image/gif" }), banner);
    expect(out).toEqual({ ok: false, error: "Avatar must be a PNG, JPEG or WebP image." });
  });

  it("answers unreadable when the picture cannot be decoded", async () => {
    globalThis.createImageBitmap = vi.fn(async () => {
      throw new Error("bad");
    }) as unknown as typeof createImageBitmap;
    const out = await cropImage(png(), banner);
    expect(out).toEqual({ ok: false, error: "That file could not be read as an image." });
  });

  it("answers unreadable for an empty picture, and still releases it", async () => {
    const close = vi.fn();
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 0,
      height: 10,
      close,
    })) as unknown as typeof createImageBitmap;
    const out = await cropImage(png(), banner);
    expect(out.ok).toBe(false);
    expect(drawImage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("answers unreadable without a 2D context, and clears the canvas", async () => {
    bitmap(100, 100);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const out = await cropImage(png(), banner);
    expect(out.ok).toBe(false);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("falls back from PNG to WebP to JPEG when each is over the limit", async () => {
    bitmap(100, 100);
    const big = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/png" });
    const types: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb, type) => {
      types.push(type ?? "");
      cb(type === "image/jpeg" ? new Blob(["j"], { type: "image/jpeg" }) : big);
    });
    const out = await cropImage(png(), banner);
    expect(types).toEqual(["image/png", "image/webp", "image/jpeg"]);
    expect(out.ok && [out.file.name, out.file.type]).toEqual(["banner.jpg", "image/jpeg"]);
  });

  it("names a WebP result .webp and stops after it when it fits", async () => {
    bitmap(100, 100);
    const big = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/png" });
    const types: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb, type) => {
      types.push(type ?? "");
      cb(type === "image/webp" ? new Blob(["w"], { type: "image/webp" }) : big);
    });
    const out = await cropImage(png(), banner);
    expect(types).toEqual(["image/png", "image/webp"]);
    expect(out.ok && out.file.name).toBe("banner.webp");
  });

  it("reports the size limit when even JPEG is over it", async () => {
    bitmap(100, 100);
    const big = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/jpeg" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(big));
    const out = await cropImage(png(), banner);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("1024");
  });

  it("answers unreadable when the encoder yields nothing or throws", async () => {
    bitmap(100, 100);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(null));
    expect((await cropImage(png(), banner)).ok).toBe(false);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {
      throw new Error("no");
    });
    expect((await cropImage(png(), banner)).ok).toBe(false);
  });
});
