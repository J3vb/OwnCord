import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAppearanceTab } from "@components/settings/AppearanceTab";

const {
  mockGetActiveThemeName,
  mockLoadCustomTheme,
  mockRestoreTheme,
  mockApplyThemeByName,
} = vi.hoisted(() => ({
  mockGetActiveThemeName: vi.fn(() => "neon-glow"),
  mockLoadCustomTheme: vi.fn(() => null),
  mockRestoreTheme: vi.fn(),
  mockApplyThemeByName: vi.fn(),
}));

vi.mock("@stores/ui.store", () => ({
  setTheme: vi.fn(),
}));

vi.mock("@lib/themes", () => ({
  getActiveThemeName: mockGetActiveThemeName,
  loadCustomTheme: mockLoadCustomTheme,
  restoreTheme: mockRestoreTheme,
  applyThemeByName: mockApplyThemeByName,
}));

describe("AppearanceTab — Accessibility", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
    mockLoadCustomTheme.mockReturnValue(null);
  });

  afterEach(() => {
    container.remove();
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("theme tiles are <button> elements", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    expect(tiles.length).toBe(4);

    for (const tile of tiles) {
      expect(tile.tagName).toBe("BUTTON");
    }
  });

  it("theme container has role=radiogroup", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const themeRow = container.querySelector(".theme-options");
    expect(themeRow?.getAttribute("role")).toBe("radiogroup");
  });

  it("theme tiles have role=radio and aria-checked", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    for (const tile of tiles) {
      expect(tile.getAttribute("role")).toBe("radio");
      expect(["true", "false"]).toContain(tile.getAttribute("aria-checked"));
    }

    // Active tile should have aria-checked=true
    const active = container.querySelector(".theme-opt.active");
    expect(active?.getAttribute("aria-checked")).toBe("true");
  });

  it("activates theme tile on Enter key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const midnight = tiles[2] as HTMLElement;

    midnight.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(midnight.classList.contains("active")).toBe(true);
    expect(midnight.getAttribute("aria-checked")).toBe("true");
  });

  it("activates theme tile on Space key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const dark = tiles[0] as HTMLElement;

    dark.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(dark.classList.contains("active")).toBe(true);
  });

  it("uses a real preset for the default accent state", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeSwatch = container.querySelector('.accent-swatch.active') as HTMLElement;
    const hexInput = container.querySelector('.accent-hex-row input') as HTMLInputElement;

    expect(activeSwatch).not.toBeNull();
    expect(activeSwatch.title).toBe("#00c8ff");
    expect(hexInput.placeholder).toBe("00c8ff");
  });

  it("uses blurple as the displayed default accent for non-neon built-in themes", () => {
    mockGetActiveThemeName.mockReturnValue("dark");

    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeSwatch = container.querySelector('.accent-swatch.active') as HTMLElement;
    const hexInput = container.querySelector('.accent-hex-row input') as HTMLInputElement;

    expect(activeSwatch).not.toBeNull();
    expect(activeSwatch.title).toBe("#5865f2");
    expect(hexInput.placeholder).toBe("5865f2");
  });

  it("reflects a custom theme accent when no override has been saved", () => {
    mockGetActiveThemeName.mockReturnValue("custom-sunrise");
    mockLoadCustomTheme.mockReturnValue({
      name: "custom-sunrise",
      author: "test",
      version: "1.0.0",
      colors: { "--accent": "#123456" },
    });

    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeSwatch = container.querySelector('.accent-swatch.active');
    const hexInput = container.querySelector('.accent-hex-row input') as HTMLInputElement;

    expect(activeSwatch).toBeNull();
    expect(hexInput.value).toBe("123456");
    expect(hexInput.placeholder).toBe("123456");
  });

  it("updates the displayed default accent when switching built-in themes without an override", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const dark = tiles[0] as HTMLElement;
    const hexInput = container.querySelector('.accent-hex-row input') as HTMLInputElement;

    dark.click();

    const activeSwatch = container.querySelector('.accent-swatch.active') as HTMLElement;
    expect(activeSwatch.title).toBe("#5865f2");
    expect(hexInput.value).toBe("5865f2");
    expect(hexInput.placeholder).toBe("5865f2");
  });

  it("restores a custom active theme without forcing a built-in tile active", () => {
    mockGetActiveThemeName.mockReturnValue("custom-sunrise");

    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeTile = container.querySelector(".theme-opt.active");
    expect(activeTile).toBeNull();
    expect(mockRestoreTheme).toHaveBeenCalledTimes(1);
  });

  it("does not inject an accent override when no accent has been saved", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
    expect(document.body.style.getPropertyValue("--accent")).toBe("");
  });
});
