// AudioPipeline — unified audio pipeline: input volume + VAD gating
//
// Architecture:
//   rawMicTrack → AudioContext source
//       ├──→ AnalyserNode (VAD reads raw audio here — always sees real signal)
//       └──→ GainNode (inputVolume × vadGate) → MediaStreamDestination → WebRTC sender
//
// The pipeline is always active while in a voice session. This avoids
// creating/destroying it when volume changes, and gives the VAD a stable
// analyser that's independent of LiveKit's track lifecycle.

import { Track, type Room, type LocalAudioTrack } from "livekit-client";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { createRNNoiseProcessor } from "@lib/noise-suppression";

const log = createLogger("audioPipeline");

export class AudioPipeline {
  private room: Room | null = null;

  // Pipeline nodes
  private audioPipelineCtx: AudioContext | null = null;
  private audioPipelineGain: GainNode | null = null;
  private audioPipelineAnalyser: AnalyserNode | null = null;
  private audioPipelineDest: MediaStreamAudioDestinationNode | null = null;
  private vadTimer: ReturnType<typeof setTimeout> | null = null;
  /** When true, mic is currently gated (muted by VAD — gain set to 0). */
  private vadGated = false;
  /** The user's input volume gain (0-2.0). VAD multiplies this by 0 or 1. */
  private currentInputGain = 1.0;

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

  /** Attach RNNoise processor to the local mic track. Safe to call if already attached. */
  async applyNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    if (micPub.track.getProcessor() !== undefined) return;
    const processor = createRNNoiseProcessor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LocalTrack.setProcessor uses wide generic, but AudioProcessorOptions is guaranteed at runtime with webAudioMix
    await micPub.track.setProcessor(processor as any);
    log.info("RNNoise processor attached to mic track");
  }

  /** Remove RNNoise processor from the local mic track. Safe to call if none attached. */
  async removeNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    if (micPub.track.getProcessor() === undefined) return;
    await micPub.track.stopProcessor();
    log.info("RNNoise processor removed from mic track");
  }

  // --- Pipeline setup/teardown ---

  /** Build or rebuild the audio pipeline on the current mic track. */
  setupAudioPipeline(): void {
    this.teardownAudioPipeline();
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;

    try {
      const mediaTrack = micPub.track.mediaStreamTrack;
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

      // Wire: source → analyser (tap) and source → gain → dest
      source.connect(analyser);
      source.connect(gainNode);
      gainNode.connect(dest);

      this.audioPipelineCtx = ctx;
      this.audioPipelineGain = gainNode;
      this.audioPipelineAnalyser = analyser;
      this.audioPipelineDest = dest;

      // Replace the WebRTC sender's track with the pipeline output
      const adjustedTrack = dest.stream.getAudioTracks()[0];
      if (adjustedTrack !== undefined && micPub.track.sender) {
        void micPub.track.sender.replaceTrack(adjustedTrack).catch((err) => {
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
    this.stopVadPolling();

    // Restore original mic track on the WebRTC sender
    if (this.room !== null) {
      const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (micPub?.track?.sender !== undefined) {
        const originalTrack = micPub.track.mediaStreamTrack;
        void micPub.track.sender.replaceTrack(originalTrack).catch((err) => log.debug("Failed to replace track during teardown", err));
      }
    }

    if (this.audioPipelineGain !== null) { this.audioPipelineGain.disconnect(); this.audioPipelineGain = null; }
    if (this.audioPipelineAnalyser !== null) { this.audioPipelineAnalyser.disconnect(); this.audioPipelineAnalyser = null; }
    if (this.audioPipelineDest !== null) { this.audioPipelineDest.disconnect(); this.audioPipelineDest = null; }
    if (this.audioPipelineCtx !== null) { void this.audioPipelineCtx.close(); this.audioPipelineCtx = null; }
    this.vadGated = false;
  }

  /** Update the effective gain on the pipeline (inputVolume × vadGate).
   *  The pipeline only exists when unmuted — muting tears it down entirely. */
  updatePipelineGain(): void {
    if (this.audioPipelineGain === null || this.audioPipelineCtx === null) return;
    const effectiveGain = this.vadGated ? 0 : this.currentInputGain;
    this.audioPipelineGain.gain.setTargetAtTime(effectiveGain, this.audioPipelineCtx.currentTime, 0.015);
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
    savePref("voiceSensitivity", clamped);
    // Restart VAD polling with the new threshold (pipeline stays intact)
    this.stopVadPolling();
    if (clamped >= 100) {
      // Ensure ungated
      if (this.vadGated) { this.vadGated = false; this.updatePipelineGain(); }
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
  get lastVadRms(): number { return this._lastVadRms; }
  /** Whether VAD is using AudioWorklet (true) or setTimeout fallback (false). */
  get vadUsingWorklet(): boolean { return this._vadUsingWorklet; }

  /** Start VAD — tries AudioWorklet first, falls back to setTimeout polling. */
  startVadPolling(): void {
    this.stopVadPolling();
    if (this.audioPipelineCtx === null || this.audioPipelineAnalyser === null) return;

    const sensitivity = loadPref<number>("voiceSensitivity", 50);
    if (sensitivity >= 100) return;

    const threshold = ((100 - sensitivity) / 100) * 0.10;

    // Try AudioWorklet first
    this.audioPipelineCtx.audioWorklet.addModule("/vad-worklet.js").then(() => {
      if (this.audioPipelineCtx === null) return; // Torn down while loading
      this.startVadWorklet(threshold);
    }).catch((err) => {
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

      workletNode.port.postMessage({ type: "config", threshold });

      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "gate") {
          const gated = event.data.gated as boolean;
          if (gated !== this.vadGated) {
            this.vadGated = gated;
            this.updatePipelineGain();
          }
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
        if (!this.vadGated && silentFrames >= GATE_ON_FRAMES) {
          this.vadGated = true;
          this.updatePipelineGain();
        }
      } else {
        silentFrames = 0;
        speechFrames++;
        if (this.vadGated && speechFrames >= GATE_OFF_FRAMES) {
          this.vadGated = false;
          this.updatePipelineGain();
        }
      }

      this.vadTimer = setTimeout(poll, 16);
    };
    this.vadTimer = setTimeout(poll, 16);
    this._vadUsingWorklet = false;
    log.info("VAD setTimeout fallback started", { threshold });
  }

  /** Stop VAD (both worklet and fallback). Pipeline stays intact. */
  stopVadPolling(): void {
    // Stop setTimeout fallback
    if (this.vadTimer !== null) {
      clearTimeout(this.vadTimer);
      this.vadTimer = null;
    }
    // Stop AudioWorklet
    if (this.vadWorkletNode !== null) {
      this.vadWorkletNode.port.postMessage({ type: "stop" });
      this.vadWorkletNode.disconnect();
      this.vadWorkletNode = null;
    }
    this._vadUsingWorklet = false;
    this._lastVadRms = 0;
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

    const captureOptions = {
      echoCancellation: loadPref("echoCancellation", true),
      noiseSuppression: loadPref("noiseSuppression", true),
      autoGainControl: loadPref("autoGainControl", true),
    };

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
      } else {
        await this.removeNoiseSuppressor();
      }
    } catch (err) {
      log.error("Failed to reapply audio processing", err);
      onError?.("Failed to update audio settings");
    }
  }
}
