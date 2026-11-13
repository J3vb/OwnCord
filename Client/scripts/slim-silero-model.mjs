#!/usr/bin/env node
// Writes the smaller copy of a Silero GGML model that the app ships as its
// second speech model, public/silero-v6.2.0-slim.bin: the two LSTM matrices
// are stored as 16-bit floats, and the STFT table is left out because the
// worker takes it from silero-v5.1.2.bin, which holds the same one. The
// source file and both checksums are in public/silero-license.txt.
//
//   node scripts/slim-silero-model.mjs <ggml-in> <slim-out>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const AS_HALF = new Set(["_model.decoder.rnn.weight_ih", "_model.decoder.rnn.weight_hh"]);
const LEFT_OUT = new Set(["_model.stft.forward_basis_buffer"]);
const GGML_MAGIC = 0x67676d6c;
const HEADER_INTS = 22;
const FLOAT32 = 0;
const FLOAT16 = 1;

const single = new Float32Array(1);
const bits = new Uint32Array(single.buffer);

/** IEEE 754 binary16 bits of a float32 value, rounded to nearest, ties to even. */
function halfBits(value) {
  single[0] = value;
  const sign = (bits[0] >>> 16) & 0x8000;
  const exponent = ((bits[0] >>> 23) & 0xff) - 112;
  const mantissa = bits[0] & 0x7fffff;
  if (exponent >= 31) throw new Error("A weight is outside the 16-bit float range");
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const scaled = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((scaled + (scaled & 0x1000)) >> 13);
  }
  const half = sign | (exponent << 10) | (mantissa >> 13);
  const rest = mantissa & 0x1fff;
  return rest > 0x1000 || (rest === 0x1000 && (half & 1) === 1) ? half + 1 : half;
}

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error("usage: node scripts/slim-silero-model.mjs <ggml-in> <slim-out>");
  process.exit(2);
}
const source = readFileSync(input);
let offset = 0;
const int = () => {
  const value = source.readInt32LE(offset);
  offset += 4;
  return value;
};
if (int() !== GGML_MAGIC) throw new Error("Not a GGML file");
const modelNameLength = int();
offset += modelNameLength + HEADER_INTS * 4;
const parts = [source.subarray(0, offset)];
const seen = new Set();
while (offset < source.length) {
  const start = offset;
  const dimensions = int();
  const nameLength = int();
  const type = int();
  if (dimensions < 0 || dimensions > 3 || (type !== FLOAT32 && type !== FLOAT16)) {
    throw new Error(`Invalid tensor header at byte ${start}`);
  }
  let count = 1;
  for (let d = 0; d < dimensions; d++) count *= int();
  const name = source.toString("utf8", offset, offset + nameLength);
  offset += nameLength;
  const data = offset;
  offset += count * (type === FLOAT32 ? 4 : 2);
  if (offset > source.length) throw new Error(`Tensor ${name} runs past the end of the file`);
  seen.add(name);
  if (LEFT_OUT.has(name)) continue;
  if (!AS_HALF.has(name) || type !== FLOAT32) {
    parts.push(source.subarray(start, offset));
    continue;
  }
  const head = Buffer.from(source.subarray(start, data));
  head.writeInt32LE(FLOAT16, 8);
  const halves = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++)
    halves.writeUInt16LE(halfBits(source.readFloatLE(data + i * 4)), i * 2);
  parts.push(head, halves);
}
for (const name of [...AS_HALF, ...LEFT_OUT]) {
  if (!seen.has(name)) throw new Error(`Tensor ${name} is not in ${input}`);
}
const slim = Buffer.concat(parts);
writeFileSync(output, slim);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
console.log(`${input}: ${source.length} bytes, SHA-256 ${sha256(source)}`);
console.log(`${output}: ${slim.length} bytes, SHA-256 ${sha256(slim)}`);
