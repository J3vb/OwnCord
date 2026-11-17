import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BACKGROUND_CHARS,
  installCustomThemeEscape,
  isBackgroundDataUrl,
  loadThemeBackground,
  paintThemeBackground,
  saveCustomThemes,
  saveThemeBackground,
  setActiveCustomTheme,
} from "../../src/features/custom-themes/customTheme";
import {
  MAX_BACKGROUND_FILE_BYTES,
  prepareBackground,
} from "../../src/features/custom-themes/themeBackground";

const IMAGE = "data:image/webp;base64,UklGRg==";
const BG_KEY = "owncord:theme:custom:bg:a1";

function bgStyle(): HTMLStyleElement | null {
  return document.getElementById("owncord-custom-theme-bg") as HTMLStyleElement | null;
}

afterEach(() => {
  setActiveCustomTheme(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
});

describe("isBackgroundDataUrl", () => {
  it("takes only base64 PNG, JPEG or WebP data URLs", () => {
    expect(isBackgroundDataUrl(IMAGE)).toBe(true);
    expect(isBackgroundDataUrl("data:image/jpeg;base64,/9j/4A==")).toBe(true);
    expect(isBackgroundDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isBackgroundDataUrl("https://example.com/a.png")).toBe(false);
    expect(isBackgroundDataUrl('data:image/png;base64,AA");} body{x:1')).toBe(false);
    expect(isBackgroundDataUrl(`data:image/png;base64,${"A".repeat(MAX_BACKGROUND_CHARS)}`)).toBe(
      false,
    );
  });
});

describe("theme background storage", () => {
  it("round-trips and clamps dim and blur", () => {
    expect(saveThemeBackground("a1", { image: IMAGE, dim: 40, blur: 6 })).toBe(true);
    expect(loadThemeBackground("a1")).toEqual({ image: IMAGE, dim: 40, blur: 6 });
    localStorage.setItem(BG_KEY, JSON.stringify({ image: IMAGE, dim: 500, blur: -3 }));
    expect(loadThemeBackground("a1")).toEqual({ image: IMAGE, dim: 90, blur: 0 });
  });

  it("drops a stored value that is not a safe picture", () => {
    localStorage.setItem(BG_KEY, JSON.stringify({ image: "https://x/y.png", dim: 10, blur: 0 }));
    expect(loadThemeBackground("a1")).toBeNull();
    localStorage.setItem(BG_KEY, "{bad");
    expect(loadThemeBackground("a1")).toBeNull();
  });

  it("removes the picture for null", () => {
    saveThemeBackground("a1", { image: IMAGE, dim: 40, blur: 0 });
    saveThemeBackground("a1", null);
    expect(localStorage.getItem(BG_KEY)).toBeNull();
  });
});

describe("paintThemeBackground", () => {
  it("paints the picture behind the chat with the dim, and blur only when set", () => {
    paintThemeBackground({ image: IMAGE, dim: 35, blur: 0 });
    const css = bgStyle()?.textContent ?? "";
    expect(css).toContain(`--theme-background-image: url("${IMAGE}")`);
    expect(css).toContain("var(--bg-primary) 35%");
    expect(css).not.toContain("backdrop-filter");

    paintThemeBackground({ image: IMAGE, dim: 35, blur: 8 });
    expect(document.querySelectorAll("#owncord-custom-theme-bg")).toHaveLength(1);
    expect(bgStyle()?.textContent).toContain("backdrop-filter: blur(8px)");

    paintThemeBackground(null);
    expect(bgStyle()).toBeNull();
  });

  it("refuses a picture that is not a safe data URL", () => {
    paintThemeBackground({ image: "https://example.com/a.png", dim: 0, blur: 0 });
    expect(bgStyle()).toBeNull();
  });
});

describe("the active theme's picture", () => {
  it("paints with its theme, before the theme's own CSS, and goes when the theme goes", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: ".x { color: red; }" }]);
    saveThemeBackground("a1", { image: IMAGE, dim: 50, blur: 0 });
    expect(setActiveCustomTheme("a1")).toBe(true);
    const bg = bgStyle();
    expect(bg?.nextElementSibling?.id).toBe("owncord-custom-theme");

    setActiveCustomTheme(null);
    expect(bgStyle()).toBeNull();
  });

  it("is turned off by the escape shortcut", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: "" }]);
    saveThemeBackground("a1", { image: IMAGE, dim: 50, blur: 0 });
    setActiveCustomTheme("a1");
    const owner = new AbortController();
    installCustomThemeEscape(owner.signal);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Backspace", ctrlKey: true, shiftKey: true }),
    );
    owner.abort();
    expect(bgStyle()).toBeNull();
  });

  it("does not paint for a theme that cannot be applied", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: "@import 'x.css';" }]);
    saveThemeBackground("a1", { image: IMAGE, dim: 50, blur: 0 });
    expect(setActiveCustomTheme("a1")).toBe(false);
    expect(bgStyle()).toBeNull();
  });
});

