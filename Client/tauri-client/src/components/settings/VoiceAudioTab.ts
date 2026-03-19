/**
 * Voice & Audio settings tab — input/output device, sensitivity, audio processing.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref } from "./helpers";
import { switchInputDevice, switchOutputDevice, setVoiceSensitivity, updateSilenceSuppressionPref } from "@lib/voiceSession";
import { sensitivityToThreshold } from "@lib/vad";

export interface VoiceAudioTabHandle {
  build(): HTMLDivElement;
  cleanup(): void;
}

export function createVoiceAudioTab(signal: AbortSignal): VoiceAudioTabHandle {
  let micStream: MediaStream | null = null;
  let micAudioCtx: AudioContext | null = null;
  let micAnimFrame: number | null = null;
  let cameraPreviewStream: MediaStream | null = null;

  function cleanupMic(): void {
    if (micAnimFrame !== null) { cancelAnimationFrame(micAnimFrame); micAnimFrame = null; }
    if (micStream !== null) {
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
    if (micAudioCtx !== null) { void micAudioCtx.close(); micAudioCtx = null; }
    // Also stop camera preview
    if (cameraPreviewStream !== null) {
      for (const track of cameraPreviewStream.getTracks()) track.stop();
      cameraPreviewStream = null;
    }
  }

  function build(): HTMLDivElement {
    // Clean up any previous mic/camera stream before rebuilding
    cleanupMic();
    return buildVoiceAudioTabInner(signal, (stream, ctx, frame) => {
      micStream = stream;
      micAudioCtx = ctx;
      micAnimFrame = frame;
    }, (stream) => {
      cameraPreviewStream = stream;
    });
  }

  function cleanup(): void {
    cleanupMic();
  }

  // Also clean up on overlay close
  signal.addEventListener("abort", cleanupMic);

  return { build, cleanup };
}

type MicRegistrar = (stream: MediaStream, ctx: AudioContext, frame: number) => void;
type CameraRegistrar = (stream: MediaStream | null) => void;

function buildVoiceAudioTabInner(signal: AbortSignal, registerMic: MicRegistrar, registerCamera: CameraRegistrar): HTMLDivElement {
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

  // Video device selector
  const videoHeader = createElement("h3", {}, "Video Device");
  const videoSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
  });
  const defaultVideoOpt = createElement("option", { value: "" }, "Default");
  videoSelect.appendChild(defaultVideoOpt);
  section.appendChild(videoHeader);
  section.appendChild(videoSelect);

  // Camera preview
  const previewWrap = createElement("div", {
    style: "margin-bottom:16px;border-radius:8px;overflow:hidden;background:#1e1f22;aspect-ratio:16/9;max-width:320px",
  });
  const previewVideo = document.createElement("video");
  previewVideo.autoplay = true;
  previewVideo.muted = true;
  previewVideo.playsInline = true;
  previewVideo.style.width = "100%";
  previewVideo.style.height = "100%";
  previewVideo.style.objectFit = "cover";
  previewWrap.appendChild(previewVideo);
  section.appendChild(previewWrap);

  let previewStream: MediaStream | null = null;

  // Populate devices asynchronously
  void (async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const savedInput = loadPref<string>("audioInputDevice", "");
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      const savedVideo = loadPref<string>("videoInputDevice", "");

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
        } else if (d.kind === "videoinput") {
          const opt = createElement("option", { value: d.deviceId },
            d.label || `Camera (${d.deviceId.slice(0, 8)})`);
          if (d.deviceId === savedVideo) opt.setAttribute("selected", "");
          videoSelect.appendChild(opt);
        }
      }

      // Restore saved selections
      if (savedInput) inputSelect.value = savedInput;
      if (savedOutput) outputSelect.value = savedOutput;
      if (savedVideo) videoSelect.value = savedVideo;
    } catch {
      const errOpt = createElement("option", { value: "", disabled: "" },
        "Could not enumerate devices");
      inputSelect.appendChild(errOpt);
    }
  })();

  inputSelect.addEventListener("change", () => {
    savePref("audioInputDevice", inputSelect.value);
    void switchInputDevice(inputSelect.value);
  }, { signal });

  outputSelect.addEventListener("change", () => {
    savePref("audioOutputDevice", outputSelect.value);
    void switchOutputDevice(outputSelect.value);
  }, { signal });

  videoSelect.addEventListener("change", () => {
    savePref("videoInputDevice", videoSelect.value);
    if (previewStream !== null) {
      for (const track of previewStream.getTracks()) track.stop();
      previewStream = null;
    }
    previewVideo.srcObject = null;
    const selectedDevice = videoSelect.value;
    void (async () => {
      try {
        const constraints: MediaStreamConstraints = {
          video: selectedDevice
            ? { deviceId: { exact: selectedDevice }, width: { ideal: 320 }, height: { ideal: 180 } }
            : { width: { ideal: 320 }, height: { ideal: 180 } },
          audio: false,
        };
        previewStream = await navigator.mediaDevices.getUserMedia(constraints);
        registerCamera(previewStream);
        previewVideo.srcObject = previewStream;
      } catch { /* Camera unavailable */ }
    })();
  }, { signal });

  // Start initial camera preview
  void (async () => {
    try {
      const savedDevice = loadPref<string>("videoInputDevice", "");
      const constraints: MediaStreamConstraints = {
        video: savedDevice ? { deviceId: { exact: savedDevice }, width: { ideal: 320 }, height: { ideal: 180 } } : { width: { ideal: 320 }, height: { ideal: 180 } },
        audio: false,
      };
      previewStream = await navigator.mediaDevices.getUserMedia(constraints);
      registerCamera(previewStream);
      previewVideo.srcObject = previewStream;
    } catch { /* Camera unavailable */ }
  })();

  signal.addEventListener("abort", () => {
    if (previewStream !== null) {
      for (const track of previewStream.getTracks()) track.stop();
      previewStream = null;
      registerCamera(null);
    }
    previewVideo.srcObject = null;
  });

  // ── Mic level meter + sensitivity slider ──────────────────────────
  const sensitivityHeader = createElement("h3", {}, "Input Sensitivity");
  section.appendChild(sensitivityHeader);

  // Real-time mic level bar
  const meterWrap = createElement("div", { class: "mic-meter-wrap" });
  const meterBar = createElement("div", { class: "mic-meter-bar" });
  const meterLevel = createElement("div", { class: "mic-meter-level" });
  const meterThreshold = createElement("div", { class: "mic-meter-threshold" });
  meterBar.appendChild(meterLevel);
  meterBar.appendChild(meterThreshold);
  meterWrap.appendChild(meterBar);
  section.appendChild(meterWrap);

  // Sensitivity slider
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

  // Position threshold indicator
  function updateThresholdIndicator(sensitivity: number): void {
    const threshold = sensitivityToThreshold(sensitivity);
    // Map threshold (0-0.15) to percentage position (0-100%)
    const pct = Math.min((threshold / 0.15) * 100, 100);
    meterThreshold.style.left = `${pct}%`;
  }
  updateThresholdIndicator(savedSensitivity);

  sensitivitySlider.addEventListener("input", () => {
    const val = Number(sensitivitySlider.value);
    setText(sensitivityLabel, `${val}%`);
    savePref("voiceSensitivity", val);
    setVoiceSensitivity(val);
    updateThresholdIndicator(val);
  }, { signal });
  appendChildren(sensitivityRow, sensitivitySlider, sensitivityLabel);
  section.appendChild(sensitivityRow);

  // Start mic level monitoring for visual feedback
  void (async () => {
    try {
      const savedDevice = loadPref<string>("audioInputDevice", "");
      const constraints: MediaStreamConstraints = {
        audio: savedDevice ? { deviceId: { exact: savedDevice } } : true,
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function updateMeter(): void {
        if (signal.aborted) return;
        analyser.getByteFrequencyData(dataArray);
        // Compute RMS normalized to 0-1
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] ?? 0) / 255;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        // Scale for visual: use sqrt for more visible quiet sounds
        const visual = Math.min(Math.sqrt(rms) * 2, 1);
        meterLevel.style.width = `${visual * 100}%`;

        // Color: green if above threshold, yellow/red if below
        const threshold = sensitivityToThreshold(Number(sensitivitySlider.value));
        if (rms >= threshold) {
          meterLevel.style.background = "#43b581"; // green — voice detected
        } else {
          meterLevel.style.background = "#faa61a"; // yellow — below threshold
        }

        const frame = requestAnimationFrame(updateMeter);
        registerMic(stream, audioCtx, frame);
      }
      const firstFrame = requestAnimationFrame(updateMeter);
      registerMic(stream, audioCtx, firstFrame);
    } catch {
      // Mic access denied or unavailable — meter stays empty
    }
  })();

  // ── Audio processing toggles ──────────────────────────────────────
  const audioToggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    { key: "echoCancellation", label: "Echo Cancellation", desc: "Reduce echo from speakers feeding back into microphone", fallback: true },
    { key: "noiseSuppression", label: "Noise Suppression", desc: "Filter out background noise from your microphone", fallback: true },
    { key: "autoGainControl", label: "Automatic Gain Control", desc: "Automatically adjust microphone volume", fallback: true },
    { key: "enhancedNoiseSuppression", label: "Enhanced Noise Suppression", desc: "ML-powered noise removal (RNNoise) — filters keyboard, pets, and other non-voice sounds", fallback: false },
    { key: "silenceSuppression", label: "Silence Suppression", desc: "Stop sending audio during silence to save bandwidth", fallback: true },
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
      if (item.key === "silenceSuppression") {
        // Silence suppression takes effect on next VAD tick — no device switch needed
        updateSilenceSuppressionPref();
      } else {
        // Re-acquire mic with new constraints if in an active voice session
        const currentDevice = loadPref<string>("audioInputDevice", "");
        void switchInputDevice(currentDevice);
      }
    }, { signal });

    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  return section;
}
