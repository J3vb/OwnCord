#!/usr/bin/env node
// Admin panel type check and shrink-only gate (ARCH-10 stage 1).
//
// From Client/:
//   node scripts/check-admin-types.mjs            # fail on any new or stale error
//   node scripts/check-admin-types.mjs --update   # shrink the baseline after a fix
//
// The admin panel (Server/admin/static/js, 223 KB of classic scripts with no
// build step) has no type check of its own: it is Server-owned, so tsc never
// sees it. This script compiles it with `checkJs` under a non-strict,
// deliberately loose program (Client/tsconfig.admin.json) and fails when the
// error set grows. It is the verification floor the AO-1..AO-8 panel rebuild
// works over, not a claim the panel is type-clean.
//
// The baseline (scripts/admin-types-baseline.json) is keyed by
// file + diagnostic code + normalised message, never by line, so an edit above
// an error does not churn it. The message keeps its first line only (TypeScript's
// elaboration chain varies by version) and a printed object type collapses to
// '{…}', so adding an action to a big literal such as ACTIONS does not rename
// the errors that mention it. It only shrinks: a new identity or a higher count fails,
// and an entry the source no longer produces also fails until `--update`
// removes it, so a fixed error cannot leave stale credit behind. That is the
// same ratchet scripts/check-ui-strings.mjs enforces over UI text.
//
// Limits, stated so a green run is not read as more than it is: this proves
// nothing about runtime behaviour, the two TS2362/TS2363 arithmetic errors are
// noise from untyped DOM reads, and 0 TS2304/TS2552 (cannot find name) is the
// signal worth keeping — it stays at zero, so a typo'd global is caught.
// compare() fails every TS2304 and TS2552 whatever the baseline says.
//
// Reseeding: a TypeScript or lib.dom bump can still reword a message, which
// shows up as a stale entry plus an added one with the same count. Only then,
// rebuild the baseline from scratch and check the diff renames keys without
// growing any count:
//   rm scripts/admin-types-baseline.json && node scripts/check-admin-types.mjs --update

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const CLIENT = join(import.meta.dirname, "..");
const SERVER = join(CLIENT, "..", "Server");
export const CONFIG_PATH = join(CLIENT, "tsconfig.admin.json");
export const BASELINE_PATH = join(CLIENT, "scripts", "admin-types-baseline.json");

/** Written by `--update` so the file explains its own ratchet to a reader. */
const DOC = [
  'Admin-panel checkJs errors, keyed file -> "<code>:<normalised message>" -> count.',
  "This list only shrinks: scripts/check-admin-types.mjs fails a new identity or a higher count,",
  "and fails a listed identity the source no longer produces until",
  "`node scripts/check-admin-types.mjs --update` removes it. Keys are file + code + normalised message, never",
  "a line, so an edit above an error does not churn the file. TS2304/TS2552 (undefined name) are pinned at zero.",
].join(" ");

/**
 * Compile the panel with the loose checkJs program and return one identity per
 * diagnostic: { file, code, message } with file relative to Server/ and
 * joined with "/" on every platform. Diagnostics with no file (a config-level error) are returned in
 * `configErrors`, which fail unconditionally — they mean the program itself
 * could not be built, not that the panel has an error.
 */
export function scanTree() {
  const read = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (read.error) {
    return {
      diagnostics: [],
      configErrors: [ts.flattenDiagnosticMessageText(read.error.messageText, "\n")],
    };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, CLIENT);
  if (parsed.errors.length > 0) {
    return {
      diagnostics: [],
      configErrors: parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    };
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [];
  const configErrors = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file === undefined) {
      configErrors.push(message);
      continue;
    }
    const file = relative(SERVER, d.file.fileName).split(sep).join("/");
    diagnostics.push({ file, code: d.code, message });
  }
  return { diagnostics, configErrors };
}

/**
 * Identity key for one diagnostic: stable across line moves, reformatting and
 * edits to a printed object type.
 */
