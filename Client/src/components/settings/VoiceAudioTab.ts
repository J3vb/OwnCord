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
} from "@lib/livekitSession";
import { nativeAudioDevices } from "../../features/voice/native/devices";
import { isLinuxDesktop } from "../../features/voice/native/platform";
import { settingsText as t } from "../../i18n/settings";

const log = createLogger("VoiceAudioTab");

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
  let micStream: MediaStream | null = null;
  let micAudioCtx: AudioContext | null = null;
  let micAnimFrame: number | null = null;
  let cameraPreviewStream: MediaStream | null = null;
  let invalidateCameraPreviewRequest: (() => void) | null = null;

  function cleanupMic(): void {
    if (micAnimFrame !== null) {
      cancelAnimationFrame(micAnimFrame);
      micAnimFrame = null;
    }
    invalidateCameraPreviewRequest?.();
    if (micStream !== null) {
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
    if (micAudioCtx !== null) {
      void micAudioCtx.close();
      micAudioCtx = null;
    }
    // Also stop camera preview
    if (cameraPreviewStream !== null) {
      for (const track of cameraPreviewStream.getTracks()) track.stop();
      cameraPreviewStream = null;
    }
  }

  function build(buildSignal: AbortSignal = signal): HTMLDivElement {
    // Clean up any previous mic/camera stream before rebuilding
    cleanupMic();
    return buildVoiceAudioTabInner(
      buildSignal,
      (stream, ctx, frame) => {
        micStream = stream;
        micAudioCtx = ctx;
        micAnimFrame = frame;
      },
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
    );
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
type CameraInvalidationRegistrar = (invalidate: () => void) => void;

function buildVoiceAudioTabInner(
  signal: AbortSignal,
  registerMic: MicRegistrar,
  registerCamera: CameraRegistrar,
  registerCameraInvalidation: CameraInvalidationRegistrar,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  // Linux voice runs in the native audio engine (docs/architecture/voice-e2ee.md):
  // its capture path exposes no gain or level hook, so the input volume and
  // sensitivity controls below would be dead there. They are built as usual and
  // removed at the end, with one note in their place; the prefs keep being
  // written so another platform's profile is untouched. Output volume works:
  // the engine's playout mixer applies it with each user's volume.
  const nativeAudio = isLinuxDesktop();

  // Input device selector
  const inputHeader = createElement("h3", {}, t("voiceAudio.inputDevice"));
  const inputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.inputDevice"),
  });
  const defaultInputOpt = createElement("option", { value: "" }, t("voiceAudio.default"));
  inputSelect.appendChild(defaultInputOpt);
  section.appendChild(inputHeader);
  section.appendChild(inputSelect);

  // Input Volume slider
  const inputVolumeHeader = createElement("h3", {}, t("voiceAudio.inputVolume"));
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
  section.appendChild(inputVolumeRow);

  // ── Mic level meter with draggable sensitivity threshold ────────
  const sensitivityHeader = createElement("h3", {}, t("voiceAudio.inputSensitivity"));
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
  meterThreshold.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      e.preventDefault();
      meterThreshold.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent): void => {
        applySensitivity(sensitivityFromPointer(ev.clientX));
      };
      const onUp = (): void => {
        meterThreshold.removeEventListener("pointermove", onMove);
        meterThreshold.removeEventListener("pointerup", onUp);
        meterThreshold.removeEventListener("pointercancel", onUp);
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

  // Output device selector
  const outputHeader = createElement("h3", {}, t("voiceAudio.outputDevice"));
  const outputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.outputDevice"),
  });
  const defaultOutputOpt = createElement("option", { value: "" }, t("voiceAudio.default"));
  outputSelect.appendChild(defaultOutputOpt);
  section.appendChild(outputHeader);
  section.appendChild(outputSelect);

  // Output Volume slider
  const outputVolumeHeader = createElement("h3", {}, t("voiceAudio.outputVolume"));
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
  section.appendChild(outputVolumeRow);

  // Stream quality selector
  const qualityHeader = createElement("h3", {}, t("voiceAudio.streamQuality"));
  const qualityDesc = createElement(
    "p",
    {
      style: "color:var(--text-muted);font-size:12px;margin:0 0 8px",
    },
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
  section.appendChild(qualityHeader);
  section.appendChild(qualityDesc);
  section.appendChild(qualitySelect);

  // Screen share FPS selector
  const fpsHeader = createElement("h3", {}, t("voiceAudio.screenFps"));
  const fpsDesc = createElement(
    "p",
    {
      style: "color:var(--text-muted);font-size:12px;margin:0 0 8px",
    },
    t("voiceAudio.screenFpsDesc"),
  );
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
  section.appendChild(fpsHeader);
  section.appendChild(fpsDesc);
  section.appendChild(fpsSelect);

  // Video device selector
  const videoHeader = createElement("h3", {}, t("voiceAudio.videoDevice"));
  const videoSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.videoDevice"),
  });
  const defaultVideoOpt = createElement("option", { value: "" }, t("voiceAudio.default"));
  videoSelect.appendChild(defaultVideoOpt);
  section.appendChild(videoHeader);
  section.appendChild(videoSelect);

  // Camera preview
  const previewWrap = createElement("div", {
    style:
      "margin-bottom:16px;border-radius:8px;overflow:hidden;background:#1e1f22;aspect-ratio:16/9;max-width:320px",
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

  /**
   * (Re)fill the three device dropdowns from the current device list.
   *
   * Called on build and again on every `devicechange`, so unplugging a headset
   * with the panel open removes it from the list instead of leaving a dead
   * entry the user can select. A saved device that has vanished falls back to
   * "Default" — the same thing the voice session does on hot-swap.
   */
  async function populateDevices(): Promise<void> {
    const selects: Array<[HTMLSelectElement, MediaDeviceKind, string, string]> = [
      [inputSelect, "audioinput", "audioInputDevice", t("voiceAudio.kind.microphone")],
      [outputSelect, "audiooutput", "audioOutputDevice", t("voiceAudio.kind.speaker")],
      [videoSelect, "videoinput", "videoInputDevice", t("voiceAudio.kind.camera")],
    ];
    try {
      // On Linux the audio lists come from the native backend (the ids the
      // session can actually select); cameras are the webview's everywhere.
      const [nativeInputs, nativeOutputs, all] = await Promise.all([
        nativeAudioDevices("audioinput"),
        nativeAudioDevices("audiooutput"),
        navigator.mediaDevices.enumerateDevices(),
      ]);
      const devices =
        nativeInputs === null || nativeOutputs === null
          ? all
          : [...nativeInputs, ...nativeOutputs, ...all.filter((d) => d.kind === "videoinput")];
      if (signal.aborted) return;

      for (const [select, kind, prefKey, label] of selects) {
        const saved = loadPref<string>(prefKey, "");
        // Keep the leading "Default" option, replace the rest.
        while (select.options.length > 1) select.remove(1);
        let savedStillPresent = false;
        for (const d of devices) {
          if (d.kind !== kind) continue;
          if (d.deviceId === saved) savedStillPresent = true;
          select.appendChild(
            createElement(
              "option",
              { value: d.deviceId },
              d.label || `${label} (${d.deviceId.slice(0, 8)})`,
            ),
          );
        }
        select.value = saved !== "" && savedStillPresent ? saved : "";
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
      void switchInputDevice(inputSelect.value);
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
  });

  function stopCameraPreview(): void {
    cameraRequestId += 1;
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
      } catch (err) {
        if (signal.aborted || thisRequest !== cameraRequestId) return;
        const msg = err instanceof Error ? err.message : t("voiceAudio.cameraUnavailable");
        previewErrorEl = createElement("div", { class: "setting-desc" }, msg);
        previewWrap.appendChild(previewErrorEl);
      }
    })();
  }

  videoSelect.addEventListener(
    "change",
    () => {
      savePref("videoInputDevice", videoSelect.value);
      startCameraPreview(videoSelect.value);
    },
    { signal },
  );

  // Start initial camera preview only if a device has been explicitly selected
  const savedVideoDevice = loadPref<string>("videoInputDevice", "");
  if (savedVideoDevice !== "") {
    startCameraPreview(savedVideoDevice);
  }

  // Camera teardown on overlay close is already covered by the factory's
  // single signal.addEventListener("abort", cleanupMic), registered once
  // against the overlay-lifetime signal in createVoiceAudioTab — registering
  // another "abort" handler here too would add one more listener every time
  // the tab is rebuilt, since this function runs again on every build.

  // Start mic level monitoring for visual feedback
  // The meter previews the webview's microphone; on the native engine the
  // saved device id is the engine's, and the meter is hidden anyway.
  if (!nativeAudio)
    void (async () => {
      const thisRequest = ++micRequestId;
      try {
        const savedDevice = loadPref<string>("audioInputDevice", "");
        const constraints: MediaStreamConstraints = {
          audio: savedDevice ? { deviceId: { exact: savedDevice } } : true,
          video: false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        // Race guard: teardown (cleanup or abort) may have run while we awaited
        // — opening the mic now would leave it hot with nobody left to stop it,
        // and registerMic would re-arm state cleanupMic() already cleared.
        if (signal.aborted || thisRequest !== micRequestId) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
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
      } catch (err) {
        log.warn("Mic access denied or unavailable — meter stays empty", err);
      }
    })();

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
      key: "autoGainControl",
      label: t("voiceAudio.agc.label"),
      desc: t("voiceAudio.agc.desc"),
      fallback: true,
    },
    {
      key: "enhancedNoiseSuppression",
      label: t("voiceAudio.enhanced.label"),
      desc: t("voiceAudio.enhanced.desc"),
      fallback: false,
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
        // Reapply audio processing constraints to the live mic track
        void reapplyAudioProcessing();
      },
    });

    appendChildren(row, info, toggle);
    section.appendChild(row);
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
