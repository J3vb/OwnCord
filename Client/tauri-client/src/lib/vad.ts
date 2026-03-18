// =============================================================================
// Voice Activity Detection — Web Audio API based speech detection
// =============================================================================

import { createLogger } from "@lib/logger";

const log = createLogger("vad");

export interface VadOptions {
  /** Audio volume threshold (0-1) to detect speech. Default 0.01 */
  readonly threshold?: number;
  /** How often to check volume in ms. Default 50 */
  readonly intervalMs?: number;
  /** Minimum consecutive detections before triggering. Default 3 */
  readonly minConsecutive?: number;
}

export interface VadDetector {
  start(stream: MediaStream): void;
  stop(): void;
  setThreshold(threshold: number): void;
  onSpeakingChange(callback: (speaking: boolean) => void): () => void;
  isSpeaking(): boolean;
  destroy(): void;
}

type SpeakingCallback = (speaking: boolean) => void;

const DEFAULT_THRESHOLD = 0.01;
const DEFAULT_INTERVAL_MS = 50;
const DEFAULT_MIN_CONSECUTIVE = 3;

/** Max VAD threshold value. Sensitivity 0% maps to this threshold. */
const MAX_THRESHOLD = 0.15;

/** Convert sensitivity slider (0-100) to VAD threshold (0-MAX_THRESHOLD).
 *  High sensitivity = low threshold (picks up quiet sounds).
 *  0% sensitivity = threshold 0.15 (only loud sounds trigger).
 *  100% sensitivity = threshold 0.0 (everything triggers). */
export function sensitivityToThreshold(sensitivity: number): number {
  return ((100 - sensitivity) / 100) * MAX_THRESHOLD;
}
// Require more silence samples than speech samples to prevent flicker
const SILENCE_MULTIPLIER = 2;

function computeRms(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    if (val === undefined) continue;
    // getByteFrequencyData returns 0-255 where 0 = silence, 255 = max.
    // Normalize to 0-1 range.
    const normalized = val / 255;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}

export function createVadDetector(options?: VadOptions): VadDetector {
  let threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const minConsecutive = options?.minConsecutive ?? DEFAULT_MIN_CONSECUTIVE;
  const silenceRequired = minConsecutive * SILENCE_MULTIPLIER;

  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  let speaking = false;
  let consecutiveAbove = 0;
  let consecutiveBelow = 0;

  const callbacks = new Set<SpeakingCallback>();

  function emitChange(newState: boolean): void {
    if (speaking === newState) return;
    speaking = newState;
    for (const cb of callbacks) {
      cb(speaking);
    }
  }

  function tick(): void {
    if (analyser === null) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const rms = computeRms(data);

    if (rms >= threshold) {
      consecutiveAbove++;
      consecutiveBelow = 0;
      if (!speaking && consecutiveAbove >= minConsecutive) {
        emitChange(true);
      }
    } else {
      consecutiveBelow++;
      consecutiveAbove = 0;
      if (speaking && consecutiveBelow >= silenceRequired) {
        emitChange(false);
      }
    }
  }

  function cleanup(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (sourceNode !== null) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (analyser !== null) {
      analyser.disconnect();
      analyser = null;
    }
    if (audioContext !== null) {
      void audioContext.close();
      audioContext = null;
    }
    consecutiveAbove = 0;
    consecutiveBelow = 0;
    if (speaking) {
      emitChange(false);
    }
  }

  return {
    start(stream: MediaStream): void {
      if (destroyed) throw new Error("VadDetector has been destroyed");
      // Stop any existing monitoring first
      cleanup();

      // Force 48kHz so FFT bins cover the voice-frequency range (0-24kHz)
      // consistently regardless of the system audio device's native rate.
      // At high native rates (e.g. 192kHz), most bins would be above voice
      // frequencies, making the RMS calculation artificially low.
      audioContext = new AudioContext({ sampleRate: 48000 });
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;

      sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNode.connect(analyser);

      intervalId = setInterval(tick, intervalMs);
      log.debug("VAD started", { threshold, intervalMs, minConsecutive, sampleRate: audioContext.sampleRate });
    },

    stop(): void {
      if (destroyed) return;
      cleanup();
    },

    setThreshold(newThreshold: number): void {
      if (newThreshold < 0 || newThreshold > 1) {
        throw new Error("Threshold must be between 0 and 1");
      }
      log.debug("VAD threshold changed", { old: threshold, new: newThreshold });
      threshold = newThreshold;
    },

    onSpeakingChange(callback: SpeakingCallback): () => void {
      callbacks.add(callback);
      return () => { callbacks.delete(callback); };
    },

    isSpeaking(): boolean {
      return speaking;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cleanup();
      callbacks.clear();
      log.debug("VAD destroyed");
    },
  };
}
