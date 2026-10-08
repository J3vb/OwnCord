import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  requiredContexts,
  strictUpToDate,
  evaluate,
  classifyRuns,
} from "./verify-gate-evidence.mjs";

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

// Evidence must come from the push-to-main CI run, not a dev-PR run of the same SHA.
test("a newer green run from an excluded (pull request) suite does not mask a failure", () => {
  const runs = [
    ok("A"),
    {
      name: "B",
      status: "completed",
      conclusion: "failure",
      started_at: "2020-01-01T00:00:00Z",
      check_suite: { id: 1 },
    },
    ok("B", { started_at: "2020-01-02T00:00:00Z", check_suite: { id: 2 } }),
  ];
  const problems = evaluate(req, runs, { excludedSuites: new Set([2]) }).join(" | ");
  assert.ok(problems.includes("B: failure"));
});

test("a run that only exists in an excluded suite counts as never reported", () => {
  const runs = [ok("A"), ok("B", { check_suite: { id: 2 } })];
  assert.ok(
    evaluate(req, runs, { excludedSuites: new Set([2]) })
      .join(" | ")
      .includes("B: never reported"),
  );
});

test("no push-to-main CI run for the commit is not releasable", () => {
  assert.ok(
    evaluate(req, [ok("A"), ok("B")], { mainRunFound: false })
      .join(" | ")
      .includes("no push-to-main CI run for this commit"),
  );
});

const wr = (id, event, head_branch, path = ".github/workflows/ci.yml") => ({
  check_suite_id: id,
  event,
  head_branch,
  path,
});

test("a workflow_dispatch ci.yml suite is distrusted, the push-to-main one is not", () => {
  const { excludedSuites, mainRunFound } = classifyRuns([
    wr(1, "push", "main"),
    wr(2, "workflow_dispatch", "main"),
    wr(3, "schedule", "main"),
    wr(4, "pull_request", "feature"),
    wr(5, "dynamic", "main", "dynamic/github-code-scanning/codeql"),
  ]);
  assert.deepEqual([...excludedSuites].sort(), [2, 3, 4]);
  assert.equal(mainRunFound, true);
});

test("no push-to-main ci.yml run among the workflow runs is reported", () => {
  assert.equal(classifyRuns([wr(2, "workflow_dispatch", "main")]).mainRunFound, false);
});

test("a ref-suffixed workflow path still identifies ci.yml", () => {
  const { excludedSuites, mainRunFound } = classifyRuns([
    wr(1, "push", "main", ".github/workflows/ci.yml@refs/heads/main"),
    wr(2, "workflow_dispatch", "main", ".github/workflows/ci.yml@refs/heads/main"),
  ]);
  assert.equal(mainRunFound, true);
  assert.deepEqual([...excludedSuites], [2]);
});
