// =============================================================================
// RNNoise AudioWorklet Processor
//
// Runs on the audio rendering thread. Receives WASM module bytes from the
// main thread, initializes RNNoise, and processes 480-sample frames at 48kHz.
// =============================================================================

const FRAME_SIZE = 480;
const OUTPUT_RING_CAPACITY = 50;
const RN_NOISE_INT16_SCALE = 32768;

// The shipped @jitsi/rnnoise-wasm build minifies every export to a one-letter
// name; this is its `Module["asm"]` table from dist/rnnoise.js, e.g.
// `_rnnoise_create = Module["asm"]["f"]`. The import object in _initWasm is
// likewise tied to this build, so a different rnnoise.wasm needs both updated.
const EXPORT_NAMES = {
  memory: "c",
  __wasm_call_ctors: "d",
  rnnoise_create: "f",
  malloc: "g",
  rnnoise_destroy: "h",
  free: "i",
  rnnoise_process_frame: "j",
};

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** @type {(() => number) | null} */
    this._create = null;
    /** @type {((state: number) => void) | null} */
    this._destroy = null;
    /** @type {((state: number, out: number, inp: number) => number) | null} */
    this._process = null;
    /** @type {((bytes: number) => number) | null} */
    this._malloc = null;
    /** @type {((ptr: number) => void) | null} */
    this._free = null;
    /** @type {number} */
    this._state = 0;
    /** @type {number} */
    this._inputPtr = 0;
    /** @type {number} */
    this._outputPtr = 0;
    /** @type {Float32Array | null} */
    this._heapF32 = null;
    /** @type {boolean} */
    this._ready = false;
    /** @type {boolean} */
    this._destroyed = false;

    // Ring buffer to accumulate 480-sample frames
    this._inputRing = new Float32Array(FRAME_SIZE);
    this._inputRingOffset = 0;

    // Output ring buffer (contiguous for efficiency)
    this._outBuffer = new Float32Array(OUTPUT_RING_CAPACITY * FRAME_SIZE);
    this._outWritePos = 0;
    this._outReadPos = 0;
    this._outAvailable = 0;
    this._outSampleOffset = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === "init") {
        this._initWasm(event.data.wasmBytes);
      } else if (event.data.type === "destroy") {
        this._cleanup();
      }
    };
  }

  /**
   * Reports an error to the main thread and logs it.
   * @param {string} message - Error message
   * @param {*} [error] - Optional error object
   * @private
   */
  _reportError(message, error) {
    console.error(`RNNoise Processor: ${message}`, error);
    this.port.postMessage({ type: "error", message });
  }

  /**
   * Initializes the WASM module and RNNoise state.
   * @param {ArrayBuffer} wasmBytes - Raw WASM module bytes
   * @private
   */
  async _initWasm(wasmBytes) {
    let allocated = false;
    try {
      const module = await WebAssembly.compile(wasmBytes);
      const present = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
      const missing = Object.entries(EXPORT_NAMES)
        .filter(([, exportName]) => !present.has(exportName))
        .map(([name, exportName]) => `${name} (${exportName})`);
      if (missing.length > 0) {
        throw new Error(`WASM module missing required RNNoise exports: ${missing.join(", ")}`);
      }

      // The module exports its own memory and imports only the two Emscripten
      // runtime helpers (resize-heap and memcpy) — it is not a WASI module, so
      // the old wasi_snapshot_preview1 stubs never matched. Both helpers run
      // only after instantiation, so they can read the memory captured below.
      let memory = null;
      const importObject = {
        a: {
          a: (requestedSize) => {
            const extraPages = Math.ceil((requestedSize - memory.buffer.byteLength) / 65536);
            if (extraPages <= 0) return true;
            try {
              memory.grow(extraPages);
              this._heapF32 = new Float32Array(memory.buffer);
              return true;
            } catch {
              return false;
            }
          },
          b: (dest, src, num) => {
            new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
          },
        },
      };

      const instance = await WebAssembly.instantiate(module, importObject);
      const exports = instance.exports;
      memory = exports[EXPORT_NAMES.memory];
      this._heapF32 = new Float32Array(memory.buffer);
      this._create = exports[EXPORT_NAMES.rnnoise_create];
      this._destroy = exports[EXPORT_NAMES.rnnoise_destroy];
      this._process = exports[EXPORT_NAMES.rnnoise_process_frame];
      this._malloc = exports[EXPORT_NAMES.malloc];
      this._free = exports[EXPORT_NAMES.free];

      // Emscripten runs __wasm_call_ctors before any exported C function; the
      // RNNoise globals malloc reads during rnnoise_create are only initialized
      // here. The Emscripten wrapper does this on instantiation.
      exports[EXPORT_NAMES.__wasm_call_ctors]();

      this._state = this._create();
      this._inputPtr = this._malloc(FRAME_SIZE * 4);
      this._outputPtr = this._malloc(FRAME_SIZE * 4);
      allocated = true;

      this._ready = true;
      this.port.postMessage({ type: "ready" });
    } catch (err) {
      // Cleanup allocated memory on failure
      if (allocated) {
        try {
          if (this._inputPtr && this._free) this._free(this._inputPtr);
          if (this._outputPtr && this._free) this._free(this._outputPtr);
          if (this._state && this._destroy) this._destroy(this._state);
        } catch (cleanupErr) {
          // Log cleanup errors but don't override original error
          console.warn("Failed to cleanup WASM memory:", cleanupErr);
        }
      }
      this._reportError(
        `WASM initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  /**
   * Processes a complete 480-sample frame through RNNoise.
   * Copies input ring buffer to WASM memory, runs noise suppression,
   * and stores the result in the output ring buffer.
   * @private
   */
  _processFrame() {
    if (!this._process || !this._heapF32) return;

    const inOff = this._inputPtr / 4;
    const outOff = this._outputPtr / 4;

    // CRITICAL: Bounds check before accessing heap
    if (inOff + FRAME_SIZE > this._heapF32.length || outOff + FRAME_SIZE > this._heapF32.length) {
      console.error("WASM heap bounds exceeded");
      return;
    }

    for (let i = 0; i < FRAME_SIZE; i++) {
      this._heapF32[inOff + i] = this._inputRing[i] * RN_NOISE_INT16_SCALE;
    }

    this._process(this._state, this._outputPtr, this._inputPtr);

    // Write to contiguous buffer
    const writeStart = this._outWritePos * FRAME_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) {
      this._outBuffer[writeStart + i] = this._heapF32[outOff + i] / RN_NOISE_INT16_SCALE;
    }
    this._outWritePos = (this._outWritePos + 1) % OUTPUT_RING_CAPACITY;
    if (this._outAvailable < OUTPUT_RING_CAPACITY) {
      this._outAvailable++;
    } else {
      // Overwrite oldest
      this._outReadPos = (this._outReadPos + 1) % OUTPUT_RING_CAPACITY;
      this._outSampleOffset = 0;
    }
  }

  /**
   * Cleans up WASM resources and marks the processor as destroyed.
   * Safe to call multiple times.
   * @private
   */
  _cleanup() {
    if (this._state && this._destroy && this._free) {
      try {
        this._destroy(this._state);
        this._free(this._inputPtr);
        this._free(this._outputPtr);
      } catch (err) {
        console.warn("RNNoise cleanup failed:", err);
        // Continue cleanup even if individual steps fail
      }
    }
    this._ready = false;
    this._destroyed = true;
    this._state = 0;
  }

  /**
   * Processes input audio data into the ring buffer and triggers frame processing.
   * @param {Float32Array} inData - Input audio samples
   * @private
   */
  _processInputRingBuffer(inData) {
    let inIdx = 0;
    while (inIdx < inData.length) {
      const needed = FRAME_SIZE - this._inputRingOffset;
      const toCopy = Math.min(needed, inData.length - inIdx);
      this._inputRing.set(inData.subarray(inIdx, inIdx + toCopy), this._inputRingOffset);
      this._inputRingOffset += toCopy;
      inIdx += toCopy;

      if (this._inputRingOffset >= FRAME_SIZE) {
        this._processFrame();
        this._inputRingOffset = 0;
      }
    }
  }

  /**
   * Fills output buffer from the processed frames ring buffer.
   * @param {Float32Array} outData - Output audio buffer to fill
   * @private
   */
  _fillOutputFromRingBuffer(outData) {
    let outIdx = 0;
    while (outIdx < outData.length && this._outAvailable > 0) {
      const readStart = this._outReadPos * FRAME_SIZE;
      const available = FRAME_SIZE - this._outSampleOffset;
      const toWrite = Math.min(available, outData.length - outIdx);
      outData.set(
        this._outBuffer.subarray(
          readStart + this._outSampleOffset,
          readStart + this._outSampleOffset + toWrite,
        ),
        outIdx,
      );
      outIdx += toWrite;
      this._outSampleOffset += toWrite;
      if (this._outSampleOffset >= FRAME_SIZE) {
        this._outReadPos = (this._outReadPos + 1) % OUTPUT_RING_CAPACITY;
        this._outAvailable--;
        this._outSampleOffset = 0;
      }
    }
    // Fill remaining with silence
    if (outIdx < outData.length) {
      outData.fill(0, outIdx);
    }
  }

  /**
   * Main audio processing method called by the AudioWorklet.
   * @param {Float32Array[][]} inputs - Input audio buffers
   * @param {Float32Array[][]} outputs - Output audio buffers
   * @returns {boolean} - Whether to continue processing
   */
  process(inputs, outputs) {
    if (this._destroyed) return false;

    // Validate input/output structure
    if (!inputs || !inputs[0] || !inputs[0][0] || !outputs || !outputs[0] || !outputs[0][0]) {
      return true; // Pass through silence or existing data
    }

    const input = inputs[0];
    const output = outputs[0];
    const inData = input[0];
    const outData = output[0];

    // Validate buffer lengths
    if (inData.length === 0 || outData.length === 0) {
      return true;
    }

    if (!this._ready) {
      // Pass through until WASM is ready
      const copyLength = Math.min(inData.length, outData.length);
      outData.set(inData.subarray(0, copyLength));
      if (copyLength < outData.length) {
        outData.fill(0, copyLength);
      }
      return true;
    }

    this._processInputRingBuffer(inData);
    this._fillOutputFromRingBuffer(outData);

    return true;
  }
}

registerProcessor("rnnoise-processor", RNNoiseProcessor);
