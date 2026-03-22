/**
 * Accessibility settings tab — reduced motion, high contrast, role colors, OS motion sync, large font.
 */

import { createElement, appendChildren } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";

type ToggleItem = {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly fallback: boolean;
  readonly sideEffect?: (nowOn: boolean) => void;
};

const TOGGLES: ReadonlyArray<ToggleItem> = [
  {
    key: "reducedMotion",
    label: "Reduce Motion",
    desc: "Disable animations and transitions",
    fallback: false,
    sideEffect: (nowOn) => {
      document.documentElement.classList.toggle("reduced-motion", nowOn);
    },
  },
  {
    key: "highContrast",
    label: "High Contrast",
    desc: "Increase contrast for better readability",
    fallback: false,
    sideEffect: (nowOn) => {
      document.documentElement.classList.toggle("high-contrast", nowOn);
    },
  },
  {
    key: "roleColors",
    label: "Role Colors",
    desc: "Show colored usernames based on role in chat",
    fallback: true,
  },
  {
    key: "syncOsMotion",
    label: "Sync with OS",
    desc: "Automatically enable reduced motion based on your OS accessibility settings",
    fallback: false,
  },
  {
    key: "largeFont",
    label: "Large Font",
    desc: "Use larger text throughout the app for better readability",
    fallback: false,
    sideEffect: (nowOn) => {
      document.documentElement.classList.toggle("large-font", nowOn);
    },
  },
];

export function buildAccessibilityTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  for (const item of TOGGLES) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      onChange: (nowOn) => {
        savePref(item.key, nowOn);
        if (item.sideEffect !== undefined) {
          item.sideEffect(nowOn);
        }
      },
    });

    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  return section;
}
