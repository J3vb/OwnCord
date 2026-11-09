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
// probability drops away. The gate runs with it at the automatic threshold
// and at the slider's alike, so typing, a fan or breath above the slider's
// level neither opens the gate nor holds it open after speech.
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

// Use the same speech confidence to open the gate and to renew its hold.
// The hold bridges quiet consonants, while sustained uncertain audio
// cannot keep the gate open by itself.
const SPEECH_PROBABILITY = 0.5;

// Three 32 ms frames confirm speech. Two strong frames can open the gate
// sooner when RNNoise independently confirms the second frame.
const SILERO_CAPTURE_SAMPLES = 1536;
const SILERO_ATTACK_FRAMES = 3;
const SILERO_HOLD_FRAMES = 16;
const SILERO_MAX_PENDING = 3;
const SILERO_OPEN_PROBABILITY = 0.8;
const SILERO_FAST_OPEN_PROBABILITY = 0.85;
const RNNOISE_FAST_OPEN_PROBABILITY = 0.98;

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
    this._gated = true;
    this._speechGate = false;
    this._active = true;
    this._startupFrames = 0;
    this._startupGrace = 188; // ~500 ms for the capture and classifier to settle
    this._frameCounter = 0; // for throttled RMS updates
    this._rmsPeak = 0; // loudest smoothed level since the last RMS update
    this._powers = new Float64Array(SMOOTH_QUANTA); // mean square of the last quanta
    this._powerAt = 0;
    this._powerSum = 0;
    this._sileroPort = null;
    this._sileroReady = false;
    this._sileroAudio = null;
    this._sileroOffset = 0;
    this._sileroFrame = 0;
    this._sileroLastScore = -1;
    this._sileroPending = 0;
    this._sileroPeak = 0;
    this._sileroRnnoisePeak = 0;
    this._sileroAttackPeak = 0;
    this._sileroStrongFrame = null;

    this.port.onmessage = (event) => {
      if (event.data.type === "config") {
        if (event.data.gateOnFrames !== undefined) this._gateOnFrames = event.data.gateOnFrames;
        if (event.data.gateOffFrames !== undefined) this._gateOffFrames = event.data.gateOffFrames;
        if (event.data.speechGate !== undefined) this._speechGate = event.data.speechGate;
        this._setThreshold(event.data.threshold);
        if (this._gated) this.port.postMessage({ type: "gate", gated: true });
      } else if (event.data.type === "threshold") {
        this._setThreshold(event.data.threshold);
      } else if (event.data.type === "speechGate") {
        // RNNoise's verdict arrived (or went away) under a running gate: the
        // counts carry on, as a threshold move's do.
        this._speechGate = event.data.on;
      } else if (event.data.type === "silero") {
        this._setSileroPort(event.data.port);
      } else if (event.data.type === "sileroReady") {
        this._sileroReady = true;
      } else if (event.data.type === "stop") {
        this._sileroPort?.close();
        this._active = false;
      }
    };
  }

  _setGated(closed) {
    if (closed === this._gated) return;
    this._gated = closed;
    this.port.postMessage({ type: "gate", gated: closed });
  }

  _setSileroPort(port) {
    this._sileroPort?.close();
    this._sileroPort = port;
    this._sileroReady = false;
    this._sileroAudio = port === null ? null : new Float32Array(SILERO_CAPTURE_SAMPLES);
    this._sileroOffset = 0;
    this._sileroFrame = 0;
    this._sileroLastScore = -1;
    this._sileroPending = 0;
    this._sileroPeak = 0;
    this._sileroRnnoisePeak = 0;
    this._resetSileroAttack();
    this._silentFrames = 0;
    if (port !== null) {
      this._setGated(this._threshold > 0);
      port.onmessage = ({ data }) => {
        if (this._sileroPort === port) this._onSileroScore(data);
      };
    }
  }

  _resetSileroAttack() {
    this._speechFrames = 0;
    this._sileroAttackPeak = 0;
    this._sileroStrongFrame = null;
  }

  _onSileroScore({ frame, probability, peak, rnnoisePeak }) {
    this._sileroPending--;
    const previous = this._sileroLastScore;
    this._sileroLastScore = frame;
    if (this._threshold === 0 || this._sileroFrame - frame > SILERO_MAX_PENDING) return;

    if (frame !== previous + 1 || probability < SILERO_OPEN_PROBABILITY) this._resetSileroAttack();
    if (probability >= SILERO_OPEN_PROBABILITY) {
      this._sileroAttackPeak = Math.max(this._sileroAttackPeak, peak);
      this._speechFrames = Math.min(SILERO_ATTACK_FRAMES, this._speechFrames + 1);
    }
    const strong = probability >= SILERO_FAST_OPEN_PROBABILITY;
    const shortSpeechConfirmed =
      strong &&
      this._sileroStrongFrame === frame - 1 &&
      rnnoisePeak >= RNNOISE_FAST_OPEN_PROBABILITY;
    this._sileroStrongFrame = strong ? frame : null;
    const speechConfirmed = this._speechFrames === SILERO_ATTACK_FRAMES;
    if (this._gated) {
      if ((speechConfirmed || shortSpeechConfirmed) && this._sileroAttackPeak >= this._threshold) {
        this._silentFrames = 0;
        this._setGated(false);
      }
    } else if (speechConfirmed && peak >= this._threshold * CLOSE_RATIO) {
      this._silentFrames = 0;
    } else if (++this._silentFrames >= SILERO_HOLD_FRAMES) {
      this._resetSileroAttack();
      this._setGated(true);
    }
  }

  _sampleSilero(samples, rms, rnnoiseProbability) {
    this._sileroPeak = Math.max(this._sileroPeak, rms);
    this._sileroRnnoisePeak = Math.max(this._sileroRnnoisePeak, rnnoiseProbability);
    for (let start = 0; start < samples.length;) {
      const count = Math.min(samples.length - start, SILERO_CAPTURE_SAMPLES - this._sileroOffset);
      this._sileroAudio.set(samples.subarray(start, start + count), this._sileroOffset);
      start += count;
      this._sileroOffset += count;
      if (this._sileroOffset !== SILERO_CAPTURE_SAMPLES) continue;
      const frame = this._sileroFrame++;
      if (this._sileroPending < SILERO_MAX_PENDING) {
        const audio = this._sileroAudio;
        this._sileroPort.postMessage(
          { frame, samples: audio, peak: this._sileroPeak, rnnoisePeak: this._sileroRnnoisePeak },
          [audio.buffer],
        );
        this._sileroAudio = new Float32Array(SILERO_CAPTURE_SAMPLES);
        this._sileroPending++;
      }
      this._sileroOffset = 0;
      this._sileroPeak = rms;
      this._sileroRnnoisePeak = 0;
      if (frame - this._sileroLastScore > SILERO_MAX_PENDING) {
        this._resetSileroAttack();
        this._setGated(true);
      }
    }
  }

  _setThreshold(threshold) {
    const wasEnabled = this._threshold > 0;
    this._threshold = threshold;
    const enabled = threshold > 0;
    if (wasEnabled === enabled) return;
    this._silentFrames = 0;
    this._resetSileroAttack();
    this._setGated(enabled);
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

    const starting = this._startupFrames < this._startupGrace;
    if (starting) {
      this._startupFrames++;
    } else {
      this._reportLevel(rms);
    }

    if (this._sileroPort !== null) {
      if (this._sileroReady && this._threshold > 0)
        this._sampleSilero(inputs[2]?.[0] ?? samples, rms, probability);
      return true;
    }

    // Zero means RNNoise has no verdict. Give it time to start before
    // opening on level alone. If it fails, the level gate still works.
    if (this._threshold === 0 || (starting && this._speechGate && probability === 0)) {
      return true;
    }
    const voiced = !this._speechGate || probability === 0 || probability >= SPEECH_PROBABILITY;
    if (this._gated) {
      if (rms >= this._threshold && voiced) this._speechFrames++;
      else if (this._speechFrames > 0) this._speechFrames--;
      if (this._speechFrames >= this._gateOffFrames) {
        this._gated = false;
        this._speechFrames = 0;
        this._silentFrames = 0;
        this.port.postMessage({ type: "gate", gated: false });
      }
    } else if (rms < this._threshold * CLOSE_RATIO || !voiced) {
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

  _reportLevel(rms) {
    // Report the peak of the smoothed levels every ~50 ms for the meter
    // and the automatic sensitivity estimate.
    if (rms > this._rmsPeak) this._rmsPeak = rms;
    this._frameCounter++;
    if (this._frameCounter >= 19) {
      this._frameCounter = 0;
      this.port.postMessage({ type: "rms", value: this._rmsPeak });
      this._rmsPeak = 0;
    }
  }
}

registerProcessor("vad-processor", VadProcessor);
