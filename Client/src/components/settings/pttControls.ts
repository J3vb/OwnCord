/**
 * The push-to-talk key capture and release delay, shared by the Keybinds tab
 * and Voice & Video's Push to Talk input mode. PTT uses Rust-side
 * GetAsyncKeyState polling so the key is NOT hijacked.
 *
 * Where the host reports the `portal` global-keys backend (Wayland with the
 * desktop's shortcut service) the control changes shape: the key is captured
 * in the webview but restricted to function keys, then bound through the
 * desktop's own dialog, and the button shows the trigger the desktop reports.
 * The branch is the host's `status().backend`, never a platform check.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref } from "./helpers";
import { vkName, pttReleaseDelayMs, PTT_RELEASE_DELAY_MAX_MS } from "@lib/ptt";
import { loadGlobalShortcutVks } from "@lib/voiceShortcuts";
import {
  functionKeyVk,
  globalKeysErrorCode,
  markPortalBound,
  portalHoldsShortcuts,
} from "@lib/globalKeys";
import type { GlobalKeysStatus } from "../../platform/contracts/globalShortcuts";
import { desktop } from "../../platform/desktop";
import { REBINDABLE_ACTIONS, loadEffectiveKeybinds } from "@lib/prefs/keybinds";
import { staysAttached, watchGlobalKeys } from "./globalKeysWatch";
import { actionLabel } from "@lib/prefs/keybindLabels";
import { beginCapture } from "./comboCapture";
import { settingsText as t } from "../../i18n/settings";

/**
 * The name of the in-app action bound to `vk`, or null. Push to talk's poller
 * ignores modifiers, so a key used in any in-app combination clashes with it.
 */
