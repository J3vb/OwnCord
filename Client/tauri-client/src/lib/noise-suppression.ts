// =============================================================================
// Noise Suppression — RNNoise ML-based noise removal via Web Audio API
//
// Inserts between getUserMedia stream and the PeerConnection to clean audio.
// RNNoise processes 480-sample frames at 48kHz (10ms).
//
// Uses AudioWorklet (modern, runs on audio thread) with ScriptProcessorNode
// fallback (deprecated but widely supported).
// =============================================================================

import { createRNNWasmModule } from "@jitsi/rnnoise-wasm";
import { createLogger } from "@lib/logger";

const log = createLogger("noise-suppression");

const RNNOISE_FRAME_SIZE = 480;
const SCRIPT_PROCESSOR_BUFFER = 4096;

export interface NoiseSuppressor {
  process(input: MediaStream): Promise<MediaStream>;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Shared WASM module cache (used by ScriptProcessorNode fallback)
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

// ---------------------------------------------------------------------------
// AudioWorklet-based suppressor (preferred, runs on audio thread)
// ---------------------------------------------------------------------------

function createWorkletSuppressor(): NoiseSuppressor {
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let destNode: MediaStreamAudioDestinationNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let destroyed = false;

  return {
    async process(input: MediaStream): Promise<MediaStream> {
      if (destroyed) throw new Error("NoiseSuppressor destroyed");

      audioContext = new AudioContext({ sampleRate: 48000 });

      // Load the worklet processor module
      await audioContext.audioWorklet.addModule("/rnnoise-worklet.js");

      // Fetch WASM bytes to send to the worklet thread
      const wasmResponse = await fetch("/rnnoise.wasm");
      const wasmBytes = await wasmResponse.arrayBuffer();

      sourceNode = audioContext.createMediaStreamSource(input);
      destNode = audioContext.createMediaStreamDestination();

      workletNode = new AudioWorkletNode(audioContext, "rnnoise-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      // Wait for WASM init in the worklet
      const initPromise = new Promise<void>((resolve, reject) => {
        if (workletNode === null) { reject(new Error("No worklet")); return; }
        workletNode.port.onmessage = (event: MessageEvent) => {
          if (event.data.type === "ready") {
            resolve();
          } else if (event.data.type === "error") {
            reject(new Error(event.data.message));
          }
        };
      });

      // Send WASM bytes to the worklet for initialization
      workletNode.port.postMessage({ type: "init", wasmBytes }, [wasmBytes]);
      await initPromise;

      sourceNode.connect(workletNode);
      workletNode.connect(destNode);

      log.info("RNNoise AudioWorklet processing active");
      return destNode.stream;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;

      if (workletNode !== null) {
        workletNode.port.postMessage({ type: "destroy" });
        workletNode.disconnect();
        workletNode = null;
      }
      if (sourceNode !== null) {
        sourceNode.disconnect();
        sourceNode = null;
      }
      if (destNode !== null) {
        destNode.disconnect();
        destNode = null;
      }
      if (audioContext !== null) {
        void audioContext.close();
        audioContext = null;
      }
      log.info("RNNoise AudioWorklet destroyed");
    },
  };
}

// ---------------------------------------------------------------------------
// ScriptProcessorNode fallback (deprecated but universal)
// ---------------------------------------------------------------------------

function createScriptProcessorSuppressor(): NoiseSuppressor {
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let destNode: MediaStreamAudioDestinationNode | null = null;
  let processorNode: ScriptProcessorNode | null = null;
  let rnnoiseState: number = 0;
  let inputPtr: number = 0;
  let outputPtr: number = 0;
  let wasmModule: RNNoiseModule | null = null;
  let destroyed = false;

  const inputRing = new Float32Array(RNNOISE_FRAME_SIZE);
  let inputRingOffset = 0;

  const OUT_RING_CAPACITY = 50;
  const outRing: Float32Array[] = new Array(OUT_RING_CAPACITY);
  let outWriteIdx = 0;
  let outReadIdx = 0;
  let outCount = 0;
  let outSampleOffset = 0;

  function processFrame(): void {
    if (wasmModule === null) return;
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

  return {
    async process(input: MediaStream): Promise<MediaStream> {
      if (destroyed) throw new Error("NoiseSuppressor destroyed");

      wasmModule = await loadRNNoise();
      rnnoiseState = wasmModule._rnnoise_create();
      inputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);
      outputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);

      audioContext = new AudioContext({ sampleRate: 48000 });
      sourceNode = audioContext.createMediaStreamSource(input);
      destNode = audioContext.createMediaStreamDestination();
      processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);

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

      sourceNode.connect(processorNode);
      processorNode.connect(destNode);

      log.info("RNNoise ScriptProcessor processing active (fallback)");
      return destNode.stream;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;

      if (processorNode !== null) {
        processorNode.onaudioprocess = null;
        processorNode.disconnect();
        processorNode = null;
      }
      if (sourceNode !== null) {
        sourceNode.disconnect();
        sourceNode = null;
      }
      if (destNode !== null) {
        destNode.disconnect();
        destNode = null;
      }
      if (audioContext !== null) {
        void audioContext.close();
        audioContext = null;
      }
      if (wasmModule !== null && rnnoiseState !== 0) {
        wasmModule._rnnoise_destroy(rnnoiseState);
        wasmModule._free(inputPtr);
        wasmModule._free(outputPtr);
        rnnoiseState = 0;
      }
      outWriteIdx = 0;
      outReadIdx = 0;
      outCount = 0;
      outSampleOffset = 0;
      log.info("RNNoise ScriptProcessor destroyed");
    },
  };
}

// ---------------------------------------------------------------------------
// Factory — tries AudioWorklet first, falls back to ScriptProcessorNode
// ---------------------------------------------------------------------------

/** Check if AudioWorklet is available in this browser context. */
function supportsAudioWorklet(): boolean {
  try {
    return typeof AudioWorkletNode !== "undefined"
      && typeof AudioContext !== "undefined"
      && "audioWorklet" in AudioContext.prototype;
  } catch {
    return false;
  }
}

export function createNoiseSuppressor(): NoiseSuppressor {
  log.debug("Creating noise suppressor", { audioWorkletSupported: supportsAudioWorklet() });
  if (supportsAudioWorklet()) {
    // Wrap in a facade that falls back to ScriptProcessor on failure
    const worklet = createWorkletSuppressor();
    let fallback: NoiseSuppressor | null = null;
    let activeSuppressor: NoiseSuppressor = worklet;

    return {
      async process(input: MediaStream): Promise<MediaStream> {
        try {
          return await worklet.process(input);
        } catch (err) {
          log.warn("AudioWorklet failed, falling back to ScriptProcessorNode", err);
          worklet.destroy();
          fallback = createScriptProcessorSuppressor();
          activeSuppressor = fallback;
          return fallback.process(input);
        }
      },
      destroy(): void {
        activeSuppressor.destroy();
      },
    };
  }

  log.info("AudioWorklet not supported, using ScriptProcessorNode");
  return createScriptProcessorSuppressor();
}
