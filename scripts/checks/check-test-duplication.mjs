#!/usr/bin/env node
// Copy-pasted setup is what makes the client tests long, so the share of
// duplicated lines in Client/tests is held as a shrink-only ratchet: the
// percentage jscpd reports may not rise above the one stored in
// scripts/checks/test-duplication-baseline.json. A change that removes
// duplication lowers the stored number with --update, which refuses to raise it.
//
// jscpd is a pinned root devDependency, so `npm ci` at the repository root
// is all the script needs (the Repository Hygiene job runs it there). It can
// also read a report that is already on disk with --report <jscpd-report.json>.
//
// The settings below are the ones the baseline was measured with: a
// 50-token minimum, and a line and size limit high enough that no file is
// skipped (jscpd skips files over 1,000 lines by default, which hides the
// biggest tests from the count).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE_PATH = path.join(ROOT, "scripts/checks/test-duplication-baseline.json");
const JSCPD_BIN = path.join(ROOT, "node_modules/jscpd/bin/jscpd");
export const JSCPD_ARGS = [
  "--min-tokens",
  "50",
  "--max-lines",
  "20000",
  "--max-size",
  "5mb",
  "--reporters",
  "json",
  "--silent",
];
export const UPDATE_COMMAND = "node scripts/checks/check-test-duplication.mjs --update";

/** The duplicated-line share and counts from a jscpd JSON report. */
export function measure(report) {
  const total = report?.statistics?.total;
  if (!total || typeof total.percentage !== "number") {
    throw new Error("the jscpd report has no statistics.total.percentage");
  }
  return {
    percentage: total.percentage,
    duplicatedLines: total.duplicatedLines,
    clones: total.clones,
  };
}

/** "ok", "lower" (the baseline can drop) or "higher" (the ratchet is broken). */
export function compare(current, baseline) {
  if (current.percentage > baseline.percentage) return "higher";
  if (current.percentage < baseline.percentage) return "lower";
  return "ok";
}

/** The baseline to store after a change; it never rises. */
export function nextBaseline(current, baseline) {
  if (baseline && current.percentage > baseline.percentage) {
    throw new Error(
      `refusing to raise the baseline from ${baseline.percentage}% to ${current.percentage}%`,
    );
  }
  return current;
}

function runJscpd() {
  const out = mkdtempSync(path.join(tmpdir(), "jscpd-tests-"));
  try {
    execFileSync(process.execPath, [JSCPD_BIN, ...JSCPD_ARGS, "--output", out, "Client/tests"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return JSON.parse(readFileSync(path.join(out, "jscpd-report.json"), "utf8"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function main(argv) {
  const update = argv.includes("--update");
  const reportAt = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : null;
  const report = reportAt ? JSON.parse(readFileSync(reportAt, "utf8")) : runJscpd();
  const current = measure(report);
  const baseline = readBaseline();

  if (update) {
    const next = nextBaseline(current, baseline);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline set to ${next.percentage}% (${next.duplicatedLines} duplicated lines)`);
    return 0;
  }
  if (!baseline) {
    console.error(`no baseline yet; measured ${current.percentage}%. Run: ${UPDATE_COMMAND}`);
    return 1;
  }
  const verdict = compare(current, baseline);
  if (verdict === "higher") {
    console.error(
      `Client/tests duplication rose to ${current.percentage}% (baseline ${baseline.percentage}%). ` +
        "Share the repeated setup in Client/tests/helpers instead of copying it.",
    );
    return 1;
  }
  if (verdict === "lower") {
    console.log(
      `Client/tests duplication is ${current.percentage}%, below the baseline ${baseline.percentage}%. ` +
        `Lower the baseline in this PR: ${UPDATE_COMMAND}`,
    );
    return 0;
  }
  console.log(
    `Client/tests duplication is ${current.percentage}% (baseline ${baseline.percentage}%).`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
