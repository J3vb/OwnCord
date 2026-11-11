/**
 * WCAG 2.x colour contrast math and the custom-accent derivation.
 *
 * The owner's Q8 decision (docs/archive/plans/b9-unified-experience-accessibility-polish.prd.md):
 * a custom accent is honoured for fills; `--on-accent`, `--accent-hover` and
 * `--accent-active` are derived from it; and where the accent is itself the
 * text (below 4.5:1) or the focus indicator (below 3:1) on the theme's
 * surfaces, that use falls back to the theme's tested colour. The split by use
 * is the owner's 2026-09-23 clarification aligning Q8 with Q1.
 *
 * Pure functions only, so the Playwright contrast checks can import the same
 * math the app uses.
 */

export type Rgb = readonly [number, number, number];

/** Applies `f` to each of three values, keeping the three-tuple type. */
function map3<T>(t: readonly [T, T, T], f: (x: T, i: number) => number): Rgb {
  return [f(t[0], 0), f(t[1], 1), f(t[2], 2)];
}

/**
 * Text for light accents. Black, not a softer near-black: with it, the better
 * of the two text colours reads at >= 4.58:1 on ANY accent; #111214 would
 * leave mid-luminance accents at 4.3:1.
 */
export const ON_ACCENT_DARK = "#000000";
export const ON_ACCENT_LIGHT = "#ffffff";

/** Q1/Q8: below these, an accent is not used as text / as a focus indicator. */
export const ACCENT_TEXT_MIN_CONTRAST = 4.5;
export const ACCENT_FOCUS_MIN_CONTRAST = 3;

/**
 * Parse `#rgb`, `#rrggbb` or a computed `rgb()`/`rgba()` string. Alpha is
 * dropped; callers composite translucent layers themselves. Returns null for
 * anything else, so an unexpected value fails closed rather than guessing.
 */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const short = /^#([\da-f])([\da-f])([\da-f])$/.exec(v);
  if (short !== null) {
    return map3([short[1]!, short[2]!, short[3]!], (h) => parseInt(h + h, 16));
  }
  const long = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/.exec(v);
  if (long !== null) {
    return map3([long[1]!, long[2]!, long[3]!], (h) => parseInt(h, 16));
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (fn !== null) {
    return map3([fn[1]!, fn[2]!, fn[3]!], (n) => Math.min(255, Number(n)));
  }
  return null;
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio, 1 to 21, order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mix(from: Rgb, to: Rgb, weight: number): Rgb {
  return map3(from, (c, i) => Math.round(c + (to[i]! - c) * weight));
}

export interface AccentTokens {
  readonly onAccent: string;
  readonly hover: string;
  readonly active: string;
  /** The accent as a text colour, or null to keep the theme's tested one. */
  readonly text: string | null;
  /** The accent as the focus ring, or null to keep the theme's tested one. */
  readonly focus: string | null;
}

/**
 * Derive the accent roles for `accent` on a theme whose surfaces are
 * `surfaces` (every `--bg-*` the accent may sit on as text or a ring).
 *
 * `--on-accent` is whichever of white or near-black contrasts more. Hover and
 * active move the fill AWAY from that text colour (darker under white, lighter
 * under near-black), so their contrast with it only ever rises.
 */
export function deriveAccentTokens(accent: Rgb, surfaces: readonly Rgb[]): AccentTokens {
  const light = parseColor(ON_ACCENT_LIGHT)!;
  const dark = parseColor(ON_ACCENT_DARK)!;
  const useLight = contrastRatio(accent, light) >= contrastRatio(accent, dark);
  const away: Rgb = useLight ? [0, 0, 0] : [255, 255, 255];
  const minContrast = Math.min(...surfaces.map((s) => contrastRatio(accent, s)));
  return {
    onAccent: useLight ? ON_ACCENT_LIGHT : ON_ACCENT_DARK,
    hover: toHex(mix(accent, away, 0.15)),
    active: toHex(mix(accent, away, 0.3)),
    // No surfaces means nothing was measurable: fail closed to the theme colour.
    text: surfaces.length > 0 && minContrast >= ACCENT_TEXT_MIN_CONTRAST ? toHex(accent) : null,
    focus: surfaces.length > 0 && minContrast >= ACCENT_FOCUS_MIN_CONTRAST ? toHex(accent) : null,
  };
}

type Hsl = readonly [number, number, number];

function toHsl(rgb: Rgb): Hsl {
  const [r, g, b] = map3(rgb, (c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hueChannel(p: number, q: number, t: number): number {
  const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}

function fromHsl(hsl: Hsl): Rgb {
  const [h, s, l] = hsl;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return map3(
    [hueChannel(p, q, h + 1 / 3), hueChannel(p, q, h), hueChannel(p, q, h - 1 / 3)],
    (c) => Math.round(c * 255),
  );
}

const LIGHTNESS_STEP = 0.005;

/**
 * `color` as text on `surfaces`, keeping its hue and saturation and moving only
 * its lightness, the shortest way, until it reads at `min` on every surface.
 * Returns the colour itself when it already does, and null when no lightness
 * works (surfaces on both sides of the colour) or nothing was measurable.
 */
export function clampTextColor(
  color: Rgb,
  surfaces: readonly Rgb[],
  min: number = ACCENT_TEXT_MIN_CONTRAST,
): Rgb | null {
  if (surfaces.length === 0) return null;
  const reads = (c: Rgb): boolean => surfaces.every((s) => contrastRatio(c, s) >= min);
  if (reads(color)) return color;
  const [h, s, l0] = toHsl(color);
  const steps = Math.ceil(1 / LIGHTNESS_STEP);
  for (let i = 1; i <= steps; i++) {
    const delta = i * LIGHTNESS_STEP;
    for (const l of [Math.min(1, l0 + delta), Math.max(0, l0 - delta)]) {
      const candidate = fromHsl([h, s, l]);
      if (reads(candidate)) return candidate;
    }
  }
  return null;
}
