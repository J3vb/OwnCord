// Silero VAD v5.1.2, 16 kHz model. The GGML layout and forward pass follow
// whisper.cpp's Silero implementation. See silero-license.txt.
export const FRAME_SAMPLES = 512;
const BINS = 129;
const FEATURES = 128;
const STFT_SIZE = 256;
const GGML_MAGIC = 0x67676d6c;
const ENCODERS = [
  [129, 128, 1],
  [128, 64, 2],
  [64, 64, 2],
  [64, 128, 1],
];

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function half(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const mantissa = bits & 1023;
  return exponent === 0
    ? sign * mantissa * 2 ** -24
    : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function readWeights(bytes) {
  const view = new DataView(bytes);
  const decoder = new TextDecoder();
  let offset = 0;
  const int = () => {
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const string = (length) => {
    const value = decoder.decode(new Uint8Array(bytes, offset, length));
    offset += length;
    return value;
  };
  if (int() !== GGML_MAGIC || string(int()) !== "silero-16k") {
    throw new Error("Invalid Silero model header");
  }
  const expected = [
    5, 1, 2, 512, 64, 4, 129, 128, 3, 128, 64, 3, 64, 64, 3, 64, 128, 3, 128, 128, 128, 1,
  ];
  for (const field of expected) {
    if (int() !== field) throw new Error("Unsupported Silero model layout");
  }

  const tensors = new Map();
  while (offset < bytes.byteLength) {
    const dimensions = int();
    const nameLength = int();
    const type = int();
    if (
      dimensions < 0 ||
      dimensions > 3 ||
      nameLength < 1 ||
      nameLength > 80 ||
      (type !== 0 && type !== 1)
    ) {
      throw new Error("Invalid Silero tensor header");
    }
    let length = 1;
    for (let d = 0; d < dimensions; d++) length *= int();
    const name = string(nameLength);
    const step = type === 0 ? 4 : 2;
    if (length < 1 || length > (bytes.byteLength - offset) / step || tensors.has(name)) {
      throw new Error("Invalid Silero tensor size");
    }
    const values = new Float32Array(length);
    for (let j = 0; j < length; j++, offset += step) {
      values[j] = type === 0 ? view.getFloat32(offset, true) : half(view.getUint16(offset, true));
    }
    tensors.set(name, values);
  }

  return (name, length) => {
    const values = tensors.get("_model." + name);
    if (values?.length !== length) throw new Error("Missing or invalid Silero tensor " + name);
    return values;
  };
}

function stft(frame, basis, magnitude, padded) {
  padded.set(frame, 64);
  for (let i = 1; i <= 64; i++) {
    padded[64 - i] = frame[i];
    padded[FRAME_SAMPLES + 63 + i] = frame[FRAME_SAMPLES - 1 - i];
  }
  for (let bin = 0; bin < BINS; bin++) {
    const real = bin * STFT_SIZE;
    const imaginary = (bin + BINS) * STFT_SIZE;
    for (let t = 0; t < 4; t++) {
      const start = t * FEATURES;
      let re = 0;
      let im = 0;
      for (let j = 0; j < STFT_SIZE; j++) {
        const sample = padded[start + j];
        re += sample * basis[real + j];
        im += sample * basis[imaginary + j];
      }
      magnitude[bin * 4 + t] = Math.sqrt(re * re + im * im);
    }
  }
}

function encoderLayer(input, width, layer) {
  const { channels, stride, weights, bias, output, outputWidth } = layer;
  for (let o = 0; o < bias.length; o++) {
    const row = o * channels * 3;
    for (let t = 0; t < outputWidth; t++) {
      const center = t * stride;
      let value = bias[o];
      for (let i = 0; i < channels; i++) {
        const at = i * width + center;
        const w = row + i * 3;
        if (center > 0) value += input[at - 1] * weights[w];
        value += input[at] * weights[w + 1];
        if (center + 1 < width) value += input[at + 1] * weights[w + 2];
      }
      output[o * outputWidth + t] = Math.max(0, value);
    }
  }
}

export function createSileroVad(bytes) {
  const tensor = readWeights(bytes);
  const basis = tensor("stft.forward_basis_buffer", STFT_SIZE * BINS * 2);
  const magnitude = new Float32Array(BINS * 4);
  const padded = new Float32Array(FRAME_SAMPLES + 128);
  let width = 4;
  const layers = ENCODERS.map(([channels, count, stride], index) => {
    const name = `encoder.${index}.reparam_conv`;
    const outputWidth = Math.ceil(width / stride);
    const layer = {
      channels,
      stride,
      weights: tensor(name + ".weight", channels * count * 3),
      bias: tensor(name + ".bias", count),
      outputWidth,
      output: new Float32Array(count * outputWidth),
    };
    width = outputWidth;
    return layer;
  });
  const gateCount = FEATURES * 4;
  const inputWeights = tensor("decoder.rnn.weight_ih", FEATURES * gateCount);
  const stateWeights = tensor("decoder.rnn.weight_hh", FEATURES * gateCount);
  const inputBias = tensor("decoder.rnn.bias_ih", gateCount);
  const stateBias = tensor("decoder.rnn.bias_hh", gateCount);
  const outputWeights = tensor("decoder.decoder.2.weight", FEATURES);
  const outputBias = tensor("decoder.decoder.2.bias", 1)[0];
  const gates = new Float32Array(gateCount);
  const hidden = new Float32Array(FEATURES);
  const cell = new Float32Array(FEATURES);

  return {
    reset() {
      hidden.fill(0);
      cell.fill(0);
    },
    score(frame) {
      if (frame.length !== FRAME_SAMPLES) throw new Error("Silero needs 512 samples");
      stft(frame, basis, magnitude, padded);
      let input = magnitude;
      let width = 4;
      for (const layer of layers) {
        encoderLayer(input, width, layer);
        input = layer.output;
        width = layer.outputWidth;
      }

      for (let gate = 0; gate < gateCount; gate++) {
        const offset = gate * FEATURES;
        let value = inputBias[gate] + stateBias[gate];
        for (let i = 0; i < FEATURES; i++) {
          value += inputWeights[offset + i] * input[i] + stateWeights[offset + i] * hidden[i];
        }
        gates[gate] = value;
      }

      let score = outputBias;
      for (let i = 0; i < FEATURES; i++) {
        const inputGate = sigmoid(gates[i]);
        const forgetGate = sigmoid(gates[FEATURES + i]);
        const candidate = Math.tanh(gates[FEATURES * 2 + i]);
        const outputGate = sigmoid(gates[FEATURES * 3 + i]);
        cell[i] = forgetGate * cell[i] + inputGate * candidate;
        hidden[i] = outputGate * Math.tanh(cell[i]);
        score += Math.max(0, hidden[i]) * outputWeights[i];
      }
      return sigmoid(score);
    },
  };
}
