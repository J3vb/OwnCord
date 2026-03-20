/**
 * Appearance settings tab — theme, font size, compact mode.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, applyTheme, THEMES, createToggle } from "./helpers";
import type { ThemeName } from "./helpers";
import { setTheme } from "@stores/ui.store";

export function buildAppearanceTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const currentTheme = loadPref<ThemeName>("theme", "dark");
  const currentFontSize = loadPref<number>("fontSize", 16);
  const currentCompact = loadPref<boolean>("compactMode", false);

  // Theme selector
  const themeHeader = createElement("h3", {}, "Theme");
  const themeRow = createElement("div", { class: "theme-options" });
  for (const name of Object.keys(THEMES) as ThemeName[]) {
    const btn = createElement("div", {
      class: `theme-opt ${name}${name === currentTheme ? " active" : ""}`,
    }, name.charAt(0).toUpperCase() + name.slice(1));

    btn.addEventListener("click", () => {
      applyTheme(name);
      savePref("theme", name);
      setTheme(name);
      const prev = themeRow.querySelector(".theme-opt.active");
      if (prev) prev.classList.remove("active");
      btn.classList.add("active");
    }, { signal });

    themeRow.appendChild(btn);
  }
  appendChildren(section, themeHeader, themeRow);

  // Font size slider
  const fontHeader = createElement("h3", {}, "Font Size");
  const fontRow = createElement("div", { class: "slider-row" });
  const fontSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "12",
    max: "20",
    value: String(currentFontSize),
  });
  const fontLabel = createElement("span", { class: "slider-val" }, `${currentFontSize}px`);
  fontSlider.addEventListener("input", () => {
    const size = Number(fontSlider.value);
    setText(fontLabel, `${size}px`);
    document.documentElement.style.setProperty("--font-size", `${size}px`);
    savePref("fontSize", size);
  }, { signal });
  appendChildren(fontRow, fontSlider, fontLabel);
  appendChildren(section, fontHeader, fontRow);

  // Compact mode toggle
  const compactRow = createElement("div", { class: "setting-row" });
  const compactLabel = createElement("span", { class: "setting-label" }, "Compact Mode");
  const compactToggle = createToggle(currentCompact, {
    signal,
    onChange: (isNowCompact) => {
      savePref("compactMode", isNowCompact);
      document.documentElement.classList.toggle("compact-mode", isNowCompact);
    },
  });
  appendChildren(compactRow, compactLabel, compactToggle);
  section.appendChild(compactRow);

  // Apply stored preferences on render
  applyTheme(currentTheme);
  document.documentElement.style.setProperty("--font-size", `${currentFontSize}px`);
  document.documentElement.classList.toggle("compact-mode", currentCompact);

  return section;
}
