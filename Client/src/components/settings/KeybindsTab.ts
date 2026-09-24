/**
 * Keybinds settings tab — push-to-talk key capture and quick switcher display.
 * PTT uses Rust-side GetAsyncKeyState polling so the key is NOT hijacked.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref } from "./helpers";
import { vkName } from "@lib/ptt";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";

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
      class: "ac-btn",
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
