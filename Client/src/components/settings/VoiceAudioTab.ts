/**
 * Voice & Audio settings tab — input/output device, sensitivity, audio processing.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";
import { createLogger } from "@lib/logger";
import {
  switchInputDevice,
  switchOutputDevice,
  setVoiceSensitivity,
  setInputVolume,
  setOutputVolume,
  reapplyAudioProcessing,
  reapplyEnhancedNoiseSuppression,
} from "@lib/livekitSession";
import {
  VAD_MAX_THRESHOLD,
  micCaptureOptions,
  isMissingDeviceError,
  startVadDetector,
  vadThreshold,
} from "@lib/audioPipeline";
import { createMicProcessor, type MicProcessor } from "@lib/micProcessor";
import { Track, type AudioProcessorOptions } from "livekit-client";
import {
  nativeAudioDevices,
  nativeCameraDevices,
  nativeCameraSupport,
} from "../../features/voice/native/devices";
import { isLinuxDesktop } from "../../features/voice/native/platform";
import { desktop } from "../../platform/desktop";
import { NativeVideoRenderer } from "../../features/voice/native/videoRenderer";
import { settingsText as t } from "../../i18n/settings";
import { setStatusIcon, statusIcon } from "../../features/settings/status";

const log = createLogger("VoiceAudioTab");

/** Meter RMS above which the mic status pill counts the mic as picking you up. */
const MIC_NOISE_FLOOR = 0.005;
/** How long the pill keeps saying "Hearing you" after the last frame above the floor. */
const MIC_HEARD_HOLD_MS = 1000;

export interface VoiceAudioTabHandle {
  /**
   * Build the pane's DOM. `signal` scopes this build's own element
   * listeners — pass a per-render signal (aborted just before the next
   * build) so a discarded pane's listeners don't outlive it. Defaults to
   * the factory's overlay-lifetime signal when omitted, matching this
   * tab's original single-signal behavior.
   */
  build(signal?: AbortSignal): HTMLDivElement;
  cleanup(): void;
}

export function createVoiceAudioTab(signal: AbortSignal): VoiceAudioTabHandle {
  let stopMeter: (() => void) | null = null;
  let cameraPreviewStream: MediaStream | null = null;
  let invalidateCameraPreviewRequest: (() => void) | null = null;
  let stopNativePreview: (() => void) | null = null;

  function stopMic(): void {
    stopMeter?.();
    stopMeter = null;
  }

  function cleanupMic(): void {
    stopMic();
    invalidateCameraPreviewRequest?.();
    // Also stop camera preview
    if (cameraPreviewStream !== null) {
      for (const track of cameraPreviewStream.getTracks()) track.stop();
      cameraPreviewStream = null;
    }
    // The native (Linux) preview releases the host capture and its socket.
    stopNativePreview?.();
    stopNativePreview = null;
  }

  function build(buildSignal: AbortSignal = signal): HTMLDivElement {
    // Clean up any previous mic/camera stream before rebuilding
    cleanupMic();
    return buildVoiceAudioTabInner(
      buildSignal,
      (stop) => {
        stopMeter = stop;
      },
      stopMic,
      (stream) => {
        // Stop old camera tracks before registering new stream
        if (cameraPreviewStream !== null && cameraPreviewStream !== stream) {
          for (const track of cameraPreviewStream.getTracks()) track.stop();
        }
        cameraPreviewStream = stream;
      },
      (invalidate) => {
        invalidateCameraPreviewRequest = invalidate;
      },
      (stop) => {
        stopNativePreview = stop;
      },
    );
  }

  function cleanup(): void {
    cleanupMic();
  }

  // Also clean up on overlay close
  signal.addEventListener("abort", cleanupMic);

  return { build, cleanup };
}

type MicRegistrar = (stop: () => void) => void;
type CameraRegistrar = (stream: MediaStream | null) => void;
type CameraInvalidationRegistrar = (invalidate: () => void) => void;
type NativePreviewRegistrar = (stop: () => void) => void;

