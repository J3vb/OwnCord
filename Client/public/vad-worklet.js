// =============================================================================
// VAD (Voice Activity Detection) AudioWorklet Processor
//
// Runs on the audio rendering thread. Computes a smoothed RMS level (the last
// SMOOTH_QUANTA render quanta, ~10 ms) and sends gating decisions to the main thread via MessagePort. This replaces
// setTimeout-based polling which pauses when the app is backgrounded.
//
// Input 0 is the microphone (the processor's analyser tap). Input 1, when
// connected, is RNNoise's speech probability for the latest frame
// (rnnoise-worklet.js output 1): with `speechGate` on, a quantum counts as
// speech only when its level clears the threshold AND the probability says
// voice, and as quiet when the level drops under the close level OR the
// probability drops away. Automatic sensitivity runs with it; the manual
// slider stays a pure level gate.
//
// Protocol:
//   Main → Worklet:  { type: "config", threshold: number, gateOnFrames: number, gateOffFrames: number, speechGate?: boolean }
//   Main → Worklet:  { type: "threshold", threshold: number }  (move the level only; automatic sensitivity)
//   Main → Worklet:  { type: "speechGate", on: boolean }  (require RNNoise's verdict, once it is wired)
//   Main → Worklet:  { type: "stop" }
//   Worklet → Main:  { type: "gate", gated: boolean }
//   Worklet → Main:  { type: "rms", value: number }  (loudest smoothed level since the last one)
//   Worklet → Main:  { type: "stopped" }  (from the final process() call)
// =============================================================================

// The gate and the settings meter both read this one level, so a green meter
// bar past the handle is what the gate opens on. A single 2.67 ms quantum
// swings ~4 dB inside voiced speech; ~10 ms does not.
const SMOOTH_QUANTA = 4;

// Hysteresis: the gate opens at the threshold and closes only this far
// below it, so the quieter stretches of a word do not count as silence and a
// voice hovering at the line does not chatter.
const HYSTERESIS_DB = 6;
const CLOSE_RATIO = 10 ** (-HYSTERESIS_DB / 20);

// RNNoise's probability that a frame is voice: at or above the first it
// counts toward opening, under the second it counts toward closing. Inside
// a word the probability dips at stops and pauses; the hold covers those.
const SPEECH_OPEN_PROBABILITY = 0.5;
const SPEECH_CLOSE_PROBABILITY = 0.15;

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._threshold = 0.05;
    // process() runs once per 128-sample render quantum (2.667ms @ 48kHz —
    // see audioPipeline.ts's `new AudioContext({ sampleRate: 48000 })`), NOT
    // once per ~16ms poll like the setTimeout fallback. These frame counts
    // are therefore ~6x the fallback's, so both paths gate on the same
    // wall-clock timing.
    this._gateOnFrames = 188; // ~500ms below the close level before gating: bridges the pauses inside a sentence
    this._gateOffFrames = 12; // ~32ms of speech before ungating
    this._silentFrames = 0;
    // Counts up on a quantum at the threshold and down on one below it, so a
    // single dip inside an onset does not start the attack over.
    this._speechFrames = 0;
    this._gated = false;
    this._speechGate = false;
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
        if (event.data.speechGate !== undefined) this._speechGate = event.data.speechGate;
        // A new threshold restarts the attack/hold counts; the start-up
        // grace is about audio settling and is not repeated.
        this._silentFrames = 0;
        this._speechFrames = 0;
        if (this._gated) {
          this._gated = false;
          this.port.postMessage({ type: "gate", gated: false });
        }
      } else if (event.data.type === "threshold") {
        // The automatic floor moved: the attack/hold state and the gate carry
        // on, so a running estimate never reopens a closed gate.
        this._threshold = event.data.threshold;
      } else if (event.data.type === "speechGate") {
        // RNNoise's verdict arrived (or went away) under a running gate: the
        // counts carry on, as a threshold move's do.
        this._speechGate = event.data.on;
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
    // The probability is constant across a quantum; an unconnected input
    // reads as no voice, which only matters with the speech gate on.
    const speech = inputs[1];
    const probability =
      speech !== undefined && speech.length > 0 && speech[0] !== undefined && speech[0].length > 0
        ? speech[0][speech[0].length - 1]
        : 0;
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

    // Gate logic (the setTimeout fallback in audioPipeline.ts mirrors the
    // level rule; it has no RNNoise and so no speech rule)
    const voiced = !this._speechGate || probability >= SPEECH_OPEN_PROBABILITY;
    const unvoiced = this._speechGate && probability < SPEECH_CLOSE_PROBABILITY;
    if (this._gated) {
      if (rms >= this._threshold && voiced) this._speechFrames++;
      else if (this._speechFrames > 0) this._speechFrames--;
      if (this._speechFrames >= this._gateOffFrames) {
        this._gated = false;
        this._speechFrames = 0;
        this._silentFrames = 0;
        this.port.postMessage({ type: "gate", gated: false });
      }
    } else if (rms < this._threshold * CLOSE_RATIO || unvoiced) {
      this._silentFrames++;
      if (this._silentFrames >= this._gateOnFrames) {
        this._gated = true;
        this._silentFrames = 0;
        this._speechFrames = 0;
        this.port.postMessage({ type: "gate", gated: true });
      }
    } else {
      this._silentFrames = 0;
    }

    return true;
  }
}

registerProcessor("vad-processor", VadProcessor);
