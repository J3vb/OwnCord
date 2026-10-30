#!/usr/bin/env node
// Sums the nightly mutation shards into the one full-surface score the B7-8
// baseline records (docs/archive/plans/b7-8-mutation-baseline-2026-09-20.md). Averaging
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCORED = ["Killed", "Timeout", "Survived", "NoCoverage"];
const DETECTED = ["Killed", "Timeout"];

const sumOf = (totals, statuses) => statuses.reduce((n, s) => n + (totals[s] ?? 0), 0);

/** Totals, scored count and score for a set of `{ mutants }` file entries. */
function tally(entries) {
  const totals = {};
  for (const { mutants } of entries)
    for (const { status } of mutants) totals[status] = (totals[status] ?? 0) + 1;
  const scored = sumOf(totals, SCORED);
  return {
    totals,
    files: entries.length,
    scored,
    score: scored ? sumOf(totals, DETECTED) / scored : 0,
  };
}

/**
 * Pools parsed Stryker reports; throws if a file appears in more than one.
 * `names` (parallel to `reports`) adds perShard/perFile; a shard with no name is its index.
 */
export function aggregate(reports, names = []) {
  if (reports.length === 0) throw new Error("no reports to aggregate");
  const seen = new Set();
  const perShard = {};
  const perFile = {};
  const all = [];
  reports.forEach(({ files }, i) => {
    const shard = names[i] ?? String(i);
    for (const path of Object.keys(files)) {
      if (seen.has(path)) throw new Error(`${path} appears in more than one shard`);
      seen.add(path);
    }
    const entries = Object.entries(files);
    perShard[shard] = tally(entries.map(([, f]) => f));
    for (const [path, f] of entries) {
      const { totals, scored, score } = tally([f]);
      perFile[path] = {
        shard,
        score,
        scored,
        killed: totals.Killed ?? 0,
        timeout: totals.Timeout ?? 0,
        survived: totals.Survived ?? 0,
        noCoverage: totals.NoCoverage ?? 0,
      };
      all.push(f);
    }
  });
  // Pooled over every mutant, never the mean of shard scores.
  return { ...tally(all), perShard, perFile };
}

/** Writes the summary JSON, creating the parent directory (a fresh CI checkout has none). */
export function writeSummary(path, summary) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
}

/** The job-summary markdown. `revision` is the pinned dev SHA the shards ran on (the workflow run's own SHA is main's). */
export function jobSummary({
  pct,
  configured,
  files,
  shards,
  scored,
  totals,
  revision,
  perShard = {},
}) {
  const rows = Object.entries(totals).map(([s, n]) => `| ${s} | ${n} |`);
  const shardRows = Object.keys(perShard)
    .sort()
    .map((n) => {
      const { score, totals } = perShard[n];
      return `| ${n} | ${(score * 100).toFixed(2)} % | ${totals.Survived ?? 0} | ${totals.NoCoverage ?? 0} |`;
    });
  return `## Full-surface mutation score: ${pct} %\n\nRevision: ${revision}\n\n${configured} configured files (${files} with mutants) across ${shards} shards, ${scored} scored mutants.\n\n| Status | Mutants |\n| --- | --- |\n${rows.join("\n")}\n\n| Shard | Score | Survived | NoCoverage |\n| --- | --- | --- | --- |\n${shardRows.join("\n")}\n`;
}

function main() {
  const clientDir = fileURLToPath(new URL("..", import.meta.url));
  const reportsDir = join(clientDir, "reports/mutation");
  return import(join(clientDir, "tests/mutation/stryker.shard.config.mjs")).then((config) => {
    const artifacts = process.argv[2];
    const reportPath = (n) =>
      artifacts
        ? join(artifacts, `mutation-report-${n}`, "mutation.json")
        : join(reportsDir, n, "mutation.json");
    // main's scheduled workflow still runs the six pre-split shards until a
    // release carries the new matrix there; score whichever layout reported.
    const legacyRan =
      Object.keys(config.legacy).some((n) => existsSync(reportPath(n))) &&
      !Object.keys(config.shards).some((n) => existsSync(reportPath(n)));
    const shards = legacyRan ? config.legacy : config.shards;
    const names = Object.keys(shards);
    const paths = names.map(reportPath);
    const missing = names.filter((_, i) => !existsSync(paths[i]));
    if (missing.length) {
      console.error(`missing mutation.json for shard(s): ${missing.join(", ")}`);
      process.exit(1);
    }
    // The pinned dev SHA (needs.pin.outputs.sha); empty when run by hand.
    const revision = process.env.PIN_SHA ?? "";
    const result = aggregate(
      paths.map((p) => JSON.parse(readFileSync(p, "utf8"))),
      names,
    );
    // Configured files that emit no mutants (constants.ts, protocolTypes.ts) appear in no report.
    const configured = Object.values(shards).flat().length;
    writeSummary(join(reportsDir, "summary.json"), {
      shards: names,
      configuredFiles: configured,
      revision,
      ...result,
    });
    const pct = (result.score * 100).toFixed(2);
    const lines = [
      `Full-surface mutation score: ${pct} % over ${configured} configured files (${result.files} with mutants, ${result.scored} scored mutants)`,
      ...Object.entries(result.totals).map(([s, n]) => `  ${s}: ${n}`),
    ];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        jobSummary({
          pct,
          configured,
          files: result.files,
          shards: names.length,
          scored: result.scored,
          totals: result.totals,
          revision,
          perShard: result.perShard,
        }),
      );
    }
  });
}

// The shard config throws without STRYKER_SHARD; any valid name satisfies it.
process.env.STRYKER_SHARD ||= "livekit-1";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
