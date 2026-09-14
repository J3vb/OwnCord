#!/usr/bin/env node
// Fail when a release.yml job that publishes something (pushes an image, cuts
// a GitHub Release) carries no `environment: release`, and so runs with no
// required-reviewer approval (R-09 / docs/plans/b1-release-tag-protection.sh).
//
//   node scripts/check-release-environment.mjs
//   node --test scripts/check-release-environment.test.mjs
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

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
