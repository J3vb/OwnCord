import { describe, it, expect } from "vitest";
import {
  clampTextColor,
  contrastRatio,
  deriveAccentTokens,
  parseColor,
  toHex,
  type Rgb,
} from "../../src/lib/text/colorContrast";

const DARK_SURFACES: Rgb[] = ["#313338", "#2b2d31", "#1e1f22", "#383a40"].map((c) =>
  parseColor(c)!,
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

describe("clampTextColor", () => {
  /** Discord's preset role colours, the ones admins pick most. */
  const PRESETS = [
    "#1abc9c",
    "#2ecc71",
    "#3498db",
    "#9b59b6",
    "#e91e63",
    "#f1c40f",
    "#e67e22",
    "#e74c3c",
    "#95a5a6",
    "#607d8b",
    "#11806a",
    "#1f8b4c",
    "#206694",
    "#71368a",
    "#ad1457",
    "#c27c0e",
    "#a84300",
    "#992d22",
    "#979c9f",
    "#546e7a",
    "#ff0000",
    "#5865f2",
  ];
  const THEMES: Record<string, Rgb[]> = {
    dark: ["#313338", "#2b2d31"].map((c) => parseColor(c)!),
    light: ["#ffffff", "#f2f3f5"].map((c) => parseColor(c)!),
  };

  function hue(rgb: Rgb): number {
    const [r, g, b] = rgb.map((c) => c / 255) as unknown as Rgb;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }
  const spread = (rgb: Rgb): number => Math.max(...rgb) - Math.min(...rgb);

  for (const [theme, surfaces] of Object.entries(THEMES)) {
    it(`keeps every preset readable and visibly tinted on ${theme}`, () => {
      for (const hex of PRESETS) {
        const input = parseColor(hex)!;
        const out = clampTextColor(input, surfaces);
        expect(out, hex).not.toBeNull();
        for (const s of surfaces) {
          expect(contrastRatio(out!, s), hex).toBeGreaterThanOrEqual(4.5);
        }
        // Still the same colour family, not grey: the hue holds and some tint is left.
        const dh = Math.abs(hue(out!) - hue(input));
        expect(Math.min(dh, 360 - dh), hex).toBeLessThan(8);
        expect(spread(out!), hex).toBeGreaterThanOrEqual(Math.min(16, spread(input)));
      }
    });
  }

  it("returns a colour that already reads unchanged", () => {
    const green = parseColor("#57f287")!;
    expect(clampTextColor(green, THEMES["dark"]!)).toBe(green);
  });

  it("lightens on dark surfaces and darkens on light ones", () => {
    const red = parseColor("#ff0000")!;
    const onDark = clampTextColor(red, THEMES["dark"]!)!;
    const onLight = clampTextColor(red, THEMES["light"]!)!;
    expect(onDark[1]).toBeGreaterThan(0);
    expect(onLight[0]).toBeLessThan(255);
  });

  it("gives up when no lightness reads on surfaces either side of mid-grey", () => {
    const surfaces = ["#404040", "#c0c0c0"].map((c) => parseColor(c)!);
    expect(clampTextColor(parseColor("#ff0000")!, surfaces)).toBeNull();
  });

  it("fails closed with nothing to measure", () => {
    expect(clampTextColor(parseColor("#ff0000")!, [])).toBeNull();
  });
});
