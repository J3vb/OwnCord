// MicProcessor — the microphone's whole outbound chain as one livekit-client
// TrackProcessor:
//
//   capture track → [RNNoise] ─┬→ AnalyserNode (the voice detector's tap)
//                              └→ DelayNode (gate lookahead) → GainNode
//                                   (inputVolume × voice gate × push-to-talk)
//                                   → MediaStreamDestination = processedTrack
//
// livekit-client publishes, republishes and restarts a track through
// `track.mediaStreamTrack`, which is `processor.processedTrack` whenever a
// processor is attached, and its own restart() keeps the processor and swaps
// only the capture track. So once this is attached before the first publish,
// every sender swap the SDK makes on its own (device change, hot-plug, a
// processing toggle, a device-ended restart, a full-reconnect republish)
// carries the gated output: raw or pre-gate audio never reaches the sender.
//
// The graph runs in its own 48 kHz AudioContext: RNNoise needs 48 kHz, and
// the SDK's restart() call site sends no audioContext (OC-0277).

import type { Track, TrackProcessor, AudioProcessorOptions } from "livekit-client";
import { createLogger } from "@lib/logger";
import { createRNNoiseNode, type RNNoiseNode } from "@lib/noise-suppression";

const log = createLogger("micProcessor");

/** How far the voice runs behind the detector while the gate is on. The gate
 *  opens only after ~32 ms of sustained level (vad-worklet.js), which is what
 *  keeps a mouse click from opening it; the delay covers that wait and the
 *  opening ramp, so the start of a word is not cut off. */
export const GATE_LOOKAHEAD_S = 0.05;
/** Gain smoothing: opening has to finish inside the lookahead. */
const GATE_OPEN_TIME_CONSTANT_S = 0.005;
const GAIN_TIME_CONSTANT_S = 0.015;

export type GateSource = "vad" | "ptt";

export interface MicProcessor extends TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  /** The graph's own context; set on the LocalAudioTrack before setProcessor(). */
  readonly context: AudioContext;
  /** Post-RNNoise tap for the voice detector; null before init(). */
  readonly analyser: AnalyserNode | null;
  /** The GainNode's current value; null before init(). */
  readonly gainValue: number | null;
  readonly inputGain: number;
  readonly enhanced: boolean;
  setInputGain(gain: number): void;
  /** Close or open one of the two gates; the output is open only when both are. */
  setGate(source: GateSource, closed: boolean): void;
  isGateClosed(source: GateSource): boolean;
  setLookahead(seconds: number): void;
  /** Route through RNNoise or around it; a load failure leaves it off. */
  setEnhanced(on: boolean): Promise<void>;
}

export function createMicProcessor(): MicProcessor {
  const ctx = new AudioContext({ sampleRate: 48000 });
  let source: MediaStreamAudioSourceNode | null = null;
  let entry: GainNode | null = null;
  let analyser: AnalyserNode | null = null;
  let delay: DelayNode | null = null;
  let gain: GainNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  let rnnoise: RNNoiseNode | null = null;
  let enhanced = false;
  let inputGain = 1;
  const closed: Record<GateSource, boolean> = { vad: false, ptt: false };
  let destroyed = false;

  function applyGain(timeConstant: number): void {
    if (gain === null) return;
    const effective = closed.vad || closed.ptt ? 0 : inputGain;
    gain.gain.setTargetAtTime(effective, ctx.currentTime, timeConstant);
  }

  /** Wire entry → (RNNoise →) analyser + delay for the current `enhanced`. */
  function route(): void {
    if (entry === null || analyser === null || delay === null) return;
    entry.disconnect();
    if (rnnoise !== null) rnnoise.node.disconnect();
    const head = enhanced && rnnoise !== null ? rnnoise.node : entry;
    if (head !== entry) entry.connect(head);
    head.connect(analyser);
    head.connect(delay);
  }

  function connectSource(track: MediaStreamTrack): void {
    source?.disconnect();
    source = ctx.createMediaStreamSource(new MediaStream([track]));
    if (entry !== null) source.connect(entry);
  }

  return {
    name: "owncord-mic",
    context: ctx,
    get analyser() {
      return analyser;
    },
    get gainValue() {
      return gain?.gain.value ?? null;
    },
    get inputGain() {
      return inputGain;
    },
    get enhanced() {
      return enhanced;
    },
    get processedTrack(): MediaStreamTrack | undefined {
      return dest?.stream.getAudioTracks()[0];
    },

    async init(opts: AudioProcessorOptions): Promise<void> {
      void ctx.resume(); // WebView2 autoplay policy can leave it suspended
      entry = ctx.createGain();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      delay = ctx.createDelay(GATE_LOOKAHEAD_S);
      delay.delayTime.value = 0;
      gain = ctx.createGain();
      gain.gain.setValueAtTime(closed.vad || closed.ptt ? 0 : inputGain, ctx.currentTime);
      dest = ctx.createMediaStreamDestination();
      delay.connect(gain);
      gain.connect(dest);
      route();
      connectSource(opts.track);
      log.info("Mic processor started", { inputGain, gated: closed });
    },

    async restart(opts: AudioProcessorOptions): Promise<void> {
      // The SDK swaps only the capture track; the gated graph and its output
      // track stay as they are, so the sender never sees the new raw track.
      connectSource(opts.track);
      log.debug("Mic processor source replaced");
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      source?.disconnect();
      rnnoise?.destroy();
      rnnoise = null;
      entry?.disconnect();
      analyser?.disconnect();
      delay?.disconnect();
      gain?.disconnect();
      dest?.disconnect();
      void ctx.close();
      log.info("Mic processor destroyed");
    },

    setInputGain(next: number): void {
      inputGain = next;
      applyGain(GAIN_TIME_CONSTANT_S);
    },

    setGate(gate: GateSource, isClosed: boolean): void {
      if (closed[gate] === isClosed) return;
      closed[gate] = isClosed;
      // Closing is gentle; opening has to finish inside the lookahead.
      applyGain(isClosed ? GAIN_TIME_CONSTANT_S : GATE_OPEN_TIME_CONSTANT_S);
    },

    isGateClosed(gate: GateSource): boolean {
      return closed[gate];
    },

    setLookahead(seconds: number): void {
      if (delay !== null) delay.delayTime.value = seconds;
    },

    async setEnhanced(on: boolean): Promise<void> {
      if (on && rnnoise === null && !destroyed) {
        try {
          rnnoise = await createRNNoiseNode(ctx);
        } catch (err) {
          log.warn("RNNoise failed to start — Enhanced Noise Suppression stays off", err);
          on = false;
        }
        if (destroyed) {
          rnnoise?.destroy();
          rnnoise = null;
          return;
        }
      }
      enhanced = on && rnnoise !== null;
      route();
    },
  };
}
