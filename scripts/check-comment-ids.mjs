#!/usr/bin/env node
// Plan and ticket ids in code comments ("(WP 7.4b)", "B7-15c", "OC-0395",
// "Codex review round 2") point at documents a reader of the code does not
// have. This counts them per file in production code and holds the counts in
// scripts/comment-id-baseline.json as a shrink-only ratchet: a file may not
// gain one, a file that lost some must have its row lowered, and the total
// stays under TOTAL_CAP. Run with --update to write the lowered counts after
// rewriting comments; it refuses to raise any row.
//
// Comments are found with a small lexer per language (strings, template
// literals, regex literals, raw strings, Rust lifetimes), not with a regex
// over the whole line, so an id inside a string or a URL in code is not
// counted. Imports nothing outside node:, like the other Docs & Ledger checks.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = path.join(ROOT, "scripts/comment-id-baseline.json");

/** Ids that may remain in total. Lower it in every change that removes ids; it never rises. */
export const TOTAL_CAP = 2030;

/** Each pattern names a kind of id. All are matched inside comment text only. */
export const ID_PATTERNS = [
  ["work package", /\bWP[ -]?\d+[A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*/g],
  [
    "plan item",
    /\b(?!(?:OC|UTF|SHA|AES|HTTP|FNV|ISO|CRC|ALPN|RFC|CVE|GHSA|IEEE|ECMA|ES|P|X|A|V)-)[A-Z]{1,5}\d{0,2}-\d+[a-z]?\b/g,
  ],
  // A bare roadmap item, "(6.13c)" or "5.4d-2", without the WP prefix.
  ["roadmap item", /(?<![\w.]|WP[ -])\d{1,2}\.\d{1,2}[a-h]\d?(?:-\d+)?(?![\w.])/g],
  ["ledger id", /\bOC-\d{3,5}\b/g],
  ["pull request", /(?<![\w&/])#[1-9]\d{2,4}\b/g],
  ["review bot", /\bCodex\b/g],
  ["review round", /\b[Rr]ound \d+\b/g],
  ["numbered decision", /\b(?:[Dd]ecision|[Ff]inding|[Ii]tem) \d+\b/g],
  ["owner decision", /\b[Oo]wner(?:'s)? decision\b|\b[Oo]wner's (?:call|choice)\b/g],
];

const LANGS = {
  ".ts": "ts",
  ".go": "go",
  ".rs": "rs",
};

/** The production files in scope, relative to the repo root, slash-separated. */
export function scopeFiles(files) {
  return files.filter((f) => {
    if (f.startsWith("Client/src/")) {
      return (
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".d.ts") &&
        !f.endsWith("/protocolTypes.ts")
      );
    }
    if (f.startsWith("Server/")) {
      return (
        f.endsWith(".go") &&
        !f.endsWith("_test.go") &&
        !f.startsWith("Server/db/dbgen/") &&
        f !== "Server/ws/message_types.go" &&
        !f.includes("/testdata/")
      );
    }
    if (f.startsWith("Client/src-tauri/src/")) {
      const base = path.posix.basename(f);
      return (
        f.endsWith(".rs") &&
        base !== "tests.rs" &&
        !base.endsWith("_tests.rs") &&
        !f.includes("/tests/")
      );
    }
    return false;
  });
}

const REGEX_PREV = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/**
 * The comments of one source file, as { line, text } per comment line.
 * lang is "ts", "go" or "rs".
 */
export function comments(src, lang) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  // TS template literals nest through ${ }; each entry is the brace depth at
  // which the template resumes.
  const templates = [];
  let braces = 0;
  let prev = ""; // last significant code character, for regex detection
  let prevWord = "";

  const push = (start, end, startLine) => {
    const text = src.slice(start, end);
    text.split("\n").forEach((t, k) => out.push({ line: startLine + k, text: t }));
  };
  const skipString = (q) => {
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === "\\") i++;
      if (src[i] === "\n") line++;
      i++;
    }
    i++;
  };
  const skipTemplate = () => {
    // at the char after ` or after the closing } of a ${ }
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") line++;
      if (c === "`") {
        i++;
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        templates.push(braces);
        braces++;
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      const start = i + 2;
      while (i < n && src[i] !== "\n") i++;
      push(start, i, line);
      continue;
    }
    if (c === "/" && d === "*") {
      const start = i + 2;
      const startLine = line;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "\n") line++;
        if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
          continue;
        }
        if (lang === "rs" && src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
          continue;
        }
        i++;
      }
      push(start, Math.max(start, i - 2), startLine);
      continue;
    }
    if (lang === "ts") {
      if (c === "`") {
        i++;
        skipTemplate();
        prev = "`";
        continue;
      }
      if (c === "{") braces++;
      if (c === "}") {
        braces--;
        if (templates.length > 0 && templates[templates.length - 1] === braces) {
          templates.pop();
          i++;
          skipTemplate();
          prev = "`";
          continue;
        }
      }
      if (c === "/" && (prev === "" || REGEX_PREV.has(prev) || REGEX_WORDS.has(prevWord))) {
        i++;
        let inClass = false;
        while (i < n && src[i] !== "\n") {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) break;
          i++;
        }
        i++;
        prev = "/";
        prevWord = "";
        continue;
      }
    }
    if (c === '"' || (c === "'" && lang === "ts")) {
      skipString(c);
      prev = c;
      prevWord = "";
      continue;
    }
    if (lang === "go" && c === "`") {
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prev = "`";
      continue;
    }
    if (lang === "go" && c === "'") {
      skipString("'");
      prev = "'";
      continue;
    }
    if (lang === "rs") {
      const raw = /^b?r(#*)"/.exec(src.slice(i, i + 12));
      if (raw && !/[\w]/.test(src[i - 1] ?? "")) {
        const close = '"' + raw[1];
        const end = src.indexOf(close, i + raw[0].length);
        const stop = end < 0 ? n : end + close.length;
        for (let k = i; k < stop; k++) if (src[k] === "\n") line++;
        i = stop;
        prev = '"';
        continue;
      }
      if (c === "'") {
        const ch = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/u.exec(
          src.slice(i, i + 12),
        );
        i += ch ? ch[0].length : 1;
        prev = "'";
        continue;
      }
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
      prevWord = m[0];
      prev = "a";
      i += m[0].length;
      continue;
    }
    prev = c;
    prevWord = "";
    i++;
  }
  return out;
}

