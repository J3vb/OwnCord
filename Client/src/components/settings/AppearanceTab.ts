/**
 * Appearance settings tab — theme, font size, compact mode.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, applyTheme, THEMES, createToggle } from "./helpers";
import type { ThemeName } from "./helpers";
import { applyAccent, getActiveThemeName, restoreTheme } from "@lib/themes";
import { setRovingTabindex, enableRovingNavigation } from "@lib/a11y";
import {
  applyFontSize,
  effectiveFontSize,
  MIN_FONT_SIZE_PX,
  MAX_FONT_SIZE_PX,
} from "@lib/appearance";
import { settingsText as t } from "../../i18n/settings";

const FALLBACK_ACCENT = "#5865f2";

function getDefaultAccent(themeName: string): string {
  if (themeName === "neon-glow") return "#00c8ff";
  // Light's own accent (B9 Q13): white on it reads at 5.54:1.
  return themeName === "light" ? "#4f5bd5" : FALLBACK_ACCENT;
}

export function buildAppearanceTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const activeThemeName = getActiveThemeName();
  const currentTheme = activeThemeName in THEMES ? (activeThemeName as ThemeName) : null;
  const currentFontSize = loadPref<number>("fontSize", 16);
  const currentCompact = loadPref<boolean>("compactMode", false);
  let hasStoredAccent = localStorage.getItem("owncord:settings:accentColor") !== null;
  const defaultAccent = getDefaultAccent(activeThemeName);

  // Theme selector
  const themeHeader = createElement("h3", {}, t("appearance.theme"));
  const themeRow = createElement("div", { class: "theme-options", role: "radiogroup" });
  for (const name of Object.keys(THEMES) as ThemeName[]) {
    const isActive = name === currentTheme;
    const btn = createElement(
      "button",
      {
        class: `theme-opt ${name}${isActive ? " active" : ""}`,
        role: "radio",
        tabindex: isActive ? "0" : "-1",
        "aria-checked": isActive ? "true" : "false",
        "aria-label": name.charAt(0).toUpperCase() + name.slice(1),
      },
      name.charAt(0).toUpperCase() + name.slice(1),
    );

    const activateTheme = (): void => {
      applyTheme(name);
      for (const child of themeRow.children) {
        child.classList.remove("active");
        child.setAttribute("aria-checked", "false");
      }
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
      if (hasStoredAccent) {
        // applyThemeByName clears every inline custom property on <body>,
        // which includes the accent override applyAccent puts there. Without
        // re-applying it, a theme that sets --accent on its body class
        // (neon-glow) silently reverts the user's accent until restart.
        applyAccent(loadPref<string>("accentColor", getDefaultAccent(name)));
      } else {
        syncDisplayedAccent(getDefaultAccent(name));
      }
    };

    btn.addEventListener("click", activateTheme, { signal });
    btn.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activateTheme();
        }
      },
      { signal },
    );

    themeRow.appendChild(btn);
  }
  // One Tab stop with arrow-key movement (contract Keyboard table). The theme
  // tiles are a horizontal row, so ArrowLeft/Right is the stepping axis.
  setRovingTabindex(themeRow, "[role='radio']");
  enableRovingNavigation(themeRow, "[role='radio']", signal);
  appendChildren(section, themeHeader, themeRow);

  // Font size slider
  const fontHeader = createElement("h3", {}, t("appearance.fontSize"));
  const fontRow = createElement("div", { class: "slider-row" });
  const fontSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: String(MIN_FONT_SIZE_PX),
    max: String(MAX_FONT_SIZE_PX),
    value: String(currentFontSize),
    "aria-label": t("appearance.fontSize"),
  });
  // The EFFECTIVE size, not the raw slider position: Large Font can floor it
  // above where the slider sits, and a label that disagrees with the rendered
  // text is the same "control that lies" bug in a different place (OC-0319).
  const fontLabel = createElement(
    "span",
    { class: "slider-val" },
    t("appearance.fontSize.value", { size: effectiveFontSize() }),
  );
  fontSlider.addEventListener(
    "input",
    () => {
      const size = Number(fontSlider.value);
      savePref("fontSize", size);
      // Both read the pref back, so save first (OC-0319).
      applyFontSize();
      setText(fontLabel, t("appearance.fontSize.value", { size: effectiveFontSize() }));
    },
    { signal },
  );
  appendChildren(fontRow, fontSlider, fontLabel);
  appendChildren(section, fontHeader, fontRow);

  // Compact mode toggle
  const compactRow = createElement("div", { class: "setting-row" });
  const compactLabel = createElement(
    "span",
    { class: "setting-label" },
    t("appearance.compactMode"),
  );
  const compactToggle = createToggle(currentCompact, {
    signal,
    label: t("appearance.compactMode"),
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

  function saveAccent(color: string): void {
    hasStoredAccent = true;
    savePref("accentColor", color);
    applyAccent(color);
  }

  const accentHeader = createElement("h3", {}, t("appearance.accentColor"));
  const swatchesRow = createElement("div", { class: "accent-swatches", role: "radiogroup" });

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
    "aria-label": t("appearance.accentAria"),
    "aria-describedby": "accent-contrast-note",
  });
  // Owner decision Q8 (B9-2): disclose the readable-colour fallback.
  const accentNote = createElement(
    "p",
    { class: "setting-desc", id: "accent-contrast-note" },
    t("appearance.accentNote"),
  );

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
      tabindex: color === currentAccent ? "0" : "-1",
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
    swatch.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activateSwatch();
        }
      },
      { signal },
    );

    swatchesRow.appendChild(swatch);
  }
  // Same roving behaviour as the theme tiles (A11Y-09).
  setRovingTabindex(swatchesRow, "[role='radio']");
  enableRovingNavigation(swatchesRow, "[role='radio']", signal);

  hexInput.addEventListener(
    "input",
    () => {
      const raw = hexInput.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
      hexInput.value = raw;
      if (raw.length === 6) {
        const color = `#${raw}`;
        saveAccent(color);
        syncDisplayedAccent(color);
      }
    },
    { signal },
  );

  appendChildren(hexInputRow, hexPrefix, hexInput);
  appendChildren(section, accentHeader, swatchesRow, hexInputRow, accentNote);

  // Apply stored preferences on render
  if (currentTheme === null) {
    restoreTheme();
  } else {
    applyTheme(currentTheme);
  }
  applyFontSize();
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