describe("prepareBackground", () => {
  function file(type: string, size = 10): File {
    return new File([new Uint8Array(size)], "pic", { type });
  }

  function stubDecode(width: number, height: number): { close: ReturnType<typeof vi.fn> } {
    const bitmap = { width, height, close: vi.fn() };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.resolve(bitmap)),
    );
    return bitmap;
  }

  function stubCanvas(urls: (canvas: HTMLCanvasElement, type: string) => string): void {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
      this: HTMLCanvasElement,
      type?: string,
    ) {
      return urls(this, type ?? "image/png");
    });
  }

  it("refuses other types and oversized files before decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    await expect(prepareBackground(file("image/svg+xml"))).resolves.toEqual({
      ok: false,
      problem: "type",
    });
    await expect(prepareBackground(file("image/gif"))).resolves.toEqual({
      ok: false,
      problem: "type",
    });
    await expect(
      prepareBackground(file("image/png", MAX_BACKGROUND_FILE_BYTES + 1)),
    ).resolves.toEqual({ ok: false, problem: "tooBig" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("says a picture that will not decode is unreadable", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new Error("bad"))),
    );
    await expect(prepareBackground(file("image/png"))).resolves.toEqual({
      ok: false,
      problem: "unreadable",
    });
  });

  it("shrinks to 2560 px and stores WebP", async () => {
    const bitmap = stubDecode(5120, 2880);
    const sizes: string[] = [];
    stubCanvas((canvas, type) => {
      sizes.push(`${canvas.width}x${canvas.height}`);
      return type === "image/webp" ? IMAGE : "data:image/png;base64,AA==";
    });
    await expect(prepareBackground(file("image/jpeg"))).resolves.toEqual({
      ok: true,
      image: IMAGE,
    });
    expect(sizes).toEqual(["2560x1440"]);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("falls back to JPEG where the webview has no WebP encoder", async () => {
    stubDecode(800, 600);
    stubCanvas((_canvas, type) =>
      type === "image/jpeg" ? "data:image/jpeg;base64,/9j/" : "data:image/png;base64,AA==",
    );
    await expect(prepareBackground(file("image/png"))).resolves.toEqual({
      ok: true,
      image: "data:image/jpeg;base64,/9j/",
    });
  });

  it("steps down in size until it fits, and gives up past the last step", async () => {
    stubDecode(4000, 4000);
    const huge = `data:image/webp;base64,${"A".repeat(MAX_BACKGROUND_CHARS)}`;
    const widths: number[] = [];
    stubCanvas((canvas) => {
      widths.push(canvas.width);
      return canvas.width > 1280 ? huge : IMAGE;
    });
    await expect(prepareBackground(file("image/webp"))).resolves.toEqual({
      ok: true,
      image: IMAGE,
    });
    expect(widths).toEqual([2560, 1920, 1280]);

    stubCanvas(() => huge);
    await expect(prepareBackground(file("image/webp"))).resolves.toEqual({
      ok: false,
      problem: "tooBig",
    });
  });
});
