/**
 * Stored appearance preferences — applied at app startup.
 *
 * Extracted from SettingsOverlay so the startup path (main.ts, ConnectPage)
 * can apply the stored theme/font/compact prefs without pulling in the full
 * settings overlay (whose tabs statically import the LiveKit stack).
 */

import { loadPref, applyTheme, THEMES } from "@components/settings/helpers";
import type { ThemeName } from "@components/settings/helpers";
import { getActiveThemeName, restoreTheme } from "@lib/themes";
import { syncOsMotionListener } from "@lib/os-motion";

/**
 * Apply stored appearance preferences (theme, font size, compact mode).
 * Call at app startup so the UI doesn't flash default styles.
 */
export function applyStoredAppearance(): void {
  const activeThemeName = getActiveThemeName();
  if (activeThemeName in THEMES) {
    applyTheme(activeThemeName as ThemeName);
  } else {
    restoreTheme();
  }
  try {
    const rawAccent = localStorage.getItem("owncord:settings:accentColor");
    if (rawAccent !== null) {
      const accent = JSON.parse(rawAccent);
      if (typeof accent === "string" && /^#[\da-fA-F]{3,8}$/.test(accent)) {
        document.documentElement.style.setProperty("--accent", accent);
        document.body.style.setProperty("--accent", accent);
      }
    }
  } catch {
    // Corrupted localStorage — keep the theme default accent.
  }
  document.documentElement.style.setProperty(
    "--font-size",
    `${loadPref<number>("fontSize", 16)}px`,
  );
  document.documentElement.classList.toggle(
    "compact-mode",
    loadPref<boolean>("compactMode", false),
  );
  document.documentElement.classList.toggle(
    "reduced-motion",
    loadPref<boolean>("reducedMotion", false),
  );
  document.documentElement.classList.toggle(
    "high-contrast",
    loadPref<boolean>("highContrast", false),
  );
  document.documentElement.classList.toggle("large-font", loadPref<boolean>("largeFont", false));

  syncOsMotionListener(loadPref<boolean>("syncOsMotion", false));
}
