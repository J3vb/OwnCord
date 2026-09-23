/**
 * Accessibility settings tab — reduced motion, high contrast, role colors, OS motion sync, large font.
 */

import { createElement } from "@lib/dom";
import { appendToggleRows, loadPref, type ToggleItem } from "./helpers";
import { SYNC_OS_MOTION_DEFAULT, syncOsMotionListener } from "@lib/os-motion";
import { applyFontSize } from "@lib/appearance";
import { settingsText as t } from "../../i18n/settings";

// Built per render, not at module load, so every label reads the catalog.
const toggles = (): ReadonlyArray<ToggleItem> => [
  {
    key: "reducedMotion",
    label: t("accessibility.reducedMotion.label"),
    desc: t("accessibility.reducedMotion.desc"),
    fallback: false,
    // Do not write the `reduced-motion` class directly here: when "Sync with
    // OS" is on, os-motion.ts owns that class via a live media-query
    // listener, and writing it directly would silently fight that listener
    // (OC-0232). savePref has already stored the new manual value by the
    // time this runs, so re-invoking syncOsMotionListener lets whichever
    // source is supposed to own the class re-derive it consistently: ON
    // re-reads the OS media query (OS wins), OFF re-reads the just-saved
    // manual pref — matching applyStoredAppearance's startup ordering.
    sideEffect: () => {
      syncOsMotionListener(loadPref<boolean>("syncOsMotion", SYNC_OS_MOTION_DEFAULT));
    },
  },
  {
    key: "highContrast",
    label: t("accessibility.highContrast.label"),
    desc: t("accessibility.highContrast.desc"),
    fallback: false,
    sideEffect: (nowOn) => {
      document.documentElement.classList.toggle("high-contrast", nowOn);
    },
  },
  {
    key: "roleColors",
    label: t("accessibility.roleColors.label"),
    desc: t("accessibility.roleColors.desc"),
    fallback: true,
  },
  {
    key: "syncOsMotion",
    label: t("accessibility.syncOsMotion.label"),
    desc: t("accessibility.syncOsMotion.desc"),
    fallback: SYNC_OS_MOTION_DEFAULT,
    sideEffect: (nowOn) => {
      syncOsMotionListener(nowOn);
    },
  },
  {
    key: "largeFont",
    label: t("accessibility.largeFont.label"),
    desc: t("accessibility.largeFont.desc"),
    fallback: false,
    // The class is a state marker only — an inline `--font-size` on the same
    // element outranks any class rule, so the size itself must go through
    // appearance.ts's single writer, which savePref has already fed (OC-0319).
    sideEffect: (nowOn) => {
      document.documentElement.classList.toggle("large-font", nowOn);
      applyFontSize();
    },
  },
];

export function buildAccessibilityTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  appendToggleRows(section, toggles(), signal);

  return section;
}
