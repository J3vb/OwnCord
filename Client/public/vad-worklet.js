// =============================================================================
// VAD (Voice Activity Detection) AudioWorklet Processor
//
// Runs on the audio rendering thread. Computes a smoothed RMS level (the last
// SMOOTH_QUANTA render quanta, ~10 ms) and sends gating decisions to the main thread via MessagePort. This replaces
// setTimeout-based polling which pauses when the app is backgrounded.
//
// Protocol:
//   Main → Worklet:  { type: "config", threshold: number, gateOnFrames: number, gateOffFrames: number }
//   Main → Worklet:  { type: "stop" }
//   Worklet → Main:  { type: "gate", gated: boolean }
//   Worklet → Main:  { type: "rms", value: number }  (loudest smoothed level since the last one)
//   Worklet → Main:  { type: "stopped" }  (from the final process() call)
// =============================================================================

// The gate and the settings meter both read this one level, so a green meter
// bar past the handle is what the gate opens on. A single 2.67 ms quantum
// swings ~4 dB inside voiced speech; ~10 ms does not.
const SMOOTH_QUANTA = 4;

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._threshold = 0.05;
    // process() runs once per 128-sample render quantum (2.667ms @ 48kHz —
    // see audioPipeline.ts's `new AudioContext({ sampleRate: 48000 })`), NOT
    // once per ~16ms poll like the setTimeout fallback. These frame counts
    // are therefore ~6x the fallback's, so both paths gate on the same
    // wall-clock timing.
    this._gateOnFrames = 120; // ~320ms below the threshold before gating: bridges a 250ms pause and its quiet tails
    this._gateOffFrames = 12; // ~32ms of speech before ungating
    this._silentFrames = 0;
    this._speechFrames = 0;
    this._gated = false;
    this._active = true;
    this._startupFrames = 0;
    this._startupGrace = 188; // ~500ms grace period
    this._frameCounter = 0; // for throttled RMS updates
    this._rmsPeak = 0; // loudest smoothed level since the last RMS update
    this._powers = new Float64Array(SMOOTH_QUANTA); // mean square of the last quanta
    this._powerAt = 0;
    this._powerSum = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === "config") {
        this._threshold = event.data.threshold;
        if (event.data.gateOnFrames !== undefined) this._gateOnFrames = event.data.gateOnFrames;
        if (event.data.gateOffFrames !== undefined) this._gateOffFrames = event.data.gateOffFrames;
        // A new threshold restarts the attack/hold counts; the start-up
        // grace is about audio settling and is not repeated.
        this._silentFrames = 0;
        this._speechFrames = 0;
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
    if (!this._active) {
      // Returning false stops the processor. The main thread waits for this
      // before closing the AudioContext: a context closed first never calls
      // process() again, and Chromium then keeps the node alive for good.
      this.port.postMessage({ type: "stopped" });
      return false;
    }

    const input = inputs[0];
    if (input === undefined || input.length === 0 || input[0] === undefined) return true;

    const samples = input[0];
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      sum += v * v;
    }
    const power = sum / samples.length;
    this._powerSum += power - this._powers[this._powerAt];
    this._powers[this._powerAt] = power;
    this._powerAt = (this._powerAt + 1) % SMOOTH_QUANTA;
    const rms = Math.sqrt(Math.max(this._powerSum, 0) / SMOOTH_QUANTA);

    // Grace period: don't gate for the first ~500ms to let audio settle
    if (this._startupFrames < this._startupGrace) {
      this._startupFrames++;
      return true;
    }

    // Send the loudest smoothed level to the main thread every ~19 frames
    // (~50ms at 128 samples/frame @ 48kHz): the level the gate below compared
    // against, for the VAD indicator bar in the UI
    if (rms > this._rmsPeak) this._rmsPeak = rms;
    this._frameCounter++;
    if (this._frameCounter >= 19) {
      this._frameCounter = 0;
      this.port.postMessage({ type: "rms", value: this._rmsPeak });
      this._rmsPeak = 0;
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
