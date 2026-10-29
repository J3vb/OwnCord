/** The PCM fallback's encoder (WP 8.9): 16-bit mono WAV, built in JS. */

export const WAV_RATE = 16_000;

/** Average `input` down from `inRate` to `outRate`; a lower or equal input rate is kept. */
export function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate <= outRate) return input;
  const ratio = inRate / outRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** A 16 kHz (by default) mono 16-bit WAV of the captured float chunks. */
export function encodeWav(
  chunks: readonly Float32Array[],
  inRate: number,
  outRate = WAV_RATE,
): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const joined = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  const samples = downsample(joined, inRate, outRate);
  const rate = inRate < outRate ? inRate : outRate;
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
