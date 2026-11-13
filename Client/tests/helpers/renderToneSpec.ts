/**
 * A test-side renderer for a tone spec, following the envelope and glide
 * formulas the app's two renderers implement: the gain rises over `attack`,
 * falls exponentially to `endGain` at `duration`, then linearly to 0 over
 * `release`; with `glide` the pitch slides exponentially between points, on a
 * continuous phase. Mono, summed and clipped to [-1, 1].
 */
import type { NativeToneNote } from "../../src/platform/contracts/nativeVoice";

function pitchAt(n: NativeToneNote, t: number): number {
  let hz = n.freqs[0]![1];
  n.freqs.forEach(([offset, f], k) => {
    if (t < offset) return;
    hz = f;
    const next = n.freqs[k + 1];
    if (n.glide === true && next !== undefined && t < next[0]) {
      hz = f * (next[1] / f) ** ((t - offset) / (next[0] - offset));
    }
  });
  return hz;
}

function gainAt(n: NativeToneNote, t: number): number {
  const attack = n.attack ?? 0;
  const release = n.release ?? 0;
  if (t < attack) return n.gain * (t / attack);
  if (t <= n.duration) {
    return n.gain * (n.endGain / n.gain) ** ((t - attack) / (n.duration - attack));
  }
  return n.endGain * (1 - (t - n.duration) / release);
}

export function renderToneSpec(spec: readonly NativeToneNote[], rate: number): Float32Array {
  const end = Math.max(...spec.map((n) => n.at + n.duration + (n.release ?? 0)));
  const out = new Float32Array(Math.ceil(end * rate) + 1);
  for (const n of spec) {
    const start = Math.round(n.at * rate);
    const total = Math.round((n.duration + (n.release ?? 0)) * rate);
    let phase = 0;
    for (let i = 0; i < total; i++) {
      const t = i / rate;
      out[start + i]! += Math.sin(phase) * gainAt(n, t);
      phase += (2 * Math.PI * pitchAt(n, t)) / rate;
    }
  }
  return out.map((s) => Math.max(-1, Math.min(1, s)));
}

/** The peak of a rendered spec, in dBFS. */
export function peakDbfs(samples: Float32Array): number {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return 20 * Math.log10(peak);
}
