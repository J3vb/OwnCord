// The weekly scan (.github/workflows/weekly-supply-chain.yml) repeats the steps
// of ci.yml's supply-chain job. Bumping a pin or adding a lockfile in one and
// not the other would leave the weekly run scanning with a different tool or
// a shorter list, so this fails Repository Hygiene when they differ.
//
//   node --test scripts/checks/check-supply-chain-sync.test.mjs
//
// Text-level like check-workflow-guards.mjs: no YAML parser among the root
// devDependencies, and these are line comparisons.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// The body of one job under `jobs:`, up to the next 2-space-indented key.
function jobBlock(src, job) {
  const jobs = src.split(/^jobs:\s*$/m)[1] ?? "";
  const start = jobs.search(new RegExp(`^  ${job}:\\s*$`, "m"));
  if (start < 0) throw new Error(`job ${job} not found`);
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^ {2}[\w-]+:\s*$/m);
  return next < 0 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

// What decides the scan's verdict: tool pins, the lockfile list, the Rust
// toolchain action, and the two scanner invocations.
function scanFingerprint(block) {
  const lines = block.split("\n").map((l) => l.trim());
  return {
    pins: lines.filter((l) => /^(OSV|CARGO_DENY)_\w+:/.test(l)),
    lockfiles: lines.filter((l) => /^-L\s/.test(l)),
    toolchain: lines.filter((l) => /dtolnay\/rust-toolchain@/.test(l)),
    commands: lines.filter((l) => /^(run: )?(osv-scanner scan|cargo deny )/.test(l)),
  };
}

test("the weekly scan matches ci.yml's supply-chain job", () => {
  const ci = scanFingerprint(jobBlock(read(".github/workflows/ci.yml"), "supply-chain"));
  const weekly = scanFingerprint(
    jobBlock(read(".github/workflows/weekly-supply-chain.yml"), "weekly-supply-chain"),
  );
  assert.equal(ci.pins.length, 4, "ci.yml pins osv-scanner and cargo-deny by version and digest");
  assert.ok(ci.lockfiles.length >= 5, "ci.yml names every lockfile");
  assert.equal(ci.toolchain.length, 1);
  assert.equal(ci.commands.length, 2);
  assert.deepEqual(weekly, ci);
});

test("a drifted pin is caught", () => {
  const job = (v) => `jobs:\n  a:\n    steps:\n      - env:\n          OSV_VERSION: ${v}\n  b:\n`;
  assert.notDeepEqual(
    scanFingerprint(jobBlock(job("2.6.0"), "a")),
    scanFingerprint(jobBlock(job("2.7.0"), "a")),
  );
});

test("a job block stops at the next job", () => {
  const src = "jobs:\n  a:\n    x: 1\n  b:\n    OSV_VERSION: 9\n";
  assert.deepEqual(scanFingerprint(jobBlock(src, "a")).pins, []);
});
