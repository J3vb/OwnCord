#!/usr/bin/env node
// Fail when a watched document cites a repository path that is not there.
//
//   node scripts/check-doc-citations.mjs
//   node --test scripts/check-doc-citations.test.mjs
//
// ── Why this is a repository check and not a Go test ─────────────────────────
// This check used to live inside TestCommunityServicesDocIsCurrent, in
// Server/migrations. That package is the right home for the parts of the gate
// that are about MIGRATIONS — the class list, the B5 range coupling, the table
// shapes. It was the wrong home for this part, because the paths a document
// cites are not server paths: docs/architecture/community-services.md names
// eleven files under Client/, two under docs/, one workflow and one script.
//
// Since `dfa5f66a` the CI workflow selects which jobs run from the diff
// (scripts/ci-select.mjs), and a change confined to Client/ or docs/ does not
// select the server job. So a pull request that renamed or deleted a CITED
// file skipped the only leg that could catch the dangling citation and merged
// green, leaving the failure for whoever next touched Server/. Reproduced both
// ways before this moved:
//
//   git mv Client/src/lib/nsfw-gate.ts …   -> server=false, gate never ran
//   git mv docs/trust-model.md …           -> every capability false, same
//
// Running here instead puts it in `Docs & Ledger Consistency`, which is
// unconditional, so the check is reached by every pull request whatever its
// diff selects. That is also why it is a repository-wide concern rather than a
// server one: it reads only Markdown and the existence of paths, and it needs
// no Go toolchain to answer.
//
// Doc rot in a reference document is invisible otherwise: a renamed test file
// leaves a citation that reads fine and proves nothing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Documents whose backticked repository paths must exist. Coverage is OPT-IN,
// the same rule as check-doc-counts.mjs's WATCHED list: a new reference
// document is unchecked until it is added here. Keep this list to documents
// that cite paths as EVIDENCE ("Tested at: `Server/api/foo_test.go`"), not to
// plans and scorecards, whose citations are dated records of where something
// lived on the day they were written.
export const WATCHED = ["docs/architecture/community-services.md"];

// repoPath matches a backticked span that claims to be a path in this
// repository. `data/` is deliberately absent: data/erasure.key and
// data/erasure/markers.sqlite are runtime state and exist on a server, not in
// a checkout.
export const repoPath =
  /^(?:Server|Client|docs|protocol|scripts|\.github|\.superpowers)\/[A-Za-z0-9_.\-/]+$/;

// backtickSpan finds every `...` span in the document.
const backtickSpan = /`([^`\n]+)`/g;

// plannedPaths are paths a watched document names that do not exist yet, each
// with the step that creates it. The check runs in BOTH directions: an
// unlisted missing path fails, and a listed path that now EXISTS fails too,
// because that means the step landed and the exemption is stale.
//
// Empty since B5-1 landed `Server/safefetch` (PR #1541): the exemption it held
// was removed by the reverse check, which is the whole point of having one.
export const PLANNED_PATHS = {
  "docs/architecture/community-services.md": {},
};

/**
 * Every distinct repository path a document cites, in first-seen order.
 *
 * Pure: takes the document text, returns path strings. A trailing slash is
 * stripped so `Client/` and `Client` are one citation — the document uses the
 * directory form in prose and `os.stat` does not care.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function citedPaths(text) {
  const seen = new Set();
  for (const m of text.matchAll(backtickSpan)) {
    const p = m[1];
    if (!repoPath.test(p) || seen.has(p)) continue;
    seen.add(p);
  }
  return [...seen];
}

/**
 * Compare a document's citations against what exists.
 *
 * Pure: `exists` is injected so the unit suite can state a tree without
 * touching the filesystem, and so this function is the thing under test rather
 * than the checkout.
 *
 * @param {string} doc document path, for the messages
 * @param {string[]} cited paths the document names
 * @param {(path: string) => boolean} exists
 * @param {Record<string, string>} planned path -> the step that creates it
 * @returns {string[]} problems; empty means the document is current
 */
export function evaluate(doc, cited, exists, planned = {}) {
  const problems = [];
  for (const p of cited) {
    const here = exists(p.replace(/\/$/, ""));
    const isPlanned = Object.hasOwn(planned, p);
    if (here && isPlanned) {
      problems.push(
        `${doc} exempts \`${p}\` as owed by ${planned[p]}, but it exists now. ` +
          `Drop the exemption from PLANNED_PATHS in scripts/check-doc-citations.mjs.`,
      );
    } else if (!here && !isPlanned) {
      problems.push(
        `${doc} cites \`${p}\`, which does not exist. Fix the citation, or add it to ` +
          `PLANNED_PATHS in scripts/check-doc-citations.mjs with the step that creates it.`,
      );
    }
  }
  for (const [p, step] of Object.entries(planned)) {
    if (!cited.includes(p)) {
      problems.push(
        `PLANNED_PATHS exempts \`${p}\` (owed by ${step}) but ${doc} does not cite it any ` +
          `more; drop the entry.`,
      );
    }
  }
  return problems;
}

function main() {
  const problems = [];
  let citations = 0;

  for (const rel of WATCHED) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) {
      problems.push(
        `${rel}: watched file does not exist — fix the list in scripts/check-doc-citations.mjs`,
      );
      continue;
    }
    const cited = citedPaths(readFileSync(p, "utf8"));
    citations += cited.length;
    problems.push(
      ...evaluate(rel, cited, (path) => existsSync(join(ROOT, path)), PLANNED_PATHS[rel] ?? {}),
    );
  }

  if (problems.length) {
    console.error(`\n${problems.length} citation problem(s):\n`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`${citations} cited path(s) across ${WATCHED.length} watched document(s) all exist.`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
