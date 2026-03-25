/**
 * Voice & Audio settings tab — input/output device, sensitivity, audio processing.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";
import { switchInputDevice, switchOutputDevice, setVoiceSensitivity, setInputVolume, setOutputVolume, reapplyAudioProcessing } from "@lib/livekitSession";

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
      // Stop old camera tracks before registering new stream
      if (cameraPreviewStream !== null && cameraPreviewStream !== stream) {
        for (const track of cameraPreviewStream.getTracks()) track.stop();
      }
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

  // Input Volume slider
  const inputVolumeHeader = createElement("h3", {}, "Input Volume");
  section.appendChild(inputVolumeHeader);
  const inputVolumeRow = createElement("div", { class: "slider-row" });
  const savedInputVolume = loadPref<number>("inputVolume", 100);
  const inputVolumeSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "200",
    step: "1",
    value: String(savedInputVolume),
  });
  const inputVolumeLabel = createElement("span", { class: "slider-val" }, `${savedInputVolume}%`);
  inputVolumeSlider.addEventListener("input", () => {
    const val = Number(inputVolumeSlider.value);
    setText(inputVolumeLabel, `${val}%`);
    setInputVolume(val);
  }, { signal });
  appendChildren(inputVolumeRow, inputVolumeSlider, inputVolumeLabel);
  section.appendChild(inputVolumeRow);

  // ── Mic level meter with draggable sensitivity threshold ────────
  const sensitivityHeader = createElement("h3", {}, "Input Sensitivity");
  section.appendChild(sensitivityHeader);

  // Real-time mic level bar with embedded draggable threshold handle
  const meterWrap = createElement("div", { class: "mic-meter-wrap" });
  const meterBar = createElement("div", { class: "mic-meter-bar" });
  const meterLevel = createElement("div", { class: "mic-meter-level" });
  const meterThreshold = createElement("div", { class: "mic-meter-threshold" });
  meterBar.appendChild(meterLevel);
  meterBar.appendChild(meterThreshold);
  meterWrap.appendChild(meterBar);
  section.appendChild(meterWrap);

  let currentSensitivity = loadPref<number>("voiceSensitivity", 50);

  function updateThresholdIndicator(sensitivity: number): void {
    // Invert: sensitivity 100 (no gating) → handle at LEFT (0%),
    //         sensitivity 0 (max gating) → handle at RIGHT (100%).
    // This matches Discord: drag LEFT = easier to pass, RIGHT = harder.
    meterThreshold.style.left = `${100 - sensitivity}%`;
  }
  updateThresholdIndicator(currentSensitivity);

  /** Compute sensitivity % from a mouse/touch X position relative to the meter bar. */
  function sensitivityFromPointer(clientX: number): number {
    const rect = meterBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // Invert: clicking LEFT = high sensitivity, RIGHT = low sensitivity
    return Math.round((1 - ratio) * 100);
  }

  function applySensitivity(val: number): void {
    currentSensitivity = val;
    savePref("voiceSensitivity", val);
    setVoiceSensitivity(val);
    updateThresholdIndicator(val);
  }

  // Drag the threshold handle
  meterThreshold.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    meterThreshold.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent): void => { applySensitivity(sensitivityFromPointer(ev.clientX)); };
    const onUp = (): void => {
      meterThreshold.removeEventListener("pointermove", onMove);
      meterThreshold.removeEventListener("pointerup", onUp);
    };
    meterThreshold.addEventListener("pointermove", onMove, { signal });
    meterThreshold.addEventListener("pointerup", onUp, { signal });
  }, { signal });

  // Click on the meter bar to jump the threshold
  meterBar.addEventListener("click", (e: MouseEvent) => {
    applySensitivity(sensitivityFromPointer(e.clientX));
  }, { signal });

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

  // Output Volume slider
  const outputVolumeHeader = createElement("h3", {}, "Output Volume");
  section.appendChild(outputVolumeHeader);
  const outputVolumeRow = createElement("div", { class: "slider-row" });
  const savedOutputVolume = loadPref<number>("outputVolume", 100);
  const outputVolumeSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "200",
    step: "1",
    value: String(savedOutputVolume),
  });
  const outputVolumeLabel = createElement("span", { class: "slider-val" }, `${savedOutputVolume}%`);
  outputVolumeSlider.addEventListener("input", () => {
    const val = Number(outputVolumeSlider.value);
    setText(outputVolumeLabel, `${val}%`);
    setOutputVolume(val);
  }, { signal });
  appendChildren(outputVolumeRow, outputVolumeSlider, outputVolumeLabel);
  section.appendChild(outputVolumeRow);

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

  function stopCameraPreview(): void {
    registerCamera(null);
    previewVideo.srcObject = null;
  }

  let previewErrorEl: HTMLDivElement | null = null;

  function clearPreviewError(): void {
    if (previewErrorEl !== null) {
      previewErrorEl.remove();
      previewErrorEl = null;
    }
  }

  function startCameraPreview(deviceId: string): void {
    stopCameraPreview();
    clearPreviewError();
    void (async () => {
      try {
        const constraints: MediaStreamConstraints = {
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 320 }, height: { ideal: 180 } }
            : { width: { ideal: 320 }, height: { ideal: 180 } },
          audio: false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        registerCamera(stream);
        previewVideo.srcObject = stream;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Camera unavailable";
        previewErrorEl = createElement("div", { class: "setting-desc" }, msg) as HTMLDivElement;
        previewWrap.appendChild(previewErrorEl);
      }
    })();
  }

  videoSelect.addEventListener("change", () => {
    savePref("videoInputDevice", videoSelect.value);
    startCameraPreview(videoSelect.value);
  }, { signal });

  // Start initial camera preview only if a device has been explicitly selected
  const savedVideoDevice = loadPref<string>("videoInputDevice", "");
  if (savedVideoDevice !== "") {
    startCameraPreview(savedVideoDevice);
  }

  signal.addEventListener("abort", () => {
    stopCameraPreview();
  });

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

      let latestFrame = 0;
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
        const threshold = ((100 - currentSensitivity) / 100) * 0.15;
        if (rms >= threshold) {
          meterLevel.style.background = "#43b581"; // green — voice detected
        } else {
          meterLevel.style.background = "#faa61a"; // yellow — below threshold
        }

        latestFrame = requestAnimationFrame(updateMeter);
        registerMic(stream, audioCtx, latestFrame);
      }
      latestFrame = requestAnimationFrame(updateMeter);
      registerMic(stream, audioCtx, latestFrame);
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
  ];

  for (const item of audioToggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      onChange: (nowOn) => {
        savePref(item.key, nowOn);
        // Reapply audio processing constraints to the live mic track
        void reapplyAudioProcessing();
      },
    });

    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  return section;
}
