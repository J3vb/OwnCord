#!/usr/bin/env node
// Fail when an active document states a finding count the ledger contradicts
// (the automated half of G-04).
//
//   node scripts/check-doc-counts.mjs
//   node scripts/check-doc-counts.mjs --selftest
//
// Scope, deliberately small: this counts ledger statuses and compares them to
// the numbers active documents assert. It is not a document-status framework,
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
// Dated docs/audit-*.md are reported, never failed: they are point-in-time
// snapshots that are deliberately not maintained, and editing them is out of
// scope for the repository-layout work. audit-2026-08-19.md does claim zero
// open findings — true when written, false now, and left alone on purpose.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Active documents that assert a count. Adding a count to a document means
// adding it here — an unlisted document is not checked.
const WATCHED = [
  "docs/README.md",
  "docs/plans/README.md",
  "docs/plans/hp-0-scorecard-2026-08-25.md",
  "docs/plans/hp-1-scorecard-2026-08-27.md",
  "docs/plans/repo-health-issue-register-2026-08-23.md",
  "docs/plans/b0-baseline-2026-08-25.md",
  "docs/plans/b1-repository-foundation-2026-08-25.md",
  "CLAUDE.md",
  "README.md",
];

// Reported but never failed — dated snapshots, see the header.
const REPORT_ONLY = ["docs/audit-"];

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
  const notes = [];
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
      if (REPORT_ONLY.some((prefix) => rel.startsWith(prefix))) notes.push(entry);
      else failures.push(entry);
    }
  }

  for (const n of notes) console.log(`NOTE  ${n}`);

  if (failures.length) {
    console.error(`\n${failures.length} document claim(s) contradict the ledger:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nThe ledger is the source of truth. Update the document, or if the ledger is\n" +
        "wrong, fix .superpowers/findings-ledger.json and re-render FINDINGS.md.",
    );
    process.exit(1);
  }
  console.log(
    `\n${claimCount} claim(s) across ${WATCHED.length} watched document(s) agree with the ledger.`,
  );
}

function selftest() {
  let failed = 0;
  const assert = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
    if (!cond) failed++;
  };
  const t = tally({ findings: [{ status: "open" }, { status: "open" }, { status: "fixed" }] });
  assert(t.open === 2 && t.fixed === 1 && t.total === 3, "tally counts by status and total");
  assert(t.refuted === 0, "a declared-but-unused status counts 0, not undefined");

  const c = claimsIn;
  const has = (s, kind, value) => c(s).some((x) => x.kind === kind && x.value === value);

  assert(
    has("Ledger: **306 fixed / 38 open / 3 declined / 1 duplicate = 348**.", "open", 38),
    "enumeration: reads each pair",
  );
  assert(
    has("Ledger: **306 fixed / 38 open / 3 declined / 1 duplicate = 348**.", "total", 348),
    "enumeration: reads the = total",
  );
  assert(
    has("**38 open** · 0 blocked · 306 fixed · 3 declined", "fixed", 306),
    "enumeration: FINDINGS.md header shape",
  );
  assert(
    has("| open | **38** |\n| **Total** | **348** |", "open", 38),
    "status table with a Total row",
  );
  assert(has("the ledger holds\n348 records", "total", 348), '"N records" near a ledger mention');

  // The false positives that made a looser version unusable.
  assert(
    c("The 45 open P1 rows are tracked in the register.").length === 0,
    'a lone "45 open" is not a ledger claim',
  );
  assert(
    c("| All 8 findings F1-F8 closed |").length === 0,
    "a different register is not a ledger claim",
  );
  assert(
    c("| `golangci-lint` | claimed broken (G-05) | G-05 **refuted** |").length === 0,
    '"G-05 refuted" is an id, not a count',
  );
  assert(c('`tools/mcp-introspect/package.json` (`">=20"`)').length === 0, '">=20" is not a count');
  assert(
    c('go build -ldflags "-X main.version=1.2.0-alpha.3"').length === 0,
    "a version string is not a count",
  );
  assert(c("11 medium, 27 low").length === 0, "severities are not statuses");
  assert(c("22 sit under Client/").length === 0, "a bare number is not a claim");
  assert(
    c("348 records in some unrelated table").length === 0,
    '"N records" without ledger context is ignored',
  );

  console.log(
    failed ? `\nselftest: ${failed} assertion(s) failed` : "\nselftest: all assertions pass",
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();
else main();
