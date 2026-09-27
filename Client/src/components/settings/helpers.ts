/**
 * Shared helpers and constants for settings tabs.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { STORAGE_PREFIX, loadPref, savePref, readMigratedStringPref } from "@lib/preferences";
import { THEMES, applyTheme, type ThemeName } from "@lib/themes";

// Preference persistence lives in `@lib/preferences` and the theme palette in
// `@lib/themes` so `lib/` and `features/` modules can use them without
// importing the component layer (ARCH-06). Re-exported here so the settings
// tabs keep a single import site — and, critically, so both layers share one
// implementation (they used to be copy-pasted and had drifted).
export { STORAGE_PREFIX, loadPref, savePref, readMigratedStringPref };
export { THEMES, applyTheme };
export type { ThemeName };

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
// Form feedback (B9-2 UI contract)
// ---------------------------------------------------------------------------

/**
 * The account/recovery forms' inline messages. They use the shared
 * `.form-error`/`.form-status`/`.form-warning` classes, so the text colour is
 * the qualified `--text-danger`/`--text-positive`/`--text-warning` token
 * rather than the fill tokens (`--red`, `--green`, `--yellow`), which read
 * below 4.5:1 on several surfaces, and the message is announced through the
 * live role `outcomeEl` fixes at creation from the outcome it is given
 * (`role=alert` for an error, `role=status` otherwise); `showOutcome` keeps
 * it. Colour is never the only signal — the copy says which it is.
 */
export type Outcome = "error" | "success" | "warning";

const OUTCOME_CLASS: Readonly<Record<Outcome, string>> = {
  error: "form-error",
  success: "form-status",
  warning: "form-warning",
};

/** An empty inline message element for `outcome`, with its live role set. */
export function outcomeEl(outcome: Outcome, testId?: string): HTMLDivElement {
  return createElement("div", {
    class: OUTCOME_CLASS[outcome],
    role: outcome === "error" ? "alert" : "status",
    ...(testId === undefined ? {} : { "data-testid": testId }),
  });
}

/**
 * Show `text` in `el` as `outcome` ('' clears it). The live role set by
 * `outcomeEl` stays put: swapping it with the text rebuilds the live region
 * and the new text is not announced.
 */
export function showOutcome(el: HTMLElement, outcome: Outcome, text: string): void {
  el.className = OUTCOME_CLASS[outcome];
  setText(el, text);
}
