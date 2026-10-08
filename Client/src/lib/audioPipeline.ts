// AudioPipeline — owns the microphone's MicProcessor (lib/micProcessor.ts)
// and the voice detector that drives its gate.
//
// The processor is attached to the LocalAudioTrack before its first publish
// (MediaControl.enableMicrophone → attach) and stays on it for the track's
// life: livekit-client's mute, unmute, device switch, processing restart and
// full-reconnect republish all keep it, so the sender only ever carries the
// processor's gated output. This class holds the settings (input volume,
// sensitivity, push-to-talk) and re-applies them to whichever processor is
// live, runs the VAD worklet on the processor's tap, and mirrors the
// Enhanced Noise Suppression preference into it. The Linux native room has
// no web mic track and so no processor: push-to-talk goes to its own gate.

import { Track, type Room, type LocalAudioTrack } from "livekit-client";
import { loadPref, savePref } from "@lib/preferences";
import { createLogger } from "@lib/logger";
import {
  createMicProcessor,
  GATE_LOOKAHEAD_S,
  workletStopped,
  type MicProcessor,
} from "@lib/micProcessor";
import { voiceText } from "../i18n/voice";

const log = createLogger("audioPipeline");

/** The gate threshold at sensitivity 0, as the RMS of one 128-sample render
 *  quantum. The settings meter draws its level on this same scale. */
export const VAD_MAX_THRESHOLD = 0.1;

/** The RMS a render quantum must reach to count as speech at `sensitivity`
 *  (0-100). 100 is no gate at all. */
export function vadThreshold(sensitivity: number): number {
  return ((100 - sensitivity) / 100) * VAD_MAX_THRESHOLD;
}

/**
 * The microphone capture request: the processing toggles and the chosen input
 * device. A restart takes the whole request, so one that names no device
 * reopens the system default; the settings meter uses the same request so it
 * measures what the call captures. The device is `exact`, as in
 * switchActiveDevice: Chromium resolves a merely preferred device id to the
 * default device. `onDefault` swaps a saved device for the system default,
 * for a retry while that device is unplugged (the pref keeps it, DP-31).
 */
export function micCaptureOptions(onDefault = false): {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  deviceId?: { exact: string } | string;
} {
  const deviceId = loadPref<string>("audioInputDevice", "");
  return {
    echoCancellation: loadPref("echoCancellation", true),
    noiseSuppression: loadPref("noiseSuppression", true),
    autoGainControl: loadPref("autoGainControl", true),
    ...(deviceId === "" ? {} : { deviceId: onDefault ? "default" : { exact: deviceId } }),
  };
}

/** True when a capture request failed because its exact device is not
 *  there (unplugged), so a retry with `micCaptureOptions(true)` can help. */
export function isMissingDeviceError(err: unknown, options: { deviceId?: unknown }): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return (
    options.deviceId !== undefined && (name === "OverconstrainedError" || name === "NotFoundError")
  );
}

export interface VadDetector {
  /** Resolves once the worklet has stopped: only then may its context close. */
  stop(): Promise<void>;
  /** Move the threshold without restarting; the attack/hold state carries on. */
  setThreshold(threshold: number): void;
}

export interface VadDetectorHandlers {
  /** The gate verdict: true = closed (silence). */
  onGate(gated: boolean): void;
  /** The loudest quantum since the last report, for a level meter. */
  onRms?(rms: number): void;
  /** Which path is running once it has started. */
  onStarted?(usingWorklet: boolean): void;
}

/**
 * Run the voice detector over `analyser`: the AudioWorklet (vad-worklet.js)
 * when it loads, otherwise a setTimeout poll with the same timing. Both apply
 * the same attack (~32 ms) and hold (~200 ms), so the settings meter and the
 * live gate open and close alike.
 */
