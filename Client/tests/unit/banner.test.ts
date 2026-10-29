import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchImageAsObjectUrl = vi.fn();
const images: BannerImages = {
  fetch: (url) => fetchImageAsObjectUrl(url) as Promise<string | null>,
  resolve: (path) => `https://server.test${path}`,
  recover: () => undefined,
  still: () => Promise.resolve(null),
};

import { isBannerColor, paintBanner, type BannerImages } from "../../src/features/profiles/banner";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("paintBanner", () => {
  let card: HTMLDivElement;
  let strip: HTMLDivElement;
  let revoke: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    card = document.createElement("div");
    strip = document.createElement("div");
    card.appendChild(strip);
    document.body.appendChild(card);
  });
  afterEach(() => {
    card.remove();
    revoke.mockRestore();
  });

  it("image grows strip and moves avatar", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:banner");
    paintBanner(strip, { banner: "/api/v1/files/7", banner_color: "#112233" }, card, images);
    // The height is reserved at once, so the card does not jump on arrival.
    expect(card.style.getPropertyValue("--upp-banner-h")).toBe("120px");
    await flush();
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/7");
    expect(strip.querySelector("img.banner-img")?.getAttribute("src")).toBe("blob:banner");
    expect(card.style.getPropertyValue("--upp-banner-h")).toBe("120px");
  });

  it("a colour change keeps the picture without fetching it again", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:banner");
    paintBanner(strip, { banner: "/api/v1/files/7", banner_color: "#112233" }, card, images);
    await flush();
    const img = strip.querySelector("img.banner-img");
    paintBanner(strip, { banner: "/api/v1/files/7", banner_color: "#445566" }, card, images);
    await flush();
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
    expect(strip.querySelector("img.banner-img")).toBe(img);
    expect(card.style.getPropertyValue("--upp-banner-h")).toBe("120px");
    expect(strip.style.background).not.toBe("");
  });

  it("gives the height back when the picture cannot be fetched", async () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    paintBanner(strip, { banner: "/api/v1/files/7", banner_color: "#abc" }, card, images);
    await flush();
    expect(strip.querySelector("img")).toBeNull();
    expect(card.style.getPropertyValue("--upp-banner-h")).toBe("");
    // The colour still shows behind the missing picture.
    expect(strip.style.background).not.toBe("");
  });

  it("colour only", () => {
    paintBanner(strip, { banner: null, banner_color: "#a1b2c3" }, card, images);
    expect(strip.style.background).toContain("rgb(161, 178, 195)");
    expect(card.style.getPropertyValue("--upp-banner-h")).toBe("");
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();
  });

  it("invalid colour ignored", () => {
    for (const bad of ["red", "#12", "#12345", "#gggggg", "url(x)", "#1234567", ""]) {
      paintBanner(strip, { banner_color: bad }, card, images);
      expect(strip.style.background).toBe("");
    }
    expect(isBannerColor("#FFF")).toBe(true);
    expect(isBannerColor("#abcdef")).toBe(true);
    expect(isBannerColor(null)).toBe(false);
  });

  it("neither keeps gradient", () => {
    strip.style.background = "red";
    card.style.setProperty("--upp-banner-h", "120px");
    paintBanner(strip, {}, card, images);
    paintBanner(strip, { banner: null, banner_color: null }, card, images);
    expect(strip.style.background).toBe("");
    expect(strip.childElementCount).toBe(0);
    expect(card.style.getPropertyValue("--upp-banner-h")).toBe("");
  });

  it("late fetch after close releases the url", async () => {
    let resolve!: (url: string) => void;
    fetchImageAsObjectUrl.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    paintBanner(strip, { banner: "/api/v1/files/7" }, card, images);
    // The popup closes before the bytes arrive.
    card.remove();
    resolve("blob:late");
    await flush();
    // Nothing is painted and nothing keeps the URL; the attachment cache that
    // issued it still owns (and revokes) it, so it is not revoked from here.
    expect(strip.childElementCount).toBe(0);
    expect(revoke).not.toHaveBeenCalledWith("blob:late");
  });

  it("drops a fetch for a banner that was repainted meanwhile", async () => {
    let resolveOld!: (url: string) => void;
    fetchImageAsObjectUrl.mockReturnValueOnce(new Promise<string>((r) => (resolveOld = r)));
    paintBanner(strip, { banner: "/api/v1/files/1" }, card, images);
    paintBanner(strip, { banner: null, banner_color: "#000000" }, card, images);
    resolveOld("blob:old");
    await flush();
    expect(strip.childElementCount).toBe(0);
    expect(card.style.getPropertyValue("--upp-banner-h")).toBe("");
  });

  it("plays an animated banner, and shows its first frame under reduced motion (WP 8.7)", async () => {
    const STILL = "data:image/png;base64,U1RJTEw=";
    const animated: BannerImages = { ...images, still: () => Promise.resolve(STILL) };
    fetchImageAsObjectUrl.mockResolvedValue("blob:anim");
    paintBanner(strip, { banner: "/api/v1/files/8" }, card, animated);
    await flush();
    expect(strip.querySelector("img.banner-img")?.getAttribute("src")).toBe("blob:anim");

    document.documentElement.classList.add("reduced-motion");
    try {
      paintBanner(strip, { banner: "/api/v1/files/9" }, card, animated);
      await flush();
      expect(strip.querySelector("img.banner-img")?.getAttribute("src")).toBe(STILL);
    } finally {
      document.documentElement.classList.remove("reduced-motion");
    }
  });

  it("drops an animated banner repainted while its still was drawn", async () => {
    let finishStill!: (still: string | null) => void;
    const slow: BannerImages = {
      ...images,
      still: () => new Promise<string | null>((r) => (finishStill = r)),
    };
    fetchImageAsObjectUrl.mockResolvedValue("blob:anim");
    paintBanner(strip, { banner: "/api/v1/files/1" }, card, slow);
    await flush();
    paintBanner(strip, { banner: null }, card, slow);
    finishStill("data:image/png;base64,U1RJTEw=");
    await flush();
    expect(strip.childElementCount).toBe(0);
  });
});
