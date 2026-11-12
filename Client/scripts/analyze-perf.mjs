#!/usr/bin/env node
// Summarizes the JSON lines the opt-in performance measurements write
// (`npm run test:e2e:stream-perf`, `npm run test:e2e:chat-perf`; files under
// test-results/perf/). Each trial counts once; intervals resample whole runs.
// A scenario with a failed or unverified trial is reported as not eligible to
// back a decision: a skipped supported case never counts as a pass.
//
//   node scripts/analyze-perf.mjs <file.jsonl>... [--compare base,candidate] [--json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { quantile, seededRandom, summarize } from "./perf-stats.mjs";

/** Parses JSON lines into run headers and trial rows; bad lines are reported, not fatal. */
export function parseLines(text) {
  const runs = new Map();
  const trials = [];
  const errors = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      errors.push(`line ${index + 1}: not JSON`);
      return;
    }
    if (row.kind === "run") runs.set(row.run, row);
    else if (row.kind === "trial") trials.push(row);
    else errors.push(`line ${index + 1}: unknown kind ${JSON.stringify(row.kind)}`);
  });
  return { runs, trials, errors };
}

const keyOf = (t) => `${t.suite} / ${t.scenario}`;

/** Groups trials by scenario, then metric, then arm, then run. */
export function group(trials) {
  const scenarios = new Map();
  for (const t of trials) {
    const key = keyOf(t);
    let s = scenarios.get(key);
    if (!s) {
      s = { statuses: {}, reasons: new Set(), metrics: new Map() };
      scenarios.set(key, s);
    }
    s.statuses[t.status] = (s.statuses[t.status] ?? 0) + 1;
    if (t.status !== "ok") {
      if (t.reason) s.reasons.add(t.reason);
      continue;
    }
    for (const [name, value] of Object.entries(t.metrics ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const arms = s.metrics.get(name) ?? new Map();
      s.metrics.set(name, arms);
      const runs = arms.get(t.arm) ?? new Map();
      arms.set(t.arm, runs);
      const values = runs.get(t.run) ?? [];
      runs.set(t.run, values);
      values.push(value);
    }
  }
  return scenarios;
}

/** A scenario backs a decision only when nothing in it failed or went unverified. */
export const eligible = (statuses) => !statuses.failed && !statuses.unverified;

/**
 * Candidate median minus base median, with a 95% interval from resampling
 * each arm's runs independently.
 */
export function compareArms(baseRuns, candRuns, { iterations = 2000, seed = 1 } = {}) {
  const asc = (a, b) => a - b;
  const med = (runs) => quantile(runs.flat().sort(asc), 0.5);
  const base = med(baseRuns);
  const cand = med(candRuns);
  const random = seededRandom(seed);
  const pick = (runs) => {
    const pooled = [];
    for (let i = 0; i < runs.length; i++) pooled.push(...runs[Math.floor(random() * runs.length)]);
    return quantile(pooled.sort(asc), 0.5);
  };
  const diffs = [];
  for (let i = 0; i < iterations; i++) diffs.push(pick(candRuns) - pick(baseRuns));
  diffs.sort(asc);
  return {
    base,
    candidate: cand,
    diff: cand - base,
    pct: base === 0 ? Number.NaN : ((cand - base) / Math.abs(base)) * 100,
    ci95: [quantile(diffs, 0.025), quantile(diffs, 0.975)],
  };
}

const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)) : "-");

export function report(scenarios, compare) {
  const out = [];
  const json = [];
  for (const [key, s] of [...scenarios].sort(([a], [b]) => a.localeCompare(b))) {
    const ok = eligible(s.statuses);
    const counts = Object.entries(s.statuses)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    json.push({ scenario: key, statuses: s.statuses, eligible: ok, reasons: [...s.reasons] });
    out.push(`## ${key}`, "", `Trials: ${counts}. Eligible: ${ok ? "yes" : "no"}.`);
    if (s.reasons.size) out.push(`Not ok because: ${[...s.reasons].join("; ")}.`);
    if (s.metrics.size)
      out.push(
        "",
        "| metric | arm | n | runs | p50 | p95 | p50 95% CI |",
        "|---|---|---|---|---|---|---|",
      );
    for (const [metric, arms] of [...s.metrics].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [arm, runs] of arms) {
        const sum = summarize([...runs.values()]);
        json.push({ scenario: key, metric, arm, eligible: ok, ...sum });
        out.push(
          `| ${metric} | ${arm} | ${sum.n} | ${sum.runs} | ${fmt(sum.p50)} | ${fmt(sum.p95)} | ${fmt(sum.ci95[0])} to ${fmt(sum.ci95[1])} |`,
        );
      }
    }
    if (compare) {
      const [baseArm, candArm] = compare;
      const rows = [];
      for (const [metric, arms] of s.metrics) {
        const base = arms.get(baseArm);
        const cand = arms.get(candArm);
        if (!base || !cand) continue;
        const c = compareArms([...base.values()], [...cand.values()]);
        json.push({ scenario: key, metric, compare: { base: baseArm, candidate: candArm }, ...c });
        rows.push(
          `| ${metric} | ${fmt(c.base)} | ${fmt(c.candidate)} | ${fmt(c.diff)} (${fmt(c.pct)}%) | ${fmt(c.ci95[0])} to ${fmt(c.ci95[1])} |`,
        );
      }
      if (rows.length) {
        out.push(
          "",
          `${candArm} vs ${baseArm} (median difference; an interval crossing 0 shows no change):`,
          "",
          "| metric | base p50 | candidate p50 | difference | 95% CI |",
          "|---|---|---|---|---|",
          ...rows,
        );
      }
    }
    out.push("");
  }
  return { text: out.join("\n"), json };
}

function main(argv) {
  const files = [];
  let compare;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--compare") compare = argv[++i]?.split(",");
    else if (argv[i] === "--json") asJson = true;
    else files.push(argv[i]);
  }
  if (files.length === 0 || (compare && compare.length !== 2)) {
    console.error("usage: analyze-perf.mjs <file.jsonl>... [--compare base,candidate] [--json]");
    return 2;
  }
  const trials = [];
  const runs = new Map();
  for (const file of files) {
    const parsed = parseLines(readFileSync(file, "utf8"));
    parsed.errors.forEach((e) => console.error(`${file}: ${e}`));
    parsed.runs.forEach((v, k) => runs.set(k, v));
    trials.push(...parsed.trials);
  }
  const orphans = trials.filter((t) => !runs.has(t.run)).length;
  if (orphans) console.error(`${orphans} trial rows have no run header`);
  const { text, json } = report(group(trials), compare);
  if (asJson) console.log(JSON.stringify({ runs: [...runs.values()], results: json }, null, 2));
  else {
    const headers = [...runs.values()];
    const shas = [...new Set(headers.map((r) => r.sha))].join(", ");
    console.log(`# Performance summary\n\n${headers.length} runs, commits ${shas || "-"}.\n`);
    console.log(text);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
