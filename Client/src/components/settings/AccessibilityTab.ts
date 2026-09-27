/**
 * Accessibility settings tab — reduced motion, high contrast, role colors, OS motion sync, large font.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { appendToggleRows, loadPref, type ToggleItem } from "./helpers";
import { SYNC_OS_MOTION_DEFAULT, syncOsMotionListener } from "@lib/os-motion";
import { applyFontSize, effectiveFontSize } from "@lib/appearance";
import { settingsText as t } from "../../i18n/settings";

// Built per render, not at module load, so every label reads the catalog.
const motionToggles = (): ReadonlyArray<ToggleItem> => [
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
    key: "syncOsMotion",
    label: t("accessibility.syncOsMotion.label"),
    // Rewritten with what the OS asks for right now; see osMotionState below.
    desc: "",
    fallback: SYNC_OS_MOTION_DEFAULT,
    sideEffect: (nowOn) => {
      syncOsMotionListener(nowOn);
    },
  },
];

const readabilityToggles = (onFontChange: () => void): ReadonlyArray<ToggleItem> => [
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
      onFontChange();
    },
  },
];

const chatToggles = (): ReadonlyArray<ToggleItem> => [
  {
    key: "roleColors",
    label: t("accessibility.roleColors.label"),
    desc: t("accessibility.roleColors.desc"),
    fallback: true,
  },
];

/** A titled group of settings rows. */
function group(title: string): HTMLDivElement {
  const el = createElement("div", { class: "setting-group" });
  el.appendChild(createElement("h3", { class: "setting-group-title" }, title));
  return el;
}

export function buildAccessibilityTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // Motion: the OS row only affects motion, so it sits under Reduce Motion
  // and says what the system is asking for right now.
  const motion = group(t("accessibility.group.motion"));
  const [, osRow] = appendToggleRows(motion, motionToggles(), signal);
  osRow!.classList.add("nested");
  const osDesc = osRow!.querySelector<HTMLElement>(".setting-desc")!;
  const osQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const paintOs = (): void => {
    setText(
      osDesc,
      osQuery?.matches === true
        ? t("accessibility.syncOsMotion.asking")
        : t("accessibility.syncOsMotion.notAsking"),
    );
  };
  paintOs();
  osQuery?.addEventListener("change", paintOs, { signal });

  // Readability, with the text size Large Font raises (set in Appearance).
  const readability = group(t("accessibility.group.readability"));
  const sizeValue = createElement("span", { class: "setting-value" });
  const paintSize = (): void => {
    setText(sizeValue, t("appearance.fontSize.value", { size: effectiveFontSize() }));
  };
  appendToggleRows(readability, readabilityToggles(paintSize), signal);
  const readout = createElement("div", { class: "setting-row setting-readout" });
  const readoutInfo = createElement("div", {});
  appendChildren(
    readoutInfo,
    createElement("div", { class: "setting-label" }, t("accessibility.textSize.label")),
    createElement("div", { class: "setting-desc" }, t("accessibility.textSize.desc")),
  );
  appendChildren(readout, readoutInfo, sizeValue);
  readability.appendChild(readout);
  paintSize();

  const chat = group(t("accessibility.group.chat"));
  appendToggleRows(chat, chatToggles(), signal);

  appendChildren(section, motion, readability, chat);
  return section;
}
