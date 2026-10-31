/**
 * Voice settings: the live mic meter (web and native) and the audio processing
 * toggles.
 */
import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, createToggle } from "../helpers";
import {
  onNativeInputLevel,
  reapplyAudioProcessing,
  reapplyEnhancedNoiseSuppression,
} from "@lib/voice/livekitSession";
import {
  micCaptureOptions,
  isMissingDeviceError,
  speechDetectionOf,
  startVadDetector,
  vadThreshold,
} from "@lib/voice/audioPipeline";
import { createMicProcessor } from "@lib/voice/micProcessor";
import { Track, type AudioProcessorOptions } from "livekit-client";
import { settingsText as t } from "../../../i18n/settings";
import { setStatusIcon } from "../../../features/settings/status";
import { log, nativeTestAudio } from "./voiceTabShared";
import type { VoiceTabScope } from "./voiceTabScope";

export function mountMeterAndToggles(sc: VoiceTabScope): void {
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
  sc.startMicMeter = function startMicMeter(): void {
    if (sc.signal.aborted) return;
    const thisRequest = ++sc.micRequestId;
    sc.stopMic();
    if (sc.nativeAudio) {
      sc.startNativeMeter();
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
        if (sc.signal.aborted || thisRequest !== sc.micRequestId) {
          stopStream();
          return;
        }
        const processor = createMicProcessor();
        const options = { kind: Track.Kind.Audio, track: stream.getAudioTracks()[0]! };
        await processor.init(options as AudioProcessorOptions);
        sc.meterProcessor = processor;
        processor.setInputGain(sc.inputVolumePercent / 100);
        await processor.setEnhanced(loadPref<boolean>("enhancedNoiseSuppression", false));
        if (sc.signal.aborted || thisRequest !== sc.micRequestId) {
          if (sc.meterProcessor === processor) sc.meterProcessor = null;
          void processor.destroy();
          stopStream();
          return;
        }

        // The detector starts open, as the live gate does.
        let gateOpen = true;
        sc.meterGated = false;
        let level = 0;
        sc.lastHeardAt = Number.NEGATIVE_INFINITY;
        const paint = (): void => sc.paintMeter(level, gateOpen);
        const detector = startVadDetector(
          processor.context,
          processor.analyser!,
          sc.autoSensitivity ? "auto" : vadThreshold(sc.currentSensitivity),
          {
            onGate: (gated) => {
              gateOpen = !gated;
              sc.meterGated = gated;
              sc.syncMeterGate();
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
        sc.meterThresholdSetter = detector.setThreshold;
        sc.meterResetFloor = detector.resetFloor;
        sc.syncMeterGate();
        sc.registerMic(() => {
          sc.stopMicTestPlayback();
          if (sc.meterThresholdSetter === detector.setThreshold) sc.meterThresholdSetter = null;
          if (sc.meterResetFloor === detector.resetFloor) sc.meterResetFloor = null;
          if (sc.meterProcessor === processor) sc.meterProcessor = null;
          void detector.stop().then(() => processor.destroy());
          stopStream();
        });
        if (sc.micTesting) sc.startMicTestPlayback(processor);
      } catch (err) {
        if (sc.signal.aborted || thisRequest !== sc.micRequestId) return;
        log.warn("Mic access denied or unavailable — meter stays empty", err);
        sc.micStatus.hidden = false;
        setStatusIcon(sc.micStatusIcon, "warn");
        setText(sc.micStatusWord, t("voiceAudio.mic.noAccess"));
      }
    })();
  };

  /** The native engine's meter: the capture's level reports, after its
   *  input volume and with its gate's verdict, so the bar shows what the gate
   *  does. In a call they are the call's own; outside one the host runs a
   *  capture-only monitor (a mic test without playout), which a call, the mic
   *  test or the tab closing ends. */
  sc.startNativeMeter = function startNativeMeter(): void {
    sc.lastHeardAt = Number.NEGATIVE_INFINITY;
    const stopCallLevels = onNativeInputLevel((level, gateOpen) => {
      sc.callCapturing = level !== null;
      if (level !== null) {
        sc.paintMeter(level, gateOpen);
        return;
      }
      // The call's capture stopped (mute or leave): the empty bar, and the
      // monitor again once the device is free.
      sc.clearMeter();
      if (!sc.micTesting && sc.nativeTestId === null && !sc.nativeTestStarting)
        void sc.startNativeTest(true);
    });
    sc.registerMic(() => {
      stopCallLevels();
      if (sc.nativeMonitoring) sc.stopNativeTest();
    });
    if (!sc.micTesting) void sc.startNativeTest(true);
  };

  /** Back to the empty bar: no level, no status. */
  sc.clearMeter = function clearMeter(): void {
    sc.meterLevel.style.width = "0%";
    sc.lastHeardAt = Number.NEGATIVE_INFINITY;
    sc.micHeard = null;
    sc.micStatus.hidden = true;
  };

  sc.startMicMeter();

  /**
   * Release the meter's microphone while the call re-opens its own, then
   * meter again. The browser resolves a capture request against the streams
   * already open on the device, so a meter still holding the old settings
   * can hand them to the call's restart (and the reverse).
   */
  sc.restartMeterAfter = function restartMeterAfter(callRestart: Promise<void>): void {
    // Invalidate a meter request still in flight, then release the meter.
    sc.micRequestId++;
    sc.stopMic();
    void callRestart.then(sc.startMicMeter, sc.startMicMeter);
  };

  // ── Audio processing toggles ──────────────────────────────────────
  sc.audioToggles = [
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

  for (const item of sc.audioToggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal: sc.signal,
      label: item.label,
      onChange: (nowOn) => {
        savePref(item.key, nowOn);
        sc.updateNativeTest({ kind: "processing", audio: nativeTestAudio() });
        if (item.key === "enhancedNoiseSuppression") {
          // RNNoise sits inside the processors: re-route the call's and the
          // meter's, and leave both captures alone.
          void reapplyEnhancedNoiseSuppression();
          void sc.meterProcessor?.setEnhanced(nowOn);
          return;
        }
        // Reapply audio processing constraints to the live mic track, then to
        // the meter's, so it keeps measuring what the call captures.
        sc.restartMeterAfter(reapplyAudioProcessing());
      },
    });

    appendChildren(row, info, toggle);
    // Enhanced noise suppression builds on noise suppression: nest it.
    if (item.key === "enhancedNoiseSuppression") row.classList.add("nested");
    sc.processingCard.appendChild(row);
  }
}
