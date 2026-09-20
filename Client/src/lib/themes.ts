/**
 * Theme manager for OwnCord.
 *
 * Built-in themes are applied via body CSS class (e.g. `theme-dark`).
 * The active theme name is persisted to localStorage.
 */

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

/**
 * Restore the user's accent color override (saved by AppearanceTab).
 *
 * Must run after the theme is applied so it wins over the theme's --accent
 * value via inline style specificity.
 */
export function restoreAccent(): void {
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

/**
 * Restores the previously persisted theme and accent color.
 * Used by the Appearance tab when there is no explicit theme selected.
 */
export function restoreTheme(): void {
  applyThemeByName(getActiveThemeName());
  restoreAccent();
}
