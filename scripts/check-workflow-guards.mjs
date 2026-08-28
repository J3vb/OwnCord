#!/usr/bin/env node
// Fail when a workflow that consumes a metered credential loses one of its
// guards (L-16).
//
//   node scripts/check-workflow-guards.mjs
//   node scripts/check-workflow-guards.mjs --selftest
//
// Why this exists rather than trusting review: the guards below are three lines
// in a YAML file that nothing else verifies. actionlint checks expression
// syntax and action inputs — it has no concept of authorization or of cost, and
// `if: contains(...)` is valid input to it whatever the expression says. A
// dependency the guards rely on can also be updated by a routine bump, so the
// repository asserts its own invariants here instead of inheriting them.
//
// Deliberately text-level, not YAML-parsed: there is no YAML parser among the
// root devDependencies, and adding one to assert "this file contains a
// timeout-minutes key" would be a dependency bought for a substring search. The
// cost is that these checks are about presence and shape, not semantics — which
// is the honest limit of what a regression test can claim here.
//
// Scope: workflows that reference a metered secret. Add one to METERED below
// when a new workflow starts spending.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Workflows whose runs consume a metered credential, and therefore must carry
// every guard in CHECKS. An unlisted workflow is not checked.
const METERED = [".github/workflows/claude.yml"];

// Each check is (name, test, why). `why` is the failure message: it states the
// invariant a contributor has to restore, not the history behind it.
export const CHECKS = [
  {
    name: "timeout-minutes",
    test: (src) => /^\s*timeout-minutes:\s*\d+\s*$/m.test(src),
    why: "a workflow consuming a metered credential must declare timeout-minutes; without one it inherits GitHub's 360-minute default",
  },
  {
    name: "concurrency group",
    test: (src) => /^concurrency:\s*$/m.test(src) && /^\s*group:\s*\S/m.test(src),
    why: "a workflow consuming a metered credential must declare a concurrency group so repeated triggers collapse instead of running in parallel",
  },
  {
    name: "cancel-in-progress",
    test: (src) => /^\s*cancel-in-progress:\s*true\s*$/m.test(src),
    why: "the concurrency group must set cancel-in-progress: true, or superseded runs keep spending",
  },
  {
    name: "actor allowlist",
    // The job condition must test who triggered the run, not only what the
    // trigger text says. A content-only condition is satisfied by anyone.
    test: (src) => /github\.actor/.test(src) && /\bif:/.test(src),
    why: "the job condition must constrain github.actor, not only the trigger text — a content-only condition places no limit on who can start a run",
  },
];

export function auditWorkflow(src) {
  return CHECKS.filter((c) => !c.test(src)).map((c) => ({ name: c.name, why: c.why }));
}

function main() {
  const failures = [];

  for (const rel of METERED) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) {
      failures.push(
        `${rel}: listed in METERED but does not exist — fix the list in ${"scripts/check-workflow-guards.mjs"}`,
      );
      continue;
    }
    const src = readFileSync(p, "utf8");
    for (const { name, why } of auditWorkflow(src)) {
      failures.push(`${rel}: missing ${name} — ${why}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} workflow guard(s) missing:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("\nThese guards bound who can start a metered run and how long it may last.");
    process.exit(1);
  }
  console.log(
    `${CHECKS.length} guard(s) present in ${METERED.length} metered workflow(s): ${METERED.join(", ")}`,
  );
}

function selftest() {
  let failed = 0;
  const assert = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
    if (!cond) failed++;
  };

  const good = [
    "name: X",
    "concurrency:",
    "  group: x-${{ github.event.issue.number }}",
    "  cancel-in-progress: true",
    "jobs:",
    "  j:",
    "    if: |",
    "      contains(fromJSON('[\"someone\"]'), github.actor) && true",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
  ].join("\n");

  assert(auditWorkflow(good).length === 0, "a fully guarded workflow reports nothing");

  const missing = (src) => auditWorkflow(src).map((f) => f.name);

  assert(
    missing(good.replace("    timeout-minutes: 30", "")).includes("timeout-minutes"),
    "a missing timeout-minutes is caught",
  );
  assert(
    missing(good.replace("concurrency:", "# concurrency:")).includes("concurrency group"),
    "a missing concurrency group is caught",
  );
  assert(
    missing(good.replace("  cancel-in-progress: true", "  cancel-in-progress: false")).includes(
      "cancel-in-progress",
    ),
    "cancel-in-progress: false is caught",
  );
  assert(
    missing(good.replace("contains(fromJSON('[\"someone\"]'), github.actor) && ", "")).includes(
      "actor allowlist",
    ),
    "a condition with no actor term is caught",
  );

  // The shapes that must NOT trip it.
  assert(
    auditWorkflow(good.replace("timeout-minutes: 30", "timeout-minutes: 5")).length === 0,
    "any positive timeout satisfies the check, not one specific value",
  );
  assert(
    auditWorkflow(good.replace("github.event.issue.number", "github.ref")).length === 0,
    "the concurrency key is not prescribed, only its presence",
  );

  // A commented-out guard is not a guard.
  assert(
    missing(good.replace("    timeout-minutes: 30", "    # timeout-minutes: 30")).includes(
      "timeout-minutes",
    ),
    "a commented-out timeout does not count",
  );

  console.log(
    failed ? `\nselftest: ${failed} assertion(s) failed` : "\nselftest: all assertions pass",
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();
else main();
