import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditLoadBaseline } from "./check-load-baseline-schedule.mjs";

const good = [
  "name: Load Baseline",
  "on:",
  "  schedule:",
  '    - cron: "0 6 * * 0"',
  "  workflow_dispatch:",
  "jobs:",
  "  baseline:",
  "    if: github.repository == 'J3vb/OwnCord'",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 45",
  "    steps:",
  "      - uses: actions/checkout@x",
  "        with:",
  "          ref: ${{ github.event_name == 'schedule' && 'dev' || '' }}",
].join("\n");

const missing = (src) => auditLoadBaseline(src).map((f) => f.name);

test("a fully guarded load-baseline workflow reports nothing", () => {
  assert.equal(auditLoadBaseline(good).length, 0);
});

test("a missing schedule is caught", () => {
  assert.ok(missing(good.replace("  schedule:\n", "# no schedule\n")).includes("weekly schedule"));
});

test("an unquoted cron is caught", () => {
  assert.ok(
    missing(good.replace('    - cron: "0 6 * * 0"', "    - cron: 0 6")).includes("weekly schedule"),
  );
});

test("a missing canonical-repository guard is caught", () => {
  assert.ok(
    missing(good.replace("    if: github.repository == 'J3vb/OwnCord'\n", "")).includes(
      "canonical-repository guard",
    ),
  );
});

test("a checkout that does not pin dev on schedule is caught", () => {
  assert.ok(
    missing(
      good.replace("          ref: ${{ github.event_name == 'schedule' && 'dev' || '' }}", ""),
    ).includes("scheduled checkout pins dev"),
  );
});

test("a checkout pinned to main on schedule is caught", () => {
  assert.ok(
    missing(
      good.replace(
        "          ref: ${{ github.event_name == 'schedule' && 'dev' || '' }}",
        "          ref: ${{ github.event_name == 'schedule' && 'main' || '' }}",
      ),
    ).includes("scheduled checkout pins dev"),
  );
});
