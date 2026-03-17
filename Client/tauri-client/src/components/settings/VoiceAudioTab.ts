/**
 * Voice & Audio settings tab — input/output device, sensitivity, audio processing.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref } from "./helpers";

export function buildVoiceAudioTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const header = createElement("h1", {}, "Voice & Audio");
  section.appendChild(header);

  // Input device selector
  const inputHeader = createElement("h3", {}, "Input Device");
  const inputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
  });
  const defaultInputOpt = createElement("option", { value: "" }, "Default");
  inputSelect.appendChild(defaultInputOpt);
  section.appendChild(inputHeader);
  section.appendChild(inputSelect);

  // Output device selector
  const outputHeader = createElement("h3", {}, "Output Device");
  const outputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
  });
  const defaultOutputOpt = createElement("option", { value: "" }, "Default");
  outputSelect.appendChild(defaultOutputOpt);
  section.appendChild(outputHeader);
  section.appendChild(outputSelect);

  // Populate devices asynchronously
  void (async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const savedInput = loadPref<string>("audioInputDevice", "");
      const savedOutput = loadPref<string>("audioOutputDevice", "");

      for (const d of devices) {
        if (d.kind === "audioinput") {
          const opt = createElement("option", { value: d.deviceId },
            d.label || `Microphone (${d.deviceId.slice(0, 8)})`);
          if (d.deviceId === savedInput) opt.setAttribute("selected", "");
          inputSelect.appendChild(opt);
        } else if (d.kind === "audiooutput") {
          const opt = createElement("option", { value: d.deviceId },
            d.label || `Speaker (${d.deviceId.slice(0, 8)})`);
          if (d.deviceId === savedOutput) opt.setAttribute("selected", "");
          outputSelect.appendChild(opt);
        }
      }

      // Restore saved selections
      if (savedInput) inputSelect.value = savedInput;
      if (savedOutput) outputSelect.value = savedOutput;
    } catch {
      const errOpt = createElement("option", { value: "", disabled: "" },
        "Could not enumerate devices");
      inputSelect.appendChild(errOpt);
    }
  })();

  inputSelect.addEventListener("change", () => {
    savePref("audioInputDevice", inputSelect.value);
  }, { signal });

  outputSelect.addEventListener("change", () => {
    savePref("audioOutputDevice", outputSelect.value);
  }, { signal });

  // Input sensitivity slider
  const sensitivityHeader = createElement("h3", {}, "Input Sensitivity");
  const sensitivityRow = createElement("div", { class: "slider-row" });
  const savedSensitivity = loadPref<number>("voiceSensitivity", 50);
  const sensitivitySlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "100",
    value: String(savedSensitivity),
  });
  const sensitivityLabel = createElement("span", { class: "slider-val" }, `${savedSensitivity}%`);
  sensitivitySlider.addEventListener("input", () => {
    const val = Number(sensitivitySlider.value);
    setText(sensitivityLabel, `${val}%`);
    savePref("voiceSensitivity", val);
  }, { signal });
  appendChildren(sensitivityRow, sensitivitySlider, sensitivityLabel);
  appendChildren(section, sensitivityHeader, sensitivityRow);

  // Audio processing toggles
  const audioToggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    { key: "echoCancellation", label: "Echo Cancellation", desc: "Reduce echo from speakers feeding back into microphone", fallback: true },
    { key: "noiseSuppression", label: "Noise Suppression", desc: "Filter out background noise from your microphone", fallback: true },
    { key: "autoGainControl", label: "Automatic Gain Control", desc: "Automatically adjust microphone volume", fallback: true },
  ];

  for (const item of audioToggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createElement("div", { class: isOn ? "toggle on" : "toggle" });
    toggle.addEventListener("click", () => {
      const nowOn = !toggle.classList.contains("on");
      toggle.classList.toggle("on", nowOn);
      savePref(item.key, nowOn);
    }, { signal });

    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  return section;
}
