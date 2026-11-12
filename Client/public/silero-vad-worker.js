import { createSileroVad, FRAME_SAMPLES } from "./silero-vad.js";

const INPUT_SAMPLES = FRAME_SAMPLES * 3;
const TAP_COUNT = 31;
const HALF = (TAP_COUNT - 1) / 2;

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

async function start(port) {
  const response = await fetch(new URL("./silero-v5.1.2.bin", import.meta.url));
  if (!response.ok) throw new Error(`Silero model HTTP ${response.status}`);
  const vad = createSileroVad(await response.arrayBuffer());
  const downsample = createDownsampler();
  let lastFrame = -1;
  port.onmessage = ({ data }) => {
    const { frame, samples, peak } = data;
    try {
      if (samples.length !== INPUT_SAMPLES) throw new Error("Invalid Silero input frame");
      if (frame !== lastFrame + 1) {
        vad.reset();
        downsample.reset();
      }
      lastFrame = frame;
      const probability = vad.score(downsample.frame(samples));
      if (!Number.isFinite(probability)) throw new Error("Invalid Silero score");
      port.postMessage({ frame, probability, peak });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
      port.close();
    }
  };
  self.postMessage({ type: "ready" });
}

self.onmessage = ({ data }) => {
  void start(data.port).catch((error) => {
    self.postMessage({ type: "error", message: String(error) });
    data.port.close();
  });
};
