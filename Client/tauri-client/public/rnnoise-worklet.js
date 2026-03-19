// =============================================================================
// RNNoise AudioWorklet Processor
//
// Runs on the audio rendering thread. Receives WASM module bytes from the
// main thread, initializes RNNoise, and processes 480-sample frames at 48kHz.
// =============================================================================

const FRAME_SIZE = 480;

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

    // Output ring buffer (fixed-size, prevents unbounded growth)
    this._outCapacity = 50;
    this._outRing = new Array(this._outCapacity);
    this._outWriteIdx = 0;
    this._outReadIdx = 0;
    this._outCount = 0;
    this._outSampleOffset = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === "init") {
        this._initWasm(event.data.wasmBytes);
      } else if (event.data.type === "destroy") {
        this._cleanup();
      }
    };
  }

  async _initWasm(wasmBytes) {
    try {
      const memory = new WebAssembly.Memory({ initial: 256 });
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

      this._ready = true;
      this.port.postMessage({ type: "ready" });
    } catch (err) {
      // Fallback: the WASM module may use Emscripten-style exports
      // that need the full runtime. Signal failure so the main thread
      // can fall back to ScriptProcessorNode.
      this.port.postMessage({ type: "error", message: String(err) });
    }
  }

  _processFrame() {
    if (!this._instance || !this._heapF32) return;
    const exports = this._instance.exports;

    const inOff = this._inputPtr / 4;
    for (let i = 0; i < FRAME_SIZE; i++) {
      this._heapF32[inOff + i] = this._inputRing[i] * 32768;
    }

    exports.rnnoise_process_frame(this._state, this._outputPtr, this._inputPtr);

    const outOff = this._outputPtr / 4;
    const result = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      result[i] = this._heapF32[outOff + i] / 32768;
    }

    // Write to ring buffer, dropping oldest if full
    if (this._outCount >= this._outCapacity) {
      this._outReadIdx = (this._outReadIdx + 1) % this._outCapacity;
      this._outCount--;
      this._outSampleOffset = 0;
    }
    this._outRing[this._outWriteIdx] = result;
    this._outWriteIdx = (this._outWriteIdx + 1) % this._outCapacity;
    this._outCount++;
  }

  _cleanup() {
    if (this._instance && this._state) {
      try {
        const exports = this._instance.exports;
        exports.rnnoise_destroy(this._state);
        exports.free(this._inputPtr);
        exports.free(this._outputPtr);
      } catch {
        // Best-effort cleanup
      }
    }
    this._ready = false;
    this._destroyed = true;
    this._state = 0;
  }

  process(inputs, outputs) {
    if (this._destroyed) return false;
    if (!this._ready) {
      // Pass through until WASM is ready
      const input = inputs[0];
      const output = outputs[0];
      if (input && output && input[0] && output[0]) {
        output[0].set(input[0]);
      }
      return true;
    }

    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || !input[0] || !output[0]) return true;

    const inData = input[0];
    const outData = output[0];

    // Feed input into ring buffer, process complete frames
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

    // Drain processed frames into output
    let outIdx = 0;
    while (outIdx < outData.length && this._outCount > 0) {
      const chunk = this._outRing[this._outReadIdx];
      const available = chunk.length - this._outSampleOffset;
      const toWrite = Math.min(available, outData.length - outIdx);
      outData.set(chunk.subarray(this._outSampleOffset, this._outSampleOffset + toWrite), outIdx);
      outIdx += toWrite;
      this._outSampleOffset += toWrite;
      if (this._outSampleOffset >= chunk.length) {
        this._outReadIdx = (this._outReadIdx + 1) % this._outCapacity;
        this._outCount--;
        this._outSampleOffset = 0;
      }
    }
    // Fill remaining with silence
    if (outIdx < outData.length) {
      outData.fill(0, outIdx);
    }

    return true;
  }
}

registerProcessor("rnnoise-processor", RNNoiseProcessor);
