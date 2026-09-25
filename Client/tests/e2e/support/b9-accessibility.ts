/**
 * Reusable accessibility checks for B9 milestones (B9-2 UI contract,
 * docs/architecture/b9-ui-contract.md).
 *
 * Everything here reads the running page, so it works the same against the
 * Vite dev server and the production bundle (`playwright.config.prod.ts`).
 * The contrast math is the app's own (`src/lib/color-contrast.ts`), so a test
 * and the Q8 accent fallback can never disagree about a ratio.
 *
 * - `setAppearance` stores appearance preferences and reloads, so the app's
 *   real startup path (`applyStoredAppearance`) applies them.
 * - `findUnnamedControls` lists focusable controls with no accessible name.
 * - `focusIndicator` checks the focused element's ring against Q1 (2.4.7,
 *   1.4.11): visible, at least 2px, and 3:1 against what it sits on.
 * - `textContrast` measures an element's text against its composited
 *   background.
 * - `mountSharedControls` renders the shared-controls fixture: the real
 *   modal, form, button, toggle and status classes in every state.
 */

import type { Locator, Page } from "@playwright/test";
import { contrastRatio, parseColor, type Rgb } from "../../../src/lib/color-contrast";

export const Q1 = { text: 4.5, nonText: 3, focus: 3 } as const;

export interface AppearancePrefs {
  readonly theme?: "dark" | "neon-glow" | "midnight" | "light";
  /** `#rrggbb`, or null to clear a stored custom accent. */
  readonly accent?: string | null;
  readonly highContrast?: boolean;
  readonly fontSize?: number;
  readonly largeFont?: boolean;
  readonly reducedMotion?: boolean;
  readonly syncOsMotion?: boolean;
}

/** Store appearance preferences and reload so startup applies them. */
export async function setAppearance(page: Page, prefs: AppearancePrefs): Promise<void> {
  await page.evaluate((p) => {
    const set = (key: string, value: unknown): void => {
      if (value === undefined) return;
      const storageKey = `owncord:settings:${key}`;
      if (value === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(value));
    };
    if (p.theme !== undefined) localStorage.setItem("owncord:theme:active", p.theme);
    set("accentColor", p.accent);
    set("highContrast", p.highContrast);
    set("fontSize", p.fontSize);
    set("largeFont", p.largeFont);
    set("reducedMotion", p.reducedMotion);
    set("syncOsMotion", p.syncOsMotion);
  }, prefs);
  await page.reload();
}

type Rgba = readonly [number, number, number, number];

function parseRgba(value: string): Rgba {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/.exec(value);
  if (m !== null) {
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  }
  // color-mix() computes to color(srgb r g b / a), channels 0-1.
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (srgb === null) throw new Error(`unparseable computed colour: ${value}`);
  const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map((c) => Number(c) * 255) as [
    number,
    number,
    number,
  ];
  return [r, g, b, srgb[4] === undefined ? 1 : Number(srgb[4])];
}

/** Composite a bottom-to-top stack of computed colours onto an opaque base. */
function composite(stack: readonly string[]): Rgb {
  let out: [number, number, number] = [255, 255, 255];
  for (const layer of stack) {
    const [r, g, b, a] = parseRgba(layer);
    out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
  }
  return out;
}

/**
 * Computed background colours from `el` up to <html>, bottom layer first.
 * Background images (gradients) are not composited; the fixture avoids them.
 */
async function backgroundStack(locator: Locator): Promise<string[]> {
  return locator.evaluate((el) => {
    const layers: string[] = [];
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      layers.push(getComputedStyle(n).backgroundColor);
    }
    return layers.reverse();
  });
}

/** Contrast of an element's text (or its ::placeholder) on its composited background. */
export async function textContrast(
  locator: Locator,
  pseudo?: "::placeholder",
): Promise<{ ratio: number; fg: string; bg: string }> {
  const stack = await backgroundStack(locator);
  const fg = await locator.evaluate((el, p) => getComputedStyle(el, p ?? null).color, pseudo);
  const bg = composite(stack);
  const fgRgb = composite([...stack, fg]); // a translucent text colour blends too
  return { ratio: contrastRatio(fgRgb, bg), fg, bg: `rgb(${bg.map(Math.round).join(", ")})` };
}

/**
 * Contrast of each `[foreground token, background token]` pair as the page
 * resolves them, in one round trip. A token pair means "this text colour on
 * this surface", independent of any one screen.
 */
export async function tokenContrasts(
  page: Page,
  pairs: ReadonlyArray<readonly [string, string]>,
): Promise<number[]> {
  const colours = await page.evaluate((ps) => {
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const out = ps.map(([f, b]) => {
      probe.style.color = `var(${f})`;
      probe.style.backgroundColor = `var(${b})`;
      const cs = getComputedStyle(probe);
      return [cs.color, cs.backgroundColor] as const;
    });
    probe.remove();
    return out;
  }, pairs);
  return colours.map(([fg, bg]) => {
    const base = composite([bg]);
    return contrastRatio(composite([bg, fg]), base);
  });
}

