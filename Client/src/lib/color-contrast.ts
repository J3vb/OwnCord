/**
 * WCAG 2.x colour contrast math and the custom-accent derivation (B9-2).
 *
 * The owner's Q8 decision (docs/plans/b9-unified-experience-accessibility-polish.prd.md):
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
    return [short[1]!, short[2]!, short[3]!].map((h) => parseInt(h + h, 16)) as unknown as Rgb;
  }
  const long = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/.exec(v);
  if (long !== null) {
    return [long[1]!, long[2]!, long[3]!].map((h) => parseInt(h, 16)) as unknown as Rgb;
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (fn !== null) {
    return [fn[1]!, fn[2]!, fn[3]!].map((n) => Math.min(255, Number(n))) as unknown as Rgb;
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

function mix(from: Rgb, to: Rgb, weight: number): Rgb {
  return from.map((c, i) => Math.round(c + (to[i]! - c) * weight)) as unknown as Rgb;
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
