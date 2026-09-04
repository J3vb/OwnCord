// OC-0319 — the "Large Font" accessibility toggle used to be inert.
//
// `.large-font { --font-size: 18px }` in app.css targets documentElement, but
// that same element permanently carries an *inline* `--font-size` written by
// applyStoredAppearance() and by the Appearance-tab slider. An inline
// declaration beats a plain class rule on the same element, so the class could
// never win. The fix is the pattern this codebase already uses for
// reducedMotion (OC-0232): don't have two writers race over one property —
// give it a single writer that derives from both preferences.
//
// The derived semantics pinned here: Large Font raises the floor to 18px and
// never lowers what the slider chose. `!important` on the CSS rule would have
// pinned it *at* 18px, which shrinks the text of anyone whose slider sits at
// 19 or 20 — an accessibility toggle that makes text smaller.
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
vi.mock("@lib/os-motion", () => ({ syncOsMotionListener: vi.fn() }));

import { applyStoredAppearance } from "@lib/appearance";
import { buildAccessibilityTab } from "@components/settings/AccessibilityTab";

function fontSize(): string {
  return document.documentElement.style.getPropertyValue("--font-size");
}

describe("Large Font raises the effective font size (OC-0319)", () => {
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

  it("leaves the slider value alone when Large Font is off", () => {
    localStorage.setItem("owncord:settings:fontSize", "14");
    localStorage.setItem("owncord:settings:largeFont", "false");

    applyStoredAppearance();

    expect(fontSize()).toBe("14px");
  });

  it("raises a below-18px slider value to 18px when Large Font is on", () => {
    localStorage.setItem("owncord:settings:fontSize", "14");
    localStorage.setItem("owncord:settings:largeFont", "true");

    applyStoredAppearance();

    expect(fontSize()).toBe("18px");
  });

  it("never shrinks a slider value already above 18px", () => {
    localStorage.setItem("owncord:settings:fontSize", "20");
    localStorage.setItem("owncord:settings:largeFont", "true");

    applyStoredAppearance();

    // The whole point of the toggle is bigger text. Pinning it at 18px would
    // make "Large Font" shrink this user's UI.
    expect(fontSize()).toBe("20px");
  });

  it("applies immediately when the toggle is flipped, without a restart", () => {
    localStorage.setItem("owncord:settings:fontSize", "14");
    applyStoredAppearance();
    expect(fontSize()).toBe("14px");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const ac = new AbortController();
    container.appendChild(buildAccessibilityTab(ac.signal));

    // Index 4 is the Large Font toggle (see accessibility-tab.test.ts).
    (container.querySelectorAll(".toggle")[4] as HTMLElement).click();
    expect(fontSize()).toBe("18px");

    (container.querySelectorAll(".toggle")[4] as HTMLElement).click();
    expect(fontSize()).toBe("14px");

    ac.abort();
    container.remove();
  });
});

describe("applyFontSize clamps a corrupt stored size to a readable one", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    localStorage.clear();
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
  });

  // Before the single-writer change, a negative stored size produced
  // `--font-size: -5px`, which is invalid at computed-value time, so the
  // declaration was dropped and the app stayed readable by accident. Flooring
  // at 0 would have made it VALID — a 0px UI the user cannot read well enough
  // to reach the setting that caused it. The floor is the slider's own minimum.
  it("floors a negative stored size at the slider minimum, not at 0px", () => {
    localStorage.setItem("owncord:settings:fontSize", "-5");

    applyStoredAppearance();

    expect(fontSize()).toBe("12px");
  });

  it("floors a zero stored size at the slider minimum", () => {
    localStorage.setItem("owncord:settings:fontSize", "0");

    applyStoredAppearance();

    expect(fontSize()).toBe("12px");
  });

  // loadPref only checks `typeof parsed === typeof fallback`, and
  // JSON.parse("1e999") is Infinity — a number that passes that check.
  it("falls back to the default for a non-finite stored size", () => {
    localStorage.setItem("owncord:settings:fontSize", "1e999");

    applyStoredAppearance();

    expect(fontSize()).toBe("16px");
  });
});

describe("the Appearance slider's label shows the effective size", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    localStorage.clear();
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
  });

  it("reads 18px, not the slider position, while Large Font is on", async () => {
    localStorage.setItem("owncord:settings:fontSize", "14");
    localStorage.setItem("owncord:settings:largeFont", "true");

    const { buildAppearanceTab } = await import("@components/settings/AppearanceTab");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const ac = new AbortController();
    container.appendChild(buildAppearanceTab(ac.signal));

    // A label reading "14px" beside text rendered at 18px is the same
    // "control that lies" defect OC-0319 was about, one layer up.
    expect(container.querySelector(".slider-val")?.textContent).toBe("18px");
    expect(fontSize()).toBe("18px");

    ac.abort();
    container.remove();
  });
});
