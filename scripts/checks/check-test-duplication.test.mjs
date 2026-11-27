import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  TARGETS,
  compare,
  measure,
  nextBaseline,
  runJscpd,
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
  assert.deepEqual(TARGETS.server.extraArgs, [
    "--pattern",
    "**/*_test.go",
    "--ignore-pattern",
    "t\\.Parallel\\(\\)",
  ]);
  assert.notEqual(TARGETS.server.baselinePath, TARGETS.client.baselinePath);
});

test("the server target ignores only the t.Parallel() marker line", () => {
  const pattern = new RegExp(TARGETS.server.extraArgs.at(-1));
  assert.ok(pattern.test("\tt.Parallel()"));
  assert.ok(!pattern.test("\tdatabase := newTestDB(t)"));
  assert.ok(!pattern.test("\ttParallel()"));
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

const LINES = 30;
const body = {
  ts: (i) => `  total = total + ${i} * (input - ${i + 1});`,
  go: (i) => `\ttotal = total + ${i}*(input-${i + 1})`,
  rs: (i) => `    total = total + ${i} * (input - ${i + 1});`,
};
const wrap = {
  ts: (name, lines) =>
    `export function ${name}(input: number): number {\n  let total = input;\n${lines}\n  return total;\n}\n`,
  go: (name, lines) =>
    `package planted\n\nfunc ${name}(input int) int {\n\ttotal := input\n${lines}\n\treturn total\n}\n`,
  rs: (name, lines) =>
    `pub fn ${name}(input: i64) -> i64 {\n    let mut total = input;\n${lines}\n    total\n}\n`,
};
/** A function with a 30-line body; the same seed gives the same body. */
const source = (lang, name, seed) =>
  wrap[lang](name, Array.from({ length: LINES }, (_, i) => body[lang](i + seed)).join("\n"));

// Per target: where a planted clone pair is counted, and the files the target
// leaves out (generated code, or the other kind of file). Each left-out file
// copies one counted file, so a broken exclusion shows up as a clone.
const FIXTURES = {
  client: {
    lang: "ts",
    counted: ["helpers/a.ts", "unit/b.ts"],
    excluded: null,
  },
  server: {
    lang: "go",
    counted: ["api/a_test.go", "ws/b_test.go"],
    excluded: ["api/a.go", "ws/b.go"],
    alone: "db/c_test.go",
  },
  "client-colocated": {
    lang: "ts",
    counted: ["lib/a.test.ts", "features/b.test.ts"],
    excluded: ["lib/a.ts", "features/b.ts"],
    alone: "lib/c.test.ts",
  },
  "client-src": {
    lang: "ts",
    counted: ["lib/a.ts", "features/b.ts"],
    excluded: [
      "lib/protocolTypes.ts",
      "lib/net/wireShapes.ts",
      "lib/net/restShapes.ts",
      "lib/a.test.ts",
    ],
    alone: "features/c.ts",
  },
  "server-src": {
    lang: "go",
    counted: ["api/a.go", "ws/b.go"],
    excluded: ["db/dbgen/a.go", "ws/message_types.go", "httperr/codes.go", "api/a_test.go"],
    alone: "auth/c.go",
  },
  rust: {
    lang: "rs",
    counted: ["a.rs", "voice/b.rs"],
    excluded: ["tests.rs", "tests/a.rs", "voice/b_tests.rs"],
    alone: "c.rs",
  },
};

function plant(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "jscpd-plant-"));
  for (const [rel, text] of files) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function percentageOn(name, files) {
  const dir = plant(files);
  try {
    return measure(runJscpd(TARGETS[name], dir)).percentage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every target has a planted-clone fixture", () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), Object.keys(TARGETS).sort());
});

for (const [name, fx] of Object.entries(FIXTURES)) {
  test(`the ${name} target sees a clone planted in its own files`, () => {
    const files = fx.counted.map((rel, i) => [rel, source(fx.lang, `planted${i}`, 1)]);
    assert.ok(percentageOn(name, files) > 0, `${name} reported no duplication`);
  });

  if (fx.excluded) {
    test(`the ${name} target leaves its excluded files out`, () => {
      const files = fx.excluded.map((rel, i) => [rel, source(fx.lang, `planted${i}`, 1)]);
      files.push([fx.alone, source(fx.lang, "kept", 1)]);
      assert.equal(percentageOn(name, files), 0);
    });
  }
}