/** A computed custom property as `#rrggbb`, or "" when unset/unparseable. */
export async function tokenHex(page: Page, token: string): Promise<string> {
  const value = await page.evaluate(
    (t) => getComputedStyle(document.body).getPropertyValue(t),
    token,
  );
  const rgb = parseColor(value);
  return rgb === null ? "" : `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focusable controls under `root` whose accessible name is empty, as their
 * ARIA-snapshot line (e.g. `- button`). Uses Playwright's accessible-name
 * computation, the same tree a screen reader is given.
 */
export async function findUnnamedControls(root: Locator): Promise<string[]> {
  const unnamed: string[] = [];
  const controls = root.locator(FOCUSABLE);
  for (let i = 0; i < (await controls.count()); i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const firstLine = (await control.ariaSnapshot()).split("\n")[0] ?? "";
    // `- role "name" [state]`; an unnamed control has no quoted name.
    if (!/^- [\w-]+ "[^"]*\S[^"]*"/.test(firstLine)) unnamed.push(firstLine);
  }
  return unnamed;
}

/**
 * Tab from the top of the document until `target` is focused, or fail. An
 * element can be visible and named yet still be unreachable by keyboard (an
 * href-less <a>, a click-only <div>), which `findUnnamedControls` cannot see
 * because its FOCUSABLE selector only matches elements that are already
 * focusable. Tab is the only check that sees what a keyboard user actually
 * reaches (A11Y-08). Returns false when the target is not focused within 150
 * presses, well past the shell's tab stops.
 */
export async function keyboardReachable(page: Page, target: Locator): Promise<boolean> {
  // Drop focus to the document so the first Tab starts at the top.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return true;
  }
  return false;
}

export interface FocusIndicator {
  readonly element: string;
  readonly style: string;
  readonly width: number;
  readonly ratio: number;
  /** Empty when the indicator meets Q1; otherwise why it does not. */
  readonly problems: string[];
}

/**
 * Check the indicator on the currently focused element: an outline at least
 * 2px wide and 3:1 against the background it is drawn over.
 */
export async function focusIndicator(page: Page): Promise<FocusIndicator> {
  const focused = page.locator("*:focus");
  const info = await focused.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      element: `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ").join(".")}` : ""}`,
      style: cs.outlineStyle,
      width: parseFloat(cs.outlineWidth),
      color: cs.outlineColor,
    };
  });
  // The ring sits in the outline-offset gap, over the parent's background.
  const stack = await focused.evaluate((el) => {
    const layers: string[] = [];
    for (let n = el.parentElement; n !== null; n = n.parentElement) {
      layers.push(getComputedStyle(n).backgroundColor);
    }
    return layers.reverse();
  });
  const ratio = contrastRatio(composite([...stack, info.color]), composite(stack));
  const problems: string[] = [];
  if (info.style === "none" || info.style === "hidden") problems.push("no outline");
  if (info.width < 2) problems.push(`outline ${info.width}px < 2px`);
  if (ratio < Q1.focus) problems.push(`ring ${ratio.toFixed(2)}:1 < 3:1`);
  return { element: info.element, style: info.style, width: info.width, ratio, problems };
}

/**
 * Render the shared-controls fixture over the current page: a factory-shaped
 * dialog (`.modal-overlay > .modal[role=dialog]`) holding a labelled field
 * with its error and status messages, a named settings switch, a link, and the
 * cancel/danger/save buttons. Submitting shows the contract's pending, error
 * and success states: empty input is an error (role="alert", aria-invalid),
 * anything else a success (role="status"), after a short aria-busy pending.
 */
export async function mountSharedControls(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    document.querySelector('[data-testid="b9-fixture"]')?.remove();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay visible";
    overlay.dataset["testid"] = "b9-fixture";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="b9-fx-title" tabindex="-1">
        <div class="modal-header">
          <h3 id="b9-fx-title">Rename channel</h3>
          <button type="button" class="modal-close" aria-label="Close">&times;</button>
        </div>
        <form class="modal-body" id="b9-fx-form" novalidate>
          <p class="modal-danger-text">Renaming changes it for <strong>everyone</strong>.</p>
          <div class="form-group">
            <label class="form-label" for="b9-fx-name">Channel name</label>
            <input class="form-input" id="b9-fx-name" placeholder="general" aria-describedby="b9-fx-error b9-fx-status">
            <div class="form-error" id="b9-fx-error" role="alert"></div>
            <div class="form-status" id="b9-fx-status" role="status"></div>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Notify members</div>
              <div class="setting-desc">Post a notice in the channel</div>
            </div>
            <div class="toggle" role="switch" tabindex="0" aria-checked="false" aria-label="Notify members"></div>
          </div>
          <a href="#naming-rules">Naming rules</a>
        </form>
        <div class="modal-footer">
          <button type="button" class="btn-modal-cancel">Cancel</button>
          <button type="button" class="btn-danger">Delete</button>
          <button type="submit" form="b9-fx-form" class="btn-modal-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector<HTMLFormElement>("#b9-fx-form")!;
    const input = overlay.querySelector<HTMLInputElement>("#b9-fx-name")!;
    const save = overlay.querySelector<HTMLButtonElement>(".btn-modal-save")!;
    const error = overlay.querySelector<HTMLElement>("#b9-fx-error")!;
    const status = overlay.querySelector<HTMLElement>("#b9-fx-status")!;
    const toggle = overlay.querySelector<HTMLElement>(".toggle")!;
    const flip = (): void => {
      const on = toggle.getAttribute("aria-checked") !== "true";
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-checked", String(on));
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        flip();
      }
    });
    // Pending uses aria-disabled, not disabled: disabling the focused button
    // would drop focus to <body> mid-submit (contract: stable focus).
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (save.getAttribute("aria-busy") === "true") return;
      error.textContent = "";
      status.textContent = "Saving…";
      save.setAttribute("aria-busy", "true");
      save.setAttribute("aria-disabled", "true");
      setTimeout(() => {
        save.removeAttribute("aria-busy");
        save.removeAttribute("aria-disabled");
        if (input.value.trim() === "") {
          status.textContent = "";
          input.setAttribute("aria-invalid", "true");
          error.textContent = "Enter a channel name.";
          input.focus();
        } else {
          input.removeAttribute("aria-invalid");
          status.textContent = "Channel renamed.";
        }
      }, 150);
    });
  });
  return page.getByTestId("b9-fixture");
}
