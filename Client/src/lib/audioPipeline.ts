// AudioPipeline — unified audio pipeline: input volume + VAD gating
//
// Architecture:
//   rawMicTrack → AudioContext source
//       ├──→ AnalyserNode (VAD reads raw audio here — always sees real signal)
//       └──→ DelayNode (gate lookahead) → GainNode (inputVolume × vadGate)
//                → MediaStreamDestination → WebRTC sender
//
// The pipeline is always active while in a voice session. This avoids
// creating/destroying it when volume changes, and gives the VAD a stable
// analyser that's independent of LiveKit's track lifecycle.

import { Track, type Room, type LocalAudioTrack } from "livekit-client";
import { loadPref, savePref } from "@lib/preferences";
import { createLogger } from "@lib/logger";
import { createRNNoiseProcessor } from "@lib/noise-suppression";
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

/** How far the voice path runs behind the detector while the gate is on. The
 *  gate opens only after ~32 ms of sustained level (vad-worklet.js), which is
 *  what keeps a mouse click from opening it; the delay covers that wait and
 *  the opening ramp, so the start of a word is not cut off. */
const GATE_LOOKAHEAD_S = 0.05;
/** Gain smoothing: opening has to finish inside the lookahead. */
const GATE_OPEN_TIME_CONSTANT_S = 0.005;
const GAIN_TIME_CONSTANT_S = 0.015;

/**
 * The microphone capture request: the processing toggles and the chosen input
 * device. A restart takes the whole request, so one that names no device
 * reopens the system default; the settings meter uses the same request so it
 * measures what the call captures. The device is `exact`, as in
 * switchActiveDevice: Chromium resolves a merely preferred device id to the
 * default device.
 */
export function micCaptureOptions(): {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  deviceId?: { exact: string };
} {
  const deviceId = loadPref<string>("audioInputDevice", "");
  return {
    echoCancellation: loadPref("echoCancellation", true),
    noiseSuppression: loadPref("noiseSuppression", true),
    autoGainControl: loadPref("autoGainControl", true),
    ...(deviceId === "" ? {} : { deviceId: { exact: deviceId } }),
  };
}

/** Upper bound on waiting for the VAD processor's `stopped`; a context that
 *  is not rendering (suspended) never calls process() again. */
const VAD_STOP_CLOSE_TIMEOUT_MS = 1000;

/**
 * Close the pipeline's AudioContext once its VAD processor has stopped.
 * Chromium keeps an AudioWorkletNode, and with it the AudioContext, alive until
 * the processor's process() returns false. Closing in the same task as `stop`
 * ends rendering before the processor sees it, which pinned one closed
 * AudioContext per voice join for the page's lifetime.
 */
function closeAfterVadStops(ctx: AudioContext, vadNode: AudioWorkletNode | null): void {
  if (vadNode === null) {
    void ctx.close();
    return;
  }
  const close = () => {
    clearTimeout(timer);
    // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
    vadNode.port.onmessage = null;
    void ctx.close();
  };
  const timer = setTimeout(close, VAD_STOP_CLOSE_TIMEOUT_MS);
  // Only `stopped` is acted on: a late `gate` must not re-gate a torn-down
  // pipeline (OC-0231).
  // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
  vadNode.port.onmessage = (event: MessageEvent) => {
    if ((event.data as { type?: string }).type === "stopped") close();
  };
}

export class AudioPipeline {
  private room: Room | null = null;

  /** Monotonic counter incremented on teardown — used to discard stale async results. */
  private _pipelineGeneration = 0;
  /** Monotonic counter incremented on stopVadPolling — narrower than
   *  _pipelineGeneration (which only bumps on a full pipeline teardown), so it
   *  also invalidates an in-flight startVadPolling()'s addModule when VAD is
   *  stopped without tearing down the pipeline (e.g. setVoiceSensitivity(100)). */
  private _vadGeneration = 0;

  // Pipeline nodes
  private audioPipelineCtx: AudioContext | null = null;
  private audioPipelineGain: GainNode | null = null;
  private audioPipelineDelay: DelayNode | null = null;
  private audioPipelineAnalyser: AnalyserNode | null = null;
  private audioPipelineDest: MediaStreamAudioDestinationNode | null = null;
  private vadTimer: ReturnType<typeof setTimeout> | null = null;
  /** When true, mic is currently gated (muted by VAD — gain set to 0). */
  private vadGated = false;
  /** The user's input volume gain (0-2.0). VAD multiplies this by 0 or 1. */
  private currentInputGain = 1.0;
  /** Last value passed to setVoiceSensitivity, so a repeat does not rebuild VAD. */
  private voiceSensitivity: number | null = null;

