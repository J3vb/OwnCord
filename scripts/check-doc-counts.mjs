#!/usr/bin/env node
// Fail when an explicitly current summary states a count the ledger contradicts
// (the automated half of G-04).
//
//   node scripts/check-doc-counts.mjs
//   node --test scripts/check-doc-counts.test.mjs
//
// Scope, deliberately small: this counts ledger statuses and compares them to
// the numbers current summaries assert. It is not a document-status framework,
// and it does not check that FINDINGS.md is in sync with the ledger — that was
// RL-07, and B1-6 answered it by not tracking FINDINGS.md at all, so there is
// no committed rendering left to drift. `npm run check:docs` runs this script
// and then regenerates the rendering, which is where a generation failure
// surfaces.
//
// It reads findings-ledger.json directly and does NOT import render-ledger.mjs.
// That module has no `import.meta.main` guard, so importing it to reuse
// `validate`/`render` runs `main()` and rewrites FINDINGS.md as a side effect.
//
// ── Why the patterns are narrow ──────────────────────────────────────────────
// "open" is overloaded in this repository. The issue register has 45 open P1
// *rows*; a security scan closed 8 *findings* F1–F8; `G-05 **refuted**` puts a
// digit next to a status word. None of those are ledger counts, and a loose
// pattern flags all of them — a check that cries wolf gets ignored, which is
// the failure mode G-04 already describes.
//
// So a number is only read as a ledger claim in three unambiguous shapes:
//
//   1. An enumeration — two or more "<n> <status>" pairs on one line, e.g.
//      "306 fixed / 38 open / 3 declined / 1 duplicate = 348". A lone
//      "45 open" is never enough.
//   2. A status table row "| open | **38** |", but only in a table that also
//      carries a "| Total | 348 |" row nearby.
//   3. "<n> records" / "<n> findings", but only where the ledger is named
//      within the preceding few lines.
//
// Dated baselines, plans, scorecards and docs/audit-*.md are not checked against
// today's ledger. Their measurements belong to the cited source revisions.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Explicit allow-list of current guidance and summaries whose counts track
// the LIVE ledger. Adding a current summary means opting its document in here;
// an unlisted document is not checked. Being an active plan is not enough.
//
// Deliberately excluded: B0/B1, HP-0/HP-1 and all other dated plan/scorecard
// evidence. Do not add them to make a new measurement agree with today's
// ledger. Keep live totals in the summaries below, and preserve as-measured
// observations independently (B10 qualification item 1 / B1/G-04).
// The issue register has a dated filename but an explicitly current summary;
// document intent, not a filename-date heuristic, determines this list.
const WATCHED = [
  "docs/README.md",
  "docs/plans/README.md",
  "docs/plans/repo-health-issue-register-2026-08-23.md",
  "CLAUDE.md",
  "README.md",
];

const STATUSES = ["open", "fixed", "declined", "duplicate", "refuted", "blocked"];
const S = STATUSES.join("|");

// Never let a digit that belongs to an identifier or comparison start a claim:
// G-05, >=20, CGO_ENABLED=0, version=1.2.0-alpha.3.
const LEAD = "(?<![\\w.\\-=<>/])";
const PAIR = new RegExp(`${LEAD}(\\d+)\\*{0,2}\\s+\\*{0,2}(${S})\\b`, "gi");
const LEDGER_CONTEXT = /ledger|OC-\d|findings-ledger|FINDINGS\.md/i;

export function tally(ledger) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const f of ledger.findings) if (f.status in counts) counts[f.status]++;
  counts.total = ledger.findings.length;
  return counts;
}

export function claimsIn(text) {
  const out = [];
  const lines = text.split("\n");

  // Which lines sit in a status table that has a Total row within 10 lines?
  const totalRowAt = new Set();
  lines.forEach((l, i) => {
    if (/^\|\s*\*{0,2}total\*{0,2}\s*\|\s*\*{0,2}\d+\*{0,2}\s*\|/i.test(l)) totalRowAt.add(i);
  });
  const nearTotalRow = (i) => [...totalRowAt].some((t) => Math.abs(t - i) <= 10);

  lines.forEach((line, i) => {
    const at = i + 1;

    // 1. Enumeration: two or more "<n> <status>" pairs on one line.
    const pairs = [...line.matchAll(PAIR)];
    if (pairs.length >= 2) {
      for (const m of pairs) {
        out.push({ line: at, kind: m[2].toLowerCase(), value: Number(m[1]), text: m[0].trim() });
      }
      // "... = 348" closing an enumeration is the total.
      const eq = line.match(/=\s*\*{0,2}(\d+)\*{0,2}/);
      if (eq) out.push({ line: at, kind: "total", value: Number(eq[1]), text: eq[0].trim() });
    }

    // 2. Status table row, only inside a table that totals itself.
    const row = line.match(
      new RegExp(`^\\|\\s*\\*{0,2}(${S})\\*{0,2}\\s*\\|\\s*\\*{0,2}(\\d+)\\*{0,2}\\s*\\|`, "i"),
    );
    if (row && nearTotalRow(i)) {
      out.push({
        line: at,
        kind: row[1].toLowerCase(),
        value: Number(row[2]),
        text: row[0].trim(),
      });
    }
    const totalRow = line.match(/^\|\s*\*{0,2}total\*{0,2}\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/i);
    if (totalRow)
      out.push({ line: at, kind: "total", value: Number(totalRow[1]), text: totalRow[0].trim() });

    // 3. "<n> records"/"<n> findings", only near an explicit mention of the ledger.
    const ctx = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (LEDGER_CONTEXT.test(ctx)) {
      for (const m of line.matchAll(
        new RegExp(`${LEAD}(\\d+)\\*{0,2}\\s+(?:records?|findings?)\\b`, "gi"),
      )) {
        out.push({ line: at, kind: "total", value: Number(m[1]), text: m[0].trim() });
      }
    }
  });
  return out;
}

function main() {
  const ledgerPath = join(ROOT, ".superpowers/findings-ledger.json");
  if (!existsSync(ledgerPath)) {
    console.error(`missing ${ledgerPath}`);
    process.exit(1);
  }
  const counts = tally(JSON.parse(readFileSync(ledgerPath, "utf8")));
  console.log(`ledger: ${STATUSES.map((s) => `${counts[s]} ${s}`).join(" / ")} = ${counts.total}`);

  const failures = [];
  let claimCount = 0;

  for (const rel of WATCHED) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) {
      failures.push(
        `${rel}: watched file does not exist — fix the list in scripts/check-doc-counts.mjs`,
      );
      continue;
    }
    for (const c of claimsIn(readFileSync(p, "utf8"))) {
      const actual = counts[c.kind];
      if (actual === undefined) continue;
      claimCount++;
      if (c.value === actual) continue;
      const entry = `${rel}:${c.line}  claims "${c.text}"  — ledger says ${c.kind} = ${actual}`;
      failures.push(entry);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} document claim(s) contradict the ledger:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nThe ledger is the source of truth for current summaries. Update the current\n" +
        "summary, or correct the ledger if it is wrong. Do not rewrite dated evidence.",
    );
    process.exit(1);
  }
  console.log(
    `\n${claimCount} claim(s) across ${WATCHED.length} watched document(s) agree with the ledger.`,
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
