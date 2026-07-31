import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetActiveThemeName, mockRestoreTheme, mockApplyThemeByName } = vi.hoisted(() => ({
  mockGetActiveThemeName: vi.fn(() => "neon-glow"),
  mockRestoreTheme: vi.fn(),
  mockApplyThemeByName: vi.fn(),
}));

vi.mock("@lib/themes", () => ({
  getActiveThemeName: mockGetActiveThemeName,
  restoreTheme: mockRestoreTheme,
  applyThemeByName: mockApplyThemeByName,
}));

import { applyStoredAppearance } from "@lib/appearance";

describe("applyStoredAppearance", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    localStorage.clear();
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
  });

  afterEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("restores built-in themes through the palette helper and still applies other stored appearance prefs", () => {
    localStorage.setItem("owncord:settings:fontSize", "16");
    localStorage.setItem("owncord:settings:compactMode", "true");
    localStorage.setItem("owncord:settings:highContrast", "true");
    localStorage.setItem("owncord:settings:largeFont", "true");
    localStorage.setItem("owncord:settings:accentColor", '"#123456"');

    applyStoredAppearance();

    expect(mockApplyThemeByName).toHaveBeenCalledWith("neon-glow");
    expect(mockRestoreTheme).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("16px");
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe("#1a1b1e");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#123456");
    expect(document.documentElement.classList.contains("compact-mode")).toBe(true);
    expect(document.documentElement.classList.contains("high-contrast")).toBe(true);
    expect(document.documentElement.classList.contains("large-font")).toBe(true);
  });

  it("restores custom themes through the theme manager path", () => {
    mockGetActiveThemeName.mockReturnValue("custom-sunrise");

    applyStoredAppearance();

    expect(mockRestoreTheme).toHaveBeenCalledTimes(1);
    expect(mockApplyThemeByName).not.toHaveBeenCalled();
  });
});
