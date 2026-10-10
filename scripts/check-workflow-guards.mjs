#!/usr/bin/env node
// Fail when a workflow that consumes a metered credential loses one of its
// guards (L-16).
//
//   node scripts/check-workflow-guards.mjs
//   node --test scripts/check-workflow-guards.test.mjs
//
// Why this exists rather than trusting review: the guards below are three lines
// in a YAML file that nothing else verifies. actionlint checks expression
// syntax and action inputs — it has no concept of authorization or of cost, and
// `if: contains(...)` is valid input to it whatever the expression says. A
// dependency the guards rely on can also be updated by a routine bump, so the
// repository asserts its own invariants here instead of inheriting them.
//
// Deliberately text-level, not YAML-parsed: there is no YAML parser among the
// root devDependencies, and adding one to assert "this file contains a
// timeout-minutes key" would be a dependency bought for a substring search. The
// cost is that these checks are about presence and shape, not semantics — which
// is the honest limit of what a regression test can claim here.
//
// Scope: workflows that reference a metered secret. Add one to METERED below
// when a new workflow starts spending. Separately, every workflow is checked
// for a reference to the updater signing key, which only release.yml may hold.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Workflows whose runs consume a metered credential, and therefore must carry
// every guard in CHECKS. An unlisted workflow is not checked.
const METERED = [".github/workflows/claude.yml"];

// Each check is (name, test, why). `why` is the failure message: it states the
// invariant a contributor has to restore, not the history behind it.
// The text of each job under `jobs:` that tests github.actor. Concurrency must
// live in that block: a workflow-level group, or one on another job, is joined
// by runs the actor condition skips and can cancel a live run.
const gatedJobs = (src) =>
  (src.split(/^jobs:\s*$/m)[1] ?? "")
    .split(/^(?=  [\w-]+:\s*$)/m)
    .filter((job) => /github\.actor/.test(job));

// The indented body of a gated job's own `concurrency:` mapping, so a `group` or
// `cancel-in-progress` key elsewhere in the job (an env, a step) cannot satisfy it.
const concurrencyBlocks = (src) =>
  gatedJobs(src).map((job) => job.match(/^ {4}concurrency:\s*\n((?: {5,}\S.*\n?)*)/m)?.[1] ?? "");

// At least one gated job, and every one of them must pass.
const gatedAll = (blocks, test) => blocks.length > 0 && blocks.every(test);

export const CHECKS = [
  {
    name: "timeout-minutes",
    test: (src) => /^\s*timeout-minutes:\s*\d+\s*$/m.test(src),
    why: "a workflow consuming a metered credential must declare timeout-minutes; without one it inherits GitHub's 360-minute default",
  },
  {
    name: "concurrency group",
    test: (src) => gatedAll(concurrencyBlocks(src), (b) => /^\s*group:\s*\S/m.test(b)),
    why: "a workflow consuming a metered credential must declare a concurrency group so repeated triggers collapse instead of running in parallel",
  },
  {
    name: "cancel-in-progress",
    test: (src) =>
      gatedAll(concurrencyBlocks(src), (b) => /^\s*cancel-in-progress:\s*true\s*$/m.test(b)),
    why: "the concurrency group must set cancel-in-progress: true, or superseded runs keep spending",
  },
  {
    name: "actor allowlist",
    // The job condition must test who triggered the run, not only what the
    // trigger text says. A content-only condition is satisfied by anyone.
    test: (src) => /github\.actor/.test(src) && /\bif:/.test(src),
    why: "the job condition must constrain github.actor, not only the trigger text — a content-only condition places no limit on who can start a run",
  },
];

export function auditWorkflow(src) {
  return CHECKS.filter((c) => !c.test(src)).map((c) => ({ name: c.name, why: c.why }));
}

// The updater signing key (and its password) is handed to release.yml only.
// Any other workflow that references it hands the key every client trusts to
// build steps a pull request controls.
const SIGNING_KEY_HOLDER = "release.yml";

