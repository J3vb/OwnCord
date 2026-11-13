import { createSileroVad, FRAME_SAMPLES } from "./silero-vad.js";

const INPUT_SAMPLES = FRAME_SAMPLES * 3;
const TAP_COUNT = 31;
const HALF = (TAP_COUNT - 1) / 2;

// Two models score every frame, and a frame is speech when either says so.
//
// The first is v5.1.2 with a memory that runs on from frame to frame. The gate
// holds its score against its own bar. What it heard last decides how it scores
// the next sound: right after speech a soft "hmm" scores high, after seconds of
// silence or after typing the same "hmm" scores near zero.
//
// The second is v6.2.0 at a strict bar. It meets every sound that ends a quiet
// stretch with the same memory, its rest state: from there a soft word scores
// above the bar while a thump, a click or a key stays under it. A memory left
// running through the silence would let the thump through as well, and one
// cleared to zero would miss the word. In a room that is never quiet it runs
// on like the first, and at its bar it adds little there.
//
// The bar is the user's "Let more soft speech through": on is the lower one,
// off the higher one, which keeps more coughs and other short sounds out and
// misses a few more soft words.
const RESTED_SPEECH_PROBABILITY = 0.9;
const STRICT_RESTED_SPEECH_PROBABILITY = 0.95;
const REST_FRAMES = 7;
let softSpeech = true;

// A frame is quiet when every 8 ms of it is under the gate threshold and under
// -55 dBFS, the lowest automatic threshold. The gate reads its own level after
// RNNoise and over a sliding window, so at the edge the two can differ by a
// decibel or two, and the second model then wakes one frame later.
// After QUIET_FRAMES of them (about half a second) the second model rests.
const QUIET_FRAMES = 16;
const QUIET_POWER = 10 ** (-55 / 10);
const LEVEL_SAMPLES = 384;

/** `threshold` is the gate's, as an RMS. A worklet from an older release sends none. */
function isQuiet(samples, threshold) {
  const power = threshold > 0 ? Math.min(QUIET_POWER, threshold * threshold) : QUIET_POWER;
  for (let start = 0; start < samples.length; start += LEVEL_SAMPLES) {
    let sum = 0;
    for (let i = start; i < start + LEVEL_SAMPLES; i++) sum += samples[i] * samples[i];
    if (sum >= power * LEVEL_SAMPLES) return false;
  }
  return true;
}

/** The second model and its rest rule. `vad` resets to the rest state. */
function createRestedDetector(vad) {
  const lastQuiet = new Float32Array(FRAME_SAMPLES);
  let quietFrames = 0;
  return {
    reset() {
      vad.reset();
      quietFrames = 0;
    },
    /** Whether a 16 kHz frame is speech. `quiet` is isQuiet() of its input. */
    speech(frame, quiet) {
      if (quiet) {
        quietFrames = Math.min(QUIET_FRAMES, quietFrames + 1);
        if (quietFrames === QUIET_FRAMES) {
          // Resting. The model next runs when a sound ends the quiet, from
          // its rest state and this frame.
          lastQuiet.set(frame);
          return false;
        }
      } else {
        if (quietFrames === QUIET_FRAMES) {
          vad.reset();
          vad.score(lastQuiet);
        }
        quietFrames = 0;
      }
      const score = vad.score(frame);
      if (!Number.isFinite(score)) throw new Error("Invalid Silero score");
      return score >= (softSpeech ? RESTED_SPEECH_PROBABILITY : STRICT_RESTED_SPEECH_PROBABILITY);
    },
  };
}

// A low-pass filter before 3:1 decimation, with history across frame boundaries.
function createDownsampler() {
  const taps = new Float32Array(TAP_COUNT);
  const cutoff = 0.15;
  let sum = 0;
  for (let i = 0; i < TAP_COUNT; i++) {
    const n = i - HALF;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    taps[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAP_COUNT - 1)));
    sum += taps[i];
  }
  for (let i = 0; i < TAP_COUNT; i++) taps[i] /= sum;
  const buffer = new Float32Array(INPUT_SAMPLES + TAP_COUNT - 1);
  const output = new Float32Array(FRAME_SAMPLES);
  return {
    reset() {
      buffer.fill(0);
    },
    frame(samples) {
      buffer.set(samples, TAP_COUNT - 1);
      for (let i = 0; i < output.length; i++) {
        let value = 0;
        const start = i * 3;
        for (let j = 0; j < TAP_COUNT; j++) value += buffer[start + j] * taps[j];
        output[i] = value;
      }
      buffer.copyWithin(0, INPUT_SAMPLES);
      return output;
    },
  };
}

async function fetchModel(file) {
  const response = await fetch(new URL(file, import.meta.url));
  if (!response.ok) throw new Error(`Silero model HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function start(port) {
  const [weights, restedWeights] = await Promise.all([
    fetchModel("./silero-v5.1.2.bin"),
    fetchModel("./silero-v6.2.0-slim.bin"),
  ]);
  const vad = createSileroVad(weights);
  const rested = createRestedDetector(
    createSileroVad(restedWeights, { restFrames: REST_FRAMES, stftBasis: vad.stftBasis }),
  );
  const downsample = createDownsampler();
  let lastFrame = -1;
  port.onmessage = ({ data }) => {
    const { frame, samples, peak, threshold } = data;
    try {
      if (samples.length !== INPUT_SAMPLES) throw new Error("Invalid Silero input frame");
      if (frame !== lastFrame + 1) {
        vad.reset();
        rested.reset();
        downsample.reset();
      }
      lastFrame = frame;
      const audio = downsample.frame(samples);
      const probability = vad.score(audio);
      if (!Number.isFinite(probability)) throw new Error("Invalid Silero score");
      // The gate compares one score with the first model's bar, so the second
      // model's verdict travels as a score that clears it.
      const speech = rested.speech(audio, isQuiet(samples, threshold));
      port.postMessage({ frame, probability: speech ? 1 : probability, peak });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
      port.close();
    }
  };
  // The setting in force tells the app that this worker takes one.
  self.postMessage({ type: "ready", softSpeech });
}

// The first message brings the port. The setting comes with it, and by itself
// whenever it changes. Only a plain on or off moves the bar, so an app from an
// older release, which sends none, keeps the lower one.
self.onmessage = ({ data }) => {
  if (typeof data.softSpeech === "boolean") softSpeech = data.softSpeech;
  if (data.port === undefined) return;
  void start(data.port).catch((error) => {
    self.postMessage({ type: "error", message: String(error) });
    data.port.close();
  });
};
