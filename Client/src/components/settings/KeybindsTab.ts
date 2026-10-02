/**
 * Keybinds settings tab — push-to-talk key capture and quick switcher display.
 * PTT uses Rust-side GetAsyncKeyState polling so the key is NOT hijacked.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref } from "./helpers";
import { vkName, pttReleaseDelayMs, PTT_RELEASE_DELAY_MAX_MS } from "@lib/ptt";
import {
  keyEventToVk,
  loadGlobalShortcutVks,
  saveGlobalShortcutVk,
  shortcutConflict,
  type GlobalShortcutAction,
} from "@lib/voiceShortcuts";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";

const delayText = (ms: number): string => t("keybinds.pttReleaseDelay.value", { ms });

export function buildKeybindsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // ── Push to Talk ──────────────────────────────────────────
  const pttRow = createElement("div", { class: "keybind-row" });
  const pttLabel = createElement("span", { class: "setting-label" }, t("keybinds.pushToTalk"));
  let currentVk = loadPref<number>("pttVk", 0);
  const pttValue = createElement(
    "button",
    {
      class: "kbd",
      style: "cursor: pointer; min-width: 80px; text-align: center;",
      title: t("keybinds.clickToSet"),
      "aria-label": t("keybinds.pttAria"),
    },
    currentVk !== 0 ? vkName(currentVk) : t("keybinds.notSet"),
  );
  // i18n-exempt: inline CSS value, not user-visible text
  const hiddenStyle = "display: none;";
  const pttClear = createElement(
    "button",
    {
      class: "ac-btn secondary",
      style: `margin-left: 8px; font-size: 12px; padding: 4px 10px; ${currentVk !== 0 ? "" : hiddenStyle}`,
    },
    t("keybinds.clear"),
  );

  let capturing = false;
  let captureGeneration = 0;

  pttValue.addEventListener(
    "click",
    () => {
      if (capturing) return;
      capturing = true;
      const attempt = ++captureGeneration;
      pttValue.textContent = t("keybinds.pressKey");
      pttValue.style.borderColor = "var(--accent)";
      pttValue.style.color = "var(--accent)";

      // Use Rust-side key detection (supports mouse buttons, works globally).
      // Returns 0 on timeout (10s) if the user didn't press anything.
      void desktop.pushToTalk
        .captureKeyPress()
        .then((vk) => {
          if (signal.aborted || attempt !== captureGeneration) return;
          capturing = false;
          pttValue.style.borderColor = "";
          pttValue.style.color = "";
          if (vk === 0) {
            // Timed out — restore previous value
            setText(pttValue, currentVk !== 0 ? vkName(currentVk) : t("keybinds.notSet"));
            return;
          }
          currentVk = vk;
          setText(pttValue, vkName(vk));
          pttClear.style.display = "";
          void desktop.pushToTalk.updateKey(vk);
        })
        .catch(() => {
          if (signal.aborted || attempt !== captureGeneration) return;
          // Fallback: capture via JS keydown (dev mode without Tauri)
          capturing = false;
          pttValue.style.borderColor = "";
          pttValue.style.color = "";
          setText(pttValue, currentVk !== 0 ? vkName(currentVk) : t("keybinds.notSet"));
        });
    },
    { signal },
  );

  pttClear.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      ++captureGeneration;
      capturing = false;
      currentVk = 0;
      pttValue.style.borderColor = "";
      pttValue.style.color = "";
      setText(pttValue, t("keybinds.notSet"));
      pttClear.style.display = "none";
      void desktop.pushToTalk.updateKey(0);
    },
    { signal },
  );

  appendChildren(pttRow, pttLabel, pttValue, pttClear);
  section.appendChild(pttRow);

  // PTT hint
  const pttHint = createElement(
    "div",
    {
      style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 16px 0; line-height: 1.4;",
    },
    t("keybinds.pttHint"),
  );
  section.appendChild(pttHint);

  // DP-30: how long the mic keeps transmitting after the key is released.
  const delayHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("keybinds.pttReleaseDelay"),
  );
  const delayRow = createElement("div", { class: "slider-row" });
  const savedDelay = pttReleaseDelayMs();
  const delaySlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: String(PTT_RELEASE_DELAY_MAX_MS),
    step: "10",
    value: String(savedDelay),
    "aria-label": t("keybinds.pttReleaseDelay"),
    "aria-valuetext": delayText(savedDelay),
    "data-testid": "ptt-release-delay",
  });
  const delayValue = createElement(
    "span",
    { class: "slider-val", "data-testid": "ptt-release-delay-value" },
    delayText(savedDelay),
  );
  delaySlider.addEventListener(
    "input",
    () => {
      const ms = Number(delaySlider.value);
      savePref("pttReleaseDelayMs", ms);
      setText(delayValue, delayText(ms));
      delaySlider.setAttribute("aria-valuetext", delayText(ms));
    },
    { signal },
  );
  appendChildren(delayRow, delaySlider, delayValue);
  appendChildren(section, delayHeader, delayRow);

  // voice #12: where the desktop cannot observe global key state (macOS or a
  // Wayland session), a bound PTT key can never gate the mic — say so and
  // disable the binding control rather than promising a privacy behaviour
  // that will not happen.
  void desktop.pushToTalk
    .supported()
    .catch(() => false)
    .then((supported) => {
      if (signal.aborted || supported) return;
      setText(pttHint, t("keybinds.pttUnsupported"));
      pttValue.disabled = true;
      delaySlider.disabled = true;
    });

  // ── Navigation section ────────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const navHeader = createElement(
    "div",
    {
      class: "keybind-section-header",
    },
    t("keybinds.navigation"),
  );
  section.appendChild(navHeader);

  const navBinds: [string, string][] = [
    [t("keybinds.action.quickSwitcher"), t("keybinds.key.ctrlK")],
    [t("keybinds.action.searchMessages"), t("keybinds.key.ctrlF")],
    [t("keybinds.action.nextChannel"), t("keybinds.key.altArrow")],
    [t("keybinds.action.nextUnreadChannel"), t("keybinds.key.altShiftArrow")],
    [t("keybinds.action.closeOverlay"), t("keybinds.key.escape")],
  ];
  for (const [label, shortcut] of navBinds) {
    const row = createElement("div", { class: "keybind-row" });
    appendChildren(
      row,
      createElement("span", { class: "setting-label" }, label),
      createElement("span", { class: "kbd" }, shortcut),
    );
    section.appendChild(row);
  }

  // ── Communication section ──────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const commHeader = createElement(
    "div",
    {
      class: "keybind-section-header",
    },
    t("keybinds.communication"),
  );
  section.appendChild(commHeader);

  const commBinds: [string, string][] = [
    [t("keybinds.action.toggleMute"), t("keybinds.key.ctrlM")],
    [t("keybinds.action.toggleDeafen"), t("keybinds.key.ctrlD")],
    [t("keybinds.action.toggleCamera"), t("keybinds.key.ctrlShiftV")],
  ];
  for (const [label, shortcut] of commBinds) {
    const row = createElement("div", { class: "keybind-row" });
    appendChildren(
      row,
      createElement("span", { class: "setting-label" }, label),
      createElement("span", { class: "kbd" }, shortcut),
    );
    section.appendChild(row);
  }

  section.appendChild(
    createElement(
      "div",
      {
        style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 0 0; line-height: 1.4;",
      },
      t("keybinds.voiceHint"),
    ),
  );

  // U6: the global (unfocused) mute/deafen shortcuts are rebindable. Each row
  // captures Ctrl+Shift+<key> from the focused webview, rejects a duplicate or
  // the in-app camera combination, persists the choice and pushes it to the
  // running native poller live. The key is always Ctrl+Shift in the poller, so
  // the row renders that fixed prefix and captures only the variable key.
  // The whole section hides where global keys cannot fire (see the hint below),
  // so no control promises a shortcut the platform will not deliver.
  const globalSection = createElement("div", { style: "display: none;" });
  globalSection.appendChild(createElement("div", { class: "settings-separator" }));
  globalSection.appendChild(
    createElement("div", { class: "keybind-section-header" }, t("keybinds.globalSection")),
  );

  const globalKeys = loadGlobalShortcutVks();
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
      t("keybinds.globalKey", { key: vkName(globalKeys[action]) }),
    );
    button.addEventListener(
      "click",
      () => {
        if (captureState.binding !== null) return;
        conflict.style.display = "none";
        captureState.binding = action;
        button.style.borderColor = "var(--accent)";
        setText(button, t("keybinds.pressKey"));

        const finish = (): void => {
          stopCapture();
          button.style.borderColor = "";
          setText(button, t("keybinds.globalKey", { key: vkName(globalKeys[action]) }));
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
          const reason = shortcutConflict(vk, action, globalKeys);
          if (reason !== null) {
            finish();
            conflict.style.display = "";
            return;
          }
          globalKeys[action] = vk;
          saveGlobalShortcutVk(action, vk);
          finish();
          void desktop.globalShortcuts
            .setKeys({ muteVk: globalKeys.mute, deafenVk: globalKeys.deafen })
            .catch(() => {
              // Not a Tauri host, or the command was refused: the tray and the
              // in-app shortcuts still work; the global key path stays as it was.
            });
        };
        captureState.onKey = onKey;
        document.addEventListener("keydown", onKey, { capture: true, signal });
      },
      { signal },
    );
    appendChildren(row, createElement("span", { class: "setting-label" }, label), button);
    return row;
  };

  globalSection.appendChild(
    globalRow(
      "mute",
      t("keybinds.action.toggleMute"),
      "keybind-global-mute",
      t("keybinds.globalAria"),
    ),
  );
  globalSection.appendChild(
    globalRow(
      "deafen",
      t("keybinds.action.toggleDeafen"),
      "keybind-global-deafen",
      t("keybinds.globalDeafenAria"),
    ),
  );
  globalSection.appendChild(conflict);
  section.appendChild(globalSection);

  // U6: the voice shortcuts also work while the app is unfocused — through the
  // global key path on Windows/X11, and always through the tray's Mute/Deafen
  // items. Where global key state is unavailable (macOS, or any Wayland session), say
  // so instead of promising a shortcut that cannot fire.
  const globalHint = createElement(
    "div",
    {
      style: "font-size: 11px; color: var(--text-micro); margin: 2px 0 0 0; line-height: 1.4;",
      "data-testid": "keybinds-global-hint",
    },
    t("keybinds.globalHint"),
  );
  section.appendChild(globalHint);
  void desktop.globalShortcuts
    .supported()
    .catch(() => false)
    .then((supported) => {
      if (signal.aborted) return;
      if (supported) {
        globalSection.style.display = "";
        return;
      }
      setText(globalHint, t("keybinds.globalHintUnsupported"));
    });

  // ── Messages section ───────────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const msgHeader = createElement(
    "div",
    {
      class: "keybind-section-header",
    },
    t("keybinds.messages"),
  );
  section.appendChild(msgHeader);

  const msgBinds: [string, string][] = [
    [t("keybinds.action.uploadFile"), t("keybinds.key.ctrlU")],
    [t("keybinds.action.editLastMessage"), t("keybinds.key.arrowUp")],
    [t("keybinds.action.bold"), t("keybinds.key.ctrlB")],
    [t("keybinds.action.italic"), t("keybinds.key.ctrlI")],
    [t("keybinds.action.underline"), t("keybinds.key.ctrlU")],
  ];
  for (const [label, shortcut] of msgBinds) {
    const row = createElement("div", { class: "keybind-row" });
    appendChildren(
      row,
      createElement("span", { class: "setting-label" }, label),
      createElement("span", { class: "kbd" }, shortcut),
    );
    section.appendChild(row);
  }

  section.appendChild(
    createElement(
      "div",
      {
        style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 0 0; line-height: 1.4;",
      },
      t("keybinds.formatHint"),
    ),
  );

  return section;
}
