/**
 * Appearance settings tab — theme, accent, text size, layout and clocks.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { buildSettingsSection } from "./settingsSection";
import { loadPref, savePref, createToggle, platformText } from "./helpers";
import { isAndroidApp } from "../voice/native/platform";
import { readStored } from "@lib/prefs/preferences";
import {
  THEMES,
  applyAccent,
  SYSTEM_THEME,
  applyThemeChoice,
  getActiveThemeName,
  onSystemThemePainted,
  resolveSystemTheme,
  restoreTheme,
  type ThemeName,
} from "@lib/prefs/themes";
import { setRovingTabindex, enableRovingNavigation } from "@lib/ui/a11y";
import { createRadioCards, type RadioCardOption } from "@lib/ui/radioCards";
import { defaultAccentOf, drawSystemPreview, drawThemePreview } from "./themePreview";
import {
  applyFontSize,
  effectiveFontSize,
  MIN_FONT_SIZE_PX,
  MAX_FONT_SIZE_PX,
} from "@lib/prefs/appearance";
import {
  DATE_FORMATS,
  getDateFormat,
  getTimeFormat,
  saveDateFormat,
  saveTimeFormat,
  type DateFormat,
  type TimeFormat,
} from "@lib/text/timeFormat";
import { loadMemberLayout, MEMBER_LAYOUT_PREF, type MemberLayout } from "../members/memberLayout";
import { appZoom, ZOOM_LEVELS, zoomIndex } from "../zoom";
import { buildCustomThemeSection } from "../custom-themes/customThemeSection";
import { buildChoiceRow, buildSettingRow } from "./settingRow";
import { settingsText as t } from "../../i18n/settings";

/** "system" is a choice, not a palette: the accent default follows what it shows. */
function paletteOf(choice: string): string {
  return choice === SYSTEM_THEME ? resolveSystemTheme() : choice;
}

/** One tile per built-in theme, then the system choice, each a preview over its name. */
function themeTileOptions(): RadioCardOption<string>[] {
  const palettes = (Object.keys(THEMES) as ThemeName[]).map((name) => ({
    value: name,
    label: t(`appearance.theme.${name}`),
    preview: drawThemePreview(name),
  }));
  return [
    ...palettes,
    {
      value: SYSTEM_THEME,
      label: platformText(t("appearance.theme.system"), t("appearance.theme.system.android")),
      preview: drawSystemPreview(),
    },
  ];
}

/** The font size slider row; its label shows the effective size. */
function buildFontSizeRow(signal: AbortSignal, currentFontSize: number): HTMLElement {
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
  // text is the same "control that lies" bug in a different place.
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
      // Both read the pref back, so save first.
      applyFontSize();
      setText(fontLabel, t("appearance.fontSize.value", { size: effectiveFontSize() }));
    },
    { signal },
  );
  appendChildren(fontRow, fontSlider, fontLabel);
  return buildSettingRow({ label: t("appearance.fontSize"), control: fontRow });
}

/** The zoom slider row. Null on Android, which has no webview zoom to set. */
function buildZoomRow(signal: AbortSignal): HTMLElement | null {
  const zoomRow = createElement("div", { class: "slider-row" });
  const zoomSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: String(ZOOM_LEVELS.length - 1),
    step: "1",
    value: String(zoomIndex(appZoom.current())),
    "aria-label": t("appearance.zoom"),
  });
  const zoomLabel = createElement(
    "span",
    { class: "slider-val" },
    t("appearance.zoom.value", { percent: appZoom.current() }),
  );
  const zoomReset = createElement(
    "button",
    {
      class: "btn btn-secondary",
      type: "button",
      "aria-label": t("appearance.zoom.resetAria"),
    },
    t("appearance.zoom.reset"),
  );
  const paintZoom = (level: number): void => {
    zoomSlider.value = String(zoomIndex(level));
    zoomSlider.setAttribute("aria-valuetext", t("appearance.zoom.value", { percent: level }));
    setText(zoomLabel, t("appearance.zoom.value", { percent: level }));
  };
  paintZoom(appZoom.current());
  appZoom.subscribe(paintZoom, signal);
  zoomSlider.addEventListener(
    "input",
    () => {
      void appZoom.set(ZOOM_LEVELS[Number(zoomSlider.value)] ?? 100);
    },
    { signal },
  );
  zoomReset.addEventListener("click", () => void appZoom.reset(), { signal });
  appendChildren(zoomRow, zoomSlider, zoomLabel, zoomReset);
  // The Android app has no webview zoom to set.
  if (isAndroidApp()) return null;
  return buildSettingRow({ label: t("appearance.zoom"), control: zoomRow });
}

/** Apply stored preferences on render; a null accent means none is stored. */
function applyStoredPreferences(
  currentTheme: string | null,
  currentCompact: boolean,
  storedAccent: string | null,
): void {
  if (currentTheme === null) {
    restoreTheme();
  } else {
    applyThemeChoice(currentTheme);
  }
  applyFontSize();
  document.documentElement.classList.toggle("compact-mode", currentCompact);
  if (storedAccent !== null) {
    applyAccent(storedAccent);
  }
}

