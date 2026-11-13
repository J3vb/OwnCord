// A small drawing of a theme for its tile in Settings > Appearance: a channel
// column and a chat pane in that theme's own colours, whatever theme is
// active. Plain elements; the colours come from THEMES, so a palette change
// shows on its tile without touching this file.
import { appendChildren, createElement } from "@lib/dom";
import { THEMES, type ThemeName } from "@lib/prefs/themes";

/** The accent each theme starts with before the user picks one. */
export function defaultAccentOf(themeName: string): string {
  if (themeName === "neon-glow") return "#00c8ff";
  // Light's own accent: white on it reads at 5.54:1.
  return themeName === "light" ? "#4f5bd5" : "#5865f2";
}

function lines(count: number, cls: string): HTMLElement[] {
  return Array.from({ length: count }, () => createElement("span", { class: cls }));
}

/** One theme's picture. */
export function drawThemePreview(name: ThemeName): HTMLElement {
  const tokens: Readonly<Record<string, string>> = THEMES[name];
  const pic = createElement("span", { class: "theme-preview" });
  const vars: Readonly<Record<string, string | undefined>> = {
    "--pv-bg": tokens["--bg-primary"],
    "--pv-surface": tokens["--bg-secondary"],
    "--pv-deep": tokens["--bg-tertiary"],
    "--pv-text": tokens["--text-normal"],
    "--pv-accent": defaultAccentOf(name),
  };
  for (const [prop, value] of Object.entries(vars)) {
    if (value !== undefined) pic.style.setProperty(prop, value);
  }
  const side = createElement("span", { class: "theme-preview-side" });
  appendChildren(side, createElement("span", { class: "pv-dot" }), ...lines(2, "pv-line"));
  const main = createElement("span", { class: "theme-preview-main" });
  appendChildren(
    main,
    createElement("span", { class: "pv-line pv-accent" }),
    ...lines(2, "pv-line"),
    createElement("span", { class: "pv-input" }),
  );
  appendChildren(pic, side, main);
  return pic;
}

/** The system choice's picture: the light theme over the right half of the dark one. */
export function drawSystemPreview(): HTMLElement {
  const pic = createElement("span", { class: "theme-preview-split" });
  const light = drawThemePreview("light");
  light.classList.add("theme-preview-half");
  appendChildren(pic, drawThemePreview("dark"), light);
  return pic;
}
