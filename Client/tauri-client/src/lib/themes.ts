/**
 * Theme manager for OwnCord.
 *
 * Built-in themes are applied via body CSS class (e.g. `theme-dark`).
 * Custom themes override CSS variables inline on document.body.
 * The active theme name is persisted to localStorage.
 */

const STORAGE_KEY_ACTIVE = "owncord:theme:active";
const STORAGE_KEY_CUSTOM_PREFIX = "owncord:theme:custom:";

export interface OwnCordTheme {
  readonly name: string;
  readonly author: string;
  readonly version: string;
  readonly colors: Readonly<Record<string, string>>;
}

const BUILT_IN_THEMES: readonly string[] = ["dark", "neon-glow", "midnight", "light"];

/** Returns all known theme names: built-ins first, then any saved custom themes. */
export function listThemeNames(): readonly string[] {
  const custom: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && key.startsWith(STORAGE_KEY_CUSTOM_PREFIX)) {
      custom.push(key.slice(STORAGE_KEY_CUSTOM_PREFIX.length));
    }
  }
  return [...BUILT_IN_THEMES, ...custom];
}

/**
 * Apply a theme by name.
 * - Built-in themes: adds `theme-<name>` class to document.body.
 * - Custom themes: adds `theme-custom` class and sets inline CSS variables.
 * - Persists the active theme name to localStorage.
 */
export function applyThemeByName(name: string): void {
  // Remove all existing theme- classes
  for (const cls of [...document.body.classList]) {
    if (cls.startsWith("theme-")) {
      document.body.classList.remove(cls);
    }
  }
  // Remove any previously injected inline CSS variable overrides
  const style = document.body.style;
  for (let i = style.length - 1; i >= 0; i--) {
    const prop = style.item(i);
    if (prop.startsWith("--")) {
      style.removeProperty(prop);
    }
  }

  if (BUILT_IN_THEMES.includes(name)) {
    document.body.classList.add(`theme-${name}`);
  } else {
    const theme = loadCustomTheme(name);
    if (theme !== null) {
      document.body.classList.add("theme-custom");
      for (const [prop, value] of Object.entries(theme.colors)) {
        // Validate: property must be a CSS custom property with a spec-compliant
        // ident name; value must only contain safe CSS value characters to
        // prevent CSS injection from untrusted theme JSON files.
        if (!prop.startsWith("--") || !/^[a-zA-Z_][\w-]*$/.test(prop.slice(2))) continue;
        if (typeof value !== "string") continue;
        // Reject any value containing ( or ) — no CSS functions allowed.
        // Also reject { and } to block any injection attempts.
        if (/[(){}]/.test(value)) continue;
        // Allowlist: only permit characters found in typical CSS color/sizing values.
        // No parentheses — colors must use #hex format, not rgb()/hsl().
        if (!/^[\w\s#.,%+\-/]+$/.test(value)) continue;
        // Deny-list: block dangerous CSS keywords that slip through the allowlist.
        if (/\b(url|expression|import|image|cross-fade|element)\b/i.test(value)) continue;
        style.setProperty(prop, value);
      }
    }
  }

  localStorage.setItem(STORAGE_KEY_ACTIVE, name);
}

/** Returns the currently active theme name, defaulting to "neon-glow". */
export function getActiveThemeName(): string {
  return localStorage.getItem(STORAGE_KEY_ACTIVE) ?? "neon-glow";
}

/** Persists a custom theme to localStorage. */
export function saveCustomTheme(theme: OwnCordTheme): void {
  localStorage.setItem(
    STORAGE_KEY_CUSTOM_PREFIX + theme.name,
    JSON.stringify(theme),
  );
}

/** Loads a custom theme by name, or null if not found / parse error / invalid shape. */
export function loadCustomTheme(name: string): OwnCordTheme | null {
  const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_PREFIX + name);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>).name !== "string" ||
      typeof (parsed as Record<string, unknown>).colors !== "object"
    ) {
      return null;
    }
    return parsed as OwnCordTheme;
  } catch {
    return null;
  }
}

/**
 * Removes a custom theme from localStorage.
 * If it was the active theme, falls back to "dark".
 */
export function deleteCustomTheme(name: string): void {
  localStorage.removeItem(STORAGE_KEY_CUSTOM_PREFIX + name);
  if (getActiveThemeName() === name) {
    applyThemeByName("dark");
  }
}

/** Serialises a theme to a JSON string suitable for file export/import. */
export function exportTheme(theme: OwnCordTheme): string {
  return JSON.stringify(theme, null, 2);
}

/**
 * Restores the previously persisted theme and accent color on application startup.
 * Call once from the app entry point.
 */
export function restoreTheme(): void {
  applyThemeByName(getActiveThemeName());

  // Restore the user's accent color override (saved by AppearanceTab).
  // The accent must be applied after the theme so it wins over the theme's
  // --accent value via inline style specificity.
  try {
    const raw = localStorage.getItem("owncord:settings:accentColor");
    if (raw !== null) {
      const accent = JSON.parse(raw);
      if (typeof accent === "string" && /^#[\da-fA-F]{3,8}$/.test(accent)) {
        document.documentElement.style.setProperty("--accent", accent);
        document.body.style.setProperty("--accent", accent);
      }
    }
  } catch {
    // Corrupted localStorage — ignore, theme default will apply.
  }
}
