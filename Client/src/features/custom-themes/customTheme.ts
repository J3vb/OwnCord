/**
 * Custom CSS themes: a saved list of named themes the user writes or imports,
 * at most one active, painted on top of the built-in theme.
 *
 * A theme may never load anything: `checkThemeCss` refuses every way CSS can
 * name a file (url(), image-set(), @import, @font-face and friends), after
 * decoding CSS escapes so `u\72l(` counts as `url(`. The Content-Security-Policy
 * (img-src and font-src 'self') stays the second wall behind it. The check runs
 * on save and again on every paint, because localStorage is a trust boundary.
 *
 * This file is in the startup chunk (the stored theme paints before the first
 * render), so the settings UI lives in customThemeSection.ts.
 */

import {
  loadStoredJson,
  readStored,
  removeStored,
  saveStoredJson,
  writeStored,
} from "../../lib/prefs/preferences";
import { reclampRoleColors, restoreAccent } from "../../lib/prefs/themes";

export interface CustomTheme {
  readonly id: string;
  readonly name: string;
  readonly css: string;
}

export type ThemeCssProblem =
  | { readonly kind: "tooBig" }
  | { readonly kind: "outsideLink"; readonly found: string; readonly line: number | null };

export const MAX_THEME_CSS_CHARS = 100_000;
export const MAX_CUSTOM_THEMES = 20;
export const MAX_THEME_NAME_CHARS = 40;

const LIST_KEY = "owncord:theme:custom:list";
const ACTIVE_KEY = "owncord:theme:custom:active";
const STYLE_ID = "owncord-custom-theme";
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** Every way CSS can point at a file, lower case, as the decoded text spells it. */
const BLOCKED = [
  "url(",
  "image(",
  "image-set(",
  "cross-fade(",
  "element(",
  "src(",
  "@import",
  "@font-face",
  "@namespace",
] as const;

/** `text` with every CSS escape decoded, as the CSS tokenizer would read it. */
function decodeEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\f]?|([\s\S]))/g, (_, hex, ch) => {
    if (typeof hex === "string") {
      const code = parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(code);
    }
    // A backslash before a newline is a line continuation inside a string.
    return ch === "\n" ? "" : (ch as string);
  });
}

/** CSS input preprocessing: CR LF, CR and FF all read as one LF. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?|\f/g, "\n");
}

function firstBlocked(text: string): string | null {
  const lower = decodeEscapes(normalizeNewlines(text)).toLowerCase();
  for (const pattern of BLOCKED) {
    if (lower.includes(pattern)) return pattern;
  }
  return null;
}

/**
 * Why `css` cannot be a theme, or null when it can. Comments are checked too:
 * a comment marker inside a string would make stripping them unsafe, and a
 * theme that only mentions url( in a comment loses nothing by rewording it.
 */
export function checkThemeCss(css: string): ThemeCssProblem | null {
  if (css.length > MAX_THEME_CSS_CHARS) return { kind: "tooBig" };
  const found = firstBlocked(css);
  if (found === null) return null;
  const lines = normalizeNewlines(css).split("\n");
  const index = lines.findIndex((line) => firstBlocked(line) !== null);
  return { kind: "outsideLink", found, line: index === -1 ? null : index + 1 };
}

/** A trimmed name without control characters, cut to the name limit. */
export function cleanThemeName(name: string): string {
  return name
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, MAX_THEME_NAME_CHARS);
}

function parseThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return [];
  const themes: CustomTheme[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, css } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || seen.has(id)) continue;
    if (typeof name !== "string" || typeof css !== "string") continue;
    const clean = cleanThemeName(name);
    if (clean === "") continue;
    seen.add(id);
    themes.push({ id, name: clean, css });
    if (themes.length === MAX_CUSTOM_THEMES) break;
  }
  return themes;
}

/** The saved themes, with any malformed entry dropped. */
export function loadCustomThemes(): CustomTheme[] {
  return loadStoredJson(LIST_KEY, parseThemes, []);
}

/** Persist the list; false when storage is full or unusable. */
export function saveCustomThemes(themes: readonly CustomTheme[]): boolean {
  return saveStoredJson(LIST_KEY, themes);
}

export function newCustomThemeId(): string {
  return crypto.randomUUID();
}

/** The active theme's id, or null for none. */
export function getActiveCustomThemeId(): string | null {
  return readStored(ACTIVE_KEY);
}

function styleElement(): HTMLStyleElement | null {
  const el = document.getElementById(STYLE_ID);
  return el instanceof HTMLStyleElement ? el : null;
}

