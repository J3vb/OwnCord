#!/usr/bin/env node
// Copy-pasted code is held as a shrink-only share of duplicated lines per
// target: Client/tests, the Go test files under Server/, the colocated
// Client/src tests, and the production code of the client, the server and the
// Tauri Rust shell (generated files left out). The percentage jscpd reports for a target
// may not rise above the one stored in its baseline file. A change that
// removes duplication lowers the stored number with --update, which refuses
// to raise it. --target <name> limits a run to one target.
//
// jscpd is a pinned root devDependency, so `npm ci` at the repository root
// is all the script needs (the Repository Hygiene job runs it there). It can
// also read a report that is already on disk with
// --target <name> --report <jscpd-report.json>.
//
// The settings below are the ones both baselines were measured with: a
// 50-token minimum, and a line and size limit high enough that no file is
// skipped (jscpd skips files over 1,000 lines by default, which hides the
// biggest tests from the count).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TARGETS = {
  client: {
    label: "Client/tests",
    scan: "Client/tests",
    extraArgs: [],
    baselinePath: path.join(ROOT, "scripts/checks/test-duplication-baseline.json"),
    hint: "Share the repeated setup in Client/tests/helpers instead of copying it.",
  },
  server: {
    label: "Server Go tests",
    scan: "Server",
    extraArgs: ["--pattern", "**/*_test.go"],
    baselinePath: path.join(ROOT, "scripts/checks/server-test-duplication-baseline.json"),
    hint: "Share the repeated setup in a helper in the package's _test.go files instead of copying it.",
  },
  "client-colocated": {
    label: "Client/src colocated tests",
    scan: "Client/src",
    extraArgs: ["--pattern", "**/*.test.ts"],
    baselinePath: path.join(ROOT, "scripts/checks/client-colocated-test-duplication-baseline.json"),
    hint: "Share the repeated setup in a module-scope helper or Client/tests/helpers instead of copying it.",
  },
  "client-src": {
    label: "Client/src production code",
    scan: "Client/src",
    extraArgs: [
      "--pattern",
      "**/*.ts",
      "--ignore",
      "**/*.test.ts,**/lib/protocolTypes.ts,**/lib/net/wireShapes.ts,**/lib/net/restShapes.ts",
    ],
    baselinePath: path.join(ROOT, "scripts/checks/client-src-duplication-baseline.json"),
    hint: "Call the existing helper, or move the shared part into lib/ (lib/ui for UI) or the owning feature.",
  },
  "server-src": {
    label: "Server production Go",
    scan: "Server",
    extraArgs: [
      "--pattern",
      "**/*.go",
      "--ignore",
      "**/*_test.go,**/db/dbgen/**,**/ws/message_types.go,**/httperr/codes.go",
    ],
    baselinePath: path.join(ROOT, "scripts/checks/server-src-duplication-baseline.json"),
    hint: "Call the existing helper, or move the shared part into one function the callers share.",
  },
  rust: {
    label: "Client/src-tauri Rust",
    scan: "Client/src-tauri/src",
    extraArgs: ["--pattern", "**/*.rs", "--ignore", "**/tests.rs,**/tests/**,**/*_tests.rs"],
    baselinePath: path.join(ROOT, "scripts/checks/rust-duplication-baseline.json"),
    hint: "Move the shared part into one function or module the callers share.",
  },
};
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
export const updateCommand = (name) =>
  `node scripts/checks/check-test-duplication.mjs --target ${name} --update`;

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

function runJscpd(target) {
  const out = mkdtempSync(path.join(tmpdir(), "jscpd-tests-"));
  try {
    execFileSync(
      process.execPath,
      [JSCPD_BIN, ...JSCPD_ARGS, ...target.extraArgs, "--output", out, target.scan],
      { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
    );
    return JSON.parse(readFileSync(path.join(out, "jscpd-report.json"), "utf8"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function readBaseline(target) {
  try {
    return JSON.parse(readFileSync(target.baselinePath, "utf8"));
  } catch {
    return null;
  }
}

/** Checks or updates one target; returns the exit code for it. */
function runTarget(name, target, { update, reportAt }) {
  const report = reportAt ? JSON.parse(readFileSync(reportAt, "utf8")) : runJscpd(target);
  const current = measure(report);
  const baseline = readBaseline(target);
  const fix = updateCommand(name);

  if (update) {
    const next = nextBaseline(current, baseline);
    writeFileSync(target.baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `${target.label}: baseline set to ${next.percentage}% (${next.duplicatedLines} duplicated lines)`,
    );
    return 0;
  }
  if (!baseline) {
    console.error(`${target.label}: no baseline yet; measured ${current.percentage}%. Run: ${fix}`);
    return 1;
  }
  const verdict = compare(current, baseline);
  if (verdict === "higher") {
    console.error(
      `${target.label} duplication rose to ${current.percentage}% (baseline ${baseline.percentage}%). ` +
        target.hint,
    );
    return 1;
  }
  if (verdict === "lower") {
    console.log(
      `${target.label} duplication is ${current.percentage}%, below the baseline ${baseline.percentage}%. ` +
        `Lower the baseline in this PR: ${fix}`,
    );
    return 0;
  }
  console.log(
    `${target.label} duplication is ${current.percentage}% (baseline ${baseline.percentage}%).`,
  );
  return 0;
}

/** The target names a run covers: one with --target, else all of them. */
export function selectTargets(argv) {
  if (!argv.includes("--target")) return Object.keys(TARGETS);
  const name = argv[argv.indexOf("--target") + 1];
  if (!Object.hasOwn(TARGETS, name)) {
    throw new Error(`unknown --target ${name}; use ${Object.keys(TARGETS).join(" or ")}`);
  }
  return [name];
}

function main(argv) {
  const update = argv.includes("--update");
  const reportAt = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : null;
  const names = selectTargets(argv);
  if (reportAt && names.length !== 1) {
    console.error("--report reads one target's report; add --target <name>");
    return 2;
  }
  let code = 0;
  for (const name of names) {
    code = Math.max(code, runTarget(name, TARGETS[name], { update, reportAt }));
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
