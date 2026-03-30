// =============================================================================
// RNNoise AudioWorklet Processor
//
// Runs on the audio rendering thread. Receives WASM module bytes from the
// main thread, initializes RNNoise, and processes 480-sample frames at 48kHz.
// =============================================================================

const FRAME_SIZE = 480;
const WASM_MEMORY_INITIAL_PAGES = 256;
const OUTPUT_RING_CAPACITY = 50;
const RN_NOISE_INT16_SCALE = 32768;

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** @type {WebAssembly.Instance | null} */
    this._instance = null;
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
      // Basic validation: check for expected exports
      const module = await WebAssembly.compile(wasmBytes);
      const expectedExports = ['rnnoise_create', 'rnnoise_destroy', 'rnnoise_process_frame', 'malloc', 'free'];
      const availableExports = WebAssembly.Module.exports(module).map(exp => exp.name);
      
      const hasRequiredExports = expectedExports.every(exp => availableExports.includes(exp));
      if (!hasRequiredExports) {
        throw new Error('WASM module missing required RNNoise exports');
      }

      const memory = new WebAssembly.Memory({ initial: WASM_MEMORY_INITIAL_PAGES });
      const importObject = {
        env: {
          memory,
          emscripten_notify_memory_growth: () => {
            this._heapF32 = new Float32Array(memory.buffer);
          },
        },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
          fd_close: () => 0,
          fd_write: () => 0,
          fd_seek: () => 0,
        },
      };

      // Try instantiating with the raw WASM bytes
      const { instance } = await WebAssembly.instantiate(wasmBytes, importObject);
      this._instance = instance;
      this._heapF32 = new Float32Array(memory.buffer);

      // Call RNNoise C API
      const exports = instance.exports;
      this._state = exports.rnnoise_create();
      this._inputPtr = exports.malloc(FRAME_SIZE * 4);
      this._outputPtr = exports.malloc(FRAME_SIZE * 4);
      allocated = true;

      this._ready = true;
      this.port.postMessage({ type: "ready" });
    } catch (err) {
      // Cleanup allocated memory on failure
      if (allocated && this._instance) {
        try {
          const exports = this._instance.exports;
          if (this._inputPtr) exports.free(this._inputPtr);
          if (this._outputPtr) exports.free(this._outputPtr);
          if (this._state) exports.rnnoise_destroy(this._state);
        } catch (cleanupErr) {
          // Log cleanup errors but don't override original error
          console.warn('Failed to cleanup WASM memory:', cleanupErr);
        }
      }
      this._reportError(`WASM initialization failed: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }

  /**
   * Processes a complete 480-sample frame through RNNoise.
   * Copies input ring buffer to WASM memory, runs noise suppression,
   * and stores the result in the output ring buffer.
   * @private
   */
  _processFrame() {
    if (!this._instance || !this._heapF32) return;
    const exports = this._instance.exports;

    const inOff = this._inputPtr / 4;
    const outOff = this._outputPtr / 4;
    
    // CRITICAL: Bounds check before accessing heap
    if (inOff + FRAME_SIZE > this._heapF32.length || 
        outOff + FRAME_SIZE > this._heapF32.length) {
      console.error('WASM heap bounds exceeded');
      return;
    }

    for (let i = 0; i < FRAME_SIZE; i++) {
      this._heapF32[inOff + i] = this._inputRing[i] * RN_NOISE_INT16_SCALE;
    }

    exports.rnnoise_process_frame(this._state, this._outputPtr, this._inputPtr);

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
    if (this._instance && this._state) {
      try {
        const exports = this._instance.exports;
        exports.rnnoise_destroy(this._state);
        exports.free(this._inputPtr);
        exports.free(this._outputPtr);
      } catch (err) {
        console.warn('RNNoise cleanup failed:', err);
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
      outData.set(this._outBuffer.subarray(readStart + this._outSampleOffset, readStart + this._outSampleOffset + toWrite), outIdx);
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
    if (!inputs || !inputs[0] || !inputs[0][0] || 
        !outputs || !outputs[0] || !outputs[0][0]) {
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
