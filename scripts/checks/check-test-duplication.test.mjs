import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compare, measure, nextBaseline } from "./check-test-duplication.mjs";

const report = (percentage) => ({
  statistics: { total: { percentage, duplicatedLines: 100, clones: 5 } },
});

test("measure reads the share and counts from a jscpd report", () => {
  assert.deepEqual(measure(report(9.28)), { percentage: 9.28, duplicatedLines: 100, clones: 5 });
});

test("measure rejects a report without totals", () => {
  assert.throws(() => measure({}), /statistics\.total\.percentage/);
});

test("compare tells a rise, a fall and no change apart", () => {
  const baseline = { percentage: 9.28 };
  assert.equal(compare({ percentage: 9.29 }, baseline), "higher");
  assert.equal(compare({ percentage: 9.0 }, baseline), "lower");
  assert.equal(compare({ percentage: 9.28 }, baseline), "ok");
});

test("nextBaseline lowers the baseline and refuses to raise it", () => {
  const baseline = { percentage: 9.28, duplicatedLines: 100, clones: 5 };
  assert.equal(nextBaseline(measure(report(8.5)), baseline).percentage, 8.5);
  assert.throws(() => nextBaseline(measure(report(9.5)), baseline), /refusing to raise/);
  assert.equal(nextBaseline(measure(report(9.5)), null).percentage, 9.5);
});
