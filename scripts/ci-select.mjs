#!/usr/bin/env node
// Decide which CI jobs a change needs, from the set of paths it changes.
//
//   node scripts/ci-select.mjs --paths-file <file> [--out <file>]
//   node scripts/ci-select.mjs --all [--reason <text>] [--out <file>]
//
// Emits one `key=true|false` line per capability. The workflow turns those into
// job conditions, so a capability that is false SKIPS a job and a capability
// that is true RUNS it.
//
// ─── Why a hand-written classifier rather than a paths-filter action ────────
// Every gate in this repository is self-tested on every PR (check-doc-counts,
// check-migrations, npm-audit-gate, verify-gate-evidence), because a gate whose
// own logic is never exercised rots silently. The selection rules ARE a gate —
// a wrong `false` here stops tests from running — so they live in a pure
// function with a unit suite next to them (scripts/ci-select.test.mjs) rather
// than in an action's configuration.
//
// ─── The safety rule ────────────────────────────────────────────────────────
// Selection may only ever be wrong in the direction of running MORE jobs.
// Anything unrecognised, and any failure to obtain a diff at all, selects every
// capability. A false `false` is a test that silently did not run; a false
// `true` is a few wasted minutes.
//
// ─── Traced cross-boundary dependencies ─────────────────────────────────────
// These are files that a test in ANOTHER component reads, so the component that
// owns the test must run even though nothing under it moved. Each entry was
// read off the source, not guessed:
//
//   Server reads outside Server/:
//     protocol/schema.json                     api/absence_contract_test.go
//     docs/schema.md                           permissions/schema_doc_test.go
//     docs/api.md                              make docs-verify (gendocs blocks)
//     docs/architecture/server-boundaries.md   cmd/dbinventory/doc_test.go
//     docs/architecture/community-services.md  migrations/community_services_doc_test.go
//     Client/src/lib/types.ts                  permissions/schema_doc_test.go
//     .superpowers/findings-ledger.json        cmd/smoke/drills.go (go run ./cmd/smoke)
//
//   Client reads outside Client/:
//     docs/api.md                              tests/contract/api-profile-route.test.ts
//     Server/admin/static/index.html           tests/contract/server-admin-static-*.test.ts
//     protocol/schema.json                     src/lib/protocolTypes.ts is generated from it
//
// The two architecture docs are the trap this table exists for: they are
// Markdown, so a docs-only rule would skip them, and the Go tests that read
// them run with -count=1 precisely because Go's test cache cannot see an input
// outside the module.

import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Every capability the workflow can gate a job on. */
export const CAPABILITIES = [
  "server", // Server Build & Test (both OS legs)
  "client", // Client Static Checks, Client Unit Tests, Node policy
  "rust", // Rust Unit Tests
  "browser", // Client E2E (Playwright) + Client E2E (parity subset)
  "integration", // Client E2E (real server and media) + Admin Panel E2E
  "native", // Client E2E (Windows native)
  "harness", // widen the development browser run from smoke to full
];

/** Server paths outside the Client/Server pair that a Server test reads. */
const SERVER_READS_OUTSIDE = new Set([
  "protocol/schema.json",
  "docs/schema.md",
  "docs/api.md",
  "docs/architecture/server-boundaries.md",
  "docs/architecture/community-services.md",
  "Client/src/lib/types.ts",
  ".superpowers/findings-ledger.json",
]);

/** Client paths outside Client/ that a Client test reads. */
const CLIENT_READS_OUTSIDE = new Set([
  "protocol/schema.json",
  "docs/api.md",
  "Server/admin/static/index.html",
]);

/**
 * Paths that change the browser suite's own machinery: the Playwright specs and
 * their fixtures. A change here is the one case where the fast development run
 * stops being a fair sample of the full suite, so it widens back to full.
 * The Playwright configs are deliberately NOT here — a config change is
 * covered by running the production suite in full on every browser PR, and
 * widening on the configs would make the smoke/full split unusable.
 */
const HARNESS_PREFIXES = ["Client/tests/e2e/", "Client/tests/browser/"];

/**
 * The client's own manifests. A dependency bump can move the dev server, the
 * Playwright version or the vitest version under the smoke run, so it is a
 * harness change as well as a client change — but only for the components that
 * consume the client's npm tree, not for the Go server or the Rust crate.
 */
const HARNESS_FILES = new Set(["Client/package.json", "Client/package-lock.json"]);

/** Root files that change how every component is built or installed. */
const ROOT_BUILD_FILES = new Set([
  "package.json",
  "package-lock.json",
  ".npmrc",
  ".editorconfig",
  ".gitattributes",
]);

/** Everything, for the paths whose blast radius cannot be bounded. */
const EVERYTHING = [...CAPABILITIES];

/**
 * Classify a set of changed paths into the capabilities they require.
 *
 * Pure: no filesystem, no environment. The CLI below is the only I/O.
 *
 * @param {string[]} paths repository-relative, POSIX separators
 * @returns {Record<string, boolean>}
 */
