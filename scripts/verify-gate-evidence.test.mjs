import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { requiredContexts, strictUpToDate, evaluate } from "./verify-gate-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTECTION_SCRIPT = "docs/plans/b0-dev-branch-protection.sh";

// Parsing the real protection script, not a fixture: if its shape changes,
// this gate must find out on a pull request rather than at tag time.
const real = requiredContexts(readFileSync(join(ROOT, PROTECTION_SCRIPT), "utf8"));

test(`reads the required set from ${PROTECTION_SCRIPT}`, () => {
  assert.ok(real.length >= 10);
});

test("an ampersand name survives parsing", () => {
  assert.ok(real.includes("Server Build & Test (ubuntu-latest)"));
});

test("strict: true is pinned — identical-tree integration evidence relies on it", () => {
  assert.ok(strictUpToDate(readFileSync(join(ROOT, PROTECTION_SCRIPT), "utf8")));
});

test("strict true parses", () => {
  assert.ok(strictUpToDate('"required_status_checks": { "strict": true, "contexts": ["A"] }'));
});

test("strict false is detected, not glossed as true", () => {
  assert.ok(!strictUpToDate('"required_status_checks": { "strict": false, "contexts": ["A"] }'));
});

const req = ["A", "B"];
const ok = (name, extra = {}) => ({
  name,
  status: "completed",
  conclusion: "success",
  ...extra,
});
const why = (runs) => evaluate(req, runs).join(" | ");

test("all required green → releasable", () => {
  assert.equal(evaluate(req, [ok("A"), ok("B")]).length, 0);
});

test("an unrequired extra check does not block", () => {
  assert.equal(evaluate(req, [ok("A"), ok("B"), ok("Extra")]).length, 0);
});

test("a missing required check is caught", () => {
  assert.ok(why([ok("A")]).includes("B: never reported"));
});

test("a failed required check is caught", () => {
  assert.ok(
    why([ok("A"), { name: "B", status: "completed", conclusion: "failure" }]).includes(
      "B: failure",
    ),
  );
});

test("a still-running required check is caught, not treated as absent", () => {
  assert.ok(
    why([ok("A"), { name: "B", status: "in_progress", conclusion: null }]).includes("still"),
  );
});

test("skipped is not success — a skipped required check proves nothing", () => {
  assert.ok(
    why([ok("A"), { name: "B", status: "completed", conclusion: "skipped" }]).includes(
      "B: skipped",
    ),
  );
});

test("neutral is not success", () => {
  assert.ok(
    why([ok("A"), { name: "B", status: "completed", conclusion: "neutral" }]).includes(
      "B: neutral",
    ),
  );
});

// Re-runs: the latest attempt decides, in both directions.
test("a green re-run supersedes an earlier failure", () => {
  assert.equal(
    evaluate(req, [
      ok("A"),
      { name: "B", status: "completed", conclusion: "failure", started_at: "2020-01-01T00:00:00Z" },
      ok("B", { started_at: "2020-01-02T00:00:00Z" }),
    ]).length,
    0,
  );
});

test("a failed re-run supersedes an earlier success", () => {
  assert.ok(
    why([
      ok("A"),
      ok("B", { started_at: "2020-01-01T00:00:00Z" }),
      { name: "B", status: "completed", conclusion: "failure", started_at: "2020-01-02T00:00:00Z" },
    ]).includes("B: failure"),
  );
});

test("a commit with no checks at all is not releasable", () => {
  assert.equal(evaluate(req, []).length, 2);
});
