/**
 * Read the 16-bit mono 48 kHz PCM recordings under `tests/fixtures/audio/`
 * (provenance in that directory's README) as samples in -1..1.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const FIXTURE_SAMPLE_RATE = 48000;

export function readAudioFixture(name: string): Float32Array {
  const bytes = readFileSync(resolve("tests/fixtures/audio", name));
  // Canonical 44-byte header, which is what these fixtures were written with.
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) / 2);
  return Float32Array.from(pcm, (v) => v / 32768);
}

/**
 * `clip` placed at `atSeconds` in `totalSeconds` of quiet room tone. A real
 * microphone is never digitally silent, and a noise suppressor estimates its
 * noise floor from that tone: about -51 dBFS, an ordinary room with a PC in
 * it. Seeded, so every run sees the same samples.
 */
export function placeInRoomTone(
  clip: Float32Array,
  atSeconds: number,
  totalSeconds: number,
): Float32Array {
  const out = new Float32Array(Math.round(totalSeconds * FIXTURE_SAMPLE_RATE));
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = (seed / 0x100000000 - 0.5) * 0.01;
  }
  const at = Math.round(atSeconds * FIXTURE_SAMPLE_RATE);
  for (let i = 0; i < clip.length; i++) out[at + i] = (out[at + i] ?? 0) + (clip[i] ?? 0);
  return out;
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

export const toDb = (linear: number): number => 20 * Math.log10(Math.max(linear, 1e-9));
