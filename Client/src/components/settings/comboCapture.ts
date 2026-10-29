/**
 * One rebindable in-app action in the Keybinds tab: a button that captures a
 * key combination, plus Reset and Remove, and an alert line for a refused
 * combination. Capture goes through `comboFromEvent(e, "inApp")`,
 * the one function dispatch uses too, and saving goes through `saveKeybind`.
 *
 * Mute and deafen are not built here: they keep their global Ctrl+Shift
 * capture in `KeybindsTab.ts`.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { actionLabel, comboOrNotSet } from "@lib/keybindLabels";
import { loadPref } from "@lib/preferences";
import { keyEventToVk } from "@lib/voiceShortcuts";
import {
  REBINDABLE_ACTIONS,
  comboFromEvent,
  comboKey,
  keybindConflict,
  loadEffectiveKeybinds,
  saveKeybind,
  type ConflictKind,
  type KeyCombo,
  type KeybindConflict,
  type RebindableId,
} from "@lib/keybinds";
import type { SettingsTextKey } from "@lib/keybindCatalog";
import { settingsText as t } from "../../i18n/settings";

/** The alert text of each refusal that names no other action. */
const CONFLICT_TEXT_KEYS: Readonly<Record<Exclude<ConflictKind, "duplicate">, SettingsTextKey>> = {
  needsModifier: "keybinds.conflictNeedsModifier",
  reserved: "keybinds.conflictReserved",
  fixed: "keybinds.conflictFixed",
  ptt: "keybinds.conflictPtt",
};

/** The alert text for a refused combination. */
function conflictText(conflict: KeybindConflict): string {
  if (conflict.kind !== "duplicate") return t(CONFLICT_TEXT_KEYS[conflict.kind]);
  return conflict.with === undefined
    ? t("keybinds.conflictFixed")
    : t("keybinds.conflictWith", { action: actionLabel(conflict.with) });
}

// One capture at a time per tab: starting one cancels the one in progress.
const activeCapture = new WeakMap<AbortSignal, () => void>();

/**
 * Register `cancel` as the capture in progress for this tab, cancelling the
 * previous one. Returns a function that releases the registration once the
 * capture is over (safe to call twice).
 */
export function beginCapture(signal: AbortSignal, cancel: () => void): () => void {
  activeCapture.get(signal)?.();
  activeCapture.set(signal, cancel);
  return () => {
    if (activeCapture.get(signal) === cancel) activeCapture.delete(signal);
  };
}

/** Cancel the capture in progress for this tab, if any. */
export function cancelCapture(signal: AbortSignal): void {
  const cancel = activeCapture.get(signal);
  activeCapture.delete(signal);
  cancel?.();
}

export interface ComboCaptureOptions {
  action: RebindableId;
  /** The visible label of the row. */
  label: string;
  testId: string;
}

export interface ComboCapture {
  /** The row and its alert line. */
  element: HTMLElement;
  /** Re-read the saved binding and clear any alert (after an outside change). */
  refresh: () => void;
  /**
   * Back to the default for "Reset all". A default that another binding or
   * push to talk holds now is saved as unbound, with that row's alert saying why.
   */
  reset: () => void;
}

const savedPttVk = (): number => loadPref<number>("pttVk", 0);

const defaultOf = (action: RebindableId): KeyCombo | null =>
  REBINDABLE_ACTIONS.find((a) => a.id === action)?.defaultCombo ?? null;