/** Every style rule under `rules`, nested ones included, except keyframes. */
function* styleRules(rules: CSSRuleList): Generator<CSSStyleRule> {
  for (const rule of Array.from(rules)) {
    // A !important declaration inside a keyframe is ignored, so leave them be.
    if ("keyText" in rule) continue;
    if (rule instanceof CSSStyleRule) yield rule;
    if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) {
      yield* styleRules(rule.cssRules);
    }
  }
}

const ROOT_SELECTORS: ReadonlySet<string> = new Set([":root", "html"]);

/**
 * The theme's text with every custom property marked !important, and a
 * `:root` (or `html`) rule's selector widened to `body` too. Built-in themes
 * write their tokens inline on <html> and <body> and on `body.theme-*`, so a
 * normal `:root { --bg-primary }` would never show: inline beats it, and the
 * body's own value beats the one it would inherit. Done through the parsed
 * sheet, then written back as text, so a copy of the <style> (the voice
 * pop-out clones them) keeps it.
 */
function withImportantTokens(el: HTMLStyleElement, css: string): string | null {
  // i18n-exempt: a media query, not UI text
  el.media = "not all";
  el.textContent = css;
  const sheet = el.sheet;
  if (sheet === null) return null;
  for (const rule of styleRules(sheet.cssRules)) {
    let tokens = false;
    for (const prop of Array.from(rule.style)) {
      if (!prop.startsWith("--")) continue;
      tokens = true;
      if (rule.style.getPropertyPriority(prop) !== "important") {
        rule.style.setProperty(prop, rule.style.getPropertyValue(prop), "important");
      }
    }
    if (tokens && ROOT_SELECTORS.has(rule.selectorText.trim())) {
      // i18n-exempt: a CSS selector, not UI text
      rule.selectorText = `${rule.selectorText}, body`;
    }
  }
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
}

/**
 * Re-derive what depends on the surfaces a theme paints: a saved accent's
 * readable text and focus colours, and the clamped role colours.
 */
function refreshDerivedColors(): void {
  restoreAccent();
  reclampRoleColors();
}

/**
 * Paint `css` as the custom theme, or remove it for null. Refused CSS paints
 * nothing and returns false.
 */
export function paintCustomTheme(css: string | null): boolean {
  const old = styleElement();
  if (css === null || checkThemeCss(css) !== null) {
    old?.remove();
    refreshDerivedColors();
    return css === null;
  }
  const el = document.createElement("style");
  el.id = STYLE_ID;
  document.head.append(el);
  const final = withImportantTokens(el, css);
  // The serialised text goes through the same check: it is what will apply.
  if (final === null || checkThemeCss(final) !== null) {
    el.remove();
    old?.remove();
    refreshDerivedColors();
    return false;
  }
  el.textContent = final;
  el.removeAttribute("media");
  old?.remove();
  refreshDerivedColors();
  return true;
}

const changeListeners = new Set<() => void>();

/** Run `cb` whenever the active custom theme changes, until `signal` aborts. */
export function onCustomThemeChange(cb: () => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  changeListeners.add(cb);
  signal.addEventListener("abort", () => changeListeners.delete(cb), { once: true });
}

/** Make `id` the active theme (null for none) and paint it. */
export function setActiveCustomTheme(id: string | null): boolean {
  const ok = activate(id);
  for (const cb of changeListeners) cb();
  return ok;
}

function activate(id: string | null): boolean {
  const theme = id === null ? undefined : loadCustomThemes().find((t) => t.id === id);
  if (theme === undefined) {
    removeStored(ACTIVE_KEY);
    paintCustomTheme(null);
    return id === null;
  }
  if (!paintCustomTheme(theme.css)) {
    removeStored(ACTIVE_KEY);
    return false;
  }
  // A theme that cannot be remembered as active is not left painted, so the
  // escape shortcut, which reads the stored id, can always turn it off.
  if (!writeStored(ACTIVE_KEY, theme.id)) {
    paintCustomTheme(null);
    return false;
  }
  return true;
}

/** Paint the stored active theme at startup; a stale or refused one is cleared. */
export function applyStoredCustomTheme(): void {
  const id = getActiveCustomThemeId();
  if (id !== null) setActiveCustomTheme(id);
}

/**
 * Ctrl+Shift+Backspace turns the custom theme off, the way out when a theme
 * hides the settings. Backspace is not a bindable key (voiceShortcuts.ts), so
 * no keybind can ever claim this combo.
 */
export function installCustomThemeEscape(signal: AbortSignal): void {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "Backspace" || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      if (getActiveCustomThemeId() === null && styleElement() === null) return;
      e.preventDefault();
      setActiveCustomTheme(null);
    },
    // Capture, so a field or dialog that stops the key cannot swallow the way out.
    { signal, capture: true },
  );
}
