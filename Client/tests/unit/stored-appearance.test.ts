import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetActiveThemeName } = vi.hoisted(() => ({
  mockGetActiveThemeName: vi.fn(() => "neon-glow"),
}));

// Only the theme *selection* is stubbed. applyTheme/applyThemeByName and
// restoreAccent() stay real, because the assertions below are about what they
// actually write to the document.
vi.mock("@lib/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/themes")>()),
  getActiveThemeName: mockGetActiveThemeName,
}));

import { applyStoredAppearance, clampZoom, setZoom, stepZoom, storedZoom } from "@lib/appearance";
import { syncOsMotionListener } from "@lib/os-motion";

/** jsdom has no matchMedia; startup syncs with the OS by default (B9-2, Q1). */
function stubOsReducedMotion(matches: boolean): void {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe("applyStoredAppearance", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    localStorage.clear();
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
    stubOsReducedMotion(false);
  });

  afterEach(() => {
    syncOsMotionListener(false);
    vi.unstubAllGlobals();
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

    // applyTheme's neon-glow palette lands inline on documentElement, and its
    // body class is delegated to applyThemeByName.
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe("#17181b");
    expect(document.body.classList.contains("theme-neon-glow")).toBe(true);
    // largeFont is "true" above, so 16px is raised to the 18px Large Font floor.
    // This assertion used to read "16px" — it was pinning OC-0319, the bug where
    // the toggle changed nothing, not a behaviour worth keeping.
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("18px");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#123456");
    expect(document.documentElement.classList.contains("compact-mode")).toBe(true);
    expect(document.documentElement.classList.contains("high-contrast")).toBe(true);
    expect(document.documentElement.classList.contains("large-font")).toBe(true);
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(false);
  });

  it("follows the OS reduced-motion setting when nothing is stored (B9-2, Q1)", () => {
    stubOsReducedMotion(true);

    applyStoredAppearance();

    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);
  });
});

describe("zoom", () => {
  beforeEach(() => stubOsReducedMotion(false));
  afterEach(() => {
    syncOsMotionListener(false);
    vi.unstubAllGlobals();
  });
  const zoomStyle = (): string => document.documentElement.style.getPropertyValue("zoom");

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("defaults to 100% and sets no inline zoom", () => {
    applyStoredAppearance();
    expect(storedZoom()).toBe(100);
    expect(zoomStyle()).toBe("");
  });

  it("round-trips through the pref and applies it at startup", () => {
    expect(setZoom(150)).toBe(150);
    expect(localStorage.getItem("owncord:settings:zoomLevel")).toBe("150");
    expect(zoomStyle()).toBe("150%");
    document.documentElement.removeAttribute("style");
    applyStoredAppearance();
    expect(zoomStyle()).toBe("150%");
  });

  it("clamps to 50-200 and snaps to steps", () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(900)).toBe(200);
    expect(clampZoom(104)).toBe(100);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampZoom("big")).toBe(100);
  });

  it("repairs a corrupted stored value", () => {
    localStorage.setItem("owncord:settings:zoomLevel", "1e999");
    expect(storedZoom()).toBe(100);
    localStorage.setItem("owncord:settings:zoomLevel", "5");
    expect(storedZoom()).toBe(50);
  });

  it("steps in, out and resets, stopping at the ends", () => {
    expect(stepZoom(1)).toBe(110);
    expect(stepZoom(-1)).toBe(100);
    setZoom(200);
    expect(stepZoom(1)).toBe(200);
    setZoom(50);
    expect(stepZoom(-1)).toBe(50);
    expect(stepZoom(0)).toBe(100);
    expect(zoomStyle()).toBe("");
  });
});
