import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TARGETS,
  compare,
  measure,
  nextBaseline,
  selectTargets,
} from "./check-test-duplication.mjs";

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

test("selectTargets runs every target unless one is named", () => {
  assert.deepEqual(selectTargets([]), [
    "client",
    "server",
    "client-colocated",
    "client-src",
    "server-src",
    "rust",
  ]);
  assert.deepEqual(selectTargets(["--target", "server"]), ["server"]);
  assert.throws(() => selectTargets(["--target", "python"]), /unknown --target python/);
});

test("the server target scans only Go test files", () => {
  assert.equal(TARGETS.server.scan, "Server");
  assert.deepEqual(TARGETS.server.extraArgs, ["--pattern", "**/*_test.go"]);
  assert.notEqual(TARGETS.server.baselinePath, TARGETS.client.baselinePath);
});

test("every target keeps its own baseline file", () => {
  const paths = Object.values(TARGETS).map((t) => t.baselinePath);
  assert.equal(new Set(paths).size, paths.length);
});

test("production targets leave out tests and generated files", () => {
  const ignored = (name) =>
    TARGETS[name].extraArgs[TARGETS[name].extraArgs.indexOf("--ignore") + 1];
  assert.match(ignored("client-src"), /\*\*\/\*\.test\.ts/);
  assert.match(ignored("client-src"), /protocolTypes\.ts/);
  assert.match(ignored("client-src"), /wireShapes\.ts/);
  assert.match(ignored("client-src"), /restShapes\.ts/);
  assert.match(ignored("server-src"), /_test\.go/);
  assert.match(ignored("server-src"), /dbgen/);
  assert.match(ignored("server-src"), /message_types\.go/);
  assert.match(ignored("server-src"), /codes\.go/);
});
