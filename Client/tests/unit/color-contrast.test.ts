import { describe, it, expect } from "vitest";
import {
  clampTextColor,
  contrastRatio,
  deriveAccentTokens,
  parseColor,
  toHex,
  type Rgb,
} from "../../src/lib/text/colorContrast";
import { THEMES as PALETTES } from "../../src/lib/prefs/themes";

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

  it("derives gunmetal's orange accent tokens, the literals in theme-gunmetal.css", () => {
    const surfaces = ["#181d24", "#12161b", "#0c0f13", "#202731"].map((c) => parseColor(c)!);
    const t = deriveAccentTokens(parseColor("#ff7a45")!, surfaces);
    expect(t.onAccent).toBe("#000000");
    expect(t.hover).toBe("#ff8e61");
    expect(t.active).toBe("#ffa27d");
    expect(t.text).toBe("#ff7a45");
    expect(t.focus).toBe("#ff7a45");
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

  it("moves a grey along its own lightness and stays grey", () => {
    for (const surfaces of Object.values(THEMES)) {
      const out = clampTextColor(parseColor("#808080")!, surfaces)!;
      expect(out[0]).toBe(out[1]);
      expect(out[1]).toBe(out[2]);
      for (const s of surfaces) expect(contrastRatio(out, s)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reaches pure white or black when only that reads", () => {
    // On #747474 at 4.65:1 only #ffffff passes (#fefefe reads 4.63:1), and
    // #7b7b7b's lightness is off the 0.005 grid.
    const out = clampTextColor(parseColor("#7b7b7b")!, [parseColor("#747474")!], 4.65);
    expect(out === null ? null : toHex(out)).toBe("#ffffff");
  });

  it("fails closed with nothing to measure", () => {
    expect(clampTextColor(parseColor("#ff0000")!, [])).toBeNull();
  });
});

describe("Gunmetal palette contrast", () => {
  const g: Record<string, string> = PALETTES.gunmetal;
  const rgb = (token: string): Rgb => parseColor(g[token]!)!;
  const ratio = (fg: string, bg: string): number => contrastRatio(rgb(fg), rgb(bg));
  const SURFACES = ["--bg-primary", "--bg-secondary", "--bg-tertiary", "--bg-input"];
  const SIDES = ["--bg-primary", "--bg-secondary"];

  it("keeps every qualified text token at 4.5:1 on all four surfaces", () => {
    for (const text of [
      "--text-normal",
      "--text-muted",
      "--header-primary",
      "--header-secondary",
      "--text-link",
    ]) {
      for (const bg of SURFACES) {
        expect(ratio(text, bg), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("reads --text-faint headings and --role-member names at 4.5:1 on the main and side columns", () => {
    for (const text of ["--text-faint", "--role-member"]) {
      for (const bg of SIDES) {
        expect(ratio(text, bg), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps --text-micro a step below --text-faint, and above neon-glow's ratio", () => {
    // neon-glow inherits tokens.css's --text-micro.
    const neonMicro = parseColor("#6d6f78")!;
    const neon: Record<string, string> = PALETTES["neon-glow"];
    for (const bg of SIDES) {
      const micro = ratio("--text-micro", bg);
      expect(micro, bg).toBeLessThan(ratio("--text-faint", bg));
      expect(micro, bg).toBeGreaterThan(contrastRatio(neonMicro, parseColor(neon[bg]!)!));
    }
  });

  it("draws icons and the scrollbar thumb at 3:1 where they sit", () => {
    for (const bg of SURFACES) {
      expect(ratio("--interactive-normal", bg), bg).toBeGreaterThanOrEqual(3);
    }
    for (const thumb of ["--scrollbar-thin-thumb", "--scrollbar-auto-thumb"]) {
      for (const bg of SIDES) {
        expect(ratio(thumb, bg), `${thumb} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("tints its neutral tokens blue-grey rather than inheriting the dark greys", () => {
    for (const token of [
      "--text-micro",
      "--interactive-normal",
      "--interactive-muted",
      "--scrollbar-thin-thumb",
      "--role-member",
    ]) {
      const [r, , b] = rgb(token);
      expect(b, token).toBeGreaterThan(r);
    }
    expect(g["--bg-modifier-selected"]).toBe("rgba(76, 89, 107, 0.32)");
  });
});

describe("text on each built-in accent fill", () => {
  // Each theme's default --accent with its --on-accent (tokens.css, theme-*.css).
  it.each([
    ["dark and midnight", "#5865f2", "#ffffff"],
    ["neon-glow", "#00c8ff", "#000000"],
    ["gunmetal", "#ff7a45", "#000000"],
    ["light", "#4f5bd5", "#ffffff"],
  ])("reads at 4.5:1 on %s", (_theme, accent, onAccent) => {
    expect(contrastRatio(parseColor(onAccent)!, parseColor(accent)!)).toBeGreaterThanOrEqual(4.5);
  });

  it("is why --on-fill (white) is wrong there: it misses on Ember and cyan", () => {
    const white = parseColor("#ffffff")!;
    expect(contrastRatio(white, parseColor("#ff7a45")!)).toBeLessThan(3);
    expect(contrastRatio(white, parseColor("#00c8ff")!)).toBeLessThan(3);
  });
});
