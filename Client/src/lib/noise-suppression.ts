// =============================================================================
// Noise Suppression — RNNoise ML-based noise removal as a LiveKit TrackProcessor
//
// Implements LiveKit's TrackProcessor<Track.Kind.Audio> interface so it
// integrates with setProcessor() / stopProcessor() lifecycle, device switching,
// and mid-call toggling automatically.
//
// RNNoise processes 480-sample frames at 48kHz (10ms) in an AudioWorklet
// (public/rnnoise-worklet.js), which instantiates public/rnnoise.wasm itself.
// =============================================================================

import { Track, type TrackProcessor, type AudioProcessorOptions } from "livekit-client";
import { createLogger } from "@lib/logger";

const log = createLogger("noise-suppression");

interface ProcessingPipeline {
  readonly processedTrack: MediaStreamTrack;
  destroy(): void;
}

/** The worklet pipeline over one input track. */
async function createWorkletPipeline(
  inputTrack: MediaStreamTrack,
  audioContext: AudioContext,
): Promise<ProcessingPipeline> {
  await audioContext.audioWorklet.addModule("/rnnoise-worklet.js");
  const wasmResponse = await fetch("/rnnoise.wasm");
  const wasmBytes = await wasmResponse.arrayBuffer();

  const source = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
  const dest = audioContext.createMediaStreamDestination();
  const workletNode = new AudioWorkletNode(audioContext, "rnnoise-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  const initPromise = new Promise<void>((resolve, reject) => {
    // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
    workletNode.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === "ready") resolve();
      else if (event.data.type === "error") reject(new Error(event.data.message));
    };
  });
  // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
  workletNode.port.postMessage({ type: "init", wasmBytes }, [wasmBytes]);
  await initPromise;

  source.connect(workletNode);
  workletNode.connect(dest);

  log.info("RNNoise AudioWorklet processing active");

  return {
    processedTrack: dest.stream.getAudioTracks()[0]!,
    destroy() {
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      workletNode.port.postMessage({ type: "destroy" });
      workletNode.disconnect();
      source.disconnect();
      dest.disconnect();
      log.info("RNNoise AudioWorklet pipeline destroyed");
    },
  };
}

// ---------------------------------------------------------------------------
// LiveKit TrackProcessor implementation
// ---------------------------------------------------------------------------

/**
 * Creates an RNNoise TrackProcessor compatible with LiveKit's
 * LocalAudioTrack.setProcessor() API.
 *
 * Usage:
 *   const processor = createRNNoiseProcessor();
 *   await localAudioTrack.setProcessor(processor);
 *   // Later:
 *   await localAudioTrack.stopProcessor();
 */
export function createRNNoiseProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let pipeline: ProcessingPipeline | null = null;
  // Cached across init()/restart() calls: livekit-client's ONLY
  // processor.restart() call site (LocalTrack.setMediaStreamTrack(), reached
  // via restartTrack() on a device switch, mic replug, or an AEC/NS/AGC
  // constraint toggle) sends `{track, kind, element, localTrack}` with no
  // `audioContext` — only setProcessor() supplies one. Without this cache,
  // restart() would try to build a new pipeline from `undefined` and reject,
  // leaving `pipeline` null and the mic silently unpublished.
  let cachedCtx: AudioContext | null = null;

  return {
    name: "rnnoise",

    async init(opts: AudioProcessorOptions): Promise<void> {
      log.debug("RNNoise processor init");
      const ctx = opts.audioContext ?? cachedCtx;
      if (ctx == null) {
        // i18n-exempt: internal audio guard; the caller keeps the unprocessed track
        throw new Error("RNNoise processor: no AudioContext available");
      }
      cachedCtx = ctx;
      pipeline = await createWorkletPipeline(opts.track, ctx);
    },

    async restart(opts: AudioProcessorOptions): Promise<void> {
      log.debug("RNNoise processor restart");
      if (pipeline !== null) {
        pipeline.destroy();
        pipeline = null;
      }
      await this.init(opts);
    },

    async destroy(): Promise<void> {
      if (pipeline !== null) {
        pipeline.destroy();
        pipeline = null;
      }
      log.info("RNNoise processor destroyed");
    },

    get processedTrack(): MediaStreamTrack | undefined {
      return pipeline?.processedTrack;
    },
  };
}