export function identity(d) {
  const message = d.message.split("\n")[0].replace(/'\{[^']*\}'/g, "'{…}'");
  return `${d.code}:${message}`;
}

/** Per-file identity counts, the shape both compare() and shrink() use. */
export function counts(diagnostics) {
  const out = {};
  for (const d of diagnostics) {
    out[d.file] ??= {};
    out[d.file][identity(d)] = (out[d.file][identity(d)] ?? 0) + 1;
  }
  return out;
}

/** The baseline, or null when the file does not exist yet. */
export function loadBaseline() {
  return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
}

/**
 * Compare a scan with the baseline. `added` are identities above their baseline
 * count (every instance, since which occurrence is new cannot be known), and
 * every TS2304/TS2552 whatever its baseline; `stale` are baseline identities above the
 * scanned count.
 */
export function compare(scan, baseline) {
  const actual = counts(scan.diagnostics);
  const allowed = (baseline ?? {}).files ?? {};
  const added = [];
  const stale = [];
  for (const [file, byIdentity] of Object.entries(actual)) {
    for (const [id, n] of Object.entries(byIdentity)) {
      const cap = /^(2304|2552):/.test(id) ? 0 : (allowed[file]?.[id] ?? 0);
      if (n > cap) added.push({ file, identity: id, actual: n, baseline: cap });
    }
  }
  for (const [file, byIdentity] of Object.entries(allowed)) {
    for (const [id, n] of Object.entries(byIdentity)) {
      const now = actual[file]?.[id] ?? 0;
      if (n > now) stale.push({ file, identity: id, baseline: n, actual: now });
    }
  }
  return { added, stale };
}

/**
 * The shrunk baseline: every identity capped at its scanned count, empties
 * dropped. Never adds, except with no baseline file (null), which is how the
 * inventory is first taken.
 */
export function shrink(scan, baseline) {
  const fresh = baseline === null;
  const actual = counts(scan.diagnostics);
  const files = {};
  for (const [file, byIdentity] of Object.entries(actual)) {
    const kept = {};
    for (const id of Object.keys(byIdentity).sort()) {
      const cap = fresh
        ? byIdentity[id]
        : Math.min(byIdentity[id], baseline.files?.[file]?.[id] ?? 0);
      if (cap > 0) kept[id] = cap;
    }
    if (Object.keys(kept).length > 0) files[file] = kept;
  }
  return { _doc: DOC, files };
}

function main(argv) {
  const scan = scanTree();
  if (scan.configErrors.length > 0) {
    console.error(scan.configErrors.join("\n"));
    return 1;
  }
  const baseline = loadBaseline();
  if (argv.includes("--update")) {
    writeFileSync(BASELINE_PATH, JSON.stringify(shrink(scan, baseline), null, 2) + "\n");
    console.log(`wrote ${relative(CLIENT, BASELINE_PATH)}`);
  }
  const { added, stale } = compare(scan, argv.includes("--update") ? loadBaseline() : baseline);
  for (const a of added) {
    console.error(`${a.file}: new type error (${a.actual}, baseline ${a.baseline}): ${a.identity}`);
  }
  if (added.length > 0) {
    console.error("\nFix it, or run `node scripts/check-admin-types.mjs --update` only to shrink.");
  }
  for (const s of stale) {
    console.error(`${s.file}: baseline lists ${s.identity} ×${s.baseline}, source has ${s.actual}`);
  }
  if (stale.length > 0) {
    console.error("\nRun `node scripts/check-admin-types.mjs --update` to shrink the baseline.");
  }
  if (added.length === 0 && stale.length === 0) {
    console.log(`admin type check: ${scan.diagnostics.length} errors, all baselined.`);
  }
  return added.length > 0 || stale.length > 0 ? 1 : 0;
}

if (process.argv[1] === import.meta.filename) process.exit(main(process.argv.slice(2)));
