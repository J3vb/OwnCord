import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evaluate, median, parseBench } from "./bench-gate.mjs";

const BASELINE = {
  ref: "517eaef5",
  benchmarks: {
    BenchmarkHistoryPage: { allocsPerOp: 1370, goalNsPerOp: 400000 },
    BenchmarkUnreadCounts: { allocsPerOp: 227, goalNsPerOp: 1000000 },
  },
};

function run(history, unread) {
  return [
    "goos: linux",
    "pkg: github.com/J3vb/OwnCord/Server/db",
    ...history.map(
      ([ns, allocs]) =>
        `BenchmarkHistoryPage-4   \t 1200\t ${ns} ns/op\t 123886 B/op\t ${allocs} allocs/op`,
    ),
    ...unread.map(
      ([ns, allocs]) =>
        `BenchmarkUnreadCounts-4   \t 300\t ${ns} ns/op\t 8704 B/op\t ${allocs} allocs/op`,
    ),
    "PASS",
  ].join("\n");
}

test("parses go bench output and strips the GOMAXPROCS suffix", () => {
  const parsed = parseBench(
    run(
      [
        [1000000, 1370],
        [1100000, 1370],
      ],
      [[3000000, 227]],
    ),
  );
  assert.deepEqual(parsed.get("BenchmarkHistoryPage"), {
    ns: [1000000, 1100000],
    allocs: [1370, 1370],
  });
  assert.deepEqual(parsed.get("BenchmarkUnreadCounts"), { ns: [3000000], allocs: [227] });
});

test("median of odd and even counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("passes when allocs match and time is within slack of the ref", () => {
  const current = parseBench(
    run(
      [
        [1100000, 1370],
        [1150000, 1370],
        [1050000, 1370],
      ],
      [[3100000, 227]],
    ),
  );
  const ref = parseBench(
    run(
      [
        [1000000, 1370],
        [1000000, 1370],
        [1000000, 1370],
      ],
      [[3000000, 227]],
    ),
  );
  const { failures } = evaluate(BASELINE, current, ref);
  assert.deepEqual(failures, []);
});

test("fails on an allocation increase even without a ref", () => {
  const current = parseBench(run([[1000000, 1500]], [[3000000, 227]]));
  const { failures } = evaluate(BASELINE, current, undefined);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /BenchmarkHistoryPage: 1500 allocs\/op, baseline 1370/);
});

test("fails when the median time is more than 20 % above the ref", () => {
  const current = parseBench(
    run(
      [
        [1300000, 1370],
        [1250000, 1370],
        [900000, 1370],
      ],
      [[3000000, 227]],
    ),
  );
  const ref = parseBench(
    run(
      [
        [1000000, 1370],
        [1000000, 1370],
        [1000000, 1370],
      ],
      [[3000000, 227]],
    ),
  );
  const { failures } = evaluate(BASELINE, current, ref);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /BenchmarkHistoryPage: .* is \+25\.0 %/);
});

test("one slow sample does not move the median past the slack", () => {
  const current = parseBench(
    run(
      [
        [1000000, 1370],
        [5000000, 1370],
        [1000000, 1370],
      ],
      [[3000000, 227]],
    ),
  );
  const ref = parseBench(run([[1000000, 1370]], [[3000000, 227]]));
  assert.deepEqual(evaluate(BASELINE, current, ref).failures, []);
});

test("fails when a baseline benchmark is missing", () => {
  const current = parseBench(run([[1000000, 1370]], []));
  const { failures } = evaluate(BASELINE, current, undefined);
  assert.deepEqual(failures, ["BenchmarkUnreadCounts: no result in the current run"]);
});

test("an allocation drop is a note to lower the baseline, not a failure", () => {
  const current = parseBench(run([[400000, 400]], [[3000000, 227]]));
  const { failures, notes } = evaluate(BASELINE, current, undefined);
  assert.deepEqual(failures, []);
  assert.match(notes[0], /BenchmarkHistoryPage: 400 allocs\/op is below the baseline 1370/);
});
