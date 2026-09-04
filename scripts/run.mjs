#!/usr/bin/env node
// Root command facade (RL-04 / L-04).
//
// One entry point for the checks CI runs, so a contributor does not have to
// know which directory each stack lives in. `node scripts/run.mjs --list`
// prints every task and the exact commands it runs.
//
// Two rules this file exists to keep:
//
//   1. Cross-platform. No `make`, no shell syntax, no `cd &&`. Every step is
//      spawned directly with an explicit `cwd`, so there is no shell to quote
//      for and nothing that behaves differently on Windows.
//   2. The facade orchestrates, it never becomes the only path. Each step
//      prints the command it runs, in the directory it runs it in, so a
//      Go-only contributor can read the output and type those commands
//      instead — and never needs Node to work on the server.
//
// Dependency-free by design: Node's standard library only, like
// .superpowers/render-ledger.mjs. Adding a dependency here would mean
// `npm run check` could not run until `npm install` had.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

// npm and npx are batch shims on Windows; everything else is a real binary.
const bin = (c) => (WIN && (c === "npm" || c === "npx") ? `${c}.cmd` : c);

// Node refuses to spawn a .cmd/.bat with shell:false (the CVE-2024-27980
// mitigation): it fails with EINVAL and a null exit status. So the Windows npm
// shims need a shell, and only they do -- every other command here is a real
// binary, and a shell would put its quoting rules between us and the arguments.
const needsShell = (c) => WIN && (c === "npm" || c === "npx");

/** A step that always runs. */
const step = (cmd, args, cwd = ".") => ({ cmd, args, cwd });

/**
 * A step that is skipped, with a printed reason, when `probe` is not on PATH.
 * Used for tools CI installs but a contributor may not have: golangci-lint has
 * no wrapper in this repo at all, and sqlc is pinned by Server/sqlc.version.
 */
const optional = (probe, cmd, args, cwd, why) => ({ cmd, args, cwd, probe, why });

/**
 * Tracked files matching `patterns`. shellcheck and actionlint take file lists,
 * and the only correct list is the tracked one: `.claude/worktrees/` holds
 * gitignored copies of the tree that a filesystem glob would happily lint.
 */
