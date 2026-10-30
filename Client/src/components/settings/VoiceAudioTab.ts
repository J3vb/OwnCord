/**
 * Voice & Video settings tab — input/output device, sensitivity, audio processing.
 */

import { createElement, appendChildren, setText, setOwnedTimeout } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";
import { SHARE_FPS_OPTIONS, offeredShareFps } from "@lib/voice/shareFps";
import { createLogger } from "@lib/logger";
import { syncVideoSurface } from "@lib/voice/videoSurface";
import { AUTO_PLAY_CAMERAS_PREF, autoPlayCameras } from "../../features/voice/autoPlayCameras";
import {
  switchInputDevice,
  switchOutputDevice,
  switchVideoDevice,
  setVoiceSensitivity,
  applyInputMode,
  onNativeInputLevel,
  setInputVolume,
  setOutputVolume,
  reapplyAudioProcessing,
  reapplyEnhancedNoiseSuppression,
  getLocalMicSettings,
} from "@lib/voice/livekitSession";
import {
  vadLevelPosition,
  vadThresholdDb,
  micCaptureOptions,
  micProcessingOptions,
  isMissingDeviceError,
  speechDetectionOf,
  startVadDetector,
  vadThreshold,
} from "@lib/voice/audioPipeline";
import { GATE_LOOKAHEAD_S, createMicProcessor, type MicProcessor } from "@lib/voice/micProcessor";
import { Track, type AudioProcessorOptions } from "livekit-client";
import {
  nativeAudioDevices,
  nativeCameraDevices,
  nativeCameraSupport,
  onNativeDevicesChanged,
} from "../../features/voice/native/devices";
import { isAndroidApp, isLinuxDesktop } from "../../features/voice/native/platform";
import {
  getVideoCodecPref,
  h264Offered,
  h265Offered,
  vp9Available,
  vp9Offered,
} from "../../features/voice/videoCodec";
import { desktop } from "../../platform/desktop";
import {
  NATIVE_MIC_TEST_IN_CALL,
  type NativeMicTestEnvelope,
  type NativeMicTestUpdate,
  type NativeVoiceAudioOptions,
} from "../../platform/contracts/nativeVoice";
import { NativeVideoRenderer } from "../../features/voice/native/videoRenderer";
import { settingsText as t } from "../../i18n/settings";
import { setStatusIcon, statusIcon } from "../../features/settings/status";
import { setRovingTabindex, enableRovingNavigation } from "@lib/ui/a11y";
import { autoInputSensitivity, inputMode, type InputMode } from "@lib/ui/inputMode";
import { NoiseFloorTracker } from "@lib/voice/noiseFloor";
import { buildPttControls } from "./pttControls";

const log = createLogger("VoiceAudioTab");

/** A monitor start refused by a call that is still leaving is retried this
 *  often, this many times, then left until the next trigger. */
const MONITOR_RETRY_MS = 250;
const MONITOR_RETRIES = 8;

/** A microphone itself, not the browser's "default"/"communications" alias. */
function isRealInput(d: MediaDeviceInfo): boolean {
  return d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications";
}

/** Play the mic test on the saved output device, where the host can choose one. */
function applyMicTestSink(el: HTMLAudioElement): void {
  if (typeof el.setSinkId !== "function") return;
  el.setSinkId(loadPref<string>("audioOutputDevice", "")).catch((err: unknown) => {
    log.warn("Failed to set output device on mic test", err);
  });
}

/** Output Volume percent as an element volume, which caps at 1: above 100 %
 *  the test plays at 100 %. A corrupt pref plays at full. */
function micTestVolume(percent: number): number {
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) / 100 : 1;
}

/** The processing the call would use, from the same saved toggles. */
function nativeTestAudio(): NativeVoiceAudioOptions {
  const { echoCancellation, noiseSuppression, autoGainControl } = micProcessingOptions();
  return {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    enhancedNoiseSuppression: loadPref<boolean>("enhancedNoiseSuppression", false),
  };
}

/** The gate level in words: its decibels, or Off at 100 (no gate). */
function sensitivityLabel(sensitivity: number): string {
  if (sensitivity >= 100) return t("voiceAudio.sensitivityOff");
  return t("voiceAudio.sensitivityValue", { value: Math.round(vadThresholdDb(sensitivity)) });
}

/** Meter RMS above which the mic status pill counts the mic as picking you up. */
const MIC_NOISE_FLOOR = 0.005;
/** How long the pill keeps saying "Hearing you" after the last frame above the floor. */
const MIC_HEARD_HOLD_MS = 1000;
/** DeviceManager debounces a devicechange by 500 ms, then moves the capture. */
const DEVICE_MANAGER_SETTLE_MS = 1000;
/** Pause before the Linux camera preview starts again after its socket
 *  closed, so a capture that is ending has released the device. */