export function buildAppearanceTab(
  signal: AbortSignal,
  onDirtyCheck?: (isDirty: () => boolean) => void,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const themeGroup = buildSettingsSection({
    label: t("appearance.theme"),
    headingAttrs: { id: "appearance-theme-heading" },
  });
  const colorGroup = buildSettingsSection({
    label: t("appearance.accentColor"),
    headingAttrs: { id: "appearance-accent-heading" },
  });
  const textGroup = buildSettingsSection({ label: t("appearance.section.textSize") });
  const layoutGroup = buildSettingsSection({ label: t("appearance.section.layout") });
  appendChildren(section, themeGroup.el, colorGroup.el, textGroup.el, layoutGroup.el);
  const activeThemeName = getActiveThemeName();
  const currentTheme =
    activeThemeName in THEMES || activeThemeName === SYSTEM_THEME ? activeThemeName : null;
  const currentFontSize = loadPref<number>("fontSize", 16);
  const currentCompact = loadPref<boolean>("compactMode", false);
  let hasStoredAccent = readStored("owncord:settings:accentColor") !== null;
  const defaultAccent = defaultAccentOf(paletteOf(activeThemeName));

  // Theme: one radiogroup of preview tiles. A custom theme paints over the
  // checked one, so exactly one tile stays checked while it is on.
  const themeTiles = createRadioCards<string>({
    signal,
    labelledBy: "appearance-theme-heading",
    testId: "theme",
    layout: "tiles",
    options: themeTileOptions(),
    value: currentTheme,
    onChange: (name) => {
      applyThemeChoice(name);
      if (hasStoredAccent) {
        // applyThemeByName clears every inline custom property on <body>,
        // which includes the accent override applyAccent puts there. Without
        // re-applying it, a theme that sets --accent on its body class
        // (neon-glow) silently reverts the user's accent until restart.
        applyAccent(loadPref<string>("accentColor", defaultAccentOf(paletteOf(name))));
      } else {
        syncDisplayedAccent(defaultAccentOf(paletteOf(name)));
      }
    },
  });
  themeTiles.group.classList.add("theme-tiles");
  themeGroup.card.appendChild(themeTiles.el);

  textGroup.card.appendChild(buildFontSizeRow(signal, currentFontSize));

  // Zoom level: the native webview zoom, snapping to Discord's levels. The
  // slider follows the zoom keys (Ctrl+= / Ctrl+- / Ctrl+0) while it is open.
  const zoomRow = buildZoomRow(signal);
  if (zoomRow !== null) textGroup.card.appendChild(zoomRow);

  // Compact mode toggle
  const compactToggle = createToggle(currentCompact, {
    signal,
    label: t("appearance.compactMode"),
    onChange: (isNowCompact) => {
      savePref("compactMode", isNowCompact);
      document.documentElement.classList.toggle("compact-mode", isNowCompact);
    },
  });
  textGroup.card.appendChild(
    buildSettingRow({ label: t("appearance.compactMode"), control: compactToggle }),
  );

  // Time format (12-hour / 24-hour) and date order. A date format change can
  // move the clock default, so it repaints both rows.
  const timeFormatRow = buildChoiceRow<TimeFormat>({
    signal,
    label: t("appearance.timeFormat"),
    desc: t("appearance.timeFormat.desc"),
    testId: "time-format",
    options: [
      ["12h", t("appearance.timeFormat.12h")],
      ["24h", t("appearance.timeFormat.24h")],
    ],
    current: getTimeFormat,
    save: saveTimeFormat,
  });
  const dateFormatRow = buildChoiceRow<DateFormat>({
    signal,
    label: t("appearance.dateFormat"),
    desc: t("appearance.dateFormat.desc"),
    testId: "date-format",
    options: DATE_FORMATS.map((value) => [value, t(`appearance.dateFormat.${value}`)]),
    current: getDateFormat,
    save: (value) => {
      saveDateFormat(value);
      timeFormatRow.paint();
    },
  });
  layoutGroup.card.append(timeFormatRow.row, dateFormatRow.row);

  // Member list position (right column / under the channels)
  const memberLayoutRow = buildChoiceRow<MemberLayout>({
    signal,
    label: t("appearance.memberLayout"),
    desc: t("appearance.memberLayout.desc"),
    testId: "member-layout",
    options: [
      ["right", t("appearance.memberLayout.right")],
      ["left", t("appearance.memberLayout.left")],
    ],
    current: loadMemberLayout,
    save: (value) => savePref(MEMBER_LAYOUT_PREF, value),
  }).row;
  // A phone shows the member list as an overlay, so it has no side to pick.
  if (!isAndroidApp()) layoutGroup.card.appendChild(memberLayoutRow);

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

  const swatchesRow = createElement("div", {
    class: "accent-swatches",
    role: "radiogroup",
    "aria-labelledby": "appearance-accent-heading",
  });

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
  // Disclose the readable-colour fallback.
  const accentNote = createElement(
    "p",
    { class: "setting-desc", id: "accent-contrast-note" },
    t("appearance.accentNote"),
  );

  function syncDisplayedAccent(color: string): void {
    const swatches = Array.from(swatchesRow.children);
    const match = swatches.find(
      (child) => (child as HTMLElement).style.backgroundColor === hexToRgb(color),
    );
    // The tab stop follows the check; a custom colour leaves the first swatch as the way in.
    const stop = match ?? swatches[0];
    for (const child of swatches) {
      child.classList.toggle("active", child === match);
      child.setAttribute("aria-checked", child === match ? "true" : "false");
      child.setAttribute("tabindex", child === stop ? "0" : "-1");
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
  // One tab stop with arrow-key movement, like the theme tiles.
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
  const accentControl = createElement("div", { class: "accent-control" });
  appendChildren(accentControl, swatchesRow, hexInputRow, accentNote);
  colorGroup.card.appendChild(accentControl);
  section.appendChild(buildCustomThemeSection(signal, onDirtyCheck));

  // An OS light/dark flip under "Match my computer" changes the default
  // accent; with no stored accent the controls must follow it.
  onSystemThemePainted(() => {
    if (hasStoredAccent) return;
    syncDisplayedAccent(defaultAccentOf(paletteOf(getActiveThemeName())));
  }, signal);

  applyStoredPreferences(currentTheme, currentCompact, hasStoredAccent ? currentAccent : null);

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
