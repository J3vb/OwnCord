/**
 * Theme manager for OwnCord.
 *
 * Built-in themes are applied via body CSS class (e.g. `theme-dark`).
 * The active theme name is persisted to localStorage.
 */

import { Disposable } from "./disposable";
import { readStored, removeStored, writeStored } from "./preferences";
import { deriveAccentTokens, parseColor, type Rgb } from "./color-contrast";

/** Built-in theme palettes. Moved here from `@components/settings/helpers` so
 *  `lib/` and `features/` modules can apply a theme without importing the
 *  component layer. */
export const THEMES = {
  dark: {
    "--bg-primary": "#313338",
    "--bg-secondary": "#2b2d31",
    "--bg-tertiary": "#1e1f22",
    "--text-normal": "#dbdee1",
  },
  "neon-glow": {
    "--bg-primary": "#17181b",
    "--bg-secondary": "#111214",
    "--bg-tertiary": "#0b0c0e",
    "--text-normal": "#dfe2e6",
  },
  midnight: {
    "--bg-primary": "#1a1a2e",
    "--bg-secondary": "#16213e",
    "--bg-tertiary": "#0f1a38",
    "--text-normal": "#e2e4ef",
    // Refined Neon (B9 Q13): midnight used to inherit dark's input fill and
    // text roles, which were tuned for grey surfaces. Tested values; see
    // docs/architecture/ui-contract.md.
    "--bg-input": "#232845",
    "--text-muted": "#a9b0c8",
    "--header-primary": "#f4f5fa",
    "--text-link": "#5cc8ff",
    "--border-control": "#6a7194",
  },
  light: {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f2f3f5",
    "--bg-tertiary": "#e3e5e8",
    "--text-normal": "#2a2c31",
    // The 4 keys above are all this theme used to set. Every other
    // surface/text/border/interactive token then fell through to tokens.css's
    // dark defaults, so widgets painting --text-normal (now dark) on top of
    // e.g. --bg-input (still dark) rendered as unreadable dark-on-dark.
    "--bg-input": "#ebedef",
    "--bg-hover": "#e8e9ed",
    "--bg-active": "#dcdfe4",
    "--bg-modifier-hover": "rgba(0, 0, 0, 0.06)",
    "--bg-modifier-active": "rgba(0, 0, 0, 0.08)",
    "--bg-modifier-selected": "rgba(0, 0, 0, 0.1)",
    "--text-muted": "#51545c",
    "--text-faint": "#747f8d",
    "--text-micro": "#949ba4",
    "--header-primary": "#060607",
    "--header-secondary": "#4e5058",
    "--interactive-normal": "#4e5058",
    "--interactive-hover": "#23272a",
    "--interactive-active": "#000000",
    "--interactive-muted": "#c7ccd1",
    "--channel-icon": "#6d6f78",
    "--border": "#e3e5e8",
    "--border-strong": "#cbccd1",
    "--scrollbar-thin-thumb": "#cdcfd4",
    "--scrollbar-auto-thumb": "#cdcfd4",
    // The dark defaults for these read below 4.5:1 (text) or 3:1
    // (focus) on light surfaces. Tested values; see docs/architecture/ui-contract.md.
    "--text-link": "#00658f",
    "--text-positive": "#17703f",
    "--text-warning": "#7a5500",
    "--text-danger": "#b3261e",
    "--accent-text": "#4150c4",
    "--focus-ring": "#4752c4",
    // Refined Neon (B9 Q13); light's accent fills are body.theme-light in
    // tokens.css, outside the keys applyTheme clears.
    "--danger-fill": "#c62828",
    "--danger-fill-hover": "#a61f1f",
    "--border-control": "#7d838d",
  },
} as const;

export type ThemeName = keyof typeof THEMES;

// Union of every CSS custom property any built-in theme sets. Used by
// applyTheme to clear a previous theme's tokens before applying a new one,
// without touching inline properties owned by other code (e.g. --accent,
// --font-size).
const THEME_KEYS: ReadonlySet<string> = new Set(
  Object.values(THEMES).flatMap((theme) => Object.keys(theme)),
);

const STORAGE_KEY_ACTIVE = "owncord:theme:active";
const STORAGE_KEY_LEGACY = "owncord:settings:theme";

const BUILT_IN_THEMES: ReadonlySet<string> = new Set(Object.keys(THEMES));

/**
 * The stored choice that follows the computer's light/dark setting. It is not
 * a palette, so it is not in THEMES or ThemeName: it resolves to one of them.
 */
export const SYSTEM_THEME = "system";

const SYSTEM_DARK_THEME: ThemeName = "dark";
const SYSTEM_LIGHT_THEME: ThemeName = "light";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isKnownThemeName(name: string): boolean {
  return name === SYSTEM_THEME || BUILT_IN_THEMES.has(name);
}

const systemPaintListeners = new Set<() => void>();

/**
 * Run `cb` after an OS light/dark flip has repainted the "system" theme (and
 * restored any stored accent). A control that shows the default accent uses it
 * to refresh. Unsubscribes when `signal` aborts.
 */
export function onSystemThemePainted(cb: () => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  systemPaintListeners.add(cb);
  signal.addEventListener("abort", () => systemPaintListeners.delete(cb), { once: true });
}

/** Owns the live prefers-color-scheme listener while "system" is the choice. */
let systemOwner: Disposable | null = null;

function stopSystemSync(): void {
  systemOwner?.destroy();
  systemOwner = null;
}

function osPrefersDark(mq: MediaQueryList | null): boolean {
  // No matchMedia (or no answer) keeps the dark default the app ships with.
  return mq === null ? true : mq.matches;
}