/** The id hits in one file: [{ line, kind, id }]. */
export function idsIn(src, lang) {
  const hits = [];
  for (const { line, text } of comments(src, lang)) {
    for (const [kind, re] of ID_PATTERNS) {
      for (const m of text.matchAll(re)) hits.push({ line, kind, id: m[0] });
    }
  }
  return hits;
}

export function countTree(root, files) {
  const counts = {};
  for (const f of scopeFiles(files)) {
    const lang = LANGS[path.posix.extname(f)];
    const hits = idsIn(readFileSync(path.join(root, f), "utf8"), lang);
    if (hits.length > 0) counts[f] = hits.length;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Compare counts against the baseline. Returns the messages that fail the check. */
export function compare(actual, baseline, cap) {
  const problems = [];
  for (const [f, n] of Object.entries(actual)) {
    const allowed = baseline[f] ?? 0;
    if (n > allowed) {
      problems.push(
        `${f}: ${n} plan or ticket ids in comments, baseline allows ${allowed}. ` +
          `Say the reason in plain words instead of citing the id.`,
      );
    }
  }
  for (const [f, allowed] of Object.entries(baseline)) {
    const n = actual[f] ?? 0;
    if (n < allowed) {
      problems.push(
        `${f}: baseline says ${allowed}, the file now has ${n}. Lower the row (node scripts/check-comment-ids.mjs --update).`,
      );
    }
  }
  const total = Object.values(baseline).reduce((a, b) => a + b, 0);
  if (total > cap) {
    problems.push(
      `baseline total ${total} is above TOTAL_CAP ${cap} in scripts/check-comment-ids.mjs.`,
    );
  } else if (total < cap) {
    problems.push(
      `baseline total ${total} is below TOTAL_CAP ${cap}: lower TOTAL_CAP to ${total}.`,
    );
  }
  return problems;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "Client/src", "Client/src-tauri/src", "Server"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function main(argv) {
  const actual = countTree(ROOT, trackedFiles());
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (argv.includes("--list")) {
    for (const f of scopeFiles(trackedFiles())) {
      for (const h of idsIn(
        readFileSync(path.join(ROOT, f), "utf8"),
        LANGS[path.posix.extname(f)],
      )) {
        console.log(`${f}:${h.line}: ${h.kind}: ${h.id}`);
      }
    }
    return 0;
  }
  if (argv.includes("--update")) {
    // An empty baseline is the first recording; after that a row only goes down.
    const first = Object.keys(baseline).length === 0;
    const raised = first ? [] : Object.entries(actual).filter(([f, n]) => n > (baseline[f] ?? 0));
    if (raised.length > 0) {
      for (const [f, n] of raised)
        console.error(`${f}: ${n} > ${baseline[f] ?? 0}; the baseline never rises.`);
      return 1;
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(actual, null, 2) + "\n");
    const total = Object.values(actual).reduce((a, b) => a + b, 0);
    console.log(
      `wrote ${Object.keys(actual).length} rows, total ${total}; set TOTAL_CAP to ${total}.`,
    );
    return 0;
  }
  const problems = compare(actual, baseline, TOTAL_CAP);
  for (const p of problems) console.error(p);
  if (problems.length === 0) {
    const total = Object.values(actual).reduce((a, b) => a + b, 0);
    console.log(
      `comment ids: ${total} in ${Object.keys(actual).length} files, none above the baseline.`,
    );
  }
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