export function startVadDetector(
  ctx: AudioContext,
  analyser: AnalyserNode,
  initialThreshold: number,
  handlers: VadDetectorHandlers,
): VadDetector {
  let threshold = initialThreshold;
  let stopped = false;
  let workletNode: AudioWorkletNode | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const startFallback = (): void => {
    // setTimeout instead of rAF: rAF pauses when the Tauri window is
    // backgrounded, which freezes the VAD gate. setTimeout continues firing
    // (throttled ~1Hz when hidden), still fast enough for VAD gate timing.
    const dataArray = new Float32Array(analyser.fftSize);
    let silentFrames = 0;
    let speechFrames = 0;
    let gated = false;
    const GATE_ON_FRAMES = 12;
    const GATE_OFF_FRAMES = 2;
    let startupFrames = 0;
    const STARTUP_GRACE = 30;
    let frameCounter = 0;
    const poll = (): void => {
      if (stopped) return;
      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      frameCounter++;
      if (frameCounter >= 3) {
        frameCounter = 0;
        handlers.onRms?.(rms);
      }
      if (startupFrames < STARTUP_GRACE) {
        startupFrames++;
      } else if (rms < threshold) {
        speechFrames = 0;
        silentFrames++;
        if (!gated && silentFrames >= GATE_ON_FRAMES) {
          gated = true;
          handlers.onGate(true);
        }
      } else {
        silentFrames = 0;
        speechFrames++;
        if (gated && speechFrames >= GATE_OFF_FRAMES) {
          gated = false;
          handlers.onGate(false);
        }
      }
      timer = setTimeout(poll, 16);
    };
    timer = setTimeout(poll, 16);
    handlers.onStarted?.(false);
    log.info("VAD setTimeout fallback started", { threshold });
  };

  ctx.audioWorklet
    .addModule("/vad-worklet.js")
    .then(() => {
      if (stopped) return;
      try {
        workletNode = new AudioWorkletNode(ctx, "vad-processor");
      } catch (err) {
        log.warn("Failed to create VAD AudioWorkletNode, falling back", err);
        startFallback();
        return;
      }
      // Analysis only: the worklet's output goes nowhere.
      analyser.connect(workletNode);
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      workletNode.port.postMessage({ type: "config", threshold });
      // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "gate") handlers.onGate(event.data.gated as boolean);
        else if (event.data.type === "rms") handlers.onRms?.(event.data.value as number);
      };
      handlers.onStarted?.(true);
      log.info("VAD AudioWorklet started", { threshold });
    })
    .catch((err) => {
      if (stopped) return;
      log.warn("AudioWorklet unavailable, falling back to setTimeout VAD", err);
      startFallback();
    });

  const stop = (): Promise<void> => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    const node = workletNode;
    if (node === null) return Promise.resolve();
    workletNode = null;
    // Swap the handler first — the worklet's `process()` loop only observes
    // `stop` on its next audio-thread callback, so it can still post one more
    // {type:"gate"} message after this postMessage (OC-0231).
    const done = workletStopped(node);
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
    node.port.postMessage({ type: "stop" });
    node.disconnect();
    return done;
  };
  return {
    stop,
    setThreshold(next: number): void {
      threshold = next;
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      workletNode?.port.postMessage({ type: "config", threshold });
    },
  };
}

/** A room that gates its own capture for push-to-talk: the Linux NativeRoom,
 *  whose microphone is the Rust session's and never has a web processor. */
interface PttGatedRoom {
  setPttGated(gated: boolean): void;
}

export class AudioPipeline {
  private room: Room | null = null;
  private processor: MicProcessor | null = null;
  /** Bumped on every teardown so an attach that outlived it is discarded. */
  private generation = 0;
  private vad: VadDetector | null = null;
  private vadGated = false;
  private pttGated = false;
  private _lastVadRms = 0;
  private _vadUsingWorklet = false;
  private currentInputGain = loadPref<number>("inputVolume", 100) / 100;
  /** Last value passed to setVoiceSensitivity, so a repeat does not rebuild VAD. */
  private voiceSensitivity: number | null = null;

