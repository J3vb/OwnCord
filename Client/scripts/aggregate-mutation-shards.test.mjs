import { strict as assert } from "node:assert";
import { test } from "node:test";
import { aggregate } from "./aggregate-mutation-shards.mjs";

/** A parsed Stryker report: `{ "src/a.ts": ["Killed", "Survived"] }`. */
const report = (files) => ({
  files: Object.fromEntries(
    Object.entries(files).map(([path, statuses]) => [
      path,
      { mutants: statuses.map((status) => ({ status })) },
    ]),
  ),
});

test("score is pooled over all shards, not the mean of shard scores", () => {
  // shard 1: 1/1 = 100 %; shard 2: 1/9 = 11 %. Mean = 55.6 %, pooled = 2/10.
  const small = report({ "src/a.ts": ["Killed"] });
  const big = report({ "src/b.ts": ["Killed", ...Array(8).fill("Survived")] });
  const { score, totals } = aggregate([small, big]);
  assert.equal(score, 0.2);
  assert.equal(totals.Killed, 2);
  assert.equal(totals.Survived, 8);
});

test("timeouts count as kills; no-coverage counts against the score", () => {
  const { score } = aggregate([
    report({ "src/a.ts": ["Killed", "Timeout", "Survived", "NoCoverage"] }),
  ]);
  assert.equal(score, 0.5);
});

test("compile and runtime errors are reported but excluded from the denominator", () => {
  const { score, totals } = aggregate([
    report({ "src/a.ts": ["Killed", "Survived", "CompileError", "CompileError", "RuntimeError"] }),
  ]);
  assert.equal(score, 0.5);
  assert.equal(totals.CompileError, 2);
  assert.equal(totals.RuntimeError, 1);
});

test("the same file in two shards fails loudly", () => {
  const a = report({ "src/a.ts": ["Killed"] });
  assert.throws(() => aggregate([a, a]), /src\/a\.ts/);
});

test("no reports is an error, not a score of zero", () => {
  assert.throws(() => aggregate([]), /no reports/i);
});
