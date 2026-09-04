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

/** The Appearance slider's range, and the clamp applied to a stored value. */
export const MIN_FONT_SIZE_PX = 12;
export const MAX_FONT_SIZE_PX = 20;
/** The floor Large Font raises the effective size to. */
export const LARGE_FONT_MIN_PX = 18;

/**
 * The font size that should actually be rendered, from both preferences.
 *
 * Exported so the Appearance slider's label can show what the user will see
 * rather than the raw slider position — with Large Font on they differ.
 */
export function effectiveFontSize(): number {
  const stored = loadPref<number>("fontSize", 16);
  // localStorage is a trust boundary. loadPref only checks the parsed value's
  // typeof against the fallback, so Infinity (JSON.parse("1e999")) gets
  // through, and a hand-edited or corrupted entry can be anything at all.
  const size = typeof stored === "number" && Number.isFinite(stored) ? stored : 16;
  // Clamping to the slider's own range matters in the low direction: the old
  // code wrote a negative size straight out, which CSS rejected as invalid so
  // the app stayed readable by accident. A floor of 0 would make it *valid* —
  // a 0px UI you cannot read well enough to reach the setting that caused it.
  const floor = loadPref<boolean>("largeFont", false) ? LARGE_FONT_MIN_PX : MIN_FONT_SIZE_PX;
  return Math.min(Math.max(size, floor), MAX_FONT_SIZE_PX);
}

/**
 * Write the effective `--font-size` on documentElement.
 *
 * The single writer of that property, deliberately. The Appearance slider and
 * the Accessibility "Large Font" toggle both want a say, and an inline style
 * always beats a class rule on the same element — so `.large-font` in app.css
 * could never take effect and the toggle was inert (OC-0319). Same shape as
 * reducedMotion's sideEffect (OC-0232): one function re-derives, rather than
 * two writers fighting over one property.
 *
 * Large Font raises the *floor* to 18px and never lowers what the slider
 * chose. Pinning it at 18px (what `!important` would have done) shrinks the UI
 * of anyone whose slider sits at 19 or 20 — a "Large Font" that makes text
 * smaller.
 */
export function applyFontSize(): void {
  document.documentElement.style.setProperty("--font-size", `${effectiveFontSize()}px`);
}

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
  applyFontSize();
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
