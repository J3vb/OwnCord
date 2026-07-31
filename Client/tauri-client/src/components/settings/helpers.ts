/**
 * Shared helpers and constants for settings tabs.
 */

import { createElement } from "@lib/dom";
import { applyThemeByName } from "@lib/themes";

// Preference persistence lives in `@lib/preferences` so `lib/` modules can use
// it without importing from the component layer. Re-exported here so the
// settings tabs keep a single import site — and, critically, so both layers
// share one implementation (they used to be copy-pasted and had drifted).
export { STORAGE_PREFIX, loadPref, savePref } from "@lib/preferences";

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
    "--bg-primary": "#1a1b1e",
    "--bg-secondary": "#111214",
    "--bg-tertiary": "#0d0e10",
    "--text-normal": "#dbdee1",
  },
  midnight: {
    "--bg-primary": "#1a1a2e",
    "--bg-secondary": "#16213e",
    "--bg-tertiary": "#0f3460",
    "--text-normal": "#e0e0e0",
  },
  light: {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f2f3f5",
    "--bg-tertiary": "#e3e5e8",
    "--text-normal": "#313338",
  },
} as const;

export type ThemeName = keyof typeof THEMES;

// ---------------------------------------------------------------------------
// Accessible toggle creation
// ---------------------------------------------------------------------------

/**
 * Create an accessible toggle switch element with proper ARIA attributes
 * and keyboard support (Enter/Space to toggle).
 */
export function createToggle(
  isOn: boolean,
  opts: { signal: AbortSignal; onChange: (nowOn: boolean) => void },
): HTMLDivElement {
  const toggle = createElement("div", {
    class: isOn ? "toggle on" : "toggle",
    role: "switch",
    tabindex: "0",
    "aria-checked": isOn ? "true" : "false",
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

// ---------------------------------------------------------------------------
// Theme application
// ---------------------------------------------------------------------------

export function applyTheme(name: ThemeName): void {
  // Apply CSS variables for the theme (keeps existing behavior for inline var overrides)
  const theme = THEMES[name];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(key, value);
  }
  // Delegate body class and persistence to the theme manager
  applyThemeByName(name);
}