const PREVIEW_RESTART_MS = 500;

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
  let stopNativeMicTest: (() => void) | null = null;
  let stopNativeDevices: (() => void) | null = null;

  function stopMic(): void {
    stopMeter?.();
    stopMeter = null;
  }

  function cleanupMic(): void {
    stopMic();
    invalidateCameraPreviewRequest?.();
    // Drop it too: it closes over the whole build, so keeping it would hold
    // the discarded pane's DOM until the tab is next opened.
    invalidateCameraPreviewRequest = null;
    // Also stop camera preview
    if (cameraPreviewStream !== null) {
      for (const track of cameraPreviewStream.getTracks()) track.stop();
      cameraPreviewStream = null;
    }
    // The native (Linux) preview releases the host capture and its socket.
    stopNativePreview?.();
    stopNativePreview = null;
    // The native mic test ends with the tab, not with a meter restart: it
    // is stopped here, never in stopMic.
    stopNativeMicTest?.();
    stopNativeMicTest = null;
    // The host's device watch subscription belongs to the build, released on
    // a rebuild and on the overlay's close like the mic test.
    stopNativeDevices?.();
    stopNativeDevices = null;
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
      (stop) => {
        stopNativeMicTest = stop;
      },
      (stop) => {
        stopNativeDevices = stop;
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
type NativeMicTestRegistrar = (stop: () => void) => void;
type NativeDevicesRegistrar = NativeMicTestRegistrar;

function buildVoiceAudioTabInner(
  signal: AbortSignal,
  registerMic: MicRegistrar,
  stopMic: () => void,
  registerCamera: CameraRegistrar,
  registerCameraInvalidation: CameraInvalidationRegistrar,
  registerNativePreview: NativePreviewRegistrar,
  registerMicTest: NativeMicTestRegistrar,
  registerNativeDevices: NativeDevicesRegistrar,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  // Linux voice runs in the native audio engine (docs/architecture/voice-e2ee.md):
  // its capture takes the input volume, sensitivity and automatic sensitivity
  // like the web processor, and reports its level in a call, in the mic test
  // and in the capture-only monitor the meter runs outside a call. The
  // webview's microphone is not the engine's, so the meter opens none there.
  const nativeAudio = isLinuxDesktop();
  // The Android app has no key service for Push to Talk, no output device
  // choice and no screen sharing, so those controls are left out.
  const android = isAndroidApp();
  // The mode the gate runs in. The saved choice is kept as it is, but a phone
  // always gates on the sensitivity, as a call there does.
  const currentMode = (): InputMode => (android ? "vad" : inputMode());

  // Five cards: when you transmit, what you speak into, what you hear, what
  // you show, and how your voice is processed.
  const card = (title: string): HTMLElement => {
    const el = createElement("section", { class: "settings-card" });
    const head = createElement("div", { class: "settings-card-head" });
    head.appendChild(createElement("h3", {}, title));
    el.appendChild(head);
    section.appendChild(el);
    return el;
  };
  const inputModeCard = card(t("voiceAudio.card.inputMode"));
  const micCard = card(t("voiceAudio.card.microphone"));
  const speakersCard = card(t("voiceAudio.card.speakers"));
  const cameraCard = card(t(android ? "voiceAudio.card.camera.android" : "voiceAudio.card.camera"));
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
  /** The slider's current value, for a meter processor started after it moved. */
  let inputVolumePercent = savedInputVolume;
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
      // The meter's own processor measures after the same gain as the call's.
      inputVolumePercent = val;
      meterProcessor?.setInputGain(val / 100);
      meterResetFloor?.();
      updateNativeTest({ kind: "inputGain", percent: val });
      nativeTestFloor?.reset(performance.now());
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

  // Automatic sensitivity: the gate finds its own threshold above the room's
  // noise, and the meter shows the level without a handle.
  let autoSensitivity = autoInputSensitivity();
  const autoRow = createElement("div", {
    class: "setting-row",
    "data-testid": "auto-sensitivity",
  });
  const autoToggle = createToggle(autoSensitivity, {
    signal,
    label: t("voiceAudio.autoSensitivity"),
    onChange: (nowOn) => {
      autoSensitivity = nowOn;
      savePref("autoInputSensitivity", nowOn);
      paintSensitivity();
      meterThresholdSetter?.(nowOn ? "auto" : vadThreshold(currentSensitivity));
      applyInputMode();
      resetNativeTestGate();
    },
  });
  appendChildren(
    autoRow,
    createElement("div", { class: "setting-label" }, t("voiceAudio.autoSensitivity")),
    autoToggle,
  );
  micCard.appendChild(autoRow);

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
  if (nativeAudio) {
    // The mic test and a call share one capture, so the test waits for the call.
    micCard.appendChild(
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
  let lastHeardAt = Number.NEGATIVE_INFINITY;
  function paintMeter(level: number, gateOpen: boolean): void {
    // Same axis as the handle: decibels, GATE_DB_MIN at the left edge.
    const position = vadLevelPosition(level);
    meterLevel.style.width = `${Math.round(position * 1000) / 10}%`;
    meterLevel.style.background = gateOpen ? "var(--green)" : "var(--yellow)";
    const now = performance.now();
    if (level >= MIC_NOISE_FLOOR) lastHeardAt = now;
    showMicState(now - lastHeardAt < MIC_HEARD_HOLD_MS);
  }

  // ── Mic test: plays the processed microphone, after the voice gate, through
  // the chosen output, so you hear what a call would send. On the web it plays
  // the meter's processor; on the native engine the host loops its own capture
  // back to its own output (native_voice/mic_test.rs).
  const micTestRow = createElement("div", {
    class: "setting-row mic-test-row",
    "data-testid": "mic-test",
  });
  const micTestInfo = createElement("div", {});
  const micTestDesc = createElement("div", { class: "setting-desc" }, t("voiceAudio.micTest.desc"));
  appendChildren(
    micTestInfo,
    createElement("div", { class: "setting-label" }, t("voiceAudio.micTest.label")),
    micTestDesc,
  );
  const micTestButton = createElement(
    "button",
    { class: "ac-btn", type: "button", "aria-pressed": "false", "data-testid": "mic-test-button" },
    t("voiceAudio.micTest.start"),
  );
  appendChildren(micTestRow, micTestInfo, micTestButton);
  micCard.appendChild(micTestRow);

  let currentSensitivity = loadPref<number>("voiceSensitivity", 50);

  // ── Input mode: Voice Activity gates on the sensitivity above, Push to Talk
  // on a held key (whose controls show only in that mode).
  const modeGroup = createElement("div", {
    class: "level-options input-mode-options",
    role: "radiogroup",
    "aria-label": t("voiceAudio.inputMode"),
    "data-testid": "input-mode",
  });
  const pttBox = createElement("div", { class: "input-mode-ptt", "data-testid": "ptt-controls" });
  if (!android) pttBox.append(...buildPttControls(signal));
  const modeButtons = new Map<InputMode, HTMLButtonElement>();
  const paintMode = (): void => {
    const mode = currentMode();
    for (const [value, button] of modeButtons) {
      button.classList.toggle("active", value === mode);
      button.setAttribute("aria-checked", String(value === mode));
    }
    pttBox.hidden = mode !== "ptt";
    sensitivityHeader.hidden = mode === "ptt";
    autoRow.hidden = mode === "ptt";
    meterWrap.hidden = mode === "ptt";
  };
  const chooseMode = (mode: InputMode): void => {
    if (mode === inputMode()) return;
    savePref("inputMode", mode);
    paintMode();
    applyInputMode();
    syncMeterGate();
    resetNativeTestGate();
    const vk = loadPref<number>("pttVk", 0);
    if (mode === "vad") void desktop.pushToTalk.stop();
    else if (vk !== 0)
      // A saved key the backend refuses is cleared while arming; repaint so
      // the control does not keep showing it.
      void desktop.pushToTalk.updateKey(vk).then(() => {
        if (!signal.aborted && loadPref<number>("pttVk", 0) === 0)
          pttBox.replaceChildren(...buildPttControls(signal));
      });
  };
  const modeLabels: Record<InputMode, string> = {
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
      modeLabels[mode],
    );
    button.addEventListener("click", () => chooseMode(mode), { signal });
    modeButtons.set(mode, button);
    modeGroup.appendChild(button);
  }
  paintMode();
  setRovingTabindex(modeGroup, "[role='radio']");
  enableRovingNavigation(modeGroup, "[role='radio']", signal);
  if (android) inputModeCard.remove();
  else appendChildren(inputModeCard, modeGroup, pttBox);

  function updateThresholdIndicator(sensitivity: number): void {
    // Invert: sensitivity 100 (no gating) → handle at LEFT (0%),
    //         sensitivity 0 (max gating) → handle at RIGHT (100%).
    // This matches Discord: drag LEFT = easier to pass, RIGHT = harder.
    meterThreshold.style.left = `${100 - sensitivity}%`;
    meterThreshold.setAttribute("aria-valuenow", String(100 - sensitivity));
    const label = sensitivityLabel(sensitivity);
    meterThreshold.setAttribute("aria-valuetext", label);
    setText(sensitivityValue, label);
  }
  updateThresholdIndicator(currentSensitivity);

  function paintSensitivity(): void {
    meterThreshold.hidden = autoSensitivity;
    sensitivityValue.hidden = autoSensitivity;
  }
  paintSensitivity();

  /** Compute sensitivity % from a mouse/touch X position relative to the meter bar. */
  function sensitivityFromPointer(clientX: number): number {
    const rect = meterBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // Invert: clicking LEFT = high sensitivity, RIGHT = low sensitivity
    return Math.round((1 - ratio) * 100);
  }

  /** The meter's detector, so a dragged threshold applies to it at once. */
  let meterThresholdSetter: ((threshold: number | "auto") => void) | null = null;
  /** The meter's detector, so an Input Volume move relearns its noise floor. */
  let meterResetFloor: (() => void) | null = null;
  /** The meter's processor, so the Enhanced NS toggle re-routes it at once. */
  let meterProcessor: MicProcessor | null = null;
  /** The meter detector's last verdict, which the mic test's gate follows. */
  let meterGated = false;
  /** Whether the mic test is on. Its playback follows the meter's processor
   *  across restarts and stops with it when the tab or the overlay closes. */
  let micTesting = false;
  let micTestAudio: HTMLAudioElement | null = null;

  // ── The native mic test's state (Linux): the host's id for the running
  // test, a counter that retires a start a later click or teardown
  // superseded, the noise-floor tracker automatic sensitivity retunes the
  // test's gate with, and the event subscription.
  let nativeTestId: number | null = null;
  let nativeTestRequest = 0;
  let nativeTestStarting = false;
  /** Whether the current (or starting) native test is the meter's
   *  capture-only monitor rather than the mic test. */
  let nativeMonitoring = false;
  /** Whether a call's capture is reporting levels, which the monitor yields to. */
  let callCapturing = false;
  let nativeTestEndedEarly: number | null = null;
  let nativeTestFloor: NoiseFloorTracker | null = null;
  let unsubscribeTestEvents: (() => void) | null = null;

  /** The test's gate threshold, as the web meter gates its test playback:
   *  none in Push to Talk, the tab's sensitivity in Voice Activity. */
  function nativeTestThreshold(): number {
    if (currentMode() !== "vad") return 0;
    if (autoSensitivity) return nativeTestFloor?.threshold ?? 0;
    return vadThreshold(currentSensitivity);
  }

  function makeNativeTestFloor(): void {
    nativeTestFloor = currentMode() === "vad" && autoSensitivity ? new NoiseFloorTracker() : null;
  }

  function updateNativeTest(update: NativeMicTestUpdate): void {
    if (nativeTestId === null) return;
    desktop.nativeVoice.updateMicTest(nativeTestId, update).catch((err: unknown) => {
      log.warn("Mic test setting could not reach the native test", err);
    });
  }

  /** The mode or the automatic toggle changed: the gate starts over. */
  function resetNativeTestGate(): void {
    if (nativeTestId === null) return;
    makeNativeTestFloor();
    updateNativeTest({ kind: "voiceGate", threshold: nativeTestThreshold(), retune: false });
  }

  function paintTestButton(on: boolean): void {
    setText(micTestButton, on ? t("voiceAudio.micTest.stop") : t("voiceAudio.micTest.start"));
    micTestButton.classList.toggle("secondary", on);
    micTestButton.setAttribute("aria-pressed", String(on));
  }

  /** Forget the running test: its id, floor, subscription and meter. */
  function endNativeTest(): void {
    nativeTestId = null;
    nativeMonitoring = false;
    nativeTestFloor = null;
    unsubscribeTestEvents?.();
    unsubscribeTestEvents = null;
    clearMeter();
  }

  function onTestEvent({ test, event }: NativeMicTestEnvelope): void {
    if (test !== nativeTestId) {
      // The host ended a test whose start has not resolved here yet.
      if (event.type === "ended" && nativeTestStarting) nativeTestEndedEarly = test;
      return;
    }
    if (event.type === "ended") {
      // A call joined: the host has already stopped the test. The meter
      // follows the call's own capture from here.
      const monitor = nativeMonitoring;
      nativeTestRequest++;
      endNativeTest();
      if (monitor) return;
      micTesting = false;
      paintTestButton(false);
      setText(micTestDesc, t("voiceAudio.micTest.inCall"));
      return;
    }
    paintMeter(event.rms, event.open);
    const next = nativeTestFloor?.push(event.rms, performance.now()) ?? null;
    if (next !== null) updateNativeTest({ kind: "voiceGate", threshold: next, retune: true });
  }

  async function startNativeTest(monitor = false, attempt = 0): Promise<void> {
    const request = ++nativeTestRequest;
    // A test replaces the monitor in the host, which ends it silently.
    if (nativeMonitoring && !monitor) nativeTestId = null;
    nativeMonitoring = monitor;
    if (!monitor) setText(micTestDesc, t("voiceAudio.micTest.desc"));
    makeNativeTestFloor();
    // Before the start, so no early report is missed; a running monitor's
    // subscription already serves.
    unsubscribeTestEvents ??= desktop.nativeVoice.onMicTestEvent(onTestEvent);
    nativeTestStarting = true;
    nativeTestEndedEarly = null;
    try {
      const id = await desktop.nativeVoice.startMicTest({
        input: loadPref<string>("audioInputDevice", ""),
        output: monitor ? "" : loadPref<string>("audioOutputDevice", ""),
        audio: nativeTestAudio(),
        inputGain: inputVolumePercent,
        outputGain: monitor ? 0 : micTestVolume(loadPref<number>("outputVolume", 100)),
        threshold: nativeTestThreshold(),
        ...(monitor ? { monitor } : {}),
      });
      if (signal.aborted || request !== nativeTestRequest) {
        // Torn down or superseded while starting: stop exactly this test.
        desktop.nativeVoice.stopMicTest(id).catch((err: unknown) => {
          log.warn("A superseded mic test could not be stopped", err);
        });
        return;
      }
      if (nativeTestEndedEarly === id) {
        endNativeTest();
        if (monitor) return;
        micTesting = false;
        paintTestButton(false);
        setText(micTestDesc, t("voiceAudio.micTest.inCall"));
        return;
      }
      nativeTestId = id;
    } catch (err) {
      if (signal.aborted || request !== nativeTestRequest) return;
      if (monitor) {
        // A call holds the capture (its own levels drive the meter) or the
        // device did not open: the bar stays empty.
        log.debug("The meter's monitor could not start", err);
        endNativeTest();
        // A leaving call stops its levels before the host drops its session,
        // so the first start can be refused: try a few more times, no more.
        if (
          err instanceof Error &&
          err.message === NATIVE_MIC_TEST_IN_CALL &&
          attempt < MONITOR_RETRIES
        ) {
          setOwnedTimeout(
            signal,
            () => {
              if (request !== nativeTestRequest || micTesting || callCapturing) return;
              void startNativeTest(true, attempt + 1);
            },
            MONITOR_RETRY_MS,
          );
        }
        return;
      }
      log.warn("The mic test could not start", err);
      endNativeTest();
      micTesting = false;
      paintTestButton(false);
      setText(
        micTestDesc,
        err instanceof Error && err.message === NATIVE_MIC_TEST_IN_CALL
          ? t("voiceAudio.micTest.inCall")
          : t("voiceAudio.micTest.failed"),
      );
      startMicMeter();
    } finally {
      if (request === nativeTestRequest) nativeTestStarting = false;
    }
  }

  /** Button off, or the tab going away. */
  function stopNativeTest(): void {
    nativeTestRequest++;
    const id = nativeTestId;
    endNativeTest();
    if (id === null) return;
    desktop.nativeVoice.stopMicTest(id).catch((err: unknown) => {
      log.warn("The mic test could not be stopped", err);
    });
  }
  registerMicTest(stopNativeTest);

  /** Gate the meter's output as a call would: on the detector in Voice
   *  Activity, open in Push to Talk (there the key decides, not the level). */
  function syncMeterGate(): void {
    if (meterProcessor === null) return;
    const vad = currentMode() === "vad";
    meterProcessor.setLookahead(vad ? GATE_LOOKAHEAD_S : 0);
    meterProcessor.setGate("vad", vad && meterGated);
  }

  function startMicTestPlayback(processor: MicProcessor): void {
    stopMicTestPlayback();
    const track = processor.processedTrack;
    if (track === undefined) return;
    const el = document.createElement("audio");
    el.srcObject = new MediaStream([track]);
    el.volume = micTestVolume(loadPref<number>("outputVolume", 100));
    applyMicTestSink(el);
    micTestAudio = el;
    void el.play()?.catch((err: unknown) => {
      log.warn("Mic test playback failed", err);
    });
  }

  function stopMicTestPlayback(): void {
    if (micTestAudio === null) return;
    micTestAudio.pause();
    // Detached, or Chrome keeps the element (and this pane) alive.
    micTestAudio.srcObject = null;
    micTestAudio = null;
  }

  micTestButton.addEventListener(
    "click",
    () => {
      if (signal.aborted) return;
      micTesting = !micTesting;
      paintTestButton(micTesting);
      if (nativeAudio) {
        if (micTesting) void startNativeTest();
        else {
          stopNativeTest();
          startMicMeter();
        }
        return;
      }
      if (!micTesting) stopMicTestPlayback();
      else if (meterProcessor !== null) startMicTestPlayback(meterProcessor);
    },
    { signal },
  );

  function previewSensitivity(val: number): void {
    currentSensitivity = val;
    updateThresholdIndicator(val);
    meterThresholdSetter?.(vadThreshold(val));
    if (currentMode() === "vad" && !autoSensitivity) {
      updateNativeTest({ kind: "voiceGate", threshold: vadThreshold(val), retune: true });
    }
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
      if (autoSensitivity) return;
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
  if (!android) speakersCard.append(outputHeader, outputSelect);

  // Output Volume slider
  const outputVolumeHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.outputVolume"),
  );
  speakersCard.appendChild(outputVolumeHeader);
  const outputVolumeRow = createElement("div", { class: "slider-row" });
  const storedOutputVolume = loadPref<number>("outputVolume", 100);
  const savedOutputVolume = Number.isFinite(storedOutputVolume)
    ? Math.max(0, Math.min(200, storedOutputVolume))
    : 100;
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
      if (micTestAudio !== null) micTestAudio.volume = micTestVolume(val);
      updateNativeTest({ kind: "outputGain", gain: micTestVolume(val) });
    },
    { signal },
  );
  appendChildren(outputVolumeRow, outputVolumeSlider, outputVolumeLabel);
  speakersCard.appendChild(outputVolumeRow);

  // Camera and screen share quality selectors: separate prefs, because a
  // screen share is mostly text and a camera is mostly motion.
  function qualityGroup(
    label: string,
    desc: string,
    pref: string,
    saved: string,
    options: Array<[string, string]>,
    /** Option values shown but not selectable. */
    disabled: ReadonlySet<string> = new Set(),
  ): HTMLElement[] {
    const header = createElement("div", { class: "settings-field-label" }, label);
    const description = createElement("p", { class: "setting-desc" }, desc);
    const select = createElement("select", {
      class: "form-input",
      style: "width:100%;margin-bottom:16px",
      "aria-label": label,
    });
    for (const [value, text] of options) {
      const opt = createElement("option", { value }, text);
      if (value === saved) opt.setAttribute("selected", "");
      if (disabled.has(value)) opt.disabled = true;
      select.appendChild(opt);
    }
    select.value = saved;
    select.addEventListener(
      "change",
      () => {
        savePref(pref, select.value);
      },
      { signal },
    );
    return [header, description, select];
  }
  const cameraQualityGroup = qualityGroup(
    t("voiceAudio.cameraQuality"),
    t("voiceAudio.cameraQualityDesc"),
    "streamQuality",
    // The defaults match getCameraQuality/getScreenShareQuality in
    // lib/voice/screenShare, which this tab does not import (it pulls in the
    // voice store).
    loadPref<string>("streamQuality", "medium"),
    [
      ["low", t("voiceAudio.cameraQuality.low")],
      ["medium", t("voiceAudio.cameraQuality.medium")],
      ["high", t("voiceAudio.cameraQuality.high")],
      ["source", t("voiceAudio.cameraQuality.source")],
    ],
  );
  const screenQualityGroup = qualityGroup(
    t("voiceAudio.screenQuality"),
    t("voiceAudio.screenQualityDesc"),
    "screenShareQuality",
    loadPref<string>("screenShareQuality", "medium"),
    [
      ["low", t("voiceAudio.screenQuality.low")],
      ["medium", t("voiceAudio.screenQuality.medium")],
      ["high", t("voiceAudio.screenQuality.high")],
      ["source", t("voiceAudio.screenQuality.source")],
    ],
  );

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
  const fpsLabels: Record<number, string> = {
    60: t("voiceAudio.fps.60"),
    120: t("voiceAudio.fps.120"),
  };
  const fpsOptions: Array<[number, string]> = [
    [30, t("voiceAudio.fps.30")],
    ...SHARE_FPS_OPTIONS.map((fps): [number, string] => [fps, fpsLabels[fps] ?? String(fps)]),
  ];
  const savedFps = offeredShareFps(loadPref<number>("screenShareFps", 30));
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
  // Linux: the Wayland portal negotiates 60 fps at most; the picker
  // greys 120 out there, so say it here as well.
  const fpsGroup = isLinuxDesktop()
    ? [
        fpsHeader,
        fpsDesc,
        createElement(
          "p",
          { class: "setting-desc", "data-testid": "screen-fps-wayland-note" },
          t("voiceAudio.screenFpsWaylandNote"),
        ),
        fpsSelect,
      ]
    : [fpsHeader, fpsDesc, fpsSelect];

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

  // Remote cameras play on their own; off, each one waits behind Watch stream.
  const autoPlayRow = createElement("div", {
    class: "setting-row",
    "data-testid": "auto-play-cameras",
  });
  const autoPlayInfo = createElement("div", {});
  appendChildren(
    autoPlayInfo,
    createElement("div", { class: "setting-label" }, t("voiceAudio.autoPlayCameras")),
    createElement("div", { class: "setting-desc" }, t("voiceAudio.autoPlayCamerasDesc")),
  );
  appendChildren(
    autoPlayRow,
    autoPlayInfo,
    createToggle(autoPlayCameras(), {
      signal,
      label: t("voiceAudio.autoPlayCameras"),
      onChange: (nowOn) => savePref(AUTO_PLAY_CAMERAS_PREF, nowOn),
    }),
  );
  cameraCard.appendChild(autoPlayRow);

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
  cameraCard.append(...cameraQualityGroup);
  if (!android) cameraCard.append(...screenQualityGroup, ...fpsGroup);
  // The codec choice. Off Linux the webview's own encoders decide what is
  // offered; on Linux the native engine offers VP8, Auto (VP8), and H.264 and
  // VP9 only when its probe says it can encode them.
  const codecGroup = (h264Available: boolean, vp9Native = false): HTMLElement[] => {
    const linux = isLinuxDesktop();
    const offerVp9 = linux ? vp9Native : vp9Offered();
    const offerH265 = h265Offered();
    const savedCodec = getVideoCodecPref();
    // A saved codec that is no longer offered reads as VP8, as the resolver
    // does; the pref itself is left alone for a build that offers it.
    const unoffered =
      (savedCodec === "vp9" && !offerVp9) ||
      (savedCodec === "h265" && !offerH265) ||
      (savedCodec === "h264" && !h264Available);
    return [
      ...qualityGroup(
        t("voiceAudio.videoCodec"),
        t(linux ? "voiceAudio.videoCodecDescLinux" : "voiceAudio.videoCodecDesc"),
        "videoCodec",
        unoffered ? "vp8" : savedCodec,
        [
          ["vp8", t("voiceAudio.videoCodec.vp8")],
          [
            "h264",
            h264Available
              ? t(linux ? "voiceAudio.videoCodec.h264Linux" : "voiceAudio.videoCodec.h264")
              : t("voiceAudio.videoCodec.h264Unavailable"),
          ],
          ...(offerVp9 ? [["vp9", t("voiceAudio.videoCodec.vp9")] as [string, string]] : []),
          ...(offerH265 ? [["h265", t("voiceAudio.videoCodec.h265")] as [string, string]] : []),
          ["auto", t(linux ? "voiceAudio.videoCodec.autoLinux" : "voiceAudio.videoCodec.auto")],
        ],
        h264Available ? new Set() : new Set(["h264"]),
      ),
      createElement(
        "p",
        { class: "setting-desc" },
        t(linux ? "voiceAudio.videoCodecLinux" : "voiceAudio.videoCodecIntel"),
      ),
    ];
  };
  if (isLinuxDesktop()) {
    // The probe is asked of the host, so the group fills a slot that holds its
    // place (a group's height) and the cards below do not jump.
    const slot = createElement("div", { class: "voice-codec-slot", style: "min-height:104px" });
    cameraCard.appendChild(slot);
    void Promise.all([h264Offered(), vp9Available()]).then(([h264, vp9]) => {
      if (!signal.aborted) slot.append(...codecGroup(h264, vp9));
    });
  } else if (!android) {
    cameraCard.append(...codecGroup(true));
  }

  // Device names seen while this tab is open, to name one that is unplugged.
  const deviceLabels = new Map<string, string>();
  /**
   * (Re)fill the three device dropdowns from the current device list.
   *
   * Called on build and again on every `devicechange`, so unplugging a headset
   * with the panel open removes it from the list instead of leaving a dead
   * entry the user can select. A saved microphone or speaker that has vanished
   * stays the selection as a disabled "(disconnected)" entry: the voice
   * session keeps it too and switches back to it when it returns. A
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
        // Without a media permission the webview hides the list behind one
        // nameless entry per kind, so whether the saved device is here is unknown.
        let hidden = false;
        for (const d of devices) {
          if (d.kind !== kind) continue;
          if (d.deviceId === "") {
            hidden = true;
            continue;
          }
          if (d.deviceId === saved) savedStillPresent = true;
          const name = d.label || `${label} (${d.deviceId.slice(0, 8)})`;
          deviceLabels.set(d.deviceId, name);
          select.appendChild(createElement("option", { value: d.deviceId }, name));
        }
        const keepSaved = savedStillPresent || kind !== "videoinput";
        if (saved !== "" && !savedStillPresent && keepSaved) {
          const device = deviceLabels.get(saved) ?? `${label} (${saved.slice(0, 8)})`;
          select.appendChild(
            hidden
              ? createElement("option", { value: saved }, device)
              : createElement(
                  "option",
                  { value: saved, disabled: "" },
                  t("voiceAudio.deviceDisconnected", { device }),
                ),
          );
        }
        select.value = keepSaved ? saved : "";
      }
      // "Default" is a preference; name the device the call really captures,
      // which can lag the system default after an unplug and replug. Only a
      // web room has a mic track to read, so the list is the webview's.
      const live = loadPref<string>("audioInputDevice", "") === "" ? getLocalMicSettings() : null;
      const liveDevice =
        live === null
          ? undefined
          : (all.find((d) => isRealInput(d) && d.deviceId === live.deviceId) ??
            all.find((d) => isRealInput(d) && d.groupId !== "" && d.groupId === live.groupId));
      setText(
        defaultInputOpt,
        liveDevice?.label
          ? t("voiceAudio.defaultLive", { device: liveDevice.label })
          : t("voiceAudio.default"),
      );
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

  const onDeviceChange = (): void => {
    void populateDevices();
    // The session moves the capture after its own debounce; re-read then.
    setOwnedTimeout(signal, () => void populateDevices(), DEVICE_MANAGER_SETTLE_MS);
  };
  // MediaDevices is an EventTarget everywhere this ships, but a webview that
  // exposes enumerateDevices without the event target shouldn't take the tab
  // down with it — it just loses live refresh.
  if (typeof navigator.mediaDevices?.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange, { signal });
  }
  // On Linux the host's hot-plug watch is the trigger (null elsewhere); it
  // also starts the watch, so the lists stay live outside a call.
  // Released through cleanupMic (a rebuild or the overlay closing), not an
  // "abort" listener: build() runs again on every rebuild.
  const stopNative = onNativeDevicesChanged(onDeviceChange);
  if (stopNative !== null) registerNativeDevices(stopNative);

  inputSelect.addEventListener(
    "change",
    () => {
      savePref("audioInputDevice", inputSelect.value);
      updateNativeTest({ kind: "inputDevice", deviceId: inputSelect.value });
      const switched = switchInputDevice(inputSelect.value);
      restartMeterAfter(switched);
      void switched.then(populateDevices, populateDevices);
    },
    { signal },
  );

  outputSelect.addEventListener(
    "change",
    () => {
      savePref("audioOutputDevice", outputSelect.value);
      updateNativeTest({ kind: "outputDevice", deviceId: outputSelect.value });
      void switchOutputDevice(outputSelect.value);
      if (micTestAudio !== null) applyMicTestSink(micTestAudio);
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
    syncVideoSurface(previewVideo);
  });

  function stopCameraPreview(): void {
    cameraRequestId += 1;
    registerCamera(null);
    previewVideo.srcObject = null;
    syncVideoSurface(previewVideo);
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

  function previewDevice(deviceId: string): void {
    stopCameraPreview();
    stopNativeCameraPreview();
    if (isLinuxDesktop()) void startNativeCameraPreview(deviceId);
    else startCameraPreview(deviceId);
  }

  videoSelect.addEventListener(
    "change",
    () => {
      const picked = videoSelect.value;
      void switchVideoDevice(picked).then(() => {
        // The live camera could not use the pick and stayed on its device:
        // show that one again.
        const kept = loadPref<string>("videoInputDevice", "");
        if (signal.aborted || kept === picked || videoSelect.value !== picked) return;
        videoSelect.value = kept;
        previewDevice(kept);
      });
      previewDevice(picked);
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
      // The discovery awaits must not outlive a newer request: if the user
      // picks a camera while they are pending, that choice owns the preview.
      const thisRequest = cameraRequestId;
      try {
        // GStreamer may be missing entirely: no capture can start, so explain why
        // instead of leaving the preview box empty or showing a generic error.
        const support = await nativeCameraSupport();
        if (signal.aborted || thisRequest !== cameraRequestId) return;
        if (support !== null && !support.available) {
          setText(previewLabel, t("voiceAudio.gstreamerMissing"));
          previewLabel.hidden = false;
          return;
        }
        const cameras = await nativeCameraDevices();
        if (signal.aborted || thisRequest !== cameraRequestId) return;
        if (cameras !== null && cameras.length === 0) {
          setText(previewLabel, t("voiceAudio.noCamera"));
          previewLabel.hidden = false;
          return;
        }
        await startNativeCameraPreview(device);
      } catch {
        // A failed support/device query must still explain itself, not leave
        // the preview box in its default empty state.
        if (signal.aborted || thisRequest !== cameraRequestId) return;
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
      // The host closes the socket when the camera's owner changes: the
      // call's camera turned on (it takes the device) or off, or the call
      // ended. Start again, which shows whichever capture owns the camera now.
      const renderer = new NativeVideoRenderer(`${started.frames}/camera`, () => {
        if (activeNativePreview !== stop) return;
        const closedAt = cameraRequestId;
        renderer.dispose();
        activeNativePreview = null;
        registerNativePreview(() => {});
        previewVideo.srcObject = null;
        syncVideoSurface(previewVideo);
        setOwnedTimeout(
          signal,
          () => {
            // A camera picked meanwhile already started its own preview.
            if (cameraRequestId === closedAt) void startNativeCameraPreview(videoSelect.value);
          },
          PREVIEW_RESTART_MS,
        );
      });
      const stream = new MediaStream([renderer.mediaStreamTrack]);
      registerCamera(stream);
      previewVideo.srcObject = stream;
      syncVideoSurface(previewVideo);
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
    syncVideoSurface(previewVideo);
  }

  // Camera teardown on overlay close is already covered by the factory's
  // single signal.addEventListener("abort", cleanupMic), registered once
  // against the overlay-lifetime signal in createVoiceAudioTab — registering
  // another "abort" handler here too would add one more listener every time
  // the tab is rebuilt, since this function runs again on every build.

  // Mic level meter. It runs the call's own microphone processor
  // (lib/voice/micProcessor.ts: RNNoise when Enhanced Noise Suppression is on) over
  // a microphone opened with the call's capture settings, and the call's own
  // detector (lib/voice/audioPipeline.ts startVadDetector, same attack and hold)
  // at the same threshold. The bar is the loudest smoothed level (a ~10 ms
  // running RMS, the one the gate compares) the detector saw, on the threshold handle's axis; green is the gate open. So
  // what the meter shows is what the gate does. Opening the microphone with
  // other settings would also fight the call for the device: the browser can
  // hand the call this stream's processing instead of its own.
  // On the native engine the saved device id is the engine's, so the meter
  // shows the call capture's own level reports instead (startNativeMeter).
  function startMicMeter(): void {
    if (signal.aborted) return;
    const thisRequest = ++micRequestId;
    stopMic();
    if (nativeAudio) {
      startNativeMeter();
      return;
    }
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
        processor.setInputGain(inputVolumePercent / 100);
        await processor.setEnhanced(loadPref<boolean>("enhancedNoiseSuppression", false));
        if (signal.aborted || thisRequest !== micRequestId) {
          if (meterProcessor === processor) meterProcessor = null;
          void processor.destroy();
          stopStream();
          return;
        }

        // The detector starts open, as the live gate does.
        let gateOpen = true;
        meterGated = false;
        let level = 0;
        lastHeardAt = Number.NEGATIVE_INFINITY;
        const paint = (): void => paintMeter(level, gateOpen);
        const detector = startVadDetector(
          processor.context,
          processor.analyser!,
          autoSensitivity ? "auto" : vadThreshold(currentSensitivity),
          {
            onGate: (gated) => {
              gateOpen = !gated;
              meterGated = gated;
              syncMeterGate();
              paint();
            },
            onRms: (rms) => {
              level = rms;
              paint();
            },
          },
          undefined,
          speechDetectionOf(processor),
        );
        meterThresholdSetter = detector.setThreshold;
        meterResetFloor = detector.resetFloor;
        syncMeterGate();
        registerMic(() => {
          stopMicTestPlayback();
          if (meterThresholdSetter === detector.setThreshold) meterThresholdSetter = null;
          if (meterResetFloor === detector.resetFloor) meterResetFloor = null;
          if (meterProcessor === processor) meterProcessor = null;
          void detector.stop().then(() => processor.destroy());
          stopStream();
        });
        if (micTesting) startMicTestPlayback(processor);
      } catch (err) {
        if (signal.aborted || thisRequest !== micRequestId) return;
        log.warn("Mic access denied or unavailable — meter stays empty", err);
        micStatus.hidden = false;
        setStatusIcon(micStatusIcon, "warn");
        setText(micStatusWord, t("voiceAudio.mic.noAccess"));
      }
    })();
  }
  /** The native engine's meter: the capture's level reports, after its
   *  input volume and with its gate's verdict, so the bar shows what the gate
   *  does. In a call they are the call's own; outside one the host runs a
   *  capture-only monitor (a mic test without playout), which a call, the mic
   *  test or the tab closing ends. */
  function startNativeMeter(): void {
    lastHeardAt = Number.NEGATIVE_INFINITY;
    const stopCallLevels = onNativeInputLevel((level, gateOpen) => {
      callCapturing = level !== null;
      if (level !== null) {
        paintMeter(level, gateOpen);
        return;
      }
      // The call's capture stopped (mute or leave): the empty bar, and the
      // monitor again once the device is free.
      clearMeter();
      if (!micTesting && nativeTestId === null && !nativeTestStarting) void startNativeTest(true);
    });
    registerMic(() => {
      stopCallLevels();
      if (nativeMonitoring) stopNativeTest();
    });
    if (!micTesting) void startNativeTest(true);
  }
  /** Back to the empty bar: no level, no status. */
  function clearMeter(): void {
    meterLevel.style.width = "0%";
    lastHeardAt = Number.NEGATIVE_INFINITY;
    micHeard = null;
    micStatus.hidden = true;
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
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      label: item.label,
      onChange: (nowOn) => {
        savePref(item.key, nowOn);
        updateNativeTest({ kind: "processing", audio: nativeTestAudio() });
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

  return section;
}
