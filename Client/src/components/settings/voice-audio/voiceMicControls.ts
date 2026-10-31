/**
 * Voice settings: the microphone card's controls (status pill, input device,
 * input volume, sensitivity with its meter, the mic test button) and the input
 * mode card.
 */
import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, createToggle } from "../helpers";
import { applyInputMode, setInputVolume } from "@lib/voice/livekitSession";
import { vadLevelPosition, vadThreshold } from "@lib/voice/audioPipeline";
import { desktop } from "../../../platform/desktop";
import { settingsText as t } from "../../../i18n/settings";
import { setStatusIcon, statusIcon } from "../../../features/settings/status";
import { setRovingTabindex, enableRovingNavigation } from "@lib/ui/a11y";
import { autoInputSensitivity, inputMode, type InputMode } from "@lib/ui/inputMode";
import { buildPttControls } from "../pttControls";
import { log, sensitivityLabel, MIC_NOISE_FLOOR, MIC_HEARD_HOLD_MS } from "./voiceTabShared";
import type { VoiceTabScope } from "./voiceTabScope";

export function mountMicControls(sc: VoiceTabScope): void {
  // The microphone's state at a glance, from the live meter below.
  sc.micStatus = createElement("span", { class: "status-pill", "data-testid": "mic-status" });

  sc.micStatusIcon = statusIcon("pending");

  sc.micStatusWord = createElement("span", {});

  sc.micStatus.append(sc.micStatusIcon, sc.micStatusWord);

  sc.micStatus.hidden = true;

  sc.micCard.querySelector(".settings-card-head")!.appendChild(sc.micStatus);

  sc.micHeard = null;

  sc.showMicState = function showMicState(heard: boolean): void {
    if (heard === sc.micHeard) return;
    sc.micHeard = heard;
    sc.micStatus.hidden = false;
    setStatusIcon(sc.micStatusIcon, heard ? "ok" : "pending");
    setText(sc.micStatusWord, heard ? t("voiceAudio.mic.hearing") : t("voiceAudio.mic.noInput"));
  };

  // Input device selector
  sc.inputHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.inputDevice"),
  );

  sc.inputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.inputDevice"),
  });

  sc.defaultInputOpt = createElement("option", { value: "" }, t("voiceAudio.default"));

  sc.inputSelect.appendChild(sc.defaultInputOpt);

  sc.micCard.appendChild(sc.inputHeader);

  sc.micCard.appendChild(sc.inputSelect);

  // Input Volume slider
  sc.inputVolumeHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.inputVolume"),
  );

  sc.micCard.appendChild(sc.inputVolumeHeader);

  sc.inputVolumeRow = createElement("div", { class: "slider-row" });

  sc.savedInputVolume = loadPref<number>("inputVolume", 100);

  /** The slider's current value, for a meter processor started after it moved. */
  sc.inputVolumePercent = sc.savedInputVolume;

  sc.inputVolumeSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "200",
    step: "1",
    value: String(sc.savedInputVolume),
    "aria-label": t("voiceAudio.inputVolume"),
  });

  sc.inputVolumeLabel = createElement("span", { class: "slider-val" }, `${sc.savedInputVolume}%`);

  sc.inputVolumeSlider.addEventListener(
    "input",
    () => {
      const val = Number(sc.inputVolumeSlider.value);
      setText(sc.inputVolumeLabel, `${val}%`);
      setInputVolume(val);
      // The meter's own processor measures after the same gain as the call's.
      sc.inputVolumePercent = val;
      sc.meterProcessor?.setInputGain(val / 100);
      sc.meterResetFloor?.();
      sc.updateNativeTest({ kind: "inputGain", percent: val });
      sc.nativeTestFloor?.reset(performance.now());
    },
    { signal: sc.signal },
  );

  appendChildren(sc.inputVolumeRow, sc.inputVolumeSlider, sc.inputVolumeLabel);

  sc.micCard.appendChild(sc.inputVolumeRow);

  // ── Mic level meter with draggable sensitivity threshold ────────
  sc.sensitivityHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.inputSensitivity"),
  );

  sc.micCard.appendChild(sc.sensitivityHeader);

  // Automatic sensitivity: the gate finds its own threshold above the room's
  // noise, and the meter shows the level without a handle.
  sc.autoSensitivity = autoInputSensitivity();

  sc.autoRow = createElement("div", {
    class: "setting-row",
    "data-testid": "auto-sensitivity",
  });

  sc.autoToggle = createToggle(sc.autoSensitivity, {
    signal: sc.signal,
    label: t("voiceAudio.autoSensitivity"),
    onChange: (nowOn) => {
      sc.autoSensitivity = nowOn;
      savePref("autoInputSensitivity", nowOn);
      sc.paintSensitivity();
      sc.meterThresholdSetter?.(nowOn ? "auto" : vadThreshold(sc.currentSensitivity));
      applyInputMode();
      sc.resetNativeTestGate();
    },
  });

  appendChildren(
    sc.autoRow,
    createElement("div", { class: "setting-label" }, t("voiceAudio.autoSensitivity")),
    sc.autoToggle,
  );

  sc.micCard.appendChild(sc.autoRow);

  // Real-time mic level bar with embedded draggable threshold handle
  sc.meterWrap = createElement("div", { class: "mic-meter-wrap" });

  sc.meterBar = createElement("div", { class: "mic-meter-bar" });

  sc.meterLevel = createElement("div", { class: "mic-meter-level" });

  // A range, not a pointer-only div: the threshold is adjustable by keyboard
  // as well as drag (Q1 — every action reachable, no pointer-only control).
  sc.meterThreshold = createElement("div", {
    class: "mic-meter-threshold",
    role: "slider",
    tabindex: "0",
    "aria-label": t("voiceAudio.inputSensitivity"),
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  });

  sc.meterBar.appendChild(sc.meterLevel);

  sc.meterBar.appendChild(sc.meterThreshold);

  // The value in words beside the meter, not only as the handle's position.
  sc.sensitivityValue = createElement("span", {
    class: "slider-val",
    "data-testid": "sensitivity-value",
  });

  sc.meterWrap.append(sc.meterBar, sc.sensitivityValue);

  sc.micCard.appendChild(sc.meterWrap);

  if (sc.nativeAudio) {
    // The mic test and a call share one capture, so the test waits for the call.
    sc.micCard.appendChild(
      createElement(
        "p",
        { class: "setting-desc", "data-testid": "native-audio-note" },
        t("voiceAudio.nativeNote"),
      ),
    );
  }

  // The bar on the threshold handle's axis, green while the gate is open, and
  // the pill saying whether the mic picks anything up, whatever the
  // sensitivity, held between syllables so it does not flicker.
  sc.lastHeardAt = Number.NEGATIVE_INFINITY;

  sc.paintMeter = function paintMeter(level: number, gateOpen: boolean): void {
    // Same axis as the handle: decibels, GATE_DB_MIN at the left edge.
    const position = vadLevelPosition(level);
    sc.meterLevel.style.width = `${Math.round(position * 1000) / 10}%`;
    sc.meterLevel.style.background = gateOpen ? "var(--green)" : "var(--yellow)";
    const now = performance.now();
    if (level >= MIC_NOISE_FLOOR) sc.lastHeardAt = now;
    sc.showMicState(now - sc.lastHeardAt < MIC_HEARD_HOLD_MS);
  };

  // ── Mic test: plays the processed microphone, after the voice gate, through
  // the chosen output, so you hear what a call would send. On the web it plays
  // the meter's processor; on the native engine the host loops its own capture
  // back to its own output (native_voice/mic_test.rs).
  sc.micTestRow = createElement("div", {
    class: "setting-row mic-test-row",
    "data-testid": "mic-test",
  });

  sc.micTestInfo = createElement("div", {});

  sc.micTestDesc = createElement("div", { class: "setting-desc" }, t("voiceAudio.micTest.desc"));

  appendChildren(
    sc.micTestInfo,
    createElement("div", { class: "setting-label" }, t("voiceAudio.micTest.label")),
    sc.micTestDesc,
  );

  sc.micTestButton = createElement(
    "button",
    { class: "ac-btn", type: "button", "aria-pressed": "false", "data-testid": "mic-test-button" },
    t("voiceAudio.micTest.start"),
  );

  appendChildren(sc.micTestRow, sc.micTestInfo, sc.micTestButton);

  sc.micCard.appendChild(sc.micTestRow);

  sc.currentSensitivity = loadPref<number>("voiceSensitivity", 50);

  // ── Input mode: Voice Activity gates on the sensitivity above, Push to Talk
  // on a held key (whose controls show only in that mode).
  sc.modeGroup = createElement("div", {
    class: "level-options input-mode-options",
    role: "radiogroup",
    "aria-label": t("voiceAudio.inputMode"),
    "data-testid": "input-mode",
  });

  sc.pttBox = createElement("div", { class: "input-mode-ptt", "data-testid": "ptt-controls" });

  if (sc.android) {
    sc.pttBox.appendChild(
      createElement("div", { class: "setting-desc" }, t("voiceAudio.inputMode.ptt.android")),
    );
  } else sc.pttBox.append(...buildPttControls(sc.signal));

  sc.modeButtons = new Map<InputMode, HTMLButtonElement>();

  sc.paintMode = (): void => {
    const mode = sc.currentMode();
    for (const [value, button] of sc.modeButtons) {
      button.classList.toggle("active", value === mode);
      button.setAttribute("aria-checked", String(value === mode));
    }
    sc.pttBox.hidden = mode !== "ptt";
    sc.sensitivityHeader.hidden = mode === "ptt";
    sc.autoRow.hidden = mode === "ptt";
    sc.meterWrap.hidden = mode === "ptt";
  };

  sc.chooseMode = (mode: InputMode): void => {
    if (mode === inputMode()) return;
    savePref("inputMode", mode);
    sc.paintMode();
    applyInputMode();
    sc.syncMeterGate();
    sc.resetNativeTestGate();
    if (sc.android) {
      void import("../../../features/voice/talkButton")
        .then((m) => m.syncTalkSource())
        .catch((err: unknown) => log.warn("Talk button failed to follow the input mode", err));
      return;
    }
    const vk = loadPref<number>("pttVk", 0);
    if (mode === "vad") void desktop.pushToTalk.stop();
    else if (vk !== 0)
      // A saved key the backend refuses is cleared while arming; repaint so
      // the control does not keep showing it.
      void desktop.pushToTalk.updateKey(vk).then(() => {
        if (!sc.signal.aborted && loadPref<number>("pttVk", 0) === 0)
          sc.pttBox.replaceChildren(...buildPttControls(sc.signal));
      });
  };

  sc.modeLabels = {
    vad: t("voiceAudio.inputMode.vad"),
    ptt: t("voiceAudio.inputMode.ptt"),
  };

  for (const mode of ["vad", "ptt"] as const) {
    const button = createElement(
      "button",
      {
        class: "level-opt",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        tabindex: "-1",
        "data-testid": `input-mode-${mode}`,
      },
      sc.modeLabels[mode],
    );
    button.addEventListener("click", () => sc.chooseMode(mode), { signal: sc.signal });
    sc.modeButtons.set(mode, button);
    sc.modeGroup.appendChild(button);
  }

  sc.paintMode();

  setRovingTabindex(sc.modeGroup, "[role='radio']");

  enableRovingNavigation(sc.modeGroup, "[role='radio']", sc.signal);

  appendChildren(sc.inputModeCard, sc.modeGroup, sc.pttBox);

  sc.updateThresholdIndicator = function updateThresholdIndicator(sensitivity: number): void {
    // Invert: sensitivity 100 (no gating) → handle at LEFT (0%),
    //         sensitivity 0 (max gating) → handle at RIGHT (100%).
    // This matches Discord: drag LEFT = easier to pass, RIGHT = harder.
    sc.meterThreshold.style.left = `${100 - sensitivity}%`;
    sc.meterThreshold.setAttribute("aria-valuenow", String(100 - sensitivity));
    const label = sensitivityLabel(sensitivity);
    sc.meterThreshold.setAttribute("aria-valuetext", label);
    setText(sc.sensitivityValue, label);
  };

  sc.updateThresholdIndicator(sc.currentSensitivity);

  sc.paintSensitivity = function paintSensitivity(): void {
    sc.meterThreshold.hidden = sc.autoSensitivity;
    sc.sensitivityValue.hidden = sc.autoSensitivity;
  };

  sc.paintSensitivity();
}
