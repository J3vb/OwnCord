// Regression gate for the nightly query benchmarks (Server/db/query_perf_bench_test.go).
//
//   node Server/scripts/bench/bench-gate.mjs --baseline <json> --current <txt> [--ref <txt>] [--summary <md>]
//
// --current and --ref are raw `go test -bench` output, several runs each. The
// gate takes the median per benchmark and fails when:
//   - a benchmark in the baseline is missing from --current;
//   - allocs/op is above the baseline (allocation counts are deterministic,
//     so the slack only absorbs runtime bookkeeping);
//   - ns/op is more than TIME_SLACK above the same benchmark at the baseline's
//     ref commit, measured interleaved on the same runner. Absolute times are
//     never compared with a number stored in the repo: CI runners differ by
//     more than the regression this guards against.
import { readFileSync, appendFileSync } from "node:fs";

export const ALLOC_SLACK = 0.02;
export const TIME_SLACK = 0.2;

const LINE = /^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+([\d.]+) ns\/op(?:.*?\s([\d.]+) allocs\/op)?/;

/** Parses `go test -bench` output into name -> { ns: number[], allocs: number[] }. */
export function parseBench(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const entry = out.get(m[1]) ?? { ns: [], allocs: [] };
    entry.ns.push(Number(m[2]));
    if (m[3] !== undefined) entry.allocs.push(Number(m[3]));
    out.set(m[1], entry);
  }
  return out;
}

export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtNs(ns) {
  if (!Number.isFinite(ns)) return "n/a";
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(0)} µs`;
  return `${ns.toFixed(0)} ns`;
}

/**
 * Compares parsed runs with the baseline file. Returns the failures, the
 * notes (an allocation drop the baseline should be lowered to) and a markdown
 * table of every benchmark.
 */
export function evaluate(baseline, current, ref) {
  const failures = [];
  const notes = [];
  const rows = [
    "| Benchmark | ns/op | at ref | change | allocs/op | baseline allocs | goal |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [name, spec] of Object.entries(baseline.benchmarks)) {
    const cur = current.get(name);
    if (!cur || cur.ns.length === 0) {
      failures.push(`${name}: no result in the current run`);
      rows.push(`| ${name} | missing | | | | ${spec.allocsPerOp} | ${fmtNs(spec.goalNsPerOp)} |`);
      continue;
    }
    const ns = median(cur.ns);
    const allocs = median(cur.allocs);
    if (Number.isFinite(allocs) && allocs > spec.allocsPerOp * (1 + ALLOC_SLACK)) {
      failures.push(`${name}: ${allocs} allocs/op, baseline ${spec.allocsPerOp}`);
    } else if (Number.isFinite(allocs) && allocs < spec.allocsPerOp * (1 - ALLOC_SLACK)) {
      notes.push(
        `${name}: ${allocs} allocs/op is below the baseline ${spec.allocsPerOp}; lower the baseline`,
      );
    }
    let refNs = NaN;
    let change = "";
    const r = ref?.get(name);
    if (r && r.ns.length > 0) {
      refNs = median(r.ns);
      const delta = ns / refNs - 1;
      change = `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} %`;
      if (delta > TIME_SLACK) {
        failures.push(`${name}: ${fmtNs(ns)} is ${change} against ${fmtNs(refNs)} at the ref`);
      }
    } else if (ref) {
      notes.push(`${name}: no result at the ref, so time was not compared`);
    }
    rows.push(
      `| ${name} | ${fmtNs(ns)} | ${fmtNs(refNs)} | ${change} | ${allocs} | ${spec.allocsPerOp} | ${fmtNs(spec.goalNsPerOp)} |`,
    );
  }
  return { failures, notes, table: rows.join("\n") };
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const baselinePath = arg(argv, "--baseline");
  const currentPath = arg(argv, "--current");
  if (!baselinePath || !currentPath) {
    console.error(
      "usage: bench-gate.mjs --baseline <json> --current <txt> [--ref <txt>] [--summary <md>]",
    );
    return 2;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const current = parseBench(readFileSync(currentPath, "utf8"));
  const refPath = arg(argv, "--ref");
  const ref = refPath ? parseBench(readFileSync(refPath, "utf8")) : undefined;
  const { failures, notes, table } = evaluate(baseline, current, ref);

  const report = [
    `### Query benchmarks against ref ${String(baseline.ref).slice(0, 10)}`,
    "",
    table,
    "",
    ...notes.map((n) => `- note: ${n}`),
    ...failures.map((f) => `- **regression:** ${f}`),
    failures.length === 0 ? "No regression." : "",
  ].join("\n");
  console.log(report);
  const summary = arg(argv, "--summary");
  if (summary) appendFileSync(summary, `${report}\n`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) process.exitCode = main(process.argv.slice(2));
