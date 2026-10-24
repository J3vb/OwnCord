#!/usr/bin/env node
// Git merge driver for .superpowers/findings-ledger.json.
//
//   git config merge.findings-ledger.driver "node scripts/merge-ledger.mjs %O %A %B %P"
//   node --test scripts/merge-ledger.test.mjs
//
// Every PR that fixes a hunt finding appends its entries to the end of the
// findings array and bumps nextId, so two lanes conflict on every dev merge
// even when they touch different findings. This merges by finding id instead:
// entries one side added are kept, an entry one side changed takes that side's
// text, and nextId is recomputed. Two sides that added the same new id (both
// took nextId) keep the entry already on origin/dev and renumber the other,
// printing the rename so the branch can fix its commit message and CHANGELOG.
// Both sides changing the same existing entry differently is a real conflict:
// the file gets ordinary conflict markers and git reports it.
//
// Entries are carried as their exact source text, so a merge never re-escapes
// a string or reformats an entry nobody changed.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Split a ledger file into nextId and the raw text of each findings entry.
 * @param {string} text
 * @returns {{ nextId: number, entries: { id: string, text: string }[] }}
 */
export function parseLedger(text) {
  const parsed = JSON.parse(text);
  const start = text.indexOf("[", text.indexOf('"findings"'));
  const entries = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let from = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) from = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const raw = text.slice(from, i + 1);
        entries.push({ id: JSON.parse(raw).id, text: raw });
      }
    } else if (c === "]" && depth === 0) break;
  }
  if (entries.length !== parsed.findings.length) {
    throw new Error("findings entries could not be split from the source text");
  }
  return { nextId: parsed.nextId, entries };
}

/** @param {{ nextId: number, entries: { text: string }[] }} ledger */
export function formatLedger(ledger) {
  const body = ledger.entries.map((e) => e.text).join(",\n    ");
  return `{\n  "nextId": ${ledger.nextId},\n  "findings": [\n    ${body}\n  ]\n}\n`;
}

const idNumber = (id) => Number(/^OC-(\d+)$/.exec(id)?.[1] ?? NaN);
const idString = (n) => `OC-${String(n).padStart(4, "0")}`;

/**
 * Three-way merge by finding id.
 * @param {string} baseText
 * @param {string} oursText
 * @param {string} theirsText
 * @param {Set<string> | null} upstreamTexts entry texts already on origin/dev,
 *   which keep their id on a collision; null when origin/dev is unreadable
 * @returns {{ text: string, renames: [string, string][] } | { conflict: string }}
 */
export function mergeLedgers(baseText, oursText, theirsText, upstreamTexts) {
  const base = new Map(parseLedger(baseText).entries.map((e) => [e.id, e.text]));
  const oursLedger = parseLedger(oursText);
  const theirsLedger = parseLedger(theirsText);
  const ours = new Map(oursLedger.entries.map((e) => [e.id, e.text]));
  const theirs = new Map(theirsLedger.entries.map((e) => [e.id, e.text]));

  const merged = [];
  const moved = [];
  for (const [id, t] of theirs) {
    const o = ours.get(id);
    const b = base.get(id);
    if (o === undefined) {
      if (b === undefined) merged.push({ id, text: t });
      else if (t !== b) {
        return { conflict: `${id} was changed on one side and removed on the other` };
      }
      continue;
    }
    if (o === t) merged.push({ id, text: t });
    else if (b !== undefined) {
      if (o === b) merged.push({ id, text: t });
      else if (t === b) merged.push({ id, text: o });
      else return { conflict: `${id} was changed differently on both sides` };
    } else if (upstreamTexts?.has(o) && !upstreamTexts.has(t)) {
      merged.push({ id, text: o });
      moved.push(t);
    } else {
      merged.push({ id, text: t });
      moved.push(o);
    }
  }
  for (const [id, o] of ours) {
    if (theirs.has(id)) continue;
    const b = base.get(id);
    if (b === undefined) merged.push({ id, text: o });
    else if (o !== b) return { conflict: `${id} was changed on one side and removed on the other` };
  }

  let next = Math.max(
    oursLedger.nextId,
    theirsLedger.nextId,
    ...merged.map((e) => idNumber(e.id) + 1),
  );
  const renames = [];
  for (const text of moved) {
    const from = JSON.parse(text).id;
    const to = idString(next++);
    renames.push([from, to]);
    merged.push({ id: to, text: text.replace(`"id": "${from}"`, `"id": "${to}"`) });
  }
  return { text: formatLedger({ nextId: next, entries: merged }), renames };
}

function upstreamEntryTexts(path) {
  try {
    const text = execFileSync("git", ["show", `origin/dev:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(parseLedger(text).entries.map((e) => e.text));
  } catch {
    return null;
  }
}

function main() {
  const [basePath, oursPath, theirsPath, path = ".superpowers/findings-ledger.json"] =
    process.argv.slice(2);
  let result;
  try {
    result = mergeLedgers(
      readFileSync(basePath, "utf8"),
      readFileSync(oursPath, "utf8"),
      readFileSync(theirsPath, "utf8"),
      upstreamEntryTexts(path),
    );
  } catch (err) {
    result = { conflict: err instanceof Error ? err.message : String(err) };
  }
  if ("conflict" in result) {
    process.stderr.write(`merge-ledger: ${result.conflict}; leaving conflict markers\n`);
    try {
      execFileSync("git", [
        "merge-file",
        "-L",
        "ours",
        "-L",
        "base",
        "-L",
        "theirs",
        oursPath,
        basePath,
        theirsPath,
      ]);
    } catch {
      // merge-file exits non-zero when it wrote conflict markers
    }
    process.exit(1);
  }
  writeFileSync(oursPath, result.text);
  for (const [from, to] of result.renames) {
    process.stderr.write(
      `merge-ledger: ${from} was taken on both sides; this branch's entry is now ${to}. Update its references (commit message, CHANGELOG, PR body).\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
