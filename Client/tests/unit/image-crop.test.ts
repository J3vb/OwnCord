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
});
