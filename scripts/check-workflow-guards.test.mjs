import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditWorkflow } from "./check-workflow-guards.mjs";

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

const missing = (src) => auditWorkflow(src).map((f) => f.name);

test("a fully guarded workflow reports nothing", () => {
  assert.equal(auditWorkflow(good).length, 0);
});

test("a missing timeout-minutes is caught", () => {
  assert.ok(missing(good.replace("    timeout-minutes: 30", "")).includes("timeout-minutes"));
});

test("a missing concurrency group is caught", () => {
  assert.ok(missing(good.replace("concurrency:", "# concurrency:")).includes("concurrency group"));
});

test("cancel-in-progress: false is caught", () => {
  assert.ok(
    missing(good.replace("  cancel-in-progress: true", "  cancel-in-progress: false")).includes(
      "cancel-in-progress",
    ),
  );
});

test("a condition with no actor term is caught", () => {
  assert.ok(
    missing(good.replace("contains(fromJSON('[\"someone\"]'), github.actor) && ", "")).includes(
      "actor allowlist",
    ),
  );
});

// The shapes that must NOT trip it.
test("any positive timeout satisfies the check, not one specific value", () => {
  assert.equal(auditWorkflow(good.replace("timeout-minutes: 30", "timeout-minutes: 5")).length, 0);
});

test("the concurrency key is not prescribed, only its presence", () => {
  assert.equal(auditWorkflow(good.replace("github.event.issue.number", "github.ref")).length, 0);
});

// A commented-out guard is not a guard.
test("a commented-out timeout does not count", () => {
  assert.ok(
    missing(good.replace("    timeout-minutes: 30", "    # timeout-minutes: 30")).includes(
      "timeout-minutes",
    ),
  );
});