function buildVoiceAudioTabInner(
  signal: AbortSignal,
  registerMic: MicRegistrar,
  stopMic: () => void,
  registerCamera: CameraRegistrar,
  registerCameraInvalidation: CameraInvalidationRegistrar,
  registerNativePreview: NativePreviewRegistrar,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  // Linux voice runs in the native audio engine (docs/architecture/voice-e2ee.md):
  // its capture path exposes no gain or level hook, so the input volume and
  // sensitivity controls below would be dead there. They are built as usual and
  // removed at the end, with one note in their place; the prefs keep being
  // written so another platform's profile is untouched. Output volume works:
  // the engine's playout mixer applies it with each user's volume.
  const nativeAudio = isLinuxDesktop();

  // Four cards: what you speak into, what you hear, what you show, and how
  // your voice is processed.
  const card = (title: string): HTMLElement => {
    const el = createElement("section", { class: "settings-card" });
    const head = createElement("div", { class: "settings-card-head" });
    head.appendChild(createElement("h3", {}, title));
    el.appendChild(head);
    section.appendChild(el);
    return el;
  };
  const micCard = card(t("voiceAudio.card.microphone"));
  const speakersCard = card(t("voiceAudio.card.speakers"));
  const cameraCard = card(t("voiceAudio.card.camera"));
  const processingCard = card(t("voiceAudio.card.processing"));

  // The microphone's state at a glance, from the live meter below.
  const micStatus = createElement("span", { class: "status-pill", "data-testid": "mic-status" });
  const micStatusIcon = statusIcon("pending");
  const micStatusWord = createElement("span", {});
  micStatus.append(micStatusIcon, micStatusWord);
  micStatus.hidden = true;
  micCard.querySelector(".settings-card-head")!.appendChild(micStatus);
  let micHeard: boolean | null = null;
  function showMicState(heard: boolean): void {
    if (heard === micHeard) return;
    micHeard = heard;
    micStatus.hidden = false;
    setStatusIcon(micStatusIcon, heard ? "ok" : "pending");
    setText(micStatusWord, heard ? t("voiceAudio.mic.hearing") : t("voiceAudio.mic.noInput"));
  }

  // Input device selector
  const inputHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.inputDevice"),
  );
  const inputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.inputDevice"),
  });
  const defaultInputOpt = createElement("option", { value: "" }, t("voiceAudio.default"));
  inputSelect.appendChild(defaultInputOpt);
  micCard.appendChild(inputHeader);
  micCard.appendChild(inputSelect);

  // Input Volume slider
  const inputVolumeHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.inputVolume"),
  );
  micCard.appendChild(inputVolumeHeader);
  const inputVolumeRow = createElement("div", { class: "slider-row" });
  const savedInputVolume = loadPref<number>("inputVolume", 100);
  const inputVolumeSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "200",
    step: "1",
    value: String(savedInputVolume),
    "aria-label": t("voiceAudio.inputVolume"),
  });
  const inputVolumeLabel = createElement("span", { class: "slider-val" }, `${savedInputVolume}%`);
  inputVolumeSlider.addEventListener(
    "input",
    () => {
      const val = Number(inputVolumeSlider.value);
      setText(inputVolumeLabel, `${val}%`);
      setInputVolume(val);
    },
    { signal },
  );
  appendChildren(inputVolumeRow, inputVolumeSlider, inputVolumeLabel);
  micCard.appendChild(inputVolumeRow);

  // ── Mic level meter with draggable sensitivity threshold ────────
  const sensitivityHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.inputSensitivity"),
  );
  micCard.appendChild(sensitivityHeader);

  // Real-time mic level bar with embedded draggable threshold handle
  const meterWrap = createElement("div", { class: "mic-meter-wrap" });
  const meterBar = createElement("div", { class: "mic-meter-bar" });
  const meterLevel = createElement("div", { class: "mic-meter-level" });
  // A range, not a pointer-only div: the threshold is adjustable by keyboard
  // as well as drag (Q1 — every action reachable, no pointer-only control).
  const meterThreshold = createElement("div", {
    class: "mic-meter-threshold",
    role: "slider",
    tabindex: "0",
    "aria-label": t("voiceAudio.inputSensitivity"),
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  });
  meterBar.appendChild(meterLevel);
  meterBar.appendChild(meterThreshold);
  // The value in words beside the meter, not only as the handle's position.
  const sensitivityValue = createElement("span", {
    class: "slider-val",
    "data-testid": "sensitivity-value",
  });
  meterWrap.append(meterBar, sensitivityValue);
  micCard.appendChild(meterWrap);

  let currentSensitivity = loadPref<number>("voiceSensitivity", 50);

  function updateThresholdIndicator(sensitivity: number): void {
    // Invert: sensitivity 100 (no gating) → handle at LEFT (0%),
    //         sensitivity 0 (max gating) → handle at RIGHT (100%).
    // This matches Discord: drag LEFT = easier to pass, RIGHT = harder.
    meterThreshold.style.left = `${100 - sensitivity}%`;
    meterThreshold.setAttribute("aria-valuenow", String(100 - sensitivity));
    meterThreshold.setAttribute(
      "aria-valuetext",
      t("voiceAudio.sensitivityValue", { value: sensitivity }),
    );
    setText(sensitivityValue, `${sensitivity}%`);
  }
  updateThresholdIndicator(currentSensitivity);

  /** Compute sensitivity % from a mouse/touch X position relative to the meter bar. */
  function sensitivityFromPointer(clientX: number): number {
    const rect = meterBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // Invert: clicking LEFT = high sensitivity, RIGHT = low sensitivity
    return Math.round((1 - ratio) * 100);
  }

  /** The meter's detector, so a dragged threshold applies to it at once. */
  let meterThresholdSetter: ((threshold: number) => void) | null = null;
  /** The meter's processor, so the Enhanced NS toggle re-routes it at once. */
  let meterProcessor: MicProcessor | null = null;

  function previewSensitivity(val: number): void {
    currentSensitivity = val;
    updateThresholdIndicator(val);
    meterThresholdSetter?.(vadThreshold(val));
  }

  function commitSensitivity(): void {
    savePref("voiceSensitivity", currentSensitivity);
    setVoiceSensitivity(currentSensitivity);
  }

  function applySensitivity(val: number): void {
    previewSensitivity(val);
    commitSensitivity();
  }

  function onMove(ev: PointerEvent): void {
    previewSensitivity(sensitivityFromPointer(ev.clientX));
  }

  // Drag the threshold handle
  meterThreshold.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      e.preventDefault();
      meterThreshold.setPointerCapture(e.pointerId);
      const onUp = (): void => {
        meterThreshold.removeEventListener("pointermove", onMove);
        meterThreshold.removeEventListener("pointerup", onUp);
        meterThreshold.removeEventListener("pointercancel", onUp);
        commitSensitivity();
      };
      meterThreshold.addEventListener("pointermove", onMove, { signal });
      meterThreshold.addEventListener("pointerup", onUp, { signal });
      // A touch/pen drag that the OS claims as a pan (or any other
      // mid-drag pointer loss) fires pointercancel instead of pointerup.
      // Without this, onMove stays attached for the tab's lifetime and
      // every later hover over the handle silently rewrites and persists
      // voiceSensitivity with no button held (v097).
      meterThreshold.addEventListener("pointercancel", onUp, { signal });
    },
    { signal },
  );

  // Click on the meter bar to jump the threshold
  meterBar.addEventListener(
    "click",
    (e: MouseEvent) => {
      applySensitivity(sensitivityFromPointer(e.clientX));
    },
    { signal },
  );

  // Keyboard: standard slider semantics over the gate threshold the handle
  // shows (aria-valuenow = 100 - sensitivity), so ArrowRight/End move the
  // handle right exactly as a drag does; aria-valuetext announces the
  // sensitivity itself.
  meterThreshold.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const threshold = 100 - currentSensitivity;
      let next: number;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = 100;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = threshold - 5;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = threshold + 5;
      else return;
      e.preventDefault();
      applySensitivity(100 - Math.max(0, Math.min(100, next)));
    },
    { signal },
  );

  // Output device selector
  const outputHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.outputDevice"),
  );
  const outputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.outputDevice"),
  });
  const defaultOutputOpt = createElement("option", { value: "" }, t("voiceAudio.default"));
  outputSelect.appendChild(defaultOutputOpt);
  speakersCard.appendChild(outputHeader);
  speakersCard.appendChild(outputSelect);

  // Output Volume slider
  const outputVolumeHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.outputVolume"),
  );
  speakersCard.appendChild(outputVolumeHeader);
  const outputVolumeRow = createElement("div", { class: "slider-row" });
  const savedOutputVolume = loadPref<number>("outputVolume", 100);
  const outputVolumeSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "200",
    step: "1",
    value: String(savedOutputVolume),
    "aria-label": t("voiceAudio.outputVolume"),
  });
  const outputVolumeLabel = createElement("span", { class: "slider-val" }, `${savedOutputVolume}%`);
  outputVolumeSlider.addEventListener(
    "input",
    () => {
      const val = Number(outputVolumeSlider.value);
      setText(outputVolumeLabel, `${val}%`);
      setOutputVolume(val);
    },
    { signal },
  );
  appendChildren(outputVolumeRow, outputVolumeSlider, outputVolumeLabel);
  speakersCard.appendChild(outputVolumeRow);

  // Stream quality selector
  const qualityHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.streamQuality"),
  );
  const qualityDesc = createElement(
    "p",
    { class: "setting-desc" },
    t("voiceAudio.streamQualityDesc"),
  );
  const qualitySelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:16px",
    "aria-label": t("voiceAudio.streamQuality"),
  });
  const qualityOptions: Array<[string, string]> = [
    ["low", t("voiceAudio.quality.low")],
    ["medium", t("voiceAudio.quality.medium")],
    ["high", t("voiceAudio.quality.high")],
    ["source", t("voiceAudio.quality.source")],
  ];
  const savedQuality = loadPref<string>("streamQuality", "high");
  for (const [value, label] of qualityOptions) {
    const opt = createElement("option", { value }, label);
    if (value === savedQuality) opt.setAttribute("selected", "");
    qualitySelect.appendChild(opt);
  }
  qualitySelect.value = savedQuality;
  qualitySelect.addEventListener(
    "change",
    () => {
      savePref("streamQuality", qualitySelect.value);
    },
    { signal },
  );
  const qualityGroup = [qualityHeader, qualityDesc, qualitySelect];

  // Screen share FPS selector
  const fpsHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.screenFps"),
  );
  const fpsDesc = createElement("p", { class: "setting-desc" }, t("voiceAudio.screenFpsDesc"));
  const fpsSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:16px",
    "aria-label": t("voiceAudio.screenFps"),
  });
  const fpsOptions: Array<[number, string]> = [
    [30, t("voiceAudio.fps.30")],
    [60, t("voiceAudio.fps.60")],
    [120, t("voiceAudio.fps.120")],
  ];
  const savedFpsRaw = loadPref<number>("screenShareFps", 30);
  const savedFps = savedFpsRaw === 60 || savedFpsRaw === 120 ? savedFpsRaw : 30;
  for (const [value, label] of fpsOptions) {
    const opt = createElement("option", { value: String(value) }, label);
    if (value === savedFps) opt.setAttribute("selected", "");
    fpsSelect.appendChild(opt);
  }
  fpsSelect.value = String(savedFps);
  fpsSelect.addEventListener(
    "change",
    () => {
      savePref("screenShareFps", Number(fpsSelect.value));
    },
    { signal },
  );
  const fpsGroup = [fpsHeader, fpsDesc, fpsSelect];

  // Video device selector
  const videoHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.videoDevice"),
  );
  const videoSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.videoDevice"),
  });
  const defaultVideoOpt = createElement("option", { value: "" }, t("voiceAudio.default"));
  videoSelect.appendChild(defaultVideoOpt);
  cameraCard.append(videoHeader, videoSelect);

  // Camera preview
  const previewWrap = createElement("div", { class: "camera-preview" });
  // Said in words, so an empty box is not a mystery.
  const previewLabel = createElement(
    "div",
    { class: "camera-preview-label" },
    t("voiceAudio.previewOff"),
  );
  const previewVideo = document.createElement("video");
  previewVideo.autoplay = true;
  previewVideo.muted = true;
  previewVideo.playsInline = true;
  previewWrap.append(previewVideo, previewLabel);
  cameraCard.appendChild(previewWrap);
  cameraCard.append(...qualityGroup, ...fpsGroup);

  // Device names seen while this tab is open, to name one that is unplugged.
  const deviceLabels = new Map<string, string>();
  /**
   * (Re)fill the three device dropdowns from the current device list.
   *
   * Called on build and again on every `devicechange`, so unplugging a headset
   * with the panel open removes it from the list instead of leaving a dead
   * entry the user can select. A saved microphone or speaker that has vanished
   * stays the selection as a disabled "(disconnected)" entry: the voice
   * session keeps it too and switches back to it when it returns (DP-31). A
   * vanished camera reads as "Default".
   */
  async function populateDevices(): Promise<void> {
    const selects: Array<[HTMLSelectElement, MediaDeviceKind, string, string]> = [
      [inputSelect, "audioinput", "audioInputDevice", t("voiceAudio.kind.microphone")],
      [outputSelect, "audiooutput", "audioOutputDevice", t("voiceAudio.kind.speaker")],
      [videoSelect, "videoinput", "videoInputDevice", t("voiceAudio.kind.camera")],
    ];
    try {
      // On Linux the audio and camera lists come from the native backend (the
      // ids the session can actually select); elsewhere cameras are the
      // webview's, enumerated with the audio devices.
      const [nativeInputs, nativeOutputs, nativeCameras, all] = await Promise.all([
        nativeAudioDevices("audioinput"),
        nativeAudioDevices("audiooutput"),
        nativeCameraDevices(),
        navigator.mediaDevices.enumerateDevices(),
      ]);
      const devices =
        nativeInputs === null || nativeOutputs === null
          ? all
          : [
              ...nativeInputs,
              ...nativeOutputs,
              ...(nativeCameras ?? all.filter((d) => d.kind === "videoinput")),
            ];
      if (signal.aborted) return;

      for (const [select, kind, prefKey, label] of selects) {
        const saved = loadPref<string>(prefKey, "");
        // Keep the leading "Default" option, replace the rest.
        while (select.options.length > 1) select.remove(1);
        let savedStillPresent = false;
        for (const d of devices) {
          if (d.kind !== kind) continue;
          if (d.deviceId === saved) savedStillPresent = true;
          const name = d.label || `${label} (${d.deviceId.slice(0, 8)})`;
          deviceLabels.set(d.deviceId, name);
          select.appendChild(createElement("option", { value: d.deviceId }, name));
        }
        const keepSaved = savedStillPresent || kind !== "videoinput";
        if (saved !== "" && !savedStillPresent && keepSaved) {
          const device = deviceLabels.get(saved) ?? `${label} (${saved.slice(0, 8)})`;
          select.appendChild(
            createElement(
              "option",
              { value: saved, disabled: "" },
              t("voiceAudio.deviceDisconnected", { device }),
            ),
          );
        }
        select.value = keepSaved ? saved : "";
      }
    } catch {
      const errOpt = createElement(
        "option",
        { value: "", disabled: "" },
        t("voiceAudio.enumerateFailed"),
      );
      inputSelect.appendChild(errOpt);
    }
  }

  void populateDevices();

  // MediaDevices is an EventTarget everywhere this ships, but a webview that
  // exposes enumerateDevices without the event target shouldn't take the tab
  // down with it — it just loses live refresh.
  if (typeof navigator.mediaDevices?.addEventListener === "function") {
    navigator.mediaDevices.addEventListener(
      "devicechange",
      () => {
        void populateDevices();
      },
      { signal },
    );
  }

  inputSelect.addEventListener(
    "change",
    () => {
      savePref("audioInputDevice", inputSelect.value);
      restartMeterAfter(switchInputDevice(inputSelect.value));
    },
    { signal },
  );

  outputSelect.addEventListener(
    "change",
    () => {
      savePref("audioOutputDevice", outputSelect.value);
      void switchOutputDevice(outputSelect.value);
    },
    { signal },
  );

  // Race guard: prevent stale getUserMedia results from overwriting a newer
  // request. cleanupMic() invalidates both counters, so a stream resolving
  // after teardown is stopped instead of re-arming state nobody cleans up.
  let cameraRequestId = 0;
  let micRequestId = 0;
  registerCameraInvalidation(() => {
    cameraRequestId += 1;
    micRequestId += 1;
    // Detach the preview too: Chrome keeps a detached media element that
    // still has a source among its pending activities, and it holds the whole
    // torn-down pane alive with it. Stopping the tracks does not release it.
    previewVideo.srcObject = null;
  });

  function stopCameraPreview(): void {
    cameraRequestId += 1;
    registerCamera(null);
    previewVideo.srcObject = null;
    setText(previewLabel, t("voiceAudio.previewOff"));
    previewLabel.hidden = false;
  }

  function startCameraPreview(deviceId: string): void {
    stopCameraPreview();
    const thisRequest = ++cameraRequestId;
    void (async () => {
      try {
        const constraints: MediaStreamConstraints = {
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 320 }, height: { ideal: 180 } }
            : { width: { ideal: 320 }, height: { ideal: 180 } },
          audio: false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        // Race guard: if a newer request was issued while we awaited, discard this result
        if (signal.aborted || thisRequest !== cameraRequestId) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        registerCamera(stream);
        previewVideo.srcObject = stream;
        previewLabel.hidden = true;
      } catch (err) {
        if (signal.aborted || thisRequest !== cameraRequestId) return;
        const msg =
          err instanceof Error && err.message ? err.message : t("voiceAudio.cameraUnavailable");
        setText(previewLabel, msg);
      }
    })();
  }

  videoSelect.addEventListener(
    "change",
    () => {
      savePref("videoInputDevice", videoSelect.value);
      stopCameraPreview();
      stopNativeCameraPreview();
      if (isLinuxDesktop()) void startNativeCameraPreview(videoSelect.value);
      else startCameraPreview(videoSelect.value);
    },
    { signal },
  );

  // Start the camera preview on the saved device, or on the default when
  // none was explicitly chosen: an unexplained empty 16:9 box reads as broken
  // (voice #22). The default device is only previewed when a camera exists.
  // Linux previews through the native backend (the native camera list); its
  // preview renderer is registered so teardown releases the host capture.
  const savedVideoDevice = loadPref<string>("videoInputDevice", "");
  let activeNativePreview: (() => void) | null = null;
  void (async () => {
    const device = savedVideoDevice;
    if (isLinuxDesktop()) {
      try {
        // GStreamer may be missing entirely: no capture can start, so explain why
        // instead of leaving the preview box empty or showing a generic error.
        const support = await nativeCameraSupport();
        if (signal.aborted) return;
        if (support !== null && !support.available) {
          setText(previewLabel, t("voiceAudio.gstreamerMissing"));
          previewLabel.hidden = false;
          return;
        }
        const cameras = await nativeCameraDevices();
        if (signal.aborted) return;
        if (cameras !== null && cameras.length === 0) {
          setText(previewLabel, t("voiceAudio.noCamera"));
          previewLabel.hidden = false;
          return;
        }
        await startNativeCameraPreview(device);
      } catch {
        // A failed support/device query must still explain itself, not leave
        // the preview box in its default empty state.
        if (signal.aborted) return;
        setText(previewLabel, t("voiceAudio.cameraUnavailable"));
        previewLabel.hidden = false;
      }
      return;
    }
    if (device === "" && navigator.mediaDevices?.enumerateDevices !== undefined) {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!devices.some((d) => d.kind === "videoinput")) {
        setText(previewLabel, t("voiceAudio.noCamera"));
        return;
      }
    }
    startCameraPreview(device);
  })();

  /** The Linux settings preview: capture natively (works while the window is
   *  hidden and exposes the same device ids the call will select) and draw the
   *  frame socket's `/camera` route onto the preview canvas. */
  async function startNativeCameraPreview(deviceId: string): Promise<void> {
    stopNativeCameraPreview();
    const thisRequest = ++cameraRequestId;
    try {
      const started = await desktop.nativeVoice.startCameraPreview(deviceId, {
        fps: 15,
        maxWidth: 320,
        maxHeight: 180,
      });
      if (signal.aborted) {
        // The tab was torn down while this start was in flight; cleanupMic
        // found no registered preview to release, so release this capture
        // here. The backend has no newer start to protect.
        void desktop.nativeVoice.stopCameraPreview().catch(() => {});
        return;
      }
      if (thisRequest !== cameraRequestId) {
        // A newer request owns the single native preview slot: it has already
        // replaced this capture, so this request disowns it and reclaims
        // nothing (stopping here would release the newer preview's capture).
        return;
      }
      const renderer = new NativeVideoRenderer(`${started.frames}/camera`);
      const stream = new MediaStream([renderer.mediaStreamTrack]);
      registerCamera(stream);
      previewVideo.srcObject = stream;
      previewLabel.hidden = true;
      const stop = (): void => {
        renderer.dispose();
        void desktop.nativeVoice.stopCameraPreview().catch(() => {});
      };
      activeNativePreview = stop;
      registerNativePreview(stop);
    } catch (err) {
      if (signal.aborted || thisRequest !== cameraRequestId) return;
      // This request is still the current one and owns the single native
      // preview slot: a failed start may have left a superseded request's
      // capture running there with no renderer, so release it now.
      if (activeNativePreview === null)
        void desktop.nativeVoice.stopCameraPreview().catch(() => {});
      const msg =
        err instanceof Error && err.message ? err.message : t("voiceAudio.cameraUnavailable");
      setText(previewLabel, msg);
    }
  }

  function stopNativeCameraPreview(): void {
    if (activeNativePreview === null) return;
    activeNativePreview();
    activeNativePreview = null;
    registerNativePreview(() => {});
    previewVideo.srcObject = null;
  }

  // Camera teardown on overlay close is already covered by the factory's
  // single signal.addEventListener("abort", cleanupMic), registered once
  // against the overlay-lifetime signal in createVoiceAudioTab — registering
  // another "abort" handler here too would add one more listener every time
  // the tab is rebuilt, since this function runs again on every build.

  // Mic level meter. It runs the call's own microphone processor
  // (lib/micProcessor.ts: RNNoise when Enhanced Noise Suppression is on) over
  // a microphone opened with the call's capture settings, and the call's own
  // detector (lib/audioPipeline.ts startVadDetector, same attack and hold)
  // at the same threshold. The bar is the loudest 128-sample block the
  // detector saw, on the threshold handle's axis; green is the gate open. So
  // what the meter shows is what the gate does. Opening the microphone with
  // other settings would also fight the call for the device: the browser can
  // hand the call this stream's processing instead of its own.
  // The meter previews the webview's microphone; on the native engine the
  // saved device id is the engine's, and the meter is hidden anyway.
  function startMicMeter(): void {
    if (nativeAudio || signal.aborted) return;
    const thisRequest = ++micRequestId;
    stopMic();
    void (async () => {
      try {
        const captureOptions = micCaptureOptions();
        const stream = await navigator.mediaDevices
          .getUserMedia({ audio: captureOptions, video: false })
          .catch((err: unknown) => {
            if (!isMissingDeviceError(err, captureOptions)) throw err;
            return navigator.mediaDevices.getUserMedia({
              audio: micCaptureOptions(true),
              video: false,
            });
          });
        const stopStream = (): void => {
          for (const track of stream.getTracks()) track.stop();
        };
        // Race guard: teardown (cleanup or abort) or a newer request may have
        // run while we awaited — opening the mic now would leave it hot with
        // nobody left to stop it, and registerMic would re-arm state
        // cleanupMic() already cleared.
        if (signal.aborted || thisRequest !== micRequestId) {
          stopStream();
          return;
        }
        const processor = createMicProcessor();
        const options = { kind: Track.Kind.Audio, track: stream.getAudioTracks()[0]! };
        await processor.init(options as AudioProcessorOptions);
        meterProcessor = processor;
        await processor.setEnhanced(loadPref<boolean>("enhancedNoiseSuppression", false));
        if (signal.aborted || thisRequest !== micRequestId) {
          if (meterProcessor === processor) meterProcessor = null;
          void processor.destroy();
          stopStream();
          return;
        }

        // The detector starts open, as the live gate does.
        let gateOpen = true;
        let level = 0;
        let lastHeardAt = Number.NEGATIVE_INFINITY;
        const paint = (): void => {
          // Same axis as the handle, whose position is threshold / max.
          const position = Math.min(level / VAD_MAX_THRESHOLD, 1);
          meterLevel.style.width = `${Math.round(position * 1000) / 10}%`;
          meterLevel.style.background = gateOpen ? "var(--green)" : "var(--yellow)";
          // The pill says whether the mic picks anything up, whatever the
          // sensitivity, and holds between syllables so it does not flicker.
          const now = performance.now();
          if (level >= MIC_NOISE_FLOOR) lastHeardAt = now;
          showMicState(now - lastHeardAt < MIC_HEARD_HOLD_MS);
        };
        const detector = startVadDetector(
          processor.context,
          processor.analyser!,
          vadThreshold(currentSensitivity),
          {
            onGate: (gated) => {
              gateOpen = !gated;
              paint();
            },
            onRms: (rms) => {
              level = rms;
              paint();
            },
          },
        );
        meterThresholdSetter = detector.setThreshold;
        registerMic(() => {
          if (meterThresholdSetter === detector.setThreshold) meterThresholdSetter = null;
          if (meterProcessor === processor) meterProcessor = null;
          void detector.stop().then(() => processor.destroy());
          stopStream();
        });
      } catch (err) {
        if (signal.aborted || thisRequest !== micRequestId) return;
        log.warn("Mic access denied or unavailable — meter stays empty", err);
        micStatus.hidden = false;
        setStatusIcon(micStatusIcon, "warn");
        setText(micStatusWord, t("voiceAudio.mic.noAccess"));
      }
    })();
  }
  startMicMeter();

  /**
   * Release the meter's microphone while the call re-opens its own, then
   * meter again. The browser resolves a capture request against the streams
   * already open on the device, so a meter still holding the old settings
   * can hand them to the call's restart (and the reverse).
   */
  function restartMeterAfter(callRestart: Promise<void>): void {
    // Invalidate a meter request still in flight, then release the meter.
    micRequestId++;
    stopMic();
    void callRestart.then(startMicMeter, startMicMeter);
  }

  // ── Audio processing toggles ──────────────────────────────────────
  const audioToggles: ReadonlyArray<{
    key: string;
    label: string;
    desc: string;
    fallback: boolean;
  }> = [
    {
      key: "echoCancellation",
      label: t("voiceAudio.echo.label"),
      desc: t("voiceAudio.echo.desc"),
      fallback: true,
    },
    {
      key: "noiseSuppression",
      label: t("voiceAudio.noise.label"),
      desc: t("voiceAudio.noise.desc"),
      fallback: true,
    },
    {
      key: "enhancedNoiseSuppression",
      label: t("voiceAudio.enhanced.label"),
      desc: t("voiceAudio.enhanced.desc"),
      fallback: false,
    },
    {
      key: "autoGainControl",
      label: t("voiceAudio.agc.label"),
      desc: t("voiceAudio.agc.desc"),
      fallback: true,
    },
  ];

  for (const item of audioToggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    // The native engine reads these at connect, not live.
    const descText = nativeAudio ? t("voiceAudio.applyNextJoin", { desc: item.desc }) : item.desc;
    const desc = createElement("div", { class: "setting-desc" }, descText);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      label: item.label,
      onChange: (nowOn) => {
        savePref(item.key, nowOn);
        if (item.key === "enhancedNoiseSuppression") {
          // RNNoise sits inside the processors: re-route the call's and the
          // meter's, and leave both captures alone.
          void reapplyEnhancedNoiseSuppression();
          void meterProcessor?.setEnhanced(nowOn);
          return;
        }
        // Reapply audio processing constraints to the live mic track, then to
        // the meter's, so it keeps measuring what the call captures.
        restartMeterAfter(reapplyAudioProcessing());
      },
    });

    appendChildren(row, info, toggle);
    // Enhanced noise suppression builds on noise suppression: nest it.
    if (item.key === "enhancedNoiseSuppression") row.classList.add("nested");
    processingCard.appendChild(row);
  }

  if (nativeAudio) {
    for (const control of [inputVolumeHeader, inputVolumeRow, sensitivityHeader, meterWrap])
      control.remove();
    const note = createElement(
      "p",
      { class: "setting-desc", "data-testid": "native-audio-note" },
      t("voiceAudio.nativeNote"),
    );
    inputSelect.after(note);
  }

  return section;
}
