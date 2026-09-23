import { describe, it, expect } from "vitest";
import {
  contrastRatio,
  deriveAccentTokens,
  parseColor,
  toHex,
  type Rgb,
} from "../../src/lib/color-contrast";

const DARK_SURFACES: Rgb[] = ["#313338", "#2b2d31", "#1e1f22", "#383a40"].map(
  (c) => parseColor(c)!,
);

describe("parseColor", () => {
  it("reads short and long hex and computed rgb()/rgba()", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor(" #5865F2 ")).toEqual([88, 101, 242]);
    expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30]);
  });

  it("rejects anything else, so a caller fails closed", () => {
    for (const bad of ["", "#abcd", "#12345", "red", "var(--accent)", "hsl(0 0% 0%)"]) {
      expect(parseColor(bad)).toBeNull();
    }
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG endpoints and a known pair", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([88, 101, 242], [88, 101, 242])).toBe(1);
    // The dark theme's default accent on its primary surface: why B9-2 adds --accent-text.
    expect(contrastRatio(parseColor("#5865f2")!, parseColor("#313338")!)).toBeCloseTo(2.74, 2);
  });
});

describe("deriveAccentTokens (Q8)", () => {
  it("puts black on a light accent and lightens hover/active", () => {
    const t = deriveAccentTokens(parseColor("#00c8ff")!, DARK_SURFACES);
    expect(t.onAccent).toBe("#000000");
    // The neon-glow theme's static hover/active are these same derived values.
    expect(t.hover).toBe("#26d0ff");
    expect(t.active).toBe("#4dd9ff");
    expect(t.text).toBe("#00c8ff");
  });

  it("puts white on a dark accent and darkens hover/active", () => {
    const t = deriveAccentTokens(parseColor("#5865f2")!, DARK_SURFACES);
    expect(t.onAccent).toBe("#ffffff");
    expect(t.hover).toBe(toHex([75, 86, 206]));
  });

  it("uses the accent as text only at 4.5:1 and as a focus ring only at 3:1", () => {
    // 2.74:1 on the dark theme: neither use.
    const blurple = deriveAccentTokens(parseColor("#5865f2")!, DARK_SURFACES);
    expect([blurple.text, blurple.focus]).toEqual([null, null]);
    // 3.64:1 at worst: a focus ring, but not text.
    const green = deriveAccentTokens(parseColor("#3ba55d")!, DARK_SURFACES);
    expect([green.text, green.focus]).toEqual([null, "#3ba55d"]);
    // 6.44:1 at worst: both.
    const cyan = deriveAccentTokens(parseColor("#00c8ff")!, DARK_SURFACES);
    expect([cyan.text, cyan.focus]).toEqual(["#00c8ff", "#00c8ff"]);
  });

  it("fails closed when no surface could be measured", () => {
    const t = deriveAccentTokens(parseColor("#ffffff")!, []);
    expect([t.text, t.focus]).toEqual([null, null]);
  });

  it("keeps --on-accent at 4.5:1 or more on the fill, hover and active for every accent", () => {
    // Every 12-bit colour: the text choice and the away-from-text hover/active
    // step together guarantee the Q1 text threshold for any custom accent.
    let worst = 21;
    for (let i = 0; i < 4096; i++) {
      const accent: Rgb = [(i >> 8) * 17, ((i >> 4) & 15) * 17, (i & 15) * 17];
      const t = deriveAccentTokens(accent, DARK_SURFACES);
      const on = parseColor(t.onAccent)!;
      for (const fill of [accent, parseColor(t.hover)!, parseColor(t.active)!]) {
        worst = Math.min(worst, contrastRatio(on, fill));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});