  setRoom(room: Room | null): void {
    this.room = room;
  }

  /** Whether the audio pipeline is currently active (has a GainNode). */
  get isActive(): boolean {
    return this.audioPipelineGain !== null;
  }

  /** Current gain value from the pipeline GainNode, or null if inactive. */
  get gainValue(): number | null {
    return this.audioPipelineGain?.gain.value ?? null;
  }

  /** Current AudioContext state, or null if inactive. */
  get ctxState(): string | null {
    return this.audioPipelineCtx?.state ?? null;
  }

  /** Whether VAD is currently gating audio. */
  get isVadGated(): boolean {
    return this.vadGated;
  }

  /** Current input gain multiplier. */
  get inputGain(): number {
    return this.currentInputGain;
  }

  // --- RNNoise processor (LiveKit TrackProcessor API) ---

  /**
   * Attach RNNoise processor to the local mic track. Safe to call if already
   * attached. A no-op while the track is muted (its capture is stopped); the
   * unmute path in MediaControl.applyMicMuteState attaches it instead.
   * Never rejects when the processor cannot start: the microphone stays
   * published unprocessed, and callers await this beside the publish itself,
   * where a rejection reads as a microphone failure.
   */
  async applyNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    if (micPub.track.isMuted) return;
    if (micPub.track.getProcessor() !== undefined) return;
    const processor = createRNNoiseProcessor();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LocalTrack.setProcessor uses wide generic, but AudioProcessorOptions is guaranteed at runtime with webAudioMix
      await micPub.track.setProcessor(processor as any);
    } catch (err) {
      log.warn("RNNoise processor failed to start — microphone stays unprocessed", err);
      return;
    }
    log.info("RNNoise processor attached to mic track");
    // Rebuild so the gain/VAD chain sources from the processor's output and
    // its own sender.replaceTrack runs last, winning over setProcessor's
    // internal replaceTrack to the raw processed track (B3-1).
    this.setupAudioPipeline();
  }

  /** Remove RNNoise processor from the local mic track. Safe to call if none attached. */
  async removeNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    if (micPub.track.getProcessor() === undefined) return;
    await micPub.track.stopProcessor();
    log.info("RNNoise processor removed from mic track");
    // Rebuild so the sender ends back on the gain/VAD chain over the raw mic,
    // not whatever track stopProcessor's own internals left wired (B3-1).
    this.setupAudioPipeline();
  }

  // --- Pipeline setup/teardown ---

  /** Build or rebuild the audio pipeline on the current mic track. */
  setupAudioPipeline(): void {
    this.teardownAudioPipeline();
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    // OC-0474: the pipeline only exists when unmuted. Muting stops the capture
    // track, so building here (a device switch, a permission retry, a
    // reconnect while muted) would run a context and VAD over an ended track
    // until the next unmute, which rebuilds it on the fresh track anyway.
    if (micPub.track.isMuted) return;

    try {
      // Source from the NS processor's output when one is attached, not the
      // raw mic track — livekit-client's LocalTrack.setProcessor() does its
      // own (internal, unawaited) sender.replaceTrack(processedTrack) once
      // the worklet loads, and that call lands AFTER this one (it awaits
      // addModule+fetch first). Sourcing from mediaStreamTrack unconditionally
      // meant that call always won, silently rewiring the sender straight to
      // the raw mic and bypassing this pipeline's gain/VAD entirely (B3-1).
      const mediaTrack =
        micPub.track.getProcessor()?.processedTrack ?? micPub.track.mediaStreamTrack;
      const ctx = new AudioContext({ sampleRate: 48000 });
      void ctx.resume(); // Ensure not suspended (WebView2 autoplay policy)

      const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));

      // Analyser: VAD reads time-domain data from here (always real audio)
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;

      // GainNode: controls both input volume and VAD gating
      const gainNode = ctx.createGain();
      this.currentInputGain = loadPref<number>("inputVolume", 100) / 100;
      gainNode.gain.setValueAtTime(this.currentInputGain, ctx.currentTime);

      const dest = ctx.createMediaStreamDestination();

      // Lookahead for the gate; zero until VAD starts.
      const delay = ctx.createDelay(GATE_LOOKAHEAD_S);
      delay.delayTime.value = 0;

      // Wire: source → analyser (tap) and source → delay → gain → dest
      source.connect(analyser);
      source.connect(delay);
      delay.connect(gainNode);
      gainNode.connect(dest);

      this.audioPipelineCtx = ctx;
      this.audioPipelineGain = gainNode;
      this.audioPipelineDelay = delay;
      this.audioPipelineAnalyser = analyser;
      this.audioPipelineDest = dest;

      // Replace the WebRTC sender's track with the pipeline output.
      // BUG-106: Guard with generation counter to discard stale replaceTrack
      // if teardown races ahead of this setup.
      const adjustedTrack = dest.stream.getAudioTracks()[0];
      const gen = this._pipelineGeneration;
      if (adjustedTrack !== undefined && micPub.track.sender) {
        void micPub.track.sender
          .replaceTrack(adjustedTrack)
          .then(() => {
            if (this._pipelineGeneration !== gen) {
              log.debug("replaceTrack (setup) completed after generation change — stale");
            }
          })
          .catch((err) => {
            log.warn("Failed to replace sender track with pipeline output", err);
          });
      }

      log.info("Audio pipeline created", { inputGain: this.currentInputGain });

      // Start VAD polling if sensitivity < 100
      this.startVadPolling();
    } catch (err) {
      log.warn("Failed to set up audio pipeline", err);
    }
  }

  /** Tear down the audio pipeline and restore the original sender track. */
  teardownAudioPipeline(): void {
    this._pipelineGeneration++;
    const vadNode = this.vadWorkletNode;
    this.stopVadPolling();

    // Restore original mic track on the WebRTC sender.
    // BUG-106: Guard with generation counter so a stale teardown replaceTrack
    // cannot overwrite a subsequent setup's pipeline track.
    const gen = this._pipelineGeneration;
    if (this.room !== null) {
      const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (micPub?.track?.sender !== undefined) {
        // Restore to the NS processor's output when one is still attached, not
        // the raw mic — otherwise tearing down just the gain/VAD wrapper (e.g.
        // muting) would also silently bypass an active noise suppressor (B3-1).
        const originalTrack =
          micPub.track.getProcessor()?.processedTrack ?? micPub.track.mediaStreamTrack;
        void micPub.track.sender
          .replaceTrack(originalTrack)
          .then(() => {
            if (this._pipelineGeneration !== gen) {
              log.debug("replaceTrack (teardown) completed after generation change — stale");
            }
          })
          .catch((err) => log.debug("Failed to replace track during teardown", err));
      }
    }

    if (this.audioPipelineGain !== null) {
      this.audioPipelineGain.disconnect();
      this.audioPipelineGain = null;
    }
    if (this.audioPipelineDelay !== null) {
      this.audioPipelineDelay.disconnect();
      this.audioPipelineDelay = null;
    }
    if (this.audioPipelineAnalyser !== null) {
      this.audioPipelineAnalyser.disconnect();
      this.audioPipelineAnalyser = null;
    }
    if (this.audioPipelineDest !== null) {
      this.audioPipelineDest.disconnect();
      this.audioPipelineDest = null;
    }
    if (this.audioPipelineCtx !== null) {
      closeAfterVadStops(this.audioPipelineCtx, vadNode);
      this.audioPipelineCtx = null;
    }
    this.vadGated = false;
  }

  /** Update the effective gain on the pipeline (inputVolume × vadGate).
   *  The pipeline only exists when unmuted — muting tears it down entirely. */
  updatePipelineGain(timeConstant = GAIN_TIME_CONSTANT_S): void {
    if (this.audioPipelineGain === null || this.audioPipelineCtx === null) return;
    const effectiveGain = this.vadGated ? 0 : this.currentInputGain;
    this.audioPipelineGain.gain.setTargetAtTime(
      effectiveGain,
      this.audioPipelineCtx.currentTime,
      timeConstant,
    );
  }

  /** Apply a detector verdict: close gently, open inside the lookahead. */
  private setVadGated(gated: boolean): void {
    if (gated === this.vadGated) return;
    this.vadGated = gated;
    this.updatePipelineGain(gated ? GAIN_TIME_CONSTANT_S : GATE_OPEN_TIME_CONSTANT_S);
  }

  // --- Volume/sensitivity ---

  setInputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("inputVolume", clamped);
    this.currentInputGain = clamped / 100;
    this.updatePipelineGain();
  }

  /**
   * Apply voice sensitivity as a client-side VAD gate.
   * Sensitivity 0 = gate everything (threshold impossibly high).
   * Sensitivity 100 = gate nothing (no VAD polling).
   * VAD sets gain to 0 when gated, restores inputVolume when ungated.
   */
  setVoiceSensitivity(sensitivity: number): void {
    const clamped = Math.max(0, Math.min(100, sensitivity));
    if (clamped === this.voiceSensitivity) return;
    this.voiceSensitivity = clamped;
    savePref("voiceSensitivity", clamped);
    // Restart VAD polling with the new threshold (pipeline stays intact)
    this.stopVadPolling();
    if (clamped >= 100) {
      // Ensure ungated
      if (this.vadGated) {
        this.vadGated = false;
        this.updatePipelineGain();
      }
    } else {
      this.startVadPolling();
    }
    log.debug("Voice sensitivity updated", { sensitivity: clamped });
  }

  // --- VAD (Voice Activity Detection) ---
  //
  // Primary: AudioWorklet (vad-worklet.js) — runs on audio thread, works when
  //          app is backgrounded, zero main-thread CPU.
  // Fallback: setTimeout polling — used if AudioWorklet fails to load.

  private vadWorkletNode: AudioWorkletNode | null = null;
  /** Latest RMS value from VAD worklet, used for UI indicator. */
  private _lastVadRms = 0;
  private _vadUsingWorklet = false;

  /** Latest RMS value from VAD (for UI indicator bar). */
  get lastVadRms(): number {
    return this._lastVadRms;
  }
  /** Whether VAD is using AudioWorklet (true) or setTimeout fallback (false). */
  get vadUsingWorklet(): boolean {
    return this._vadUsingWorklet;
  }

  /** Start VAD — tries AudioWorklet first, falls back to setTimeout polling. */
  startVadPolling(): void {
    this.stopVadPolling();
    if (this.audioPipelineCtx === null || this.audioPipelineAnalyser === null) return;

    const sensitivity = loadPref<number>("voiceSensitivity", 50);
    if (sensitivity >= 100) return;

    const threshold = vadThreshold(sensitivity);
    if (this.audioPipelineDelay !== null)
      this.audioPipelineDelay.delayTime.value = GATE_LOOKAHEAD_S;

    // Try AudioWorklet first
    const gen = this._pipelineGeneration;
    const vadGen = this._vadGeneration;
    this.audioPipelineCtx.audioWorklet
      .addModule("/vad-worklet.js")
      .then(() => {
        if (gen !== this._pipelineGeneration) return; // Torn down while loading
        if (vadGen !== this._vadGeneration) return; // stopVadPolling() while loading
        if (this.audioPipelineCtx === null) return;
        this.startVadWorklet(threshold);
      })
      .catch((err) => {
        if (gen !== this._pipelineGeneration) return;
        if (vadGen !== this._vadGeneration) return;
        log.warn("AudioWorklet unavailable, falling back to setTimeout VAD", err);
        this.startVadFallback(threshold);
      });
  }

  /** Start VAD via AudioWorklet (preferred — runs on audio thread). */
  private startVadWorklet(threshold: number): void {
    if (this.audioPipelineCtx === null) return;

    try {
      const workletNode = new AudioWorkletNode(this.audioPipelineCtx, "vad-processor");

      // Wire: source → analyser → workletNode (workletNode receives audio directly)
      // We connect to the analyser's output so both the analyser and worklet see audio
      if (this.audioPipelineAnalyser !== null) {
        this.audioPipelineAnalyser.connect(workletNode);
      }
      // Don't connect workletNode output to anything — it's analysis-only

      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      workletNode.port.postMessage({ type: "config", threshold });

      // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "gate") {
          this.setVadGated(event.data.gated as boolean);
        } else if (event.data.type === "rms") {
          this._lastVadRms = event.data.value as number;
        }
      };

      this.vadWorkletNode = workletNode;
      this._vadUsingWorklet = true;
      log.info("VAD AudioWorklet started", { threshold });
    } catch (err) {
      log.warn("Failed to create VAD AudioWorkletNode, falling back", err);
      this.startVadFallback(threshold);
    }
  }

  /** Start VAD via setTimeout polling (fallback — works when AudioWorklet unavailable).
   *  setTimeout instead of rAF: rAF pauses when the Tauri window is backgrounded,
   *  which freezes the VAD gate. setTimeout continues firing (throttled ~1Hz when
   *  hidden), still fast enough for VAD gate timing (200ms on, 100ms off). */
  private startVadFallback(threshold: number): void {
    if (this.audioPipelineAnalyser === null) return;

    const analyser = this.audioPipelineAnalyser;
    const dataArray = new Float32Array(analyser.fftSize);
    let silentFrames = 0;
    let speechFrames = 0;
    const GATE_ON_FRAMES = 12;
    const GATE_OFF_FRAMES = 2;
    let startupFrames = 0;
    const STARTUP_GRACE = 30;
    let frameCounter = 0;

    const poll = (): void => {
      if (this.audioPipelineAnalyser === null) return;

      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Send RMS for UI indicator (~50ms interval)
      frameCounter++;
      if (frameCounter >= 3) {
        frameCounter = 0;
        this._lastVadRms = rms;
      }

      if (startupFrames < STARTUP_GRACE) {
        startupFrames++;
        this.vadTimer = setTimeout(poll, 16);
        return;
      }

      if (rms < threshold) {
        speechFrames = 0;
        silentFrames++;
        if (silentFrames >= GATE_ON_FRAMES) this.setVadGated(true);
      } else {
        silentFrames = 0;
        speechFrames++;
        if (speechFrames >= GATE_OFF_FRAMES) this.setVadGated(false);
      }

      this.vadTimer = setTimeout(poll, 16);
    };
    this.vadTimer = setTimeout(poll, 16);
    this._vadUsingWorklet = false;
    log.info("VAD setTimeout fallback started", { threshold });
  }

  /** Stop VAD (both worklet and fallback). Pipeline stays intact. */
  stopVadPolling(): void {
    this._vadGeneration++;
    // Stop setTimeout fallback
    if (this.vadTimer !== null) {
      clearTimeout(this.vadTimer);
      this.vadTimer = null;
    }
    // Stop AudioWorklet
    if (this.vadWorkletNode !== null) {
      // Detach the handler first — the worklet's `process()` loop only
      // observes `stop` on its next audio-thread callback, so it can still
      // post one more {type:"gate"} message after this postMessage but
      // before it does. Leaving onmessage live would let that late message
      // re-gate the mic with no VAD left running to ever un-gate it again
      // (OC-0231).
      // oxlint-disable-next-line prefer-add-event-listener -- the handler above is registered via onmessage, so removeEventListener cannot detach it
      this.vadWorkletNode.port.onmessage = null;
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      this.vadWorkletNode.port.postMessage({ type: "stop" });
      this.vadWorkletNode.disconnect();
      this.vadWorkletNode = null;
    }
    this._vadUsingWorklet = false;
    this._lastVadRms = 0;
    if (this.audioPipelineDelay !== null) this.audioPipelineDelay.delayTime.value = 0;
    // Ungate if was gated
    if (this.vadGated) {
      this.vadGated = false;
      this.updatePipelineGain();
    }
  }

  /**
   * Re-apply audio processing settings (echo cancellation, noise suppression, AGC)
   * to the live mic track by restarting it with updated constraints.
   */
  async reapplyAudioProcessing(onError?: (message: string) => void): Promise<void> {
    if (this.room === null) {
      log.debug("Skipping audio processing reapply — no active voice session");
      return;
    }
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) {
      log.debug("Skipping audio processing reapply — no mic track");
      return;
    }

    const captureOptions = micCaptureOptions();

    try {
      // restartTrack re-acquires the mic with new constraints without unpublishing
      await (micPub.track as LocalAudioTrack).restartTrack(captureOptions);
      log.info("Audio processing reapplied via restartTrack", captureOptions);

      // Rebuild audio pipeline (underlying track changed)
      this.setupAudioPipeline();

      // Re-apply or remove RNNoise processor
      const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
      if (enhancedNS) {
        await this.applyNoiseSuppressor();
        // The user just asked for it: say so when it could not start.
        if (!micPub.track.isMuted && micPub.track.getProcessor() === undefined) {
          onError?.(voiceText("audio.settingsFailed"));
        }
      } else {
        await this.removeNoiseSuppressor();
      }
    } catch (err) {
      log.error("Failed to reapply audio processing", err);
      onError?.(voiceText("audio.settingsFailed"));
    }
  }
}
