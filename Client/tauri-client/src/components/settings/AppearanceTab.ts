/**
 * Appearance settings tab — theme, font size, compact mode.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, applyTheme, THEMES, createToggle } from "./helpers";
import type { ThemeName } from "./helpers";
import { setTheme } from "@stores/ui.store";

export function buildAppearanceTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const currentTheme = loadPref<ThemeName>("theme", "neon-glow");
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

  // Accent color picker
  const ACCENT_PRESETS: readonly string[] = [
    "#5865f2", // Discord blurple (default)
    "#57f287", // green
    "#fee75c", // yellow
    "#eb459e", // fuchsia/pink
    "#ed4245", // red
    "#f47b67", // salmon
    "#e78b38", // orange
    "#3ba55d", // dark green
    "#45ddff", // cyan
    "#b9bbbe", // grey
  ];

  const currentAccent = loadPref<string>("accentColor", "#00c8ff");

  function applyAccent(color: string): void {
    // Set on both documentElement and body so the accent wins over
    // theme class specificity (body.theme-neon-glow sets --accent)
    document.documentElement.style.setProperty("--accent", color);
    document.body.style.setProperty("--accent", color);
  }

  function saveAccent(color: string): void {
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
    placeholder: "5865f2",
    value: currentAccent.replace("#", ""),
    style: "width:120px",
  }) as HTMLInputElement;

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
      // Update active state on all swatches
      for (const child of swatchesRow.children) {
        child.classList.remove("active");
        child.setAttribute("aria-checked", "false");
      }
      swatch.classList.add("active");
      swatch.setAttribute("aria-checked", "true");
      hexInput.value = color.replace("#", "");
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
      // Clear active preset swatches since it's a custom color
      for (const child of swatchesRow.children) {
        const isMatch = (child as HTMLElement).style.backgroundColor === hexToRgb(color);
        child.classList.toggle("active", isMatch);
        child.setAttribute("aria-checked", isMatch ? "true" : "false");
      }
    }
  }, { signal });

  appendChildren(hexInputRow, hexPrefix, hexInput);
  appendChildren(section, accentHeader, swatchesRow, hexInputRow);

  // Apply stored preferences on render
  applyTheme(currentTheme);
  document.documentElement.style.setProperty("--font-size", `${currentFontSize}px`);
  document.documentElement.classList.toggle("compact-mode", currentCompact);
  applyAccent(currentAccent);

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
