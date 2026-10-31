/**
 * Voice & Video settings tab — input/output device, sensitivity, audio processing.
 */

import { createElement } from "@lib/dom";
import { isAndroidApp, isLinuxDesktop } from "../../features/voice/native/platform";
import { settingsText as t } from "../../i18n/settings";
import { inputMode, type InputMode } from "@lib/ui/inputMode";
import { mountMicControls } from "./voice-audio/voiceMicControls";
import { mountMicTest } from "./voice-audio/voiceMicTest";
import { mountOutputAndVideo } from "./voice-audio/voiceOutputVideo";
import { mountDevicesAndPreview } from "./voice-audio/voiceDevicesPreview";
import { mountMeterAndToggles } from "./voice-audio/voiceMeterToggles";
import type {
  VoiceTabScope,
  MicRegistrar,
  CameraRegistrar,
  CameraInvalidationRegistrar,
  NativePreviewRegistrar,
  NativeMicTestRegistrar,
  NativeDevicesRegistrar,
} from "./voice-audio/voiceTabScope";

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
  const sc = {} as VoiceTabScope;
  sc.signal = signal;
  sc.registerMic = registerMic;
  sc.stopMic = stopMic;
  sc.registerCamera = registerCamera;
  sc.registerCameraInvalidation = registerCameraInvalidation;
  sc.registerNativePreview = registerNativePreview;
  sc.registerMicTest = registerMicTest;
  sc.registerNativeDevices = registerNativeDevices;

  sc.section = createElement("div", { class: "settings-pane active" });
  // Linux voice runs in the native audio engine (docs/architecture/voice-e2ee.md):
  // its capture takes the input volume, sensitivity and automatic sensitivity
  // like the web processor, and reports its level in a call, in the mic test
  // and in the capture-only monitor the meter runs outside a call. The
  // webview's microphone is not the engine's, so the meter opens none there.
  sc.nativeAudio = isLinuxDesktop();
  // The Android app has no key service for Push to Talk, no output device
  // choice and no screen sharing, so those controls are left out.
  sc.android = isAndroidApp();
  // The mode the gate runs in. The saved choice is kept as it is, but a phone
  // always gates on the sensitivity, as a call there does.
  sc.currentMode = (): InputMode => (sc.android ? "vad" : inputMode());

  // Five cards: when you transmit, what you speak into, what you hear, what
  // you show, and how your voice is processed.
  sc.card = (title: string): HTMLElement => {
    const el = createElement("section", { class: "settings-card" });
    const head = createElement("div", { class: "settings-card-head" });
    head.appendChild(createElement("h3", {}, title));
    el.appendChild(head);
    sc.section.appendChild(el);
    return el;
  };
  sc.inputModeCard = sc.card(t("voiceAudio.card.inputMode"));
  sc.micCard = sc.card(t("voiceAudio.card.microphone"));
  sc.speakersCard = sc.card(t("voiceAudio.card.speakers"));
  sc.cameraCard = sc.card(
    t(sc.android ? "voiceAudio.card.camera.android" : "voiceAudio.card.camera"),
  );
  sc.processingCard = sc.card(t("voiceAudio.card.processing"));
  mountMicControls(sc);
  mountMicTest(sc);
  mountOutputAndVideo(sc);
  mountDevicesAndPreview(sc);
  mountMeterAndToggles(sc);

  return sc.section;
}
