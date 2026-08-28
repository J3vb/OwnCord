#!/usr/bin/env node
// Fail when the commit being released does not carry green evidence for every
// required check (R-09 / RL-16).
//
//   node scripts/verify-gate-evidence.mjs <sha>   # assert, using $GITHUB_TOKEN
//   node scripts/verify-gate-evidence.mjs --selftest
//
// A tag push starts release.yml and nothing else. ci.yml has no `tags:` trigger,
// so the tagged commit is only ever covered by the CI that ran when that same
// commit sat on a branch — and until this script existed, nothing checked that
// it had. release.yml re-runs none of the required contexts: it builds, smokes
// and signs, which is a different question from "did the gate pass".
//
// This is deliberately a script and not a `run:` block. .claude/skills/ci-check
// states the rule: a step that exists only in release.yml first executes at tag
// time, so its own bugs surface on the release. Server/scripts/docker-smoke.sh
// is the worked example — one script, called from both workflows. Here the
// second call site is `--selftest` in ci.yml, which exercises the decision logic
// on fixtures every PR without needing a tag or a network call.
//
// The required set is read from b0-dev-branch-protection.sh rather than
// duplicated, so pinning a new check cannot leave this gate behind.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTECTION_SCRIPT = "docs/plans/b0-dev-branch-protection.sh";

// The contexts array in the protection script is the single source of truth for
// what "the gate" means. Parsed out of the heredoc rather than re-listed.
export function requiredContexts(scriptSrc) {
  const block = scriptSrc.match(/"contexts"\s*:\s*\[([^\]]*)\]/);
  if (!block) throw new Error(`no "contexts" array found in ${PROTECTION_SCRIPT}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// checkRuns is the API's check_runs array, already collected across pages.
// Returns the reasons this commit is not releasable; empty means it is.
export function evaluate(required, checkRuns) {
  const problems = [];
  const byName = new Map();
  for (const run of checkRuns) {
    // A context can report more than once (a re-run). The latest attempt wins,
    // which is what the branch-protection UI shows and what a human would read.
    const prev = byName.get(run.name);
    if (!prev || (run.started_at ?? "") >= (prev.started_at ?? "")) byName.set(run.name, run);
  }

  for (const name of required) {
    const run = byName.get(name);
    if (!run) {
      problems.push(`${name}: never reported on this commit`);
      continue;
    }
    if (run.status !== "completed") {
      problems.push(`${name}: still ${run.status} — the gate is not finished`);
      continue;
    }
    // `neutral` and `skipped` are not success. A required check that skipped on
    // the tagged commit proves nothing about it.
    if (run.conclusion !== "success") {
      problems.push(`${name}: ${run.conclusion}`);
    }
  }
  return problems;
}

async function fetchCheckRuns(repo, sha, token) {
  const runs = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    const body = await res.json();
    runs.push(...body.check_runs);
    // total_count is the count for the whole commit, not the page.
    if (runs.length >= body.total_count || body.check_runs.length === 0) break;
  }
  return runs;
}

async function main() {
  const sha = process.argv[2];
  if (!sha) {
    console.error("usage: node scripts/verify-gate-evidence.mjs <sha>");
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
    process.exit(2);
  }

  const p = join(ROOT, PROTECTION_SCRIPT);
  if (!existsSync(p)) {
    console.error(`missing ${PROTECTION_SCRIPT} — it defines the required set`);
    process.exit(2);
  }
  const required = requiredContexts(readFileSync(p, "utf8"));

  const runs = await fetchCheckRuns(repo, sha, token);
  const problems = evaluate(required, runs);

  console.log(`commit ${sha}: ${runs.length} check run(s), ${required.length} required`);
  if (problems.length) {
    console.error(`\n${problems.length} required check(s) do not evidence a green gate:\n`);
    for (const x of problems) console.error(`  ${x}`);
    console.error(
      "\nThis commit is not releasable. Publication consumes exact-SHA gate\n" +
        "evidence: the tag must point at a commit whose required checks all passed.",
    );
    process.exit(1);
  }
  console.log(`all ${required.length} required check(s) green — releasable`);
}

function selftest() {
  let failed = 0;
  const assert = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
    if (!cond) failed++;
  };

  // Parsing the real protection script, not a fixture: if its shape changes,
  // this gate must find out on a pull request rather than at tag time.
  const real = requiredContexts(readFileSync(join(ROOT, PROTECTION_SCRIPT), "utf8"));
  assert(real.length >= 10, `reads the required set from ${PROTECTION_SCRIPT} (${real.length})`);
  assert(
    real.includes("Server Build & Test (ubuntu-latest)"),
    "an ampersand name survives parsing",
  );

  const req = ["A", "B"];
  const ok = (name, extra = {}) => ({
    name,
    status: "completed",
    conclusion: "success",
    ...extra,
  });

  assert(evaluate(req, [ok("A"), ok("B")]).length === 0, "all required green → releasable");
  assert(
    evaluate(req, [ok("A"), ok("B"), ok("Extra")]).length === 0,
    "an unrequired extra check does not block",
  );

  const why = (runs) => evaluate(req, runs).join(" | ");
  assert(why([ok("A")]).includes("B: never reported"), "a missing required check is caught");
  assert(
    why([ok("A"), { name: "B", status: "completed", conclusion: "failure" }]).includes(
      "B: failure",
    ),
    "a failed required check is caught",
  );
  assert(
    why([ok("A"), { name: "B", status: "in_progress", conclusion: null }]).includes("still"),
    "a still-running required check is caught, not treated as absent",
  );
  assert(
    why([ok("A"), { name: "B", status: "completed", conclusion: "skipped" }]).includes(
      "B: skipped",
    ),
    "skipped is not success — a skipped required check proves nothing",
  );
  assert(
    why([ok("A"), { name: "B", status: "completed", conclusion: "neutral" }]).includes(
      "B: neutral",
    ),
    "neutral is not success",
  );

  // Re-runs: the latest attempt decides, in both directions.
  assert(
    evaluate(req, [
      ok("A"),
      { name: "B", status: "completed", conclusion: "failure", started_at: "2020-01-01T00:00:00Z" },
      ok("B", { started_at: "2020-01-02T00:00:00Z" }),
    ]).length === 0,
    "a green re-run supersedes an earlier failure",
  );
  assert(
    why([
      ok("A"),
      ok("B", { started_at: "2020-01-01T00:00:00Z" }),
      { name: "B", status: "completed", conclusion: "failure", started_at: "2020-01-02T00:00:00Z" },
    ]).includes("B: failure"),
    "a failed re-run supersedes an earlier success",
  );

  assert(evaluate(req, []).length === 2, "a commit with no checks at all is not releasable");

  console.log(
    failed ? `\nselftest: ${failed} assertion(s) failed` : "\nselftest: all assertions pass",
  );
  process.exit(failed ? 1 : 0);
}

// Run only when invoked directly, so `evaluate` and `requiredContexts` can be
// imported and exercised without the module trying to reach the network.
// Compared against argv[1] rather than `import.meta.main`, which needs Node
// 24.2 while package.json's engines floor is >=24 — on 24.0 it is undefined and
// the script would silently do nothing.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else await main();
}
