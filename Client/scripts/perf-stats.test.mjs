import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  counterDeltas,
  createSampler,
  quantile,
  runBootstrapMedian,
  summarize,
} from "./perf-stats.mjs";

test("quantiles interpolate and an empty set has none", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10], 0.95), 10);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test("the median interval resamples runs, so one noisy run widens it", () => {
  const steady = summarize([
    [10, 11, 10],
    [10, 10, 11],
    [11, 10, 10],
  ]);
  const noisy = summarize([
    [10, 11, 10],
    [10, 10, 11],
    [40, 42, 41],
  ]);
  assert.equal(steady.runs, 3);
  assert.equal(steady.n, 9);
  assert.ok(steady.ci95[1] - steady.ci95[0] <= 1);
  assert.ok(noisy.ci95[1] - noisy.ci95[0] > 20);
  assert.deepEqual(
    runBootstrapMedian([[1, 2]], { seed: 7 }),
    runBootstrapMedian([[1, 2]], { seed: 7 }),
  );
});

test("a counter that goes back marks the window as reset", () => {
  const before = [{ id: "v", bytes: 5000, frames: 100 }];
  const after = [{ id: "v", bytes: 200, frames: 4 }];
  const result = counterDeltas(before, after, ["bytes", "frames"]);
  assert.equal(result.reset, true);
  assert.deepEqual(result.reasons, ["v bytes went back", "v frames went back"]);
});

test("a replaced sender (old id gone, new id appears) marks the window as reset", () => {
  const before = [{ id: "old", bytes: 5000 }];
  const after = [{ id: "new", bytes: 900 }];
  const result = counterDeltas(before, after, ["bytes"]);
  assert.equal(result.reset, true);
  assert.deepEqual(result.reasons, ["old gone"]);
  assert.equal(result.deltas[0].isNew, true);
});

test("growing counters and a silent stream disappearing are a clean window", () => {
  const before = [
    { id: "a", bytes: 100 },
    { id: "idle", bytes: 0 },
  ];
  const after = [{ id: "a", bytes: 350 }];
  const result = counterDeltas(before, after, ["bytes"]);
  assert.equal(result.reset, false);
  assert.equal(result.deltas[0].delta.bytes, 250);
});

function manualClock() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn) => {
      timers.set(next, fn);
      return next++;
    },
    clearTimer: (id) => timers.delete(id),
    fire() {
      const [id, fn] = timers.entries().next().value;
      timers.delete(id);
      fn();
    },
    pending: () => timers.size,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the sampler keeps at most maxSamples and counts what it dropped", async () => {
  const clock = manualClock();
  let n = 0;
  const sampler = createSampler({ read: async () => n++, maxSamples: 3, ...clock });
  sampler.start();
  for (let i = 0; i < 5; i++) {
    await flush();
    clock.fire();
  }
  await flush();
  await sampler.stop();
  assert.deepEqual(sampler.samples(), [3, 4, 5]);
  assert.equal(sampler.stats().dropped, 3);
});

test("the sampler caps its ring by size as well", async () => {
  const clock = manualClock();
  const sampler = createSampler({ read: async () => "x".repeat(40), maxBytes: 100, ...clock });
  sampler.start();
  for (let i = 0; i < 4; i++) {
    await flush();
    clock.fire();
  }
  await flush();
  await sampler.stop();
  assert.equal(sampler.samples().length, 2);
  assert.ok(sampler.stats().bytes <= 100);
});

test("stop does not wait forever for a read in flight, and drops its late result", async () => {
  const clock = manualClock();
  let finish;
  const sampler = createSampler({
    read: () => new Promise((resolve) => (finish = resolve)),
    ...clock,
  });
  sampler.start();
  await flush();
  const stopped = sampler.stop();
  await flush();
  // Only the settle timer is left; firing it ends stop() with the read still open.
  assert.equal(clock.pending(), 1);
  clock.fire();
  await stopped;
  finish("late");
  await flush();
  assert.deepEqual(sampler.samples(), []);
  assert.equal(clock.pending(), 0);
});

test("a failed read is counted and sampling goes on", async () => {
  const clock = manualClock();
  let calls = 0;
  const sampler = createSampler({
    read: async () => {
      if (calls++ === 0) throw new Error("page closed");
      return calls;
    },
    ...clock,
  });
  sampler.start();
  await flush();
  clock.fire();
  await flush();
  await sampler.stop();
  assert.deepEqual(sampler.samples(), [2]);
  assert.equal(sampler.stats().failures, 1);
});
