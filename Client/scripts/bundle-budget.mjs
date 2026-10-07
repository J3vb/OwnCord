#!/usr/bin/env node
// Bundle budget gate for the client (B7-7). Reads the Vite manifest emitted by
// `npm run build:budget` (dist-budget/, NOT the shipped dist/ — the manifest
// must not leak into beforeBuildCommand's output) and fails when any gzip size
// exceeds its budget in bundle-budgets.json.
//
// From Client/:
//   npm run build:budget && node scripts/bundle-budget.mjs
//
// Fails closed like coverage-floor.sh: a missing or unparseable manifest, or a
// budget naming a chunk the manifest does not contain, is exit 2 — a gate that
// passes over an empty set of chunks is not a gate.
//
// gzip method: Node zlib.gzipSync level 9 (owner decision 2026-09-20). The
// earlier decision 10 named `gzip -9`; this keeps the level and format but pins
// the implementation, so the number is identical on every OS with no external
// binary to probe for. The CLI figures for the same build are recorded once in
// docs/plans/b7-0-client-baseline-2026-09-19.md as a bridge to the B7-0 record.
//
// Startup budget: the JS of the entry's STATIC CLOSURE — the index.html entry
// file plus everything reachable through its `imports` — not a fixed file list.
// A list cannot see a new eagerly-imported chunk, which is the one thing a
// startup budget exists to catch.
//
// CSS is deliberately NOT part of this number (D5, 2026-09-28). With
// `cssCodeSplit: false` every stylesheet merged into one file linked from the
// entry, so a UI PR that only added a rule to app.css moved the startup budget
// and it was raised almost daily. PERF-07 is scoped to the JS chain; every
// emitted stylesheet is budgeted separately on the `css-total` line, which
// still ratchets CSS growth without touching the startup JS figure.
//
// The pure helpers below are exported so a unit test can drive the split with a
// fixture manifest; importing this module must not touch the filesystem.

import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const DIST = "dist-budget";
const MANIFEST_PATH = `${DIST}/.vite/manifest.json`;
const exit = (code) => process.exit(code);

/** The JS files statically reachable from the entry, by manifest key. Throws
 *  on an import edge that has no manifest node — a manifest budget cannot ride
 *  on a graph it cannot resolve. */
export function startupClosureFiles(manifest) {
  const entry = manifest["index.html"];
  if (!entry?.file) throw new Error("manifest has no index.html entry");
  const files = new Set([entry.file]);
  const visited = new Set();
  const walk = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const node = manifest[key];
    if (!node) return;
    for (const imp of node.imports ?? []) {
      if (!manifest[imp]) throw new Error(`manifest import '${imp}' of '${key}' has no node`);
      files.add(manifest[imp].file);
      walk(imp);
    }
  };
  walk("index.html");
  return files;
}

/** Every emitted stylesheet, deduplicated by file: a manifest node's `css`
 *  array plus a standalone `.css` manifest entry (the old single bundle). */
export function allCssFiles(manifest) {
  const files = new Set();
  for (const node of Object.values(manifest)) {
    for (const c of node.css ?? []) files.add(c);
    if (node.file?.endsWith(".css")) files.add(node.file);
  }
  return files;
}

function main() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    console.error(`bundle-budget: cannot read ${MANIFEST_PATH}: ${err.message}`);
    console.error("bundle-budget: run 'npm run build:budget' first");
    exit(2);
  }

  const budgets = JSON.parse(
    readFileSync(new URL("../bundle-budgets.json", import.meta.url), "utf8"),
  );

  const gz = (file) => gzipSync(readFileSync(`${DIST}/${file}`), { level: 9 }).length;

  // --- startup closure (JS) --------------------------------------------------
  let closure;
  try {
    closure = startupClosureFiles(manifest);
  } catch (err) {
    console.error(`bundle-budget: ${err.message}`);
    exit(2);
  }
  const startupActual = [...closure].reduce((sum, f) => sum + gz(f), 0);

  // --- total CSS (D5) --------------------------------------------------------
  const cssFiles = allCssFiles(manifest);
  const cssActual = [...cssFiles].reduce((sum, f) => sum + gz(f), 0);

  // --- per-chunk budgets -----------------------------------------------------
  const byName = new Map();
  for (const node of Object.values(manifest)) {
    if (node.name && node.file) byName.set(node.name, node);
  }

  let failed = false;
  const line = (label, actual, budget, extra = "") => {
    const verdict = actual <= budget ? "ok" : "FAIL";
    if (verdict === "FAIL") failed = true;
    console.log(`bundle-budget: ${verdict} ${label} ${actual} B (budget ${budget} B)${extra}`);
  };

  line("startup-closure", startupActual, budgets.startup.budget, ` over ${closure.size} files`);
  line("css-total", cssActual, budgets.css.budget, ` over ${cssFiles.size} files`);

  for (const [name, spec] of Object.entries(budgets.chunks)) {
    const node = byName.get(name);
    if (!node) {
      console.error(`bundle-budget: chunk '${name}' not in manifest — renamed?`);
      exit(2);
    }
    let actual = gz(node.file);
    let extra = "";
    if (node.css) {
      const css = node.css.reduce((sum, c) => sum + gz(c), 0);
      actual += css;
      extra = ` (incl. css ${css} B)`;
    }
    if (spec.lazy) {
      // lazy = not statically reachable from the entry. `livekit` is reached
      // through the livekitSession/screenShare dynamic chunks, so checking for a
      // direct dynamicImports edge would false-fail; membership in the startup
      // closure is the property that actually matters.
      if (closure.has(node.file)) {
        console.error(
          `bundle-budget: FAIL ${name} must be lazy (statically reachable from the entry)`,
        );
        failed = true;
      } else {
        extra += " [lazy]";
      }
    }
    line(name, actual, spec.budget, extra);
  }

  // --- no embedded WASM in ANY JS chunk -------------------------------------
  const marker = budgets.forbidEmbeddedWasm.marker;
  for (const file of findEmbeddedWasm(DIST, marker)) {
    console.error(`bundle-budget: FAIL ${file} embeds the WASM marker '${marker}'`);
    failed = true;
  }

  if (failed) exit(1);
  console.log("bundle-budget: all budgets ok");
}

/** Every emitted .js file under `dir` (relative paths) that contains `marker`.
 *  Walks the directory, not the manifest: worklets and workers copied from
 *  public/ never appear in it. */
export function findEmbeddedWasm(dir, marker) {
  return readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".js") && readFileSync(`${dir}/${f}`, "utf8").includes(marker))
    .sort();
}

if (process.argv[1] === import.meta.filename) main();