  /** The local speaking verdict straight from the sensitivity gate: true while
   *  it is open, false while closed, null when no gate runs. Drives the local
   *  ring so it matches the slider and what transmits. */
  onGateSpeaking: ((speaking: boolean | null) => void) | null = null;

  setRoom(room: Room | null): void {
    this.room = room;
  }

  /** Whether a mic processor is live. */
  get isActive(): boolean {
    return this.processor !== null;
  }

  /** Current gain value from the processor's GainNode, or null if inactive. */
  get gainValue(): number | null {
    return this.processor?.gainValue ?? null;
  }

  /** Current AudioContext state, or null if inactive. */
  get ctxState(): string | null {
    return this.processor?.context.state ?? null;
  }

  /** Whether VAD is currently gating audio. */
  get isVadGated(): boolean {
    return this.vadGated;
  }

  /** Whether push-to-talk is currently gating audio. */
  get isPttGated(): boolean {
    return this.pttGated;
  }

  /** Current input gain multiplier. */
  get inputGain(): number {
    return this.currentInputGain;
  }

  /** Latest RMS value from VAD (for UI indicator bar). */
  get lastVadRms(): number {
    return this._lastVadRms;
  }

  /** Whether VAD is using AudioWorklet (true) or setTimeout fallback (false). */
  get vadUsingWorklet(): boolean {
    return this._vadUsingWorklet;
  }

  private get micTrack(): LocalAudioTrack | undefined {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    return pub?.track as LocalAudioTrack | undefined;
  }

  // --- Attach / detach ---

  /**
   * Put the processor on `track` before it is published, and apply every
   * setting to it. Throws when the SDK refuses the processor: the caller
   * treats that as a microphone failure rather than publishing raw audio.
   */
  async attach(track: LocalAudioTrack): Promise<void> {
    if (this.processor !== null && track.getProcessor() === this.processor) return;
    this.teardownAudioPipeline();
    const gen = this.generation;
    const processor = createMicProcessor();
    processor.setInputGain(this.currentInputGain);
    processor.setGate("ptt", this.pttGated);
    track.setAudioContext(processor.context);
    await track.setProcessor(processor);
    if (gen !== this.generation) {
      // Torn down while attaching: the track keeps a processor it will
      // destroy with itself, but this pipeline no longer drives it.
      return;
    }
    this.processor = processor;
    log.info("Mic processor attached", { inputGain: this.currentInputGain });
    this.startVadPolling();
    await this.applyEnhancedPreference();
  }

  /** Attach to the current microphone track when it has no live processor. */
  setupAudioPipeline(): void {
    const track = this.micTrack;
    if (track === undefined) return;
    if (this.processor !== null && track.getProcessor() === this.processor) return;
    this.attach(track).catch((err) => log.warn("Mic processor attach failed", err));
  }

  /** Drop the processor, closing its context once the detector's worklet has
   *  stopped. A live track keeps publishing its (now settings-less) output
   *  until reattached. */
  teardownAudioPipeline(): void {
    this.generation++;
    const vadStopped = this.stopVadPolling();
    const processor = this.processor;
    if (processor !== null) {
      this.processor = null;
      void vadStopped.then(() => processor.destroy());
    }
  }

  // --- Enhanced Noise Suppression ---

  private async applyEnhancedPreference(): Promise<void> {
    const processor = this.processor;
    if (processor === null) return;
    await processor.setEnhanced(loadPref<boolean>("enhancedNoiseSuppression", false));
  }

  /** Route the live processor through or around RNNoise for the saved
   *  preference. The capture is not touched. */
  async reapplyEnhancedNoiseSuppression(onError?: (message: string) => void): Promise<void> {
    const processor = this.processor;
    if (processor === null) return;
    await this.applyEnhancedPreference();
    // The user just asked for it: say so when it could not start.
    if (loadPref<boolean>("enhancedNoiseSuppression", false) && !processor.enhanced) {
      onError?.(voiceText("audio.settingsFailed"));
    }
  }

