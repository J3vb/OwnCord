// =============================================================================
// Noise Suppression — RNNoise ML-based noise removal as a LiveKit TrackProcessor
//
// Implements LiveKit's TrackProcessor<Track.Kind.Audio> interface so it
// integrates with setProcessor() / stopProcessor() lifecycle, device switching,
// and mid-call toggling automatically.
//
// RNNoise processes 480-sample frames at 48kHz (10ms).
// Uses AudioWorklet (modern, runs on audio thread) with ScriptProcessorNode
// fallback (deprecated but widely supported).
// =============================================================================

import { createRNNWasmModule } from "@jitsi/rnnoise-wasm";
import { Track, type TrackProcessor, type AudioProcessorOptions } from "livekit-client";
import { createLogger } from "@lib/logger";

const log = createLogger("noise-suppression");

const RNNOISE_FRAME_SIZE = 480;
const SCRIPT_PROCESSOR_BUFFER = 4096;

// ---------------------------------------------------------------------------
// Shared WASM module cache
// ---------------------------------------------------------------------------

interface RNNoiseModule {
  _rnnoise_create: () => number;
  _rnnoise_destroy: (state: number) => void;
  _rnnoise_process_frame: (state: number, out: number, inp: number) => number;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  ready: Promise<unknown>;
}

let cachedModule: RNNoiseModule | null = null;

async function loadRNNoise(): Promise<RNNoiseModule> {
  if (cachedModule !== null) return cachedModule;
  const startMs = performance.now();
  const mod = (createRNNWasmModule as (opts: Record<string, unknown>) => unknown)({
    locateFile: (file: string) => {
      if (file.endsWith(".wasm")) return "/rnnoise.wasm";
      return file;
    },
  }) as RNNoiseModule;
  await mod.ready;
  cachedModule = mod;
  log.info("RNNoise WASM loaded", { durationMs: Math.round(performance.now() - startMs) });
  return mod;
}

/** Check if AudioWorklet is available in this browser context. */
function supportsAudioWorklet(): boolean {
  try {
    return (
      typeof AudioWorkletNode !== "undefined" &&
      typeof AudioContext !== "undefined" &&
      "audioWorklet" in AudioContext.prototype
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal processing pipeline — shared by both init strategies
// ---------------------------------------------------------------------------

interface ProcessingPipeline {
  readonly processedTrack: MediaStreamTrack;
  destroy(): void;
}

/** AudioWorklet-based pipeline (preferred, runs on audio thread). */
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
    // eslint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
    workletNode.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === "ready") resolve();
      else if (event.data.type === "error") reject(new Error(event.data.message));
    };
  });
  // eslint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
  workletNode.port.postMessage({ type: "init", wasmBytes }, [wasmBytes]);
  await initPromise;

  source.connect(workletNode);
  workletNode.connect(dest);

  log.info("RNNoise AudioWorklet processing active");

  return {
    processedTrack: dest.stream.getAudioTracks()[0]!,
    destroy() {
      // eslint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      workletNode.port.postMessage({ type: "destroy" });
      workletNode.disconnect();
      source.disconnect();
      dest.disconnect();
      log.info("RNNoise AudioWorklet pipeline destroyed");
    },
  };
}

/** ScriptProcessorNode-based pipeline (fallback). */
async function createScriptProcessorPipeline(
  inputTrack: MediaStreamTrack,
  audioContext: AudioContext,
): Promise<ProcessingPipeline> {
  const wasmModule = await loadRNNoise();
  const rnnoiseState = wasmModule._rnnoise_create();
  const inputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);
  const outputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);

  const inputRing = new Float32Array(RNNOISE_FRAME_SIZE);
  let inputRingOffset = 0;

  const OUT_RING_CAPACITY = 50;
  const outRing: Float32Array[] = Array.from({ length: OUT_RING_CAPACITY });
  let outWriteIdx = 0;
  let outReadIdx = 0;
  let outCount = 0;
  let outSampleOffset = 0;

  function processFrame(): void {
    const inOff = inputPtr / 4;
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      wasmModule.HEAPF32[inOff + i] = (inputRing[i] ?? 0) * 32768;
    }
    wasmModule._rnnoise_process_frame(rnnoiseState, outputPtr, inputPtr);
    const outOff = outputPtr / 4;
    const result = new Float32Array(RNNOISE_FRAME_SIZE);
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      result[i] = (wasmModule.HEAPF32[outOff + i] ?? 0) / 32768;
    }
    if (outCount >= OUT_RING_CAPACITY) {
      outReadIdx = (outReadIdx + 1) % OUT_RING_CAPACITY;
      outCount--;
      outSampleOffset = 0;
    }
    outRing[outWriteIdx] = result;
    outWriteIdx = (outWriteIdx + 1) % OUT_RING_CAPACITY;
    outCount++;
  }

  const source = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
  const dest = audioContext.createMediaStreamDestination();
  const processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);

  processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
    const inData = event.inputBuffer.getChannelData(0);
    const outData = event.outputBuffer.getChannelData(0);

    let inIdx = 0;
    while (inIdx < inData.length) {
      const needed = RNNOISE_FRAME_SIZE - inputRingOffset;
      const toCopy = Math.min(needed, inData.length - inIdx);
      inputRing.set(inData.subarray(inIdx, inIdx + toCopy), inputRingOffset);
      inputRingOffset += toCopy;
      inIdx += toCopy;
      if (inputRingOffset >= RNNOISE_FRAME_SIZE) {
        processFrame();
        inputRingOffset = 0;
      }
    }

    let outIdx = 0;
    while (outIdx < outData.length && outCount > 0) {
      const chunk = outRing[outReadIdx]!;
      const available = chunk.length - outSampleOffset;
      const toWrite = Math.min(available, outData.length - outIdx);
      outData.set(chunk.subarray(outSampleOffset, outSampleOffset + toWrite), outIdx);
      outIdx += toWrite;
      outSampleOffset += toWrite;
      if (outSampleOffset >= chunk.length) {
        outReadIdx = (outReadIdx + 1) % OUT_RING_CAPACITY;
        outCount--;
        outSampleOffset = 0;
      }
    }
    if (outIdx < outData.length) {
      outData.fill(0, outIdx);
    }
  };

  source.connect(processorNode);
  processorNode.connect(dest);

  log.info("RNNoise ScriptProcessor processing active (fallback)");

  return {
    processedTrack: dest.stream.getAudioTracks()[0]!,
    destroy() {
      processorNode.onaudioprocess = null;
      processorNode.disconnect();
      source.disconnect();
      dest.disconnect();
      wasmModule._rnnoise_destroy(rnnoiseState);
      wasmModule._free(inputPtr);
      wasmModule._free(outputPtr);
      log.info("RNNoise ScriptProcessor pipeline destroyed");
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

  return {
    name: "rnnoise",

    async init(opts: AudioProcessorOptions): Promise<void> {
      log.debug("RNNoise processor init", { audioWorkletSupported: supportsAudioWorklet() });
      const ctx = opts.audioContext;

      if (supportsAudioWorklet()) {
        try {
          pipeline = await createWorkletPipeline(opts.track, ctx);
          return;
        } catch (err) {
          log.warn("AudioWorklet failed, falling back to ScriptProcessorNode", err);
        }
      }

      pipeline = await createScriptProcessorPipeline(opts.track, ctx);
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