const tracked = (...patterns) => {
  const r = spawnSync("git", ["ls-files", "-z", ...patterns], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : [];
};

// `git diff --exit-code` after regenerating is what `make protocol-verify` and
// `make sqlc-verify` reduce to. Inlined so neither needs make.
const PROTOCOL_VERIFY = [
  step("go", ["run", "./cmd/genprotocol"], "Server"),
  step(
    "git",
    ["diff", "--exit-code", "ws/message_types.go", "../Client/src/lib/protocolTypes.ts"],
    "Server",
  ),
];
// The route, table and config-key indexes in docs/. Same shape again: the
// generator rewrites the marked blocks, git reports any drift. cmd/gendocs
// also exits non-zero on its own when a config key is documented nowhere, or
// when it was built without -tags otel,wazero -- the superset build the route
// index is generated from, since /metrics mounts only under otel.
const DOCS_VERIFY = [
  step("go", ["run", "-tags", "otel,wazero", "./cmd/gendocs"], "Server"),
  step(
    "git",
    [
      "diff",
      "--exit-code",
      "../docs/api.md",
      "../docs/schema.md",
      "../docs/server-configuration.md",
    ],
    "Server",
  ),
];
const SQLC_VERIFY = [
  optional(
    "sqlc",
    "sqlc",
    ["generate"],
    "Server",
    "sqlc not on PATH — install the version in Server/sqlc.version",
  ),
  optional("sqlc", "git", ["diff", "--exit-code", "db/dbgen"], "Server", "sqlc not on PATH"),
];

const CHECK_SERVER = [
  step("go", ["build", "./..."], "Server"),
  step("go", ["build", "-tags", "otel", "./..."], "Server"),
  step("go", ["build", "-tags", "wazero", "./..."], "Server"),
  step("go", ["build", "-tags", "otel,wazero", "./..."], "Server"),
  step("go", ["vet", "./..."], "Server"),
  step("go", ["test", "-race", "./..."], "Server"),
  step("go", ["test", "-tags", "deadlock", "-count=1", "./ws/"], "Server"),
  optional(
    "golangci-lint",
    "golangci-lint",
    ["run", "./..."],
    "Server",
    "golangci-lint not on PATH — CI pins v2.11.3",
  ),
  ...PROTOCOL_VERIFY,
  ...SQLC_VERIFY,
  ...DOCS_VERIFY,
];

const CHECK_CLIENT = [
  step("npm", ["run", "typecheck"], "Client"),
  step("npm", ["run", "lint"], "Client"),
  step("npm", ["test"], "Client"),
];

// Matches ci.yml's Rust Unit Tests job exactly: --lib for tests, --all-targets
// for clippy. They differ deliberately; do not "align" them.
const CHECK_RUST = [
  step("cargo", ["fmt", "--all", "--", "--check"], "Client/src-tauri"),
  step("cargo", ["test", "--lib"], "Client/src-tauri"),
  step("cargo", ["clippy", "--all-targets", "--", "-D", "warnings"], "Client/src-tauri"),
];

// RL-07. FINDINGS.md is not tracked, so there is no committed rendering to
// drift — the gate is that generation must succeed. Rendering subsumes
// `--check`: main() validates and exits 1 on a schema problem before it writes.
// It also leaves the contributor a readable copy, which is the point of running
// it locally. CI additionally renders twice and compares, to prove the output
// is a pure function of the ledger; that needs a temp path, so it lives in
// ci.yml rather than here.
// `step`, not `optional`: this file is itself Node, so probing for it is theatre.
const LEDGER_VERIFY = [step("node", [".superpowers/render-ledger.mjs"], ".")];

// Fast and dependency-free, so it goes first: a contradicted count should not
// wait behind ten minutes of -race.
const CHECK_DOCS = [
  step("node", ["scripts/check-doc-counts.mjs"], "."),
  // OC-0395. A shipped migration is immutable: migrate.go tracks one by
  // filename and keeps no content hash, so editing it changes nothing for any
  // installation that already applied it. Nothing else can see that — a fresh
  // database applies the new text and every test passes. `step`, not
  // `optional`: it is Node, and this file is Node.
  step("node", ["scripts/check-migrations.mjs", "--selftest"], "."),
  step("node", ["scripts/check-migrations.mjs"], "."),
  ...LEDGER_VERIFY,
];

// Repository-wide formatting and script/workflow lint (RL-19 / L-13, S-05).
//
// No `gofmt -l` step here on purpose: `gofmt -l` prints offenders and still
// exits 0, so it cannot fail a build. Go formatting is enforced by the
// `formatters` block in Server/.golangci.yml, which runs inside the pinned
// Lint check, and by .githooks/pre-commit on staged files.
const CHECK_HYGIENE = [
  step("npx", ["prettier", "--check", "."], "."),
  optional(
    "shellcheck",
    "shellcheck",
    tracked("*.sh", ".githooks/pre-commit", ".githooks/pre-push"),
    ".",
    "shellcheck not on PATH — no clean Windows install; CI runs it",
  ),
  optional(
    "actionlint",
    "actionlint",
    tracked(".github/workflows/*.yml"),
    ".",
    "actionlint not on PATH — no clean Windows install; CI runs it",
  ),
  // L-16. actionlint validates expression syntax and action inputs; it has no
  // concept of who a condition admits or how long a job may run. This asserts
  // the guards on workflows that spend. `step`, not `optional`: it is Node, and
  // this file is Node. It lives in check:hygiene so it runs inside the pinned
  // Repository Hygiene job rather than needing a new required check.
  step("node", ["scripts/check-workflow-guards.mjs", "--selftest"], "."),
  step("node", ["scripts/check-workflow-guards.mjs"], "."),
  // OC-0397 / R-09. A job in release.yml that pushes an image or cuts a
  // GitHub Release must carry `environment: release`, or it publishes with
  // no required-reviewer approval. Same rationale as the guard check above:
  // Node checking Node, run here so it rides the pinned Repository Hygiene
  // job instead of a new required check.
  step("node", ["scripts/check-release-environment.mjs", "--selftest"], "."),
  step("node", ["scripts/check-release-environment.mjs"], "."),
];

const TASKS = {
  bootstrap: [
    step("npm", ["ci"], "."),
    step("npm", ["ci"], "Client"),
    step("npm", ["ci"], "tools/mcp-introspect"),
  ],
  "check:server": CHECK_SERVER,
  "check:client": CHECK_CLIENT,
  "check:rust": CHECK_RUST,
  "check:docs": CHECK_DOCS,
  "check:hygiene": CHECK_HYGIENE,
  check: [...CHECK_DOCS, ...CHECK_HYGIENE, ...CHECK_SERVER, ...CHECK_CLIENT, ...CHECK_RUST],
  generate: [
    step("go", ["run", "./cmd/genprotocol"], "Server"),
    optional(
      "sqlc",
      "sqlc",
      ["generate"],
      "Server",
      "sqlc not on PATH — install the version in Server/sqlc.version",
    ),
    // After sqlc: gendocs compiles the api package, which imports db/dbgen.
    step("go", ["run", "-tags", "otel,wazero", "./cmd/gendocs"], "Server"),
  ],
  format: [
    step("npx", ["prettier", "--write", "."], "."),
    optional("gofmt", "gofmt", ["-w", "."], "Server", "gofmt not on PATH"),
    step("cargo", ["fmt", "--all"], "Client/src-tauri"),
  ],
  "release:preflight": [
    ...CHECK_DOCS,
    ...CHECK_HYGIENE,
    ...CHECK_SERVER,
    ...CHECK_CLIENT,
    ...CHECK_RUST,
    step("npm", ["run", "build"], "Client"),
  ],
};

// Resolve against PATH directly instead of shelling out to `where`/`command`.
// Both probes were unreliable: `where.exe` lives in C:\WINDOWS\System32, which a
// Git Bash PATH does not always contain (it can carry only the subdirectories),
// and a probe that cannot start reports "not installed" for a tool that is. That
// turned every optional() step into a permanent SKIP on Windows.
function onPath(cmd) {
  const exts = WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = (process.env.PATH || "").split(WIN ? ";" : ":");
  return dirs.some((dir) => dir && exts.some((ext) => existsSync(join(dir, cmd + ext))));
}

function runTask(name) {
  const steps = TASKS[name];
  if (!steps) {
    console.error(`unknown task: ${name}\nknown: ${Object.keys(TASKS).join(", ")}`);
    process.exit(2);
  }
  const skipped = [];
  for (const s of steps) {
    if (s.probe && !onPath(s.probe)) {
      console.log(`\n--- SKIP  ${s.cmd} ${s.args.join(" ")}  (${s.why})`);
      skipped.push(s.probe);
      continue;
    }
    const where = s.cwd === "." ? "" : `  [in ${s.cwd}]`;
    console.log(`\n--- ${s.cmd} ${s.args.join(" ")}${where}`);
    // With shell:true Node deprecates a separate args array (DEP0190), because it
    // concatenates without escaping. So concatenate deliberately instead: the only
    // commands that take this branch are the npm shims, and no argument in this
    // file contains a space.
    const shell = needsShell(s.cmd);
    const r = shell
      ? spawnSync([bin(s.cmd), ...s.args].join(" "), {
          cwd: join(ROOT, s.cwd),
          stdio: "inherit",
          shell: true,
        })
      : spawnSync(s.cmd, s.args, {
          cwd: join(ROOT, s.cwd),
          stdio: "inherit",
          shell: false,
        });
    if (r.error && r.error.code !== "ENOENT") {
      console.error(`\nFAILED: ${s.cmd} could not be started: ${r.error.code}`);
      process.exit(1);
    }
    if (r.error && r.error.code === "ENOENT") {
      console.error(`\nFAILED: ${s.cmd} is not installed or not on PATH.`);
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`\nFAILED: ${s.cmd} ${s.args.join(" ")}${where} exited ${r.status}`);
      process.exit(r.status ?? 1);
    }
  }
  if (skipped.length) {
    console.log(
      `\n${name}: passed, with ${[...new Set(skipped)].join(", ")} skipped (not installed). CI runs them.`,
    );
  } else {
    console.log(`\n${name}: passed`);
  }
}

const arg = process.argv[2];
if (!arg || arg === "--list") {
  for (const [name, steps] of Object.entries(TASKS)) {
    console.log(`\n${name}`);
    for (const s of steps) {
      const where = s.cwd === "." ? "" : `   (in ${s.cwd})`;
      console.log(`  ${s.probe ? "[optional] " : ""}${s.cmd} ${s.args.join(" ")}${where}`);
    }
  }
  console.log("");
  process.exit(0);
}
if (!existsSync(join(ROOT, "Server")) || !existsSync(join(ROOT, "Client"))) {
  console.error("run this from the repository root");
  process.exit(2);
}
runTask(arg);