  // --- Volume / gates ---

  setInputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("inputVolume", clamped);
    this.currentInputGain = clamped / 100;
    this.processor?.setInputGain(this.currentInputGain);
  }

  /** Close (true) or open (false) the push-to-talk gate. It is applied to the
   *  live processor and to every one attached later, so a press or release
   *  never touches the capture device or the SDK's mute. A room that gates
   *  its own capture (NativeRoom) gets it too. */
  setPttGated(gated: boolean): void {
    this.pttGated = gated;
    this.processor?.setGate("ptt", gated);
    (this.room as Partial<PttGatedRoom> | null)?.setPttGated?.(gated);
  }

  /**
   * Apply voice sensitivity as a client-side VAD gate.
   * Sensitivity 0 = gate everything (threshold impossibly high).
   * Sensitivity 100 = gate nothing (no VAD polling).
   */
  setVoiceSensitivity(sensitivity: number): void {
    const clamped = Math.max(0, Math.min(100, sensitivity));
    if (clamped === this.voiceSensitivity) return;
    this.voiceSensitivity = clamped;
    savePref("voiceSensitivity", clamped);
    this.startVadPolling();
    log.debug("Voice sensitivity updated", { sensitivity: clamped });
  }

  // --- VAD ---

  /** (Re)start the detector on the live processor for the saved sensitivity. */
  startVadPolling(): void {
    void this.stopVadPolling();
    const processor = this.processor;
    if (processor === null || processor.analyser === null) return;
    const sensitivity = loadPref<number>("voiceSensitivity", 50);
    if (sensitivity >= 100) {
      processor.setLookahead(0);
      return;
    }
    processor.setLookahead(GATE_LOOKAHEAD_S);
    this.onGateSpeaking?.(false);
    this.vad = startVadDetector(processor.context, processor.analyser, vadThreshold(sensitivity), {
      onGate: (gated) => {
        if (this.processor !== processor) return;
        this.vadGated = gated;
        processor.setGate("vad", gated);
        this.onGateSpeaking?.(!gated);
      },
      onRms: (rms) => {
        this._lastVadRms = rms;
      },
      onStarted: (usingWorklet) => {
        this._vadUsingWorklet = usingWorklet;
      },
    });
  }

  /** Stop the detector and open its gate. The processor stays. Resolves once
   *  the detector's worklet has stopped. */
  stopVadPolling(): Promise<void> {
    const stopped = this.vad?.stop() ?? Promise.resolve();
    this.vad = null;
    this._vadUsingWorklet = false;
    this._lastVadRms = 0;
    this.vadGated = false;
    this.processor?.setGate("vad", false);
    this.onGateSpeaking?.(null);
    return stopped;
  }

  /**
   * Re-apply the browser's capture processing (echo cancellation, noise
   * suppression, AGC) to the live mic track. The SDK restarts the capture and
   * keeps the processor, whose output stays on the sender.
   */
  async reapplyAudioProcessing(onError?: (message: string) => void): Promise<void> {
    if (this.room === null) {
      log.debug("Skipping audio processing reapply — no active voice session");
      return;
    }
    const track = this.micTrack;
    if (track === undefined) {
      log.debug("Skipping audio processing reapply — no mic track");
      return;
    }
    const captureOptions = micCaptureOptions();
    try {
      // restartTrack re-acquires the mic with new constraints without unpublishing
      await track.restartTrack(captureOptions).catch((err: unknown) => {
        if (!isMissingDeviceError(err, captureOptions)) throw err;
        return track.restartTrack(micCaptureOptions(true));
      });
      log.info("Audio processing reapplied via restartTrack", captureOptions);
    } catch (err) {
      log.error("Failed to reapply audio processing", err);
      onError?.(voiceText("audio.settingsFailed"));
    }
  }
}
