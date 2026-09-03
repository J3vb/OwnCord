#!/usr/bin/env node
// Fail when a release.yml job that publishes something (pushes an image, cuts
// a GitHub Release) carries no `environment: release`, and so runs with no
// required-reviewer approval (R-09 / docs/plans/b1-release-tag-protection.sh).
//
//   node scripts/check-release-environment.mjs
//   node scripts/check-release-environment.mjs --selftest
//
// Deliberately text-level, not YAML-parsed — same tradeoff as
// scripts/check-workflow-guards.mjs: no YAML parser among the root
// devDependencies, and this is a presence/shape check, not full semantics.
//
// Gated jobs are DERIVED from the file (any job block containing `push: true`
// or `gh release create`), not read off a hardcoded job-name list. A hardcoded
// list only ever closes the instance: the next job that starts publishing
// something passes silently until someone remembers to add its name here too
// — which is exactly the shape of the gap this script exists to close.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_WORKFLOW = ".github/workflows/release.yml";

// A job block publishes something if its body does either of these. Extend
// this list, not a job-name list, when a new publish action shows up.
const PUBLISH_MARKERS = [/^\s*push:\s*true\s*$/m, /gh release create/];

// `environment: release`, scalar or mapping form — a later `url:` under the
// mapping form must not trip a false failure, so this only requires the name.
const ENV_RELEASE = /^\s*environment:\s*release\s*$/m;
const ENV_RELEASE_MAPPING = /^\s*environment:\s*\n\s*name:\s*release\s*$/m;

// Splits the `jobs:` map into { name, body } blocks by top-level (2-space)
// job keys, the same indentation contract every job in this file already
// follows.
export function splitJobs(src) {
  const lines = src.split("\n");
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) throw new Error(`no top-level "jobs:" key found`);

  const jobs = [];
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const head = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (head) {
      current = { name: head[1], body: [] };
      jobs.push(current);
      continue;
    }
    // A non-indented, non-blank line ends the jobs map (e.g. a later
    // top-level key in the workflow file).
    if (line.length && !/^\s/.test(line)) break;
    if (current) current.body.push(line);
  }
  return jobs.map((j) => ({ name: j.name, body: j.body.join("\n") }));
}

export function publishesSomething(body) {
  return PUBLISH_MARKERS.some((re) => re.test(body));
}

export function hasReleaseEnvironment(body) {
  return ENV_RELEASE.test(body) || ENV_RELEASE_MAPPING.test(body);
}

// Returns the gated jobs missing `environment: release`, as {name} objects.
export function auditReleaseEnvironment(src) {
  return splitJobs(src)
    .filter((j) => publishesSomething(j.body))
    .filter((j) => !hasReleaseEnvironment(j.body))
    .map((j) => ({ name: j.name }));
}

function main() {
  const path = join(ROOT, RELEASE_WORKFLOW);
  const src = readFileSync(path, "utf8");
  const missing = auditReleaseEnvironment(src);

  if (missing.length) {
    console.error(`\n${missing.length} release job(s) publish with no required-reviewer gate:\n`);
    for (const { name } of missing) {
      console.error(
        `  ${name}: pushes an image or creates a release but declares no ` +
          `\`environment: release\` in ${RELEASE_WORKFLOW}`,
      );
    }
    console.error(
      `\nAdd \`environment: release\` to the job (see the \`publish\` job in ` +
        `${RELEASE_WORKFLOW} for the pattern and its comment) so the run stops ` +
        `for required-reviewer approval before it publishes. Without it, a tag ` +
        `push ships to the public with no human in the loop.`,
    );
    process.exit(1);
  }
  console.log(`release environment gate: every publishing job in ${RELEASE_WORKFLOW} is guarded`);
}

function selftest() {
  let failed = 0;
  const assert = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
    if (!cond) failed++;
  };

  const workflow = (jobsSrc) => `name: X\n\non:\n  push:\n    tags: ["v*"]\n\njobs:\n${jobsSrc}`;

  const guardedScalar = workflow(
    [
      "  release-server-docker:",
      "    needs: verify-versions",
      "    environment: release",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: docker build",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  assert(auditReleaseEnvironment(guardedScalar).length === 0, "a guarded push job reports nothing");

  const unguardedScalar = workflow(
    [
      "  release-server-docker:",
      "    needs: verify-versions",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  const missingScalar = auditReleaseEnvironment(unguardedScalar);
  assert(
    missingScalar.length === 1 && missingScalar[0].name === "release-server-docker",
    "an unguarded push: true job is caught by name",
  );

  const unguardedGhRelease = workflow(
    [
      "  publish:",
      "    needs: [release-server-docker]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: gh release create ${{ github.ref_name }} assets/*",
    ].join("\n"),
  );
  assert(
    auditReleaseEnvironment(unguardedGhRelease)
      .map((j) => j.name)
      .includes("publish"),
    "an unguarded gh release create job is caught",
  );

  // Item (d) from the review: the audit must derive gated jobs from the file,
  // not from a hardcoded job-name list, so a THIRD, never-before-seen
  // publishing job is caught by its content alone.
  const newPublishJob = workflow(
    [
      "  release-npm-package:",
      "    needs: [verify-versions]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  assert(
    auditReleaseEnvironment(newPublishJob)
      .map((j) => j.name)
      .includes("release-npm-package"),
    "a newly-added publishing job with no environment is caught, not just the two known job names",
  );

  // Item (e): the mapping form (`environment:` / `  name: release`) must not
  // false-positive just because a later reviewer adds a `url:` under it.
  const mappingForm = workflow(
    [
      "  release-server-docker:",
      "    needs: verify-versions",
      "    environment:",
      "      name: release",
      "      url: https://ghcr.io",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  assert(
    auditReleaseEnvironment(mappingForm).length === 0,
    "the mapping environment form is accepted",
  );

  // A job that neither pushes nor releases (e.g. release-server, which only
  // uploads a build artifact) is never gated — it has nothing to approve.
  const nonPublishJob = workflow(
    [
      "  release-server:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/upload-artifact@v4",
    ].join("\n"),
  );
  assert(
    auditReleaseEnvironment(nonPublishJob).length === 0,
    "a job that only uploads a build artifact is not gated",
  );

  // Proof this check would have caught the collateral damage from the
  // rejected first attempt: a duplicated `environment:` key is still exactly
  // one gate per job, so the audit reports it fine — the failure that patch
  // caused is a YAML syntax error, which is actionlint's job, not this
  // script's. This assertion documents that boundary rather than pretending
  // to cover it.
  const duplicateEnvironmentKey = workflow(
    [
      "  publish:",
      "    needs: [release-server-docker]",
      "    environment: release",
      "    environment: release",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: gh release create ${{ github.ref_name }} assets/*",
    ].join("\n"),
  );
  assert(
    auditReleaseEnvironment(duplicateEnvironmentKey).length === 0,
    "a duplicated environment key still reads as present here — actionlint's syntax-check catches the duplicate, not this content-level audit",
  );

  console.log(
    failed ? `\nselftest: ${failed} assertion(s) failed` : "\nselftest: all assertions pass",
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();
else main();
