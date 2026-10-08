#!/usr/bin/env node
// Sums the nightly mutation shards into the one full-surface score the B7-8
// baseline records (docs/plans/b7-8-mutation-baseline-2026-09-20.md). Averaging
// shard percentages would be wrong: shards differ in size and errored mutants
// leave the denominator.
//
//   node scripts/aggregate-mutation-shards.mjs              # reads reports/mutation/<shard>/mutation.json
//   node scripts/aggregate-mutation-shards.mjs <artifacts>  # reads <artifacts>/mutation-report-<shard>/mutation.json
//                                                           # (the layout download-artifact gives per-name artifacts)
//   node --test scripts/aggregate-mutation-shards.test.mjs
//
// Exits 1 when any shard's report is missing: a partial score is not the
// full-surface score.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCORED = ["Killed", "Timeout", "Survived", "NoCoverage"];
const DETECTED = ["Killed", "Timeout"];

/** Pools parsed Stryker reports; throws if a file appears in more than one. */
export function aggregate(reports) {
  if (reports.length === 0) throw new Error("no reports to aggregate");
  const totals = {};
  const seen = new Set();
  for (const { files } of reports) {
    for (const [path, { mutants }] of Object.entries(files)) {
      if (seen.has(path)) throw new Error(`${path} appears in more than one shard`);
      seen.add(path);
      for (const { status } of mutants) totals[status] = (totals[status] ?? 0) + 1;
    }
  }
  const sum = (statuses) => statuses.reduce((n, s) => n + (totals[s] ?? 0), 0);
  const scored = sum(SCORED);
  return { totals, files: seen.size, scored, score: scored ? sum(DETECTED) / scored : 0 };
}

function main() {
  const clientDir = fileURLToPath(new URL("..", import.meta.url));
  const reportsDir = join(clientDir, "reports/mutation");
  return import(join(clientDir, "stryker.shard.config.mjs")).then(({ shards }) => {
    const names = Object.keys(shards);
    const artifacts = process.argv[2];
    const paths = names.map((n) =>
      artifacts
        ? join(artifacts, `mutation-report-${n}`, "mutation.json")
        : join(reportsDir, n, "mutation.json"),
    );
    const missing = names.filter((_, i) => !existsSync(paths[i]));
    if (missing.length) {
      console.error(`missing mutation.json for shard(s): ${missing.join(", ")}`);
      process.exit(1);
    }
    const result = aggregate(paths.map((p) => JSON.parse(readFileSync(p, "utf8"))));
    const summary = { shards: names, ...result };
    writeFileSync(join(reportsDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    const pct = (result.score * 100).toFixed(2);
    const lines = [
      `Full-surface mutation score: ${pct} % over ${result.files} files (${result.scored} scored mutants)`,
      ...Object.entries(result.totals).map(([s, n]) => `  ${s}: ${n}`),
    ];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = Object.entries(result.totals).map(([s, n]) => `| ${s} | ${n} |`);
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Full-surface mutation score: ${pct} %\n\n${result.files} files across ${names.length} shards, ${result.scored} scored mutants.\n\n| Status | Mutants |\n| --- | --- |\n${rows.join("\n")}\n`,
      );
    }
  });
}

// The shard config throws without STRYKER_SHARD; any valid name satisfies it.
process.env.STRYKER_SHARD ||= "livekit";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
