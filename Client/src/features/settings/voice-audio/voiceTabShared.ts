/** Constants and small helpers the voice settings modules share. */
import { loadPref } from "../helpers";
import { createLogger } from "@lib/logger";
import { vadThresholdDb, micProcessingOptions } from "@lib/voice/audioPipeline";
import type { NativeVoiceAudioOptions } from "../../../platform/contracts/nativeVoice";
import { settingsText as t } from "../../../i18n/settings";

export const log = createLogger("VoiceAudioTab");

/** A monitor start refused by a call that is still leaving is retried this
 *  often, this many times, then left until the next trigger. */
export const MONITOR_RETRY_MS = 250;
export const MONITOR_RETRIES = 8;

/** A microphone itself, not the browser's "default"/"communications" alias. */
export function isRealInput(d: MediaDeviceInfo): boolean {
  return d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications";
}

/** Play the mic test on the saved output device, where the host can choose one. */
export function applyMicTestSink(el: HTMLAudioElement): void {
  if (typeof el.setSinkId !== "function") return;
  el.setSinkId(loadPref<string>("audioOutputDevice", "")).catch((err: unknown) => {
    log.warn("Failed to set output device on mic test", err);
  });
}

/** Output Volume percent as an element volume, which caps at 1: above 100 %
 *  the test plays at 100 %. A corrupt pref plays at full. */
export function micTestVolume(percent: number): number {
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) / 100 : 1;
}

/** The processing the call would use, from the same saved toggles. */
export function nativeTestAudio(): NativeVoiceAudioOptions {
  const { echoCancellation, noiseSuppression, autoGainControl } = micProcessingOptions();
  return {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    enhancedNoiseSuppression: loadPref<boolean>("enhancedNoiseSuppression", false),
  };
}

/** The gate level in words: its decibels, or Off at 100 (no gate). */
export function sensitivityLabel(sensitivity: number): string {
  if (sensitivity >= 100) return t("voiceAudio.sensitivityOff");
  return t("voiceAudio.sensitivityValue", { value: Math.round(vadThresholdDb(sensitivity)) });
}

/** Meter RMS above which the mic status pill counts the mic as picking you up. */
export const MIC_NOISE_FLOOR = 0.005;
/** How long the pill keeps saying "Hearing you" after the last frame above the floor. */
export const MIC_HEARD_HOLD_MS = 1000;
/** DeviceManager debounces a devicechange by 500 ms, then moves the capture. */
export const DEVICE_MANAGER_SETTLE_MS = 1000;
/** Pause before the Linux camera preview starts again after its socket
 *  closed, so a capture that is ending has released the device. */
export const PREVIEW_RESTART_MS = 500;
