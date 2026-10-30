#!/usr/bin/env node
// Fail the release when the version being tagged has no row in docs/STATUS.md.
//
//   node scripts/release/verify-release-status.mjs v2.2.0-beta.4
//   node --test scripts/release/verify-release-status.test.mjs
//
// Five betas shipped while docs/plans/README.md still said the beta launch was
// next, because nothing tied a tag to a status record. STATUS.md is that record
// and this is the tie: its Releases table must carry the version before
// release.yml builds anything. A mention elsewhere in the file (a "next release"
// line, say) does not count, only a table row whose first cell is the version.
//
// A script rather than a `run:` block for the reason verify-gate-evidence.mjs
// gives: a step that exists only in release.yml first executes at tag time.
// ci.yml runs the test file on every pull request.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STATUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "STATUS.md",
);

// releaseRows returns the first cell of every row in the "## Releases" table,
// without a leading `v` or backticks.
export function releaseRows(markdown) {
  const rows = [];
  let inSection = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s+Releases\s*$/.test(line);
      continue;
    }
    if (!inSection || !line.startsWith("|")) continue;
    const first = line.split("|")[1]?.trim().replace(/^`|`$/g, "") ?? "";
    if (/^v?\d+\.\d+\.\d+/.test(first)) rows.push(first.replace(/^v/, ""));
  }
  return rows;
}

// evaluate decides on STATUS.md's text and the version being tagged (with or
// without its `v`). It returns the lines to print and whether the release may
// go ahead.
export function evaluate(markdown, version) {
  const wanted = String(version ?? "")
    .trim()
    .replace(/^v/, "");
  if (!wanted) {
    return { ok: false, lines: ["::error::no release version given"] };
  }
  const rows = releaseRows(markdown);
  if (rows.length === 0) {
    return {
      ok: false,
      lines: ["::error::docs/STATUS.md has no Releases table rows; the gate cannot read it"],
    };
  }
  if (rows.includes(wanted)) {
    return { ok: true, lines: [`v${wanted} is recorded in docs/STATUS.md`] };
  }
  return {
    ok: false,
    lines: [
      `::error::v${wanted} has no row in the Releases table of docs/STATUS.md`,
      "Add the release to docs/STATUS.md (Current release and a Releases row) in the release PR, then tag again.",
    ],
  };
}

function main() {
  const version = process.argv[2] ?? process.env.RELEASE_TAG;
  const { ok, lines } = evaluate(readFileSync(STATUS_PATH, "utf8"), version);
  for (const line of lines) console.log(line);
  if (!ok) process.exit(1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
