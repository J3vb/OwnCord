/**
 * Shared helpers and constants for settings tabs.
 */

import { createElement, appendChildren } from "@lib/dom";
import { applyThemeByName } from "@lib/themes";
import { STORAGE_PREFIX, loadPref, savePref, readMigratedStringPref } from "@lib/preferences";

// Preference persistence lives in `@lib/preferences` so `lib/` modules can use
// it without importing from the component layer. Re-exported here so the
// settings tabs keep a single import site — and, critically, so both layers
// share one implementation (they used to be copy-pasted and had drifted).
export { STORAGE_PREFIX, loadPref, savePref, readMigratedStringPref };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const THEMES = {
  dark: {
    "--bg-primary": "#313338",
    "--bg-secondary": "#2b2d31",
    "--bg-tertiary": "#1e1f22",
    "--text-normal": "#dbdee1",
  },
  "neon-glow": {
    "--bg-primary": "#17181b",
    "--bg-secondary": "#111214",
    "--bg-tertiary": "#0b0c0e",
    "--text-normal": "#dfe2e6",
  },
  midnight: {
    "--bg-primary": "#1a1a2e",
    "--bg-secondary": "#16213e",
    "--bg-tertiary": "#0f1a38",
    "--text-normal": "#e2e4ef",
    // Refined Neon (B9 Q13): midnight used to inherit dark's input fill and
    // text roles, which were tuned for grey surfaces. Tested values; see
    // docs/architecture/b9-ui-contract.md.
    "--bg-input": "#232845",
    "--text-muted": "#a9b0c8",
    "--header-primary": "#f4f5fa",
    "--text-link": "#5cc8ff",
    "--border-control": "#6a7194",
  },
  light: {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f2f3f5",
    "--bg-tertiary": "#e3e5e8",
    "--text-normal": "#2a2c31",
    // OC-0043: the 4 keys above are all this theme used to set. Every other
    // surface/text/border/interactive token then fell through to tokens.css's
    // dark defaults, so widgets painting --text-normal (now dark) on top of
    // e.g. --bg-input (still dark) rendered as unreadable dark-on-dark.
    "--bg-input": "#ebedef",
    "--bg-hover": "#e8e9ed",
    "--bg-active": "#dcdfe4",
    "--bg-modifier-hover": "rgba(0, 0, 0, 0.06)",
    "--bg-modifier-active": "rgba(0, 0, 0, 0.08)",
    "--bg-modifier-selected": "rgba(0, 0, 0, 0.1)",
    "--text-muted": "#51545c",
    "--text-faint": "#747f8d",
    "--text-micro": "#949ba4",
    "--header-primary": "#060607",
    "--header-secondary": "#4e5058",
    "--interactive-normal": "#4e5058",
    "--interactive-hover": "#23272a",
    "--interactive-active": "#000000",
    "--interactive-muted": "#c7ccd1",
    "--channel-icon": "#6d6f78",
    "--border": "#e3e5e8",
    "--border-strong": "#cbccd1",
    "--scrollbar-thin-thumb": "#cdcfd4",
    "--scrollbar-auto-thumb": "#cdcfd4",
    // B9-2: the dark defaults for these read below 4.5:1 (text) or 3:1
    // (focus) on light surfaces. Tested values; see docs/architecture/b9-ui-contract.md.
    "--text-link": "#00658f",
    "--text-positive": "#17703f",
    "--text-warning": "#7a5500",
    "--text-danger": "#b3261e",
    "--accent-text": "#4150c4",
    "--focus-ring": "#4752c4",
    // Refined Neon (B9 Q13); light's accent fills are body.theme-light in
    // tokens.css, outside the keys applyTheme clears.
    "--danger-fill": "#c62828",
    "--danger-fill-hover": "#a61f1f",
    "--border-control": "#7d838d",
  },
} as const;

export type ThemeName = keyof typeof THEMES;

// Union of every CSS custom property any built-in theme sets. Used by
// applyTheme to clear a previous theme's tokens before applying a new one,
// without touching inline properties owned by other code (e.g. --accent,
// --font-size).
const THEME_KEYS: ReadonlySet<string> = new Set(
  Object.values(THEMES).flatMap((theme) => Object.keys(theme)),
);

// ---------------------------------------------------------------------------
// Accessible toggle creation
// ---------------------------------------------------------------------------

/**
 * Create an accessible toggle switch element with proper ARIA attributes
 * and keyboard support (Enter/Space to toggle). `label` is its accessible
 * name: the visible label beside it is a sibling, not a <label>, so without
 * it a screen reader announces an unnamed "switch" (B9-2).
 */
export function createToggle(
  isOn: boolean,
  opts: { signal: AbortSignal; onChange: (nowOn: boolean) => void; label: string },
): HTMLDivElement {
  const toggle = createElement("div", {
    class: isOn ? "toggle on" : "toggle",
    role: "switch",
    tabindex: "0",
    "aria-checked": isOn ? "true" : "false",
    "aria-label": opts.label,
  });

  function doToggle(): void {
    const nowOn = !toggle.classList.contains("on");
    toggle.classList.toggle("on", nowOn);
    toggle.setAttribute("aria-checked", String(nowOn));
    opts.onChange(nowOn);
  }

  toggle.addEventListener("click", doToggle, { signal: opts.signal });
  toggle.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        doToggle();
      }
    },
    { signal: opts.signal },
  );

  return toggle;
}

/** One pref-backed toggle row: `setting-label`/`setting-desc` beside a toggle. */
export type ToggleItem = {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly fallback: boolean;
  /** Runs after `savePref`, inside the toggle's own click handler. */
  readonly sideEffect?: (nowOn: boolean) => void;
};

/** Append one `setting-row` per item — the row shape every settings tab shares. */
export function appendToggleRows(
  section: HTMLElement,
  items: ReadonlyArray<ToggleItem>,
  signal: AbortSignal,
): void {
  for (const item of items) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);
    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      label: item.label,
      onChange: (nowOn) => {
        savePref(item.key, nowOn);
        item.sideEffect?.(nowOn);
      },
    });
    appendChildren(row, info, toggle);
    section.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Theme application
// ---------------------------------------------------------------------------

export function applyTheme(name: ThemeName): void {
  const theme = THEMES[name];
  const root = document.documentElement;
  // Clear every key any built-in theme owns first, so switching to a theme
  // that sets fewer keys (e.g. light -> dark) doesn't leave the previous
  // theme's tokens stuck on <html>, outranking tokens.css's :root defaults
  // via inline-style specificity. Keys owned by other code (--accent,
  // --font-size) are not in THEME_KEYS and are left untouched.
  for (const key of THEME_KEYS) {
    root.style.removeProperty(key);
  }
  // Apply CSS variables for the theme (keeps existing behavior for inline var overrides)
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(key, value);
  }
  // Delegate body class and persistence to the theme manager
  applyThemeByName(name);
}
