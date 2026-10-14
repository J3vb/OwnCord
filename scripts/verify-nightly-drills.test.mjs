import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, MAX_AGE_HOURS } from "./verify-nightly-drills.mjs";

// Recorded from the workflow runs API (upgrade-rehearsal.yml, branch=main,
// event=schedule): three red nights, newest first, the shape the gate reads.
const recorded = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nightly-rehearsal-runs.json"),
    "utf8",
  ),
).workflow_runs;

const newest = recorded[0];
const now = new Date(Date.parse(newest.created_at) + 6 * 3_600_000);
const green = { ...newest, conclusion: "success" };

test("a green nightly from last night releases", () => {
  const { ok, lines } = evaluate([green, ...recorded.slice(1)], { now });
  assert.ok(ok);
  assert.match(lines[0], /is green/);
});

test("the recorded red nightly refuses the release and links the run", () => {
  const { ok, lines } = evaluate(recorded, { now });
  assert.ok(!ok);
  assert.match(
    lines[0],
    /^::error::.*concluded failure: https:\/\/github\.com\/.*\/runs\/38132255797$/,
  );
});

test("only the newest run counts: an older green does not cover a red last night", () => {
  const { ok } = evaluate([newest, green], { now });
  assert.ok(!ok);
});

test("no runs at all refuses", () => {
  const { ok, lines } = evaluate([], { now });
  assert.ok(!ok);
  assert.match(lines[0], /no completed scheduled/);
});

test("a run still in progress is passed over for the newest completed one", () => {
  const running = { ...newest, id: 1, status: "in_progress", conclusion: null };
  assert.ok(evaluate([running, green], { now }).ok);
  assert.ok(!evaluate([running, newest], { now }).ok);
});

test("a cancelled nightly is not a green one", () => {
  assert.ok(!evaluate([{ ...newest, conclusion: "cancelled" }], { now }).ok);
});

test(`a green nightly older than ${MAX_AGE_HOURS}h refuses: the nightly stopped running`, () => {
  const stale = new Date(Date.parse(newest.created_at) + (MAX_AGE_HOURS + 1) * 3_600_000);
  const { ok, lines } = evaluate([green], { now: stale });
  assert.ok(!ok);
  assert.match(lines[0], /h old/);
});

test("ALLOW_RED_NIGHTLY releases past a red nightly with a warning, never silently", () => {
  const { ok, lines } = evaluate(recorded, { now, allowRed: true });
  assert.ok(ok);
  assert.match(lines[0], /^::warning::releasing past a red nightly/);
});
