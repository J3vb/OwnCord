#!/usr/bin/env node
// Fail the release when the latest nightly upgrade rehearsal is not green.
//
//   node scripts/release/verify-nightly-drills.mjs        # assert, using $GITHUB_TOKEN
//   node --test scripts/release/verify-nightly-drills.test.mjs
//
// release.yml calls upgrade-rehearsal.yml with `release: true`, which skips the
// failure and recovery drills, so the drills only ever run on the nightly. From
// 2026-10-02 the nightly failed every night in drill phase R while two betas
// shipped, because nothing on the release path read it. This script is that
// read: the latest completed scheduled run must have concluded `success`, and
// must be recent enough to describe the code being released.
//
// A scheduled run always reports the default branch (`main`) as its branch,
// although it checks out and rehearses `dev` (upgrade-rehearsal.yml, the
// checkout step). `main` here is the filter that selects the nightly, not a
// claim about what it tested.
//
// ALLOW_RED_NIGHTLY=true releases anyway and prints a warning: the escape hatch
// for an emergency release. release.yml sets it from the dry run's
// `allow_red_nightly` input or, for a tag push (which has no inputs), from the
// `RELEASE_ALLOW_RED_NIGHTLY` repository variable.
//
// A script rather than a `run:` block for the reason verify-gate-evidence.mjs
// gives: a step that exists only in release.yml first executes at tag time.
// ci.yml runs the test file against fixtures on every pull request.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW = "upgrade-rehearsal.yml";

// Three nights: one scheduled run GitHub drops under load is not a reason to
// block a release, three in a row means the nightly is not running at all.
export const MAX_AGE_HOURS = 72;

// evaluate decides on the nightly's runs, newest first, as the workflow runs
// API returns them. It returns the lines to print and whether the release may
// go ahead.
export function evaluate(runs, { now = new Date(), allowRed = false } = {}) {
  const latest = runs.find((r) => r.status === "completed");
  let problem = null;
  if (!latest) {
    problem = `no completed scheduled ${WORKFLOW} run found on main`;
  } else {
    const ageHours = (now.getTime() - Date.parse(latest.created_at)) / 3_600_000;
    if (latest.conclusion !== "success") {
      problem = `the latest nightly ${WORKFLOW} run concluded ${latest.conclusion}: ${latest.html_url}`;
    } else if (!(ageHours <= MAX_AGE_HOURS)) {
      problem = `the latest green nightly ${WORKFLOW} run is ${Math.floor(ageHours)}h old (limit ${MAX_AGE_HOURS}h), so the nightly is not running: ${latest.html_url}`;
    }
  }
  if (!problem) {
    return {
      ok: true,
      lines: [
        `nightly ${WORKFLOW} is green (${latest.created_at}, workflow revision ${latest.head_sha}): ${latest.html_url}`,
      ],
    };
  }
  if (allowRed) {
    return {
      ok: true,
      lines: [
        `::warning::releasing past a red nightly (allow_red_nightly input or RELEASE_ALLOW_RED_NIGHTLY repository variable; remove the variable after this release): ${problem}`,
      ],
    };
  }
  return {
    ok: false,
    lines: [
      `::error::${problem}`,
      "A release needs a green nightly: its failure and recovery drills are the only run of them. " +
        "Fix the nightly, or for an emergency release set allow_red_nightly (dry run) or the " +
        "RELEASE_ALLOW_RED_NIGHTLY repository variable (tag push).",
    ],
  };
}

async function fetchNightlyRuns(repo, token) {
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs` +
    "?branch=main&event=schedule&status=completed&per_page=5";
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const body = await res.json();
  return body.workflow_runs;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
    process.exit(2);
  }
  const { ok, lines } = evaluate(await fetchNightlyRuns(repo, token), {
    allowRed: process.env.ALLOW_RED_NIGHTLY === "true",
  });
  for (const line of lines) console.log(line);
  if (!ok) process.exit(1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
