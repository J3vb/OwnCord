/**
 * Theme manager for OwnCord.
 *
 * Built-in themes are applied via body CSS class (e.g. `theme-dark`).
 * The active theme name is persisted to localStorage.
 */

import { deriveAccentTokens, parseColor, type Rgb } from "./color-contrast";

const STORAGE_KEY_ACTIVE = "owncord:theme:active";
const STORAGE_KEY_LEGACY = "owncord:settings:theme";

const BUILT_IN_THEMES: ReadonlySet<string> = new Set(["dark", "neon-glow", "midnight", "light"]);

function isKnownThemeName(name: string): boolean {
  return BUILT_IN_THEMES.has(name);
}

/**
 * Apply a built-in theme by name.
 * - Adds `theme-<name>` class to document.body.
 * - Persists the active theme name to localStorage.
 */
export function applyThemeByName(name: string): void {
  // Remove all existing theme- classes
  // oxlint-disable-next-line no-useless-spread -- snapshot needed: classList mutates during iteration
  for (const cls of [...document.body.classList]) {
    if (cls.startsWith("theme-")) {
      document.body.classList.remove(cls);
    }
  }
  // Remove any previously injected inline CSS variable overrides (e.g. the
  // accent color AppearanceTab sets on body via applyAccent).
  const style = document.body.style;
  for (let i = style.length - 1; i >= 0; i--) {
    const prop = style.item(i);
    if (prop.startsWith("--")) {
      style.removeProperty(prop);
    }
  }

  if (BUILT_IN_THEMES.has(name)) {
    document.body.classList.add(`theme-${name}`);
  }

  localStorage.setItem(STORAGE_KEY_ACTIVE, name);
}

/** Returns the currently active theme name, defaulting to "neon-glow". */
export function getActiveThemeName(): string {
  const active = localStorage.getItem(STORAGE_KEY_ACTIVE);
  if (active !== null && active.length > 0 && isKnownThemeName(active)) {
    return active;
  }

  if (active !== null) {
    localStorage.removeItem(STORAGE_KEY_ACTIVE);
  }

  try {
    const legacyRaw = localStorage.getItem(STORAGE_KEY_LEGACY);
    if (legacyRaw !== null) {
      const legacyName: unknown = JSON.parse(legacyRaw);
      if (typeof legacyName === "string" && legacyName.length > 0 && isKnownThemeName(legacyName)) {
        localStorage.setItem(STORAGE_KEY_ACTIVE, legacyName);
        return legacyName;
      }
    }
  } catch {
    // Ignore corrupted legacy settings and fall back to the default theme.
  }

  return "neon-glow";
}

/** Every surface an accent can sit on as text or as a focus ring. */
const SURFACE_TOKENS = ["--bg-primary", "--bg-secondary", "--bg-tertiary", "--bg-input"] as const;

function themeSurfaces(): Rgb[] {
  const cs = getComputedStyle(document.body);
  const surfaces: Rgb[] = [];
  for (const token of SURFACE_TOKENS) {
    const rgb = parseColor(cs.getPropertyValue(token));
    // One unreadable surface means the accent's contrast is unknown, and
    // deriveAccentTokens falls back to the theme colour on an empty list.
    if (rgb === null) return [];
    surfaces.push(rgb);
  }
  return surfaces;
}

/**
 * Apply a custom accent: the single writer of the accent's inline tokens.
 *
 * Must run after the theme is applied, both so it wins over the theme's
 * --accent via inline-style specificity and so the contrast check reads the
 * theme's surfaces. Fills take the user's colour; --on-accent, --accent-hover
 * and --accent-active are derived from it; --accent-text takes it only at 4.5:1
 * or better and --focus-ring only at 3:1 or better, otherwise each keeps the
 * theme's tested colour (B9-2, owner decision Q8 as aligned with Q1). High Contrast overrides those two
 * again from app/accessibility.css. An unparseable colour applies nothing.
 */
export function applyAccent(color: string): void {
  const accent = parseColor(color);
  if (accent === null) return;
  const html = document.documentElement.style;
  const body = document.body.style;
  // Set on both documentElement and body: :root derives --accent-primary and
  // --accent-secondary from these, and body.theme-neon-glow sets its own.
  html.setProperty("--accent", color);
  body.setProperty("--accent", color);
  const tokens = deriveAccentTokens(accent, themeSurfaces());
  for (const [prop, value] of [
    ["--on-accent", tokens.onAccent],
    ["--accent-hover", tokens.hover],
    ["--accent-active", tokens.active],
  ] as const) {
    html.setProperty(prop, value);
    body.setProperty(prop, value);
  }
  // Body only: the light theme writes its tested --accent-text/--focus-ring
  // inline on documentElement, and removing them here must not erase those.
  for (const [prop, value] of [
    ["--accent-text", tokens.text],
    ["--focus-ring", tokens.focus],
  ] as const) {
    if (value === null) body.removeProperty(prop);
    else body.setProperty(prop, value);
  }
}

/**
 * Restore the user's accent color override (saved by AppearanceTab).
 * Must run after the theme is applied; see applyAccent.
 */
export function restoreAccent(): void {
  try {
    const raw = localStorage.getItem("owncord:settings:accentColor");
    if (raw !== null) {
      const accent: unknown = JSON.parse(raw);
      if (typeof accent === "string") applyAccent(accent);
    }
  } catch {
    // Corrupted localStorage — ignore, theme default will apply.
  }
}

/**
 * Restores the previously persisted theme and accent color.
 * Used by the Appearance tab when there is no explicit theme selected.
 */
export function restoreTheme(): void {
  applyThemeByName(getActiveThemeName());
  restoreAccent();
}
