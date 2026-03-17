/**
 * Shared helpers and constants for settings tabs.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STORAGE_PREFIX = "owncord:settings:";

export const THEMES = {
  dark: { "--bg-primary": "#313338", "--bg-secondary": "#2b2d31", "--bg-tertiary": "#1e1f22", "--text-normal": "#dbdee1" },
  midnight: { "--bg-primary": "#1a1a2e", "--bg-secondary": "#16213e", "--bg-tertiary": "#0f3460", "--text-normal": "#e0e0e0" },
  light: { "--bg-primary": "#ffffff", "--bg-secondary": "#f2f3f5", "--bg-tertiary": "#e3e5e8", "--text-normal": "#313338" },
} as const;

export type ThemeName = keyof typeof THEMES;

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Theme application
// ---------------------------------------------------------------------------

export function applyTheme(name: ThemeName): void {
  const vars = THEMES[name];
  const root = document.documentElement;
  for (const [prop, val] of Object.entries(vars)) {
    root.style.setProperty(prop, val);
  }
}