export function classify(paths) {
  const caps = new Set();
  const add = (...names) => names.forEach((n) => caps.add(n));

  if (!Array.isArray(paths) || paths.length === 0) {
    // No paths at all is not "nothing changed": it is a diff we did not get.
    return allCapabilities();
  }

  for (const raw of paths) {
    const path = normalise(raw);
    if (path === null) return allCapabilities(); // unparseable entry: be safe

    // A shared CI input: the workflow files themselves, the scripts every job
    // runs, and the repository-root build files. The blast radius of a change
    // here is not knowable from the path, so it selects every capability.
    if (
      path.startsWith(".github/") ||
      path.startsWith("scripts/") ||
      path.startsWith(".githooks/") ||
      ROOT_BUILD_FILES.has(path)
    ) {
      add(...EVERYTHING);
      continue;
    }

    // Traced dependencies, checked before the generic prefixes below so a
    // specific file can pull in a component its generic prefix would not.
    if (SERVER_READS_OUTSIDE.has(path)) add("server", "integration");
    if (CLIENT_READS_OUTSIDE.has(path)) add("client", "browser");
    if (HARNESS_FILES.has(path) || HARNESS_PREFIXES.some((p) => path.startsWith(p))) {
      add("harness");
    }

    if (path.startsWith("Server/")) {
      add("server", "integration");
      // The admin panel's HTML is asserted against by the client's contract
      // specs, so a Server change to it is also a client-unit-test change.
      if (path.startsWith("Server/admin/static/")) add("client");
      continue;
    }

    if (path.startsWith("Client/src-tauri/")) {
      // The Rust shell: rust-tests compiles it and the native job builds it.
      // It is NOT a browser-suite input — the mocked suite runs the TS app
      // under Chromium against a vite server and never loads the crate — so a
      // Rust-only change must not spend the two browser jobs. `client` does run:
      // the unit suite reads src-tauri (check-tauri-versions.mjs compares the
      // npm and Cargo pins).
      add("client", "rust", "native");
      continue;
    }

    if (path.startsWith("Client/")) {
      // The native job builds the whole client bundle and then drives the UI
      // through Playwright, so every client change is a native-job input —
      // not only a change to the Rust shell.
      add("client", "browser", "integration", "native");
      continue;
    }

    if (path.startsWith("protocol/")) {
      // Schema changes regenerate both the Go constants and the TS types, and
      // both `make protocol-verify` legs assert the pair has not drifted.
      add("server", "client", "browser", "integration", "native");
      continue;
    }

    if (path.startsWith("tools/")) {
      // tools/mcp-introspect is a Node package with its own lockfile, and the
      // node-policy job installs it.
      add("client");
      continue;
    }

    if (path.startsWith("deploy/")) {
      add("server");
      continue;
    }

    if (path.startsWith("docs/") || path.startsWith(".superpowers/")) {
      // Prose and the findings ledger. Any tracked dependency these have is
      // handled by the traced tables above; everything else here is read by
      // humans and by the always-on documentation jobs.
      continue;
    }

    // Documentation at the repository root, and any path this classifier has
    // never been taught about.
    if (path.endsWith(".md") && !path.includes("/")) continue;
    return allCapabilities();
  }

  return Object.fromEntries(CAPABILITIES.map((c) => [c, caps.has(c)]));
}

function allCapabilities() {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, true]));
}

/** Fold a git path to the form the tables above are written in. */
function normalise(raw) {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (path === "" || path.startsWith("/") || path.includes("..")) return null;
  return path;
}

/**
 * Parse `git diff --name-status -M` output into the list of paths touched.
 *
 * Rename and copy rows name TWO paths, and both matter: a rename out of
 * Server/ into Client/ has to select both components, or the component that
 * lost the file is never re-tested.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseNameStatus(text) {
  const paths = [];
  for (const line of text.split("\n")) {
    const fields = line.split("\t").map((f) => f.trim());
    if (fields.length < 2 || !/^[A-Z]\d*$/.test(fields[0])) continue;
    // R/C rows are `status<TAB>old<TAB>new`; everything else is `status<TAB>path`.
    for (const p of fields.slice(1)) if (p !== "") paths.push(p);
  }
  return paths;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  // --all is the explicit "run everything" answer. The workflow uses it for the
  // two cases where no path list exists to reason about: an event that is not a
  // pull request into dev (see the job's comment in ci.yml), and a diff that
  // could not be obtained. Naming the state rather than passing an empty file
  // keeps a truncated download from looking like a genuine no-op diff.
  let paths;
  if (flag("--all")) {
    paths = null;
  } else {
    const file = value("--paths-file");
    if (file === null) {
      process.stderr.write(
        "usage: ci-select.mjs --paths-file <file> [--out <file>]\n" +
          "       ci-select.mjs --all [--reason <text>] [--out <file>]\n",
      );
      process.exit(2);
    }
    paths = parseNameStatus(readFileSync(file, "utf8"));
  }

  const selected = paths === null ? allCapabilities() : classify(paths);
  const lines = CAPABILITIES.map((c) => `${c}=${selected[c]}`).join("\n") + "\n";

  const out = value("--out");
  if (out !== null) appendFileSync(out, lines);
  else process.stdout.write(lines);

  // A selection always succeeds: it is the conservative default, not a check.
  // Exiting non-zero would skip every job that needs these outputs, which is
  // the one outcome this script exists to prevent.
  const reason = value("--reason");
  process.stderr.write(
    `ci-select: ${paths === null ? "all capabilities" : `${paths.length} path(s)`}` +
      `${reason ? ` (${reason})` : ""} -> ${JSON.stringify(selected)}\n`,
  );
}

// Only run the CLI when this file is the entry point; the unit suite imports
// classify() and parseNameStatus() and must not trigger a read of argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
