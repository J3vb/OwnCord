/**
 * Pure helpers for a voice message's waveform and clock (WP 8.9). A waveform is
 * one byte (0-255) per bar; on the wire it is base64url without padding.
 */

/** Bars in a recorded waveform and in the player. */
export const WAVEFORM_BARS = 64;
/** The server's cap on a decoded waveform. */
export const WAVEFORM_MAX_BYTES = 256;

/** The loudest value in each of `bars` equal slices of `values`. A short input
 *  is stretched so every bar reads a value; an empty one gives silence. */
export function bucketMax(values: ArrayLike<number>, bars: number): number[] {
  const out: number[] = Array.from({ length: bars }, () => 0);
  const n = values.length;
  if (n === 0) return out;
  for (let i = 0; i < bars; i++) {
    const start = Math.min(n - 1, Math.floor((i * n) / bars));
    const end = Math.min(n, Math.max(start + 1, Math.floor(((i + 1) * n) / bars)));
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, values[j] ?? 0);
    out[i] = peak;
  }
  return out;
}

/** Reduce level samples (0..1 peaks) to `bars` bytes, the loudest bar 255. A
 *  clip with no signal at all stays all zero. */
export function reducePeaks(peaks: ArrayLike<number>, bars = WAVEFORM_BARS): Uint8Array {
  const buckets = bucketMax(peaks, bars);
  const loudest = Math.max(...buckets);
  const out = new Uint8Array(bars);
  if (!(loudest > 0)) return out;
  for (let i = 0; i < bars; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(((buckets[i] ?? 0) / loudest) * 255)));
  }
  return out;
}

/** base64url, no padding. */
export function encodeWaveform(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url waveform, or null when it is not a valid one. */
export function decodeWaveform(encoded: string): Uint8Array | null {
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    if (binary.length === 0 || binary.length > WAVEFORM_MAX_BYTES) return null;
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Whole seconds as m:ss (no hours: a voice message is at most 5 minutes). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