/**
 * Choose a theme by stored name: a built-in palette, or "system".
 *
 * "system" paints the dark or light palette for the OS setting, persists
 * "system" (not the palette) and keeps following the OS until another theme is
 * applied. Applying any concrete theme ends the sync.
 */
export function applyThemeChoice(choice: string): void {
  if (choice !== SYSTEM_THEME) {
    applyTheme(choice as ThemeName);
    return;
  }
  stopSystemSync();
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  const paint = (): void => {
    paintTheme(osPrefersDark(mq) ? SYSTEM_DARK_THEME : SYSTEM_LIGHT_THEME);
    // paintTheme persists the palette name; this second write puts "system" back.
    writeStored(STORAGE_KEY_ACTIVE, SYSTEM_THEME);
  };
  paint();
  restoreAccent();
  if (mq === null) return;
  const owner = new Disposable();
  systemOwner = owner;
  mq.addEventListener(
    "change",
    () => {
      paint();
      // paintTheme clears the body's inline tokens, which carry the accent.
      restoreAccent();
      for (const cb of systemPaintListeners) cb();
    },
    { signal: owner.signal },
  );
}

/** The palette "system" resolves to right now. */
export function resolveSystemTheme(): ThemeName {
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  return osPrefersDark(mq) ? SYSTEM_DARK_THEME : SYSTEM_LIGHT_THEME;
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

  writeStored(STORAGE_KEY_ACTIVE, name);
  reclampRoleColors();
}

/**
 * Apply a built-in theme's palette inline on documentElement, then hand the
 * body class and persistence to applyThemeByName. Moved here from
 * `@components/settings/helpers` so `lib/` can apply a stored theme
 * without importing the component layer.
 */
export function applyTheme(name: ThemeName): void {
  stopSystemSync();
  paintTheme(name);
}

function paintTheme(name: ThemeName): void {
  const theme = THEMES[name];
  const root = document.documentElement;
  // Clear every key any built-in theme owns first, so switching to a theme
  // that sets fewer keys (e.g. light -> dark) doesn't leave the previous
  // theme's tokens stuck on <html>, outranking tokens.css's :root defaults
  // via inline-style specificity. Keys owned by other code (--accent,
  // --font-size) are not in THEME_KEYS and are left untouched.
  for (const key of THEME_KEYS) {
    root.style.removeProperty(key);
  }
  // Apply CSS variables for the theme (keeps existing behavior for inline var overrides)
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(key, value);
  }
  // Delegate body class and persistence to the theme manager
  applyThemeByName(name);
}

/** Returns the stored theme choice (a palette name or "system"), defaulting to "neon-glow". */
export function getActiveThemeName(): string {
  const active = readStored(STORAGE_KEY_ACTIVE);
  if (active !== null && active.length > 0 && isKnownThemeName(active)) {
    return active;
  }

  if (active !== null) {
    removeStored(STORAGE_KEY_ACTIVE);
  }

  try {
    const legacyRaw = readStored(STORAGE_KEY_LEGACY);
    if (legacyRaw !== null) {
      const legacyName: unknown = JSON.parse(legacyRaw);
      if (typeof legacyName === "string" && legacyName.length > 0 && isKnownThemeName(legacyName)) {
        writeStored(STORAGE_KEY_ACTIVE, legacyName);
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

/** Clamped role colours by requested colour, for the current theme's surfaces. */
const roleTextCache = new Map<string, string>();

/**
 * A role colour used as text, e.g. a username (B9 Q13 role clamp).
 *
 * Role colours are server-set, so nothing else stands between an admin's
 * `#ff0000` and a name that cannot be read. The rule and the math are the
 * custom accent's `--accent-text` (deriveAccentTokens): the colour is used only
 * where it reads at 4.5:1 on every theme surface, otherwise the name is
 * `--text-normal`. `color` may be any CSS colour, including a `var(--role-*)`
 * fallback; the result is a normalised `#rrggbb` or `var(--text-normal)`, never
 * the raw string. Render the element with `data-role-color` holding `color`
 * so a theme switch can clamp it again.
 */
export function readableRoleColor(color: string): string {
  let out = roleTextCache.get(color);
  if (out === undefined) {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.appendChild(probe);
    const rgb = parseColor(getComputedStyle(probe).color);
    probe.remove();
    const text = rgb === null ? null : deriveAccentTokens(rgb, themeSurfaces()).text;
    out = text ?? "var(--text-normal)";
    roleTextCache.set(color, out);
  }
  return out;
}

/** Re-clamp every rendered role colour against the theme now applied. */
export function reclampRoleColors(): void {
  roleTextCache.clear();
  for (const el of document.querySelectorAll<HTMLElement>("[data-role-color]")) {
    el.style.color = readableRoleColor(el.dataset["roleColor"] ?? "");
  }
}

/**
 * Apply a custom accent: the single writer of the accent's inline tokens.
 *
 * Must run after the theme is applied, both so it wins over the theme's
 * --accent via inline-style specificity and so the contrast check reads the
 * theme's surfaces. Fills take the user's colour; --on-accent, --accent-hover
 * and --accent-active are derived from it; --accent-text takes it only at 4.5:1
 * or better and --focus-ring only at 3:1 or better, otherwise each keeps the
 * theme's tested colour (see color-contrast.ts for the thresholds). High Contrast overrides those two
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
    const raw = readStored("owncord:settings:accentColor");
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
  const active = getActiveThemeName();
  if (active === SYSTEM_THEME) {
    applyThemeChoice(active);
    return;
  }
  applyThemeByName(active);
  restoreAccent();
}
