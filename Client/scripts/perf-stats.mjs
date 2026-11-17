// Pure helpers shared by the opt-in performance measurements
// (tests/e2e/fullstack/*.measure.ts) and their analyzer (analyze-perf.mjs):
// counter deltas that notice a reset, a bounded non-overlapping sampler, and
// order statistics with a run-level bootstrap. No Playwright, no I/O.

/** Linear-interpolated quantile of an ascending array; NaN when empty. */
export function quantile(sorted, q) {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const ascending = (a, b) => a - b;

/** A small seeded PRNG (mulberry32), so a bootstrap is repeatable. */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% interval of the median, resampling whole runs (each inner array is one
 * independent run's values), never single samples: trials inside one run
 * share a server, a machine state and a warm cache, so they are not
 * independent of each other.
 */
export function runBootstrapMedian(runs, { iterations = 2000, seed = 1 } = {}) {
  const groups = runs.filter((r) => r.length > 0);
  if (groups.length === 0) return [Number.NaN, Number.NaN];
  const random = seededRandom(seed);
  const medians = [];
  for (let i = 0; i < iterations; i++) {
    const pooled = [];
    for (let g = 0; g < groups.length; g++) {
      pooled.push(...groups[Math.floor(random() * groups.length)]);
    }
    medians.push(quantile(pooled.sort(ascending), 0.5));
  }
  medians.sort(ascending);
  return [quantile(medians, 0.025), quantile(medians, 0.975)];
}

/** n, run count, p50, p95, min, max and the run-bootstrap interval of p50. */
export function summarize(runs, options) {
  const all = runs.flat().sort(ascending);
  return {
    n: all.length,
    runs: runs.filter((r) => r.length > 0).length,
    p50: quantile(all, 0.5),
    p95: quantile(all, 0.95),
    min: all.length ? all[0] : Number.NaN,
    max: all.length ? all[all.length - 1] : Number.NaN,
    ci95: runBootstrapMedian(runs, options),
  };
}

/**
 * Per-id differences of cumulative counters between two reads. `reset` is
 * set when a counter went backwards or a stream that carried traffic before
 * is gone: the window then mixes two senders/receivers and its rates mean
 * nothing, so callers discard it rather than report it.
 */
export function counterDeltas(before, after, counters) {
  const prev = new Map(before.map((e) => [e.id, e]));
  const next = new Set(after.map((e) => e.id));
  const reasons = [];
  for (const e of before) {
    if (!next.has(e.id) && counters.some((c) => (e[c] ?? 0) > 0)) reasons.push(`${e.id} gone`);
  }
  const deltas = [];
  for (const e of after) {
    const p = prev.get(e.id);
    const delta = {};
    for (const c of counters) {
      const d = (e[c] ?? 0) - (p?.[c] ?? 0);
      if (d < 0) reasons.push(`${e.id} ${c} went back`);
      delta[c] = d;
    }
    deltas.push({ entry: e, isNew: p === undefined, delta });
  }
  return { reset: reasons.length > 0, reasons, deltas };
}

/**
 * Reads `read()` every `intervalMs`, one read at a time, into a ring capped
 * at `maxSamples` and `maxBytes` (JSON size). `stop()` waits at most
 * `settleMs` for a read still in flight and drops whatever it returns later,
 * so a run that ends mid-read neither hangs nor gains a sample after it ended.
 */
export function createSampler({
  read,
  intervalMs = 1000,
  maxSamples = 180,
  maxBytes = 2 * 1024 * 1024,
  settleMs = 2000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const samples = [];
  const sizes = [];
  let bytes = 0;
  let dropped = 0;
  let failures = 0;
  let running = false;
  let timer;
  let inFlight;

  const push = (sample) => {
    const size = JSON.stringify(sample).length;
    samples.push(sample);
    sizes.push(size);
    bytes += size;
    while (samples.length > maxSamples || (bytes > maxBytes && samples.length > 1)) {
      samples.shift();
      bytes -= sizes.shift();
      dropped++;
    }
  };

  const tick = () => {
    if (!running) return;
    const attempt = Promise.resolve()
      .then(read)
      .then(
        (sample) => {
          if (running && attempt === inFlight) push(sample);
        },
        () => {
          if (running) failures++;
        },
      )
      .finally(() => {
        if (attempt !== inFlight) return;
        inFlight = undefined;
        if (running) timer = setTimer(tick, intervalMs);
      });
    inFlight = attempt;
  };

  return {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    async stop() {
      running = false;
      clearTimer(timer);
      const pending = inFlight;
      inFlight = undefined;
      if (pending === undefined) return;
      let settle;
      await Promise.race([
        pending,
        new Promise((resolve) => (settle = setTimer(resolve, settleMs))),
      ]);
      clearTimer(settle);
    },
    samples: () => samples.slice(),
    stats: () => ({ kept: samples.length, dropped, failures, bytes }),
  };
}
