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
// Startup budget: the entry's STATIC CLOSURE — the index.html entry file plus
// everything reachable through its `imports` plus linked CSS — not a fixed file
// list. A list cannot see a new eagerly-imported chunk, which is the one thing
// a startup budget exists to catch.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const DIST = "dist-budget";
const MANIFEST_PATH = `${DIST}/.vite/manifest.json`;
const exit = (code) => process.exit(code);

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

const entry = manifest["index.html"];
if (!entry || !entry.file) {
  console.error("bundle-budget: manifest has no index.html entry");
  exit(2);
}

const gz = (file) => gzipSync(readFileSync(`${DIST}/${file}`), { level: 9 }).length;

// --- startup closure -------------------------------------------------------
const closure = new Set([entry.file]);
const walk = (key) => {
  const node = manifest[key];
  if (!node) return;
  for (const imp of node.imports ?? []) {
    if (!manifest[imp]) {
      console.error(`bundle-budget: manifest import '${imp}' of '${key}' has no node`);
      exit(2);
    }
    closure.add(manifest[imp].file);
    if (manifest[imp].css) manifest[imp].css.forEach((c) => closure.add(c));
    walk(imp);
  }
};
walk("index.html");
if (entry.css) entry.css.forEach((c) => closure.add(c));
// style.css is its own manifest entry, not linked through `css`
for (const [key, node] of Object.entries(manifest)) {
  if (key.endsWith(".css") && node.file) closure.add(node.file);
}
const startupActual = [...closure].reduce((sum, f) => sum + gz(f), 0);

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
for (const node of Object.values(manifest)) {
  if (!node.file?.endsWith(".js")) continue;
  if (readFileSync(`${DIST}/${node.file}`, "utf8").includes(marker)) {
    console.error(
      `bundle-budget: FAIL ${node.name ?? node.file} embeds the WASM marker '${marker}'`,
    );
    failed = true;
  }
}

if (failed) exit(1);
console.log("bundle-budget: all budgets ok");