function inAppActionOnVk(vk: number): string | null {
  const effective = loadEffectiveKeybinds();
  for (const { id } of REBINDABLE_ACTIONS) {
    if (effective[id]?.vk === vk) return actionLabel(id);
  }
  return null;
}

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
  // Non-null once the host reports the portal backend.
  let portal: GlobalKeysStatus | null = null;
  let stopKeyCapture: (() => void) | null = null;
  /** Releases the portal capture's `beginCapture` slot (Clear needs it). */
  let releaseCapture: (() => void) | null = null;

  /** The key button's resting text: the desktop's own trigger on the portal path. */
  const restingKeyText = (): string => {
    // A portal that holds the shortcut but names no key: the key is set in
    // the compositor's config, so show what was picked here, if anything.
    if (portal !== null && portal.triggersUnnamed && portal.triggers.ptt === null) {
      return currentVk !== 0 ? vkName(currentVk) : t("keybinds.portalSetInDesktop");
    }
    if (currentVk === 0) return t("keybinds.notSet");
    if (portal === null) return vkName(currentVk);
    return portal.triggers.ptt ?? t("keybinds.notSet");
  };
  const resetKeyButton = (): void => {
    capturing = false;
    pttValue.style.borderColor = "";
    pttValue.style.color = "";
    setText(pttValue, restingKeyText());
  };
  const pttNote = createElement(
    "div",
    {
      style:
        "display: none; font-size: 11px; color: var(--text-micro); margin: 2px 0 0 0; line-height: 1.4;",
      role: "status",
      "data-testid": "ptt-portal-note",
    },
    "",
  );
  const showNote = (text: string | null): void => {
    pttNote.style.display = text === null ? "none" : "";
    setText(pttNote, text ?? "");
  };

  /** Bind the captured function key through the desktop's dialog. */
  const bindPortalKey = async (vk: number): Promise<void> => {
    const attempt = ++captureGeneration;
    capturing = true;
    pttValue.style.borderColor = "var(--accent)";
    pttValue.style.color = "var(--accent)";
    setText(pttValue, t("keybinds.portalWaiting"));
    showNote(null);
    const keys = loadGlobalShortcutVks();
    try {
      const status = await desktop.globalShortcuts.bindPortal({
        pttVk: vk,
        muteVk: keys.mute,
        deafenVk: keys.deafen,
      });
      // The desktop remembers an approved bind, so the next start restores it
      // even when this panel is already gone.
      if (portalHoldsShortcuts(status)) markPortalBound();
      if (attempt !== captureGeneration) return;
      if (status.triggers.ptt !== null || status.triggersUnnamed) {
        currentVk = vk;
        void desktop.pushToTalk.updateKey(vk);
      }
      if (signal.aborted) return;
      portal = status;
      pttClear.style.display = currentVk !== 0 ? "" : "none";
      resetKeyButton();
    } catch (err) {
      if (signal.aborted || attempt !== captureGeneration) return;
      resetKeyButton();
      showNote(
        globalKeysErrorCode(err) === "bind_cancelled"
          ? t("keybinds.portalCancelled")
          : t("keybinds.portalFailed"),
      );
    }
  };

  /** Capture a function key in the webview, then bind it. */
  const capturePortalKey = (): void => {
    capturing = true;
    ++captureGeneration;
    showNote(null);
    pttValue.style.borderColor = "var(--accent)";
    pttValue.style.color = "var(--accent)";
    setText(pttValue, t("keybinds.pressFunctionKey"));
    // Starting another capture (or a Keybinds row) cancels this one.
    const release = beginCapture(signal, () => {
      finish();
      resetKeyButton();
    });
    releaseCapture = release;
    function finish(): void {
      release();
      stopKeyCapture?.();
      stopKeyCapture = null;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // cancel the capture, not the whole Settings overlay
        finish();
        resetKeyButton();
        return;
      }
      const vk = functionKeyVk(e.code);
      if (vk === null) return; // only F1-F24 can be a portal trigger here
      e.preventDefault();
      e.stopPropagation();
      finish();
      const clash = inAppActionOnVk(vk);
      if (clash !== null) {
        resetKeyButton();
        showNote(t("keybinds.pttKeyInUse", { action: clash }));
        return;
      }
      void bindPortalKey(vk);
    };
    document.addEventListener("keydown", onKey, { capture: true, signal });
    stopKeyCapture = () => document.removeEventListener("keydown", onKey, true);
  };

  pttValue.addEventListener(
    "click",
    () => {
      if (capturing) return;
      if (portal !== null) {
        capturePortalKey();
        return;
      }
      capturing = true;
      const attempt = ++captureGeneration;
      showNote(null);
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
          const clash = inAppActionOnVk(vk);
          if (clash !== null) {
            setText(pttValue, restingKeyText());
            showNote(t("keybinds.pttKeyInUse", { action: clash }));
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
      releaseCapture?.();
      releaseCapture = null;
      stopKeyCapture?.();
      stopKeyCapture = null;
      showNote(null);
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

  // How long the mic keeps transmitting after the key is released.
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

  // The portal path: the desktop's shortcut service delivers the key, so the
  // control binds through its dialog and follows what it reports.
  const enterPortalMode = (status: GlobalKeysStatus): void => {
    portal = status;
    pttValue.disabled = false;
    delaySlider.disabled = false;
    pttValue.title = t("keybinds.portalClickToSet");
    setText(pttHint, t("keybinds.pttPortalHint"));
    pttClear.style.display = currentVk !== 0 ? "" : "none";
    if (!capturing) setText(pttValue, restingKeyText());
  };
  let statusSeen = false;
  let legacyChecked = false;
  const applyStatus = (status: GlobalKeysStatus): void => {
    if (status.backend === "portal") {
      if (portal === null) enterPortalMode(status);
      else {
        portal = status;
        if (!capturing) setText(pttValue, restingKeyText());
      }
      return;
    }
    if (portal !== null) {
      // The portal went away: back to the legacy check, which disables the
      // control where nothing can deliver the key.
      portal = null;
      pttValue.title = t("keybinds.clickToSet");
      setText(pttHint, t("keybinds.pttHint"));
      if (!capturing) setText(pttValue, restingKeyText());
      legacyChecked = false;
    }
    if (legacyChecked) return;
    legacyChecked = true;
    // voice #12: where the desktop cannot observe global key state (macOS, or
    // Linux without a global shortcut service), a bound PTT key can never gate
    // the mic — say so and disable the binding control rather than promising a
    // privacy behaviour that will not happen.
    void desktop.pushToTalk
      .supported()
      .catch(() => false)
      .then((supported) => {
        if (signal.aborted || supported) return;
        setText(pttHint, t("keybinds.pttUnsupported"));
        pttValue.disabled = true;
        delaySlider.disabled = true;
      });
  };
  // Subscribe before asking, and let an event outrank the older first answer.
  const attached = staysAttached(pttRow);
  watchGlobalKeys(signal, (next) => {
    if (signal.aborted || !attached()) return false;
    statusSeen = true;
    applyStatus(next);
    return true;
  });
  void desktop.globalShortcuts
    .status()
    .then((status) => {
      if (signal.aborted || statusSeen) return;
      applyStatus(status);
    })
    .catch(() => {
      // status() does not reject; a host that cannot answer keeps today's control.
    });

  return [pttRow, pttHint, pttNote, delayHeader, delayRow];
}
