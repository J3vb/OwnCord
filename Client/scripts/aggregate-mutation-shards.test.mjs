import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate, jobSummary, writeSummary } from "./aggregate-mutation-shards.mjs";

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

test("writeSummary creates a missing parent directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "agg-"));
  try {
    const path = join(dir, "reports", "mutation", "summary.json");
    writeSummary(path, { score: 0.5 });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { score: 0.5 });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the pinned dev revision is recorded in the job summary", () => {
  const md = jobSummary({
    pct: "50.00",
    configured: 3,
    files: 2,
    shards: 2,
    scored: 4,
    totals: { Killed: 2 },
    revision: "abc123",
  });
  assert.match(md, /abc123/);
});

test("perShard scores are each shard's own pooled score", () => {
  const small = report({ "src/a.ts": ["Killed"] });
  const big = report({
    "src/b.ts": ["Killed", ...Array(4).fill("Survived")],
    "src/c.ts": ["Timeout", ...Array(4).fill("Survived"), "CompileError"],
  });
  const { perShard, score } = aggregate([small, big], ["s1", "s2"]);
  assert.equal(perShard.s1.score, 1);
  assert.equal(perShard.s1.scored, 1);
  assert.equal(perShard.s1.files, 1);
  assert.equal(perShard.s2.score, 0.2);
  assert.equal(perShard.s2.scored, 10);
  assert.equal(perShard.s2.files, 2);
  assert.equal(perShard.s2.totals.CompileError, 1);
  assert.equal(score, 3 / 11);
});

test("a shard with no scored mutants has score 0", () => {
  const { perShard } = aggregate([report({ "src/a.ts": ["CompileError"] })], ["s1"]);
  assert.equal(perShard.s1.score, 0);
  assert.equal(perShard.s1.scored, 0);
});

test("perFile carries the shard name and per-status counts", () => {
  const { perFile } = aggregate(
    [
      report({ "src/a.ts": ["Killed"] }),
      report({ "src/b.ts": ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError"] }),
    ],
    ["s1", "s2"],
  );
  assert.deepEqual(perFile["src/b.ts"], {
    shard: "s2",
    score: 0.5,
    scored: 4,
    killed: 1,
    timeout: 1,
    survived: 1,
    noCoverage: 1,
  });
  assert.equal(perFile["src/a.ts"].shard, "s1");
});

test("the job summary has one row per shard, sorted, without file names", () => {
  const { perShard } = aggregate(
    [
      report({ "src/z.ts": ["Killed", "Survived"] }),
      report({ "src/a.ts": ["Killed", "NoCoverage"] }),
    ],
    ["b-shard", "a-shard"],
  );
  const md = jobSummary({
    pct: "50.00",
    configured: 2,
    files: 2,
    shards: 2,
    scored: 4,
    totals: { Killed: 2 },
    revision: "abc",
    perShard,
  });
  assert.match(md, /\| Shard \| Score \| Survived \| NoCoverage \|/);
  assert.match(md, /\| a-shard \| 50\.00 % \| 0 \| 1 \|/);
  assert.match(md, /\| b-shard \| 50\.00 % \| 1 \| 0 \|/);
  assert.ok(md.indexOf("a-shard") < md.indexOf("b-shard"));
  assert.doesNotMatch(md, /src\//);
});
