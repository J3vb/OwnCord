import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetActiveThemeName, mockApplyThemeByName } = vi.hoisted(() => ({
  mockGetActiveThemeName: vi.fn(() => "neon-glow"),
  mockApplyThemeByName: vi.fn(),
}));

// Only the theme *selection* is stubbed. restoreAccent() stays real, because the
// accent assertions below are about what it actually writes to the document.
vi.mock("@lib/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/themes")>()),
  getActiveThemeName: mockGetActiveThemeName,
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
    // largeFont is "true" above, so 16px is raised to the 18px Large Font floor.
    // This assertion used to read "16px" — it was pinning OC-0319, the bug where
    // the toggle changed nothing, not a behaviour worth keeping.
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("18px");
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe("#1a1b1e");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#123456");
    expect(document.documentElement.classList.contains("compact-mode")).toBe(true);
    expect(document.documentElement.classList.contains("high-contrast")).toBe(true);
    expect(document.documentElement.classList.contains("large-font")).toBe(true);
  });
});
