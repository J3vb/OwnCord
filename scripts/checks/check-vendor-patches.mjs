#!/usr/bin/env node
// Fail when the vendored LiveKit crate's patch markers and its patch doc differ.
//
//   node scripts/checks/check-vendor-patches.mjs
//   node --test scripts/checks/check-vendor-patches.test.mjs
//
// Every patch in Client/src-tauri/vendor/livekit/src carries a marker comment
// `OWNCORD-PATCH (tag)`. The tag is the key. OWNCORD-PATCH.md lists each tag once
// in its "Marker index" section as a bullet that starts with
// `OWNCORD-PATCH (tag)` in backticks. A tag with no entry, an entry with no
// marker, or a marker with no tag is an error: the doc is what tells the next
// person bumping the crate what to re-apply.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR_DIR = path.join(ROOT, "Client", "src-tauri", "vendor", "livekit");

const TAGGED = /OWNCORD-PATCH \(([^)]+)\)/g;
// A bare `OWNCORD-PATCH` is allowed only as the file name OWNCORD-PATCH.md.
const BARE = /OWNCORD-PATCH(?!\.md| \()/;
const INDEX_HEADING = "## Marker index";
const ENTRY = /^- `OWNCORD-PATCH \(([^)]+)\)`/;

/** Tags and untagged markers found in the source text of one file. */
export function markersIn(text, file = "") {
  const tags = new Set();
  const bare = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(TAGGED)) tags.add(m[1]);
    if (BARE.test(line.replace(TAGGED, ""))) bare.push(`${file}:${i + 1}`);
  });
  return { tags, bare };
}

/** The tags the doc lists in its "Marker index" section. */
export function documentedTags(doc) {
  const start = doc.indexOf(`\n${INDEX_HEADING}\n`);
  if (start < 0) return null;
  const rest = doc.slice(start + INDEX_HEADING.length + 2);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const tags = [];
  for (const line of section.split("\n")) {
    const m = ENTRY.exec(line);
    if (m) tags.push(m[1]);
  }
  return tags;
}

/** Problems between the markers found and the tags documented; empty when they agree. */
export function compare(sourceTags, bare, docTags) {
  const problems = [];
  if (docTags === null) return [`OWNCORD-PATCH.md has no "${INDEX_HEADING}" section`];
  for (const where of bare) problems.push(`marker without a (tag): ${where}`);
  const seen = new Set();
  for (const t of docTags) {
    if (seen.has(t)) problems.push(`documented twice: ${t}`);
    seen.add(t);
  }
  for (const t of [...sourceTags].sort()) {
    if (!seen.has(t)) problems.push(`marker "${t}" is in the source but not in OWNCORD-PATCH.md`);
  }
  for (const t of [...seen].sort()) {
    if (!sourceTags.has(t)) problems.push(`"${t}" is in OWNCORD-PATCH.md but no marker is left`);
  }
  return problems;
}

function* rustFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* rustFiles(p);
    else if (e.name.endsWith(".rs")) yield p;
  }
}

/** Read the real tree and return the problems. */
export function check(vendorDir = VENDOR_DIR) {
  const tags = new Set();
  const bare = [];
  for (const file of rustFiles(path.join(vendorDir, "src"))) {
    const found = markersIn(readFileSync(file, "utf8"), path.relative(vendorDir, file));
    found.tags.forEach((t) => tags.add(t));
    bare.push(...found.bare);
  }
  const doc = readFileSync(path.join(vendorDir, "OWNCORD-PATCH.md"), "utf8");
  return { tags, problems: compare(tags, bare, documentedTags(doc)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { tags, problems } = check();
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`vendored livekit: ${tags.size} patch markers, all documented`);
}
