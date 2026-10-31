/**
 * Voice settings: the mic test (web playback and the Linux native test) and
 * dragging, clicking or keying the sensitivity threshold.
 */
import { setText, setOwnedTimeout } from "@lib/dom";
import { loadPref, savePref } from "../helpers";
import { setVoiceSensitivity } from "@lib/voice/livekitSession";
import { vadThreshold } from "@lib/voice/audioPipeline";
import { GATE_LOOKAHEAD_S, type MicProcessor } from "@lib/voice/micProcessor";
import { desktop } from "../../../platform/desktop";
import {
  NATIVE_MIC_TEST_IN_CALL,
  type NativeMicTestEnvelope,
  type NativeMicTestUpdate,
} from "../../../platform/contracts/nativeVoice";
import { settingsText as t } from "../../../i18n/settings";
import { NoiseFloorTracker } from "@lib/voice/noiseFloor";
import {
  log,
  MONITOR_RETRY_MS,
  MONITOR_RETRIES,
  applyMicTestSink,
  micTestVolume,
  nativeTestAudio,
} from "./voiceTabShared";
import type { VoiceTabScope } from "./voiceTabScope";

export function mountMicTest(sc: VoiceTabScope): void {
  /** Compute sensitivity % from a mouse/touch X position relative to the meter bar. */
  sc.sensitivityFromPointer = function sensitivityFromPointer(clientX: number): number {
    const rect = sc.meterBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // Invert: clicking LEFT = high sensitivity, RIGHT = low sensitivity
    return Math.round((1 - ratio) * 100);
  };

  /** The meter's detector, so a dragged threshold applies to it at once. */
  sc.meterThresholdSetter = null;

  /** The meter's detector, so an Input Volume move relearns its noise floor. */
  sc.meterResetFloor = null;

  /** The meter's processor, so the Enhanced NS toggle re-routes it at once. */
  sc.meterProcessor = null;

  /** The meter detector's last verdict, which the mic test's gate follows. */
  sc.meterGated = false;

  /** Whether the mic test is on. Its playback follows the meter's processor
   *  across restarts and stops with it when the tab or the overlay closes. */
  sc.micTesting = false;

  sc.micTestAudio = null;

  // ── The native mic test's state (Linux): the host's id for the running
  // test, a counter that retires a start a later click or teardown
  // superseded, the noise-floor tracker automatic sensitivity retunes the
  // test's gate with, and the event subscription.
  sc.nativeTestId = null;

  sc.nativeTestRequest = 0;

  sc.nativeTestStarting = false;

  /** Whether the current (or starting) native test is the meter's
   *  capture-only monitor rather than the mic test. */
  sc.nativeMonitoring = false;

  /** Whether a call's capture is reporting levels, which the monitor yields to. */
  sc.callCapturing = false;

  sc.nativeTestEndedEarly = null;

  sc.nativeTestFloor = null;

  sc.unsubscribeTestEvents = null;

  /** The test's gate threshold, as the web meter gates its test playback:
   *  none in Push to Talk, the tab's sensitivity in Voice Activity. */
  sc.nativeTestThreshold = function nativeTestThreshold(): number {
    if (sc.currentMode() !== "vad") return 0;
    if (sc.autoSensitivity) return sc.nativeTestFloor?.threshold ?? 0;
    return vadThreshold(sc.currentSensitivity);
  };

  sc.makeNativeTestFloor = function makeNativeTestFloor(): void {
    sc.nativeTestFloor =
      sc.currentMode() === "vad" && sc.autoSensitivity ? new NoiseFloorTracker() : null;
  };

  sc.updateNativeTest = function updateNativeTest(update: NativeMicTestUpdate): void {
    if (sc.nativeTestId === null) return;
    desktop.nativeVoice.updateMicTest(sc.nativeTestId, update).catch((err: unknown) => {
      log.warn("Mic test setting could not reach the native test", err);
    });
  };

  /** The mode or the automatic toggle changed: the gate starts over. */
  sc.resetNativeTestGate = function resetNativeTestGate(): void {
    if (sc.nativeTestId === null) return;
    sc.makeNativeTestFloor();
    sc.updateNativeTest({
      kind: "voiceGate",
      threshold: sc.nativeTestThreshold(),
      retune: false,
      speech: true,
    });
  };

  sc.paintTestButton = function paintTestButton(on: boolean): void {
    setText(sc.micTestButton, on ? t("voiceAudio.micTest.stop") : t("voiceAudio.micTest.start"));
    sc.micTestButton.classList.toggle("secondary", on);
    sc.micTestButton.setAttribute("aria-pressed", String(on));
  };

  /** Forget the running test: its id, floor, subscription and meter. */
  sc.endNativeTest = function endNativeTest(): void {
    sc.nativeTestId = null;
    sc.nativeMonitoring = false;
    sc.nativeTestFloor = null;
    sc.unsubscribeTestEvents?.();
    sc.unsubscribeTestEvents = null;
    sc.clearMeter();
  };

  sc.onTestEvent = function onTestEvent({ test, event }: NativeMicTestEnvelope): void {
    if (test !== sc.nativeTestId) {
      // The host ended a test whose start has not resolved here yet.
      if (event.type === "ended" && sc.nativeTestStarting) sc.nativeTestEndedEarly = test;
      return;
    }
    if (event.type === "ended") {
      // A call joined: the host has already stopped the test. The meter
      // follows the call's own capture from here.
      const monitor = sc.nativeMonitoring;
      sc.nativeTestRequest++;
      sc.endNativeTest();
      if (monitor) return;
      sc.micTesting = false;
      sc.paintTestButton(false);
      setText(sc.micTestDesc, t("voiceAudio.micTest.inCall"));
      return;
    }
    sc.paintMeter(event.rms, event.open);
    const next = sc.nativeTestFloor?.push(event.rms, performance.now()) ?? null;
    if (next !== null) sc.updateNativeTest({ kind: "voiceGate", threshold: next, retune: true });
  };

  sc.startNativeTest = async function startNativeTest(monitor = false, attempt = 0): Promise<void> {
    const request = ++sc.nativeTestRequest;
    // A test replaces the monitor in the host, which ends it silently.
    if (sc.nativeMonitoring && !monitor) sc.nativeTestId = null;
    sc.nativeMonitoring = monitor;
    if (!monitor) setText(sc.micTestDesc, t("voiceAudio.micTest.desc"));
    sc.makeNativeTestFloor();
    // Before the start, so no early report is missed; a running monitor's
    // subscription already serves.
    sc.unsubscribeTestEvents ??= desktop.nativeVoice.onMicTestEvent(sc.onTestEvent);
    sc.nativeTestStarting = true;
    sc.nativeTestEndedEarly = null;
    try {
      const id = await desktop.nativeVoice.startMicTest({
        input: loadPref<string>("audioInputDevice", ""),
        output: monitor ? "" : loadPref<string>("audioOutputDevice", ""),
        audio: nativeTestAudio(),
        inputGain: sc.inputVolumePercent,
        outputGain: monitor ? 0 : micTestVolume(loadPref<number>("outputVolume", 100)),
        threshold: sc.nativeTestThreshold(),
        speech: true,
        ...(monitor ? { monitor } : {}),
      });
      if (sc.signal.aborted || request !== sc.nativeTestRequest) {
        // Torn down or superseded while starting: stop exactly this test.
        desktop.nativeVoice.stopMicTest(id).catch((err: unknown) => {
          log.warn("A superseded mic test could not be stopped", err);
        });
        return;
      }
      if (sc.nativeTestEndedEarly === id) {
        sc.endNativeTest();
        if (monitor) return;
        sc.micTesting = false;
        sc.paintTestButton(false);
        setText(sc.micTestDesc, t("voiceAudio.micTest.inCall"));
        return;
      }
      sc.nativeTestId = id;
    } catch (err) {
      if (sc.signal.aborted || request !== sc.nativeTestRequest) return;
      if (monitor) {
        // A call holds the capture (its own levels drive the meter) or the
        // device did not open: the bar stays empty.
        log.debug("The meter's monitor could not start", err);
        sc.endNativeTest();
        // A leaving call stops its levels before the host drops its session,
        // so the first start can be refused: try a few more times, no more.
        if (
          err instanceof Error &&
          err.message === NATIVE_MIC_TEST_IN_CALL &&
          attempt < MONITOR_RETRIES
        ) {
          setOwnedTimeout(
            sc.signal,
            () => {
              if (request !== sc.nativeTestRequest || sc.micTesting || sc.callCapturing) return;
              void sc.startNativeTest(true, attempt + 1);
            },
            MONITOR_RETRY_MS,
          );
        }
        return;
      }
      log.warn("The mic test could not start", err);
      sc.endNativeTest();
      sc.micTesting = false;
      sc.paintTestButton(false);
      setText(
        sc.micTestDesc,
        err instanceof Error && err.message === NATIVE_MIC_TEST_IN_CALL
          ? t("voiceAudio.micTest.inCall")
          : t("voiceAudio.micTest.failed"),
      );
      sc.startMicMeter();
    } finally {
      if (request === sc.nativeTestRequest) sc.nativeTestStarting = false;
    }
  };

  /** Button off, or the tab going away. */
  sc.stopNativeTest = function stopNativeTest(): void {
    sc.nativeTestRequest++;
    const id = sc.nativeTestId;
    sc.endNativeTest();
    if (id === null) return;
    desktop.nativeVoice.stopMicTest(id).catch((err: unknown) => {
      log.warn("The mic test could not be stopped", err);
    });
  };

  sc.registerMicTest(sc.stopNativeTest);

  /** Gate the meter's output as a call would: on the detector in Voice
   *  Activity, open in Push to Talk (there the key decides, not the level). */
  sc.syncMeterGate = function syncMeterGate(): void {
    if (sc.meterProcessor === null) return;
    const vad = sc.currentMode() === "vad";
    sc.meterProcessor.setLookahead(vad ? GATE_LOOKAHEAD_S : 0);
    sc.meterProcessor.setGate("vad", vad && sc.meterGated);
  };

  sc.startMicTestPlayback = function startMicTestPlayback(processor: MicProcessor): void {
    sc.stopMicTestPlayback();
    const track = processor.processedTrack;
    if (track === undefined) return;
    const el = document.createElement("audio");
    el.srcObject = new MediaStream([track]);
    el.volume = micTestVolume(loadPref<number>("outputVolume", 100));
    applyMicTestSink(el);
    sc.micTestAudio = el;
    void el.play()?.catch((err: unknown) => {
      log.warn("Mic test playback failed", err);
    });
  };

  sc.stopMicTestPlayback = function stopMicTestPlayback(): void {
    if (sc.micTestAudio === null) return;
    sc.micTestAudio.pause();
    // Detached, or Chrome keeps the element (and this pane) alive.
    sc.micTestAudio.srcObject = null;
    sc.micTestAudio = null;
  };

  sc.micTestButton.addEventListener(
    "click",
    () => {
      if (sc.signal.aborted) return;
      sc.micTesting = !sc.micTesting;
      sc.paintTestButton(sc.micTesting);
      if (sc.nativeAudio) {
        if (sc.micTesting) void sc.startNativeTest();
        else {
          sc.stopNativeTest();
          sc.startMicMeter();
        }
        return;
      }
      if (!sc.micTesting) sc.stopMicTestPlayback();
      else if (sc.meterProcessor !== null) sc.startMicTestPlayback(sc.meterProcessor);
    },
    { signal: sc.signal },
  );

  sc.previewSensitivity = function previewSensitivity(val: number): void {
    sc.currentSensitivity = val;
    sc.updateThresholdIndicator(val);
    sc.meterThresholdSetter?.(vadThreshold(val));
    if (sc.currentMode() === "vad" && !sc.autoSensitivity) {
      sc.updateNativeTest({ kind: "voiceGate", threshold: vadThreshold(val), retune: true });
    }
  };

  sc.commitSensitivity = function commitSensitivity(): void {
    savePref("voiceSensitivity", sc.currentSensitivity);
    setVoiceSensitivity(sc.currentSensitivity);
  };

  sc.applySensitivity = function applySensitivity(val: number): void {
    sc.previewSensitivity(val);
    sc.commitSensitivity();
  };

  sc.onMove = function onMove(ev: PointerEvent): void {
    sc.previewSensitivity(sc.sensitivityFromPointer(ev.clientX));
  };

  // Drag the threshold handle
  sc.meterThreshold.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      e.preventDefault();
      sc.meterThreshold.setPointerCapture(e.pointerId);
      const onUp = (): void => {
        sc.meterThreshold.removeEventListener("pointermove", sc.onMove);
        sc.meterThreshold.removeEventListener("pointerup", onUp);
        sc.meterThreshold.removeEventListener("pointercancel", onUp);
        sc.commitSensitivity();
      };
      sc.meterThreshold.addEventListener("pointermove", sc.onMove, { signal: sc.signal });
      sc.meterThreshold.addEventListener("pointerup", onUp, { signal: sc.signal });
      // A touch/pen drag that the OS claims as a pan (or any other
      // mid-drag pointer loss) fires pointercancel instead of pointerup.
      // Without this, onMove stays attached for the tab's lifetime and
      // every later hover over the handle silently rewrites and persists
      // voiceSensitivity with no button held (v097).
      sc.meterThreshold.addEventListener("pointercancel", onUp, { signal: sc.signal });
    },
    { signal: sc.signal },
  );

  // Click on the meter bar to jump the threshold
  sc.meterBar.addEventListener(
    "click",
    (e: MouseEvent) => {
      if (sc.autoSensitivity) return;
      sc.applySensitivity(sc.sensitivityFromPointer(e.clientX));
    },
    { signal: sc.signal },
  );

  // Keyboard: standard slider semantics over the gate threshold the handle
  // shows (aria-valuenow = 100 - sensitivity), so ArrowRight/End move the
  // handle right exactly as a drag does; aria-valuetext announces the
  // sensitivity itself.
  sc.meterThreshold.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const threshold = 100 - sc.currentSensitivity;
      let next: number;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = 100;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = threshold - 5;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = threshold + 5;
      else return;
      e.preventDefault();
      sc.applySensitivity(100 - Math.max(0, Math.min(100, next)));
    },
    { signal: sc.signal },
  );
}