export function signingKeyHolders(workflows) {
  return workflows
    .filter(({ name, src }) => name !== SIGNING_KEY_HOLDER && /TAURI_SIGNING_PRIVATE_KEY/.test(src))
    .map(({ name }) => name);
}

// e2e-auto-confirm skips the native certificate-pin confirmation dialog. Only
// ci.yml's native E2E build may enable it; shipped builds (release, nightly,
// artifact smoke) must keep the dialog.
const AUTO_CONFIRM_HOLDER = "ci.yml";

export function autoConfirmEnablers(workflows) {
  return workflows
    .filter(({ name, src }) => name !== AUTO_CONFIRM_HOLDER && /e2e-auto-confirm/.test(src))
    .map(({ name }) => name);
}

export function autoConfirmIsDefault(cargoSrc) {
  return /^default\s*=\s*\[[^\]]*e2e-auto-confirm/m.test(cargoSrc);
}

// The Linux client links gstreamer-rs for native camera capture, whose -sys
// crates probe pkg-config at build time. An apt install that sets up a Tauri
// build (it lists libwebkit2gtk-4.1-dev) without these fails the build.
const GSTREAMER_BUILD_DEPS = ["libgstreamer1.0-dev", "libgstreamer-plugins-base1.0-dev"];

export function gstreamerBuildDepsMissing(workflows) {
  return workflows
    .filter(({ src }) =>
      // One install command: from `apt-get install` through its `\` continuations.
      (src.match(/apt-get install(?:[^\n]*\\\n)*[^\n]*/g) ?? []).some(
        (cmd) =>
          /\blibwebkit2gtk-4\.1-dev\b/.test(cmd) &&
          !GSTREAMER_BUILD_DEPS.every((dep) => cmd.includes(dep)),
      ),
    )
    .map(({ name }) => name);
}

function main() {
  const failures = [];

  for (const rel of METERED) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) {
      failures.push(
        `${rel}: listed in METERED but does not exist — fix the list in ${"scripts/check-workflow-guards.mjs"}`,
      );
      continue;
    }
    const src = readFileSync(p, "utf8");
    for (const { name, why } of auditWorkflow(src)) {
      failures.push(`${rel}: missing ${name} — ${why}`);
    }
  }

  const workflowsDir = join(ROOT, ".github/workflows");
  const workflows = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, src: readFileSync(join(workflowsDir, name), "utf8") }));
  for (const name of signingKeyHolders(workflows)) {
    failures.push(
      `.github/workflows/${name}: references the updater signing key — only ${SIGNING_KEY_HOLDER} may sign; build unsigned elsewhere`,
    );
  }

  for (const name of autoConfirmEnablers(workflows)) {
    failures.push(
      `.github/workflows/${name}: enables e2e-auto-confirm — only ${AUTO_CONFIRM_HOLDER} may; shipped builds must keep the native cert-pin dialog`,
    );
  }
  for (const name of gstreamerBuildDepsMissing(workflows)) {
    failures.push(
      `.github/workflows/${name}: installs Tauri's Linux build deps without ${GSTREAMER_BUILD_DEPS.join(" and ")} — the client's gstreamer-sys build needs them`,
    );
  }
  const cargo = "Client/src-tauri/Cargo.toml";
  if (autoConfirmIsDefault(readFileSync(join(ROOT, cargo), "utf8"))) {
    failures.push(
      `${cargo}: e2e-auto-confirm is in the default features — shipped builds would skip the cert-pin dialog`,
    );
  }

  if (failures.length) {
    console.error(`\n${failures.length} workflow guard(s) missing:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nThese guards bound who can start a metered run, how long it may last, which workflow may sign updates, and what a Linux client build installs.",
    );
    process.exit(1);
  }
  console.log(
    `${CHECKS.length} guard(s) present in ${METERED.length} metered workflow(s): ${METERED.join(", ")}`,
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
