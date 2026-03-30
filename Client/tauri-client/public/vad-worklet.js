// =============================================================================
// VAD (Voice Activity Detection) AudioWorklet Processor
//
// Runs on the audio rendering thread. Computes RMS energy per audio frame and
// sends gating decisions to the main thread via MessagePort. This replaces
// setTimeout-based polling which pauses when the app is backgrounded.
//
// Protocol:
//   Main → Worklet:  { type: "config", threshold: number, gateOnFrames: number, gateOffFrames: number }
//   Main → Worklet:  { type: "stop" }
//   Worklet → Main:  { type: "gate", gated: boolean }
//   Worklet → Main:  { type: "rms", value: number }  (optional, for VAD indicator)
// =============================================================================

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._threshold = 0.05;
    this._gateOnFrames = 12;   // ~200ms of silence before gating
    this._gateOffFrames = 2;   // ~33ms of speech before ungating
    this._silentFrames = 0;
    this._speechFrames = 0;
    this._gated = false;
    this._active = true;
    this._startupFrames = 0;
    this._startupGrace = 30;   // ~500ms grace period
    this._frameCounter = 0;    // for throttled RMS updates

    this.port.onmessage = (event) => {
      if (event.data.type === "config") {
        this._threshold = event.data.threshold;
        if (event.data.gateOnFrames !== undefined) this._gateOnFrames = event.data.gateOnFrames;
        if (event.data.gateOffFrames !== undefined) this._gateOffFrames = event.data.gateOffFrames;
        // Reset state on config change
        this._silentFrames = 0;
        this._speechFrames = 0;
        this._startupFrames = 0;
        if (this._gated) {
          this._gated = false;
          this.port.postMessage({ type: "gate", gated: false });
        }
      } else if (event.data.type === "stop") {
        this._active = false;
      }
    };
  }

  process(inputs) {
    if (!this._active) return false; // Returning false stops the processor

    const input = inputs[0];
    if (input === undefined || input.length === 0 || input[0] === undefined) return true;

    const samples = input[0];
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samples.length);

    // Grace period: don't gate for the first ~500ms to let audio settle
    if (this._startupFrames < this._startupGrace) {
      this._startupFrames++;
      return true;
    }

    // Send RMS value to main thread every ~6 frames (~50ms at 128 samples/frame @ 48kHz)
    // This is used for the VAD indicator bar in the UI
    this._frameCounter++;
    if (this._frameCounter >= 6) {
      this._frameCounter = 0;
      this.port.postMessage({ type: "rms", value: rms });
    }

    // Gate logic (identical to the setTimeout version)
    if (rms < this._threshold) {
      this._speechFrames = 0;
      this._silentFrames++;
      if (!this._gated && this._silentFrames >= this._gateOnFrames) {
        this._gated = true;
        this.port.postMessage({ type: "gate", gated: true });
      }
    } else {
      this._silentFrames = 0;
      this._speechFrames++;
      if (this._gated && this._speechFrames >= this._gateOffFrames) {
        this._gated = false;
        this.port.postMessage({ type: "gate", gated: false });
      }
    }

    return true;
  }
}

registerProcessor("vad-processor", VadProcessor);
