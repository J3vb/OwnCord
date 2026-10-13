/**
 * The push-to-talk key capture and release delay, shared by the Keybinds tab
 * and Voice & Audio's Push to Talk input mode. PTT uses Rust-side
 * GetAsyncKeyState polling so the key is NOT hijacked.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref } from "./helpers";
import { vkName, pttReleaseDelayMs, PTT_RELEASE_DELAY_MAX_MS } from "@lib/ptt";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";

const delayText = (ms: number): string => t("keybinds.pttReleaseDelay.value", { ms });

export function buildPttControls(signal: AbortSignal): HTMLElement[] {
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

  // PTT hint
  const pttHint = createElement(
    "div",
    {
      style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 16px 0; line-height: 1.4;",
    },
    t("keybinds.pttHint"),
  );

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

  return [pttRow, pttHint, delayHeader, delayRow];
}
