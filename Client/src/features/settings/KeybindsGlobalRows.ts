/** Keybinds tab: the rebindable global mute and deafen rows. */

import { createElement, appendChildren, setText } from "@lib/dom";
import {
  keyEventToVk,
  saveGlobalShortcutVk,
  shortcutConflict,
  type GlobalShortcutAction,
  type loadGlobalShortcutVks,
} from "@lib/voice/voiceShortcuts";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";
import { globalShortcutTakenVks, loadEffectiveKeybinds } from "@lib/prefs/keybinds";
import { beginCapture } from "./comboCapture";
import { buildSettingsSection } from "./settingsSection";

/** The global shortcut keys as loaded; the rows update this object as keys are rebound. */
export type GlobalKeys = ReturnType<typeof loadGlobalShortcutVks>;

// the global (unfocused) mute/deafen shortcuts are rebindable. Each row
// captures Ctrl+Shift+<key> from the focused webview, rejects a duplicate or
// the in-app camera combination, persists the choice and pushes it to the
// running native poller live. The key is always Ctrl+Shift in the poller, so
// the row renders that fixed prefix and captures only the variable key.
// The rows' card stays hidden until the host says global keys can fire, so no
// control promises a shortcut the platform will not deliver; the section
// itself also carries the hint that says which path the keys take.
export function buildGlobalShortcutSection(
  signal: AbortSignal,
  globalKeys: GlobalKeys,
  comboText: (action: GlobalShortcutAction) => string,
  commKbd: Partial<Record<GlobalShortcutAction, HTMLElement>>,
): { readonly el: HTMLElement; readonly card: HTMLElement } {
  const { el: globalSection, card } = buildSettingsSection({ label: t("keybinds.globalSection") });
  card.style.display = "none";

  const captureState: {
    binding: GlobalShortcutAction | null;
    onKey: ((e: KeyboardEvent) => void) | null;
  } = { binding: null, onKey: null };

  const stopCapture = (): void => {
    captureState.binding = null;
    if (captureState.onKey !== null) {
      document.removeEventListener("keydown", captureState.onKey, true);
      captureState.onKey = null;
    }
  };

  const conflict = createElement(
    "div",
    {
      style:
        "display: none; font-size: 11px; color: var(--text-danger); margin: 2px 0 0 0; line-height: 1.4;",
      role: "alert",
    },
    t("keybinds.globalConflict"),
  );

  const globalRow = (action: GlobalShortcutAction, label: string, testId: string, aria: string) => {
    const row = createElement("div", { class: "keybind-row" });
    const button = createElement(
      "button",
      {
        class: "kbd",
        style: "cursor: pointer; min-width: 80px; text-align: center;",
        title: t("keybinds.clickToSet"),
        "aria-label": aria,
        "data-testid": testId,
      },
      comboText(action),
    );
    const show = (text: string): void => {
      setText(button, text);
      button.setAttribute("aria-label", t("keybinds.rebindAria", { action: aria, combo: text }));
    };
    show(comboText(action));
    button.addEventListener(
      "click",
      () => {
        if (captureState.binding !== null) return;
        conflict.style.display = "none";
        captureState.binding = action;
        button.style.borderColor = "var(--accent)";
        show(t("keybinds.pressKey"));

        let release: (() => void) | null = null;
        const finish = (): void => {
          release?.();
          stopCapture();
          button.style.borderColor = "";
          show(comboText(action));
        };

        const onKey = (e: KeyboardEvent): void => {
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
          const vk = keyEventToVk(e);
          if (vk === null) return; // modifiers and unmapped keys do not bind
          e.preventDefault();
          e.stopPropagation();
          const reason = shortcutConflict(
            vk,
            action,
            globalKeys,
            globalShortcutTakenVks(loadEffectiveKeybinds()),
          );
          if (reason !== null) {
            finish();
            conflict.style.display = "";
            return;
          }
          globalKeys[action] = vk;
          saveGlobalShortcutVk(action, vk);
          const kbd = commKbd[action];
          if (kbd !== undefined) setText(kbd, comboText(action));
          finish();
          void desktop.globalShortcuts
            .setKeys({ muteVk: globalKeys.mute, deafenVk: globalKeys.deafen })
            .catch(() => {
              // Not a Tauri host, or the command was refused: the tray and the
              // in-app shortcuts still work; the global key path stays as it was.
            });
        };
        captureState.onKey = onKey;
        // Starting this capture ends an in-app row's, and the reverse.
        release = beginCapture(signal, finish);
        document.addEventListener("keydown", onKey, { capture: true, signal });
      },
      { signal },
    );
    appendChildren(row, createElement("span", { class: "setting-label" }, label), button);
    return row;
  };

  card.appendChild(
    globalRow(
      "mute",
      t("keybinds.action.toggleMute"),
      "keybind-global-mute",
      t("keybinds.globalAria"),
    ),
  );
  card.appendChild(
    globalRow(
      "deafen",
      t("keybinds.action.toggleDeafen"),
      "keybind-global-deafen",
      t("keybinds.globalDeafenAria"),
    ),
  );
  card.appendChild(conflict);
  return { el: globalSection, card };
}