export function buildComboCapture(signal: AbortSignal, opts: ComboCaptureOptions): ComboCapture {
  const { action, label, testId } = opts;
  const row = createElement("div", { class: "keybind-row" });
  const button = createElement(
    "button",
    {
      type: "button",
      class: "kbd keybind-capture-btn",
      title: t("keybinds.clickToSet"),
      "data-testid": testId,
    },
    "",
  );
  const reset = createElement(
    "button",
    {
      type: "button",
      class: "keybind-mini-btn",
      "aria-label": t("keybinds.resetAria", { action: label }),
      "data-testid": `${testId}-reset`,
    },
    t("keybinds.resetOne"),
  );
  const remove = createElement(
    "button",
    {
      type: "button",
      class: "keybind-mini-btn",
      "aria-label": t("keybinds.removeAria", { action: label }),
      title: t("keybinds.removeAria", { action: label }),
      "data-testid": `${testId}-remove`,
    },
    "",
  );
  remove.appendChild(createIcon("x", 12));
  const controls = createElement("span", { class: "keybind-controls" });
  appendChildren(controls, button, reset, remove);
  appendChildren(row, createElement("span", { class: "setting-label" }, label), controls);

  const alert = createElement("div", {
    class: "keybind-alert",
    role: "alert",
    hidden: "",
    "data-testid": `${testId}-alert`,
  });
  const element = createElement("div", { class: "keybind-capture" });
  appendChildren(element, row, alert);

  const showAlert = (text: string | null): void => {
    alert.hidden = text === null;
    setText(alert, text ?? "");
  };

  /** Disable a button, handing focus to the key button if it held it. */
  const setDisabled = (btn: HTMLButtonElement, disabled: boolean): void => {
    if (disabled && document.activeElement === btn) button.focus();
    btn.disabled = disabled;
  };

  /** The button's text, and the same in its accessible name. */
  const show = (text: string): void => {
    setText(button, text);
    button.setAttribute("aria-label", t("keybinds.rebindAria", { action: label, combo: text }));
  };

  const render = (): void => {
    const combo = loadEffectiveKeybinds()[action];
    const def = defaultOf(action);
    show(comboOrNotSet(combo));
    const isDefault =
      combo === null || def === null ? combo === def : comboKey(combo) === comboKey(def);
    setDisabled(reset, isDefault);
    setDisabled(remove, combo === null);
  };

  let capturing = false;
  let release: (() => void) | null = null;
  const finish = (): void => {
    if (!capturing) return;
    capturing = false;
    document.removeEventListener("keydown", onKey, true);
    release?.();
    release = null;
    button.classList.remove("capturing");
    render();
  };

  function onKey(e: KeyboardEvent): void {
    if (e.code === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // cancel the capture, not the whole Settings overlay
      finish();
      return;
    }
    if (e.code === "Tab") {
      finish(); // focus moves on; the capture must not follow it
      return;
    }
    // A modifier on its own (or any key that cannot be bound) keeps waiting.
    if (keyEventToVk(e) === null) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e, "inApp");
    if (combo === null) {
      // Win/Super, or Ctrl+Alt (AltGr): never captured.
      showAlert(t("keybinds.conflictReserved"));
      finish();
      return;
    }
    const conflict = keybindConflict(combo, action, loadEffectiveKeybinds(), savedPttVk());
    if (conflict !== null) {
      showAlert(conflictText(conflict));
      finish();
      return;
    }
    saveKeybind(action, combo);
    finish();
  }

  button.addEventListener(
    "click",
    () => {
      if (capturing) return;
      release = beginCapture(signal, finish);
      capturing = true;
      showAlert(null);
      button.classList.add("capturing");
      show(t("keybinds.pressKey"));
      document.addEventListener("keydown", onKey, { capture: true, signal });
    },
    { signal },
  );

  reset.addEventListener(
    "click",
    () => {
      finish();
      const def = defaultOf(action);
      if (def !== null) {
        // Another binding may have taken the default since.
        const conflict = keybindConflict(def, action, loadEffectiveKeybinds(), savedPttVk());
        if (conflict !== null) {
          showAlert(conflictText(conflict));
          return;
        }
      }
      showAlert(null);
      saveKeybind(action, undefined);
      render();
    },
    { signal },
  );

  remove.addEventListener(
    "click",
    () => {
      finish();
      showAlert(null);
      saveKeybind(action, null);
      render();
    },
    { signal },
  );

  render();
  return {
    element,
    refresh: () => {
      showAlert(null);
      render();
    },
    reset: () => {
      finish();
      showAlert(null);
      saveKeybind(action, undefined);
      const def = defaultOf(action);
      if (def !== null) {
        const conflict = keybindConflict(def, action, loadEffectiveKeybinds(), savedPttVk());
        if (conflict !== null) {
          saveKeybind(action, null);
          showAlert(conflictText(conflict));
        }
      }
      render();
    },
  };
}
