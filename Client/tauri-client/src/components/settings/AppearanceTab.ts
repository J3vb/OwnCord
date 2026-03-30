/**
 * Appearance settings tab — theme, font size, compact mode.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, applyTheme, THEMES, createToggle } from "./helpers";
import type { ThemeName } from "./helpers";
import { setTheme } from "@stores/ui.store";
import { getActiveThemeName, loadCustomTheme, restoreTheme } from "@lib/themes";

const FALLBACK_ACCENT = "#5865f2";

function getDefaultAccent(themeName: string): string {
  if (themeName === "neon-glow") return "#00c8ff";
  if (themeName in THEMES) return FALLBACK_ACCENT;

  const customTheme = loadCustomTheme(themeName);
  const accent = customTheme?.colors["--accent"];
  return typeof accent === "string" && /^#[\da-fA-F]{3,8}$/.test(accent)
    ? accent
    : FALLBACK_ACCENT;
}

export function buildAppearanceTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const activeThemeName = getActiveThemeName();
  const currentTheme = activeThemeName in THEMES
    ? activeThemeName as ThemeName
    : null;
  const currentFontSize = loadPref<number>("fontSize", 16);
  const currentCompact = loadPref<boolean>("compactMode", false);
  let hasStoredAccent = localStorage.getItem("owncord:settings:accentColor") !== null;
  const defaultAccent = getDefaultAccent(activeThemeName);

  // Theme selector
  const themeHeader = createElement("h3", {}, "Theme");
  const themeRow = createElement("div", { class: "theme-options", role: "radiogroup" });
  for (const name of Object.keys(THEMES) as ThemeName[]) {
    const isActive = name === currentTheme;
    const btn = createElement("button", {
      class: `theme-opt ${name}${isActive ? " active" : ""}`,
      role: "radio",
      tabindex: "0",
      "aria-checked": isActive ? "true" : "false",
      "aria-label": name.charAt(0).toUpperCase() + name.slice(1),
    }, name.charAt(0).toUpperCase() + name.slice(1));

    const activateTheme = (): void => {
      applyTheme(name);
      setTheme(name);
      for (const child of themeRow.children) {
        child.classList.remove("active");
        child.setAttribute("aria-checked", "false");
      }
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
      if (!hasStoredAccent) {
        syncDisplayedAccent(getDefaultAccent(name));
      }
    };

    btn.addEventListener("click", activateTheme, { signal });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activateTheme();
      }
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

  // Accent color picker
  const ACCENT_PRESETS: readonly string[] = [
    "#00c8ff", // OwnCord neon cyan
    "#57f287", // green
    "#fee75c", // yellow
    "#eb459e", // fuchsia/pink
    "#ed4245", // red
    "#f47b67", // salmon
    "#e78b38", // orange
    "#3ba55d", // dark green
    "#5865f2", // blurple
    "#b9bbbe", // grey
  ];

  const currentAccent = loadPref<string>("accentColor", defaultAccent);

  function applyAccent(color: string): void {
    // Set on both documentElement and body so the accent wins over
    // theme class specificity (body.theme-neon-glow sets --accent)
    document.documentElement.style.setProperty("--accent", color);
    document.body.style.setProperty("--accent", color);
  }

  function saveAccent(color: string): void {
    hasStoredAccent = true;
    savePref("accentColor", color);
    applyAccent(color);
  }

  const accentHeader = createElement("h3", {}, "Accent Color");
  const swatchesRow = createElement("div", { class: "accent-swatches" });

  // Declare hexInput early so swatch closures can reference it after construction
  const hexInputRow = createElement("div", { class: "accent-hex-row" });
  const hexPrefix = createElement("span", { class: "accent-hex-prefix" }, "#");
  const hexInput = createElement("input", {
    class: "form-input",
    type: "text",
    maxlength: "6",
    placeholder: defaultAccent.replace("#", ""),
    value: currentAccent.replace("#", ""),
    style: "width:120px",
  });

  function syncDisplayedAccent(color: string): void {
    for (const child of swatchesRow.children) {
      const isMatch = (child as HTMLElement).style.backgroundColor === hexToRgb(color);
      child.classList.toggle("active", isMatch);
      child.setAttribute("aria-checked", isMatch ? "true" : "false");
    }
    hexInput.value = color.replace("#", "");
    hexInput.placeholder = color.replace("#", "");
  }

  for (const color of ACCENT_PRESETS) {
    const swatch = createElement("div", {
      class: `accent-swatch${color === currentAccent ? " active" : ""}`,
      title: color,
      role: "radio",
      tabindex: "0",
      "aria-label": color,
      "aria-checked": color === currentAccent ? "true" : "false",
    });
    swatch.style.backgroundColor = color;
    // Setting color = backgroundColor lets .active use currentColor in box-shadow
    swatch.style.color = color;

    const activateSwatch = (): void => {
      saveAccent(color);
      syncDisplayedAccent(color);
    };

    swatch.addEventListener("click", activateSwatch, { signal });
    swatch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activateSwatch();
      }
    }, { signal });

    swatchesRow.appendChild(swatch);
  }

  hexInput.addEventListener("input", () => {
    const raw = hexInput.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    hexInput.value = raw;
    if (raw.length === 6) {
      const color = `#${raw}`;
      saveAccent(color);
      syncDisplayedAccent(color);
    }
  }, { signal });

  appendChildren(hexInputRow, hexPrefix, hexInput);
  appendChildren(section, accentHeader, swatchesRow, hexInputRow);

  // Apply stored preferences on render
  if (currentTheme === null) {
    restoreTheme();
  } else {
    applyTheme(currentTheme);
  }
  document.documentElement.style.setProperty("--font-size", `${currentFontSize}px`);
  document.documentElement.classList.toggle("compact-mode", currentCompact);
  if (hasStoredAccent) {
    applyAccent(currentAccent);
  }

  return section;
}

/**
 * Convert a hex color string to the CSS rgb() format browsers use for
 * element.style.backgroundColor comparisons (e.g. "#5865f2" → "rgb(88, 101, 242)").
 */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
