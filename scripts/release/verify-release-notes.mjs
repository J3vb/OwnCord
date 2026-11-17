#!/usr/bin/env node
// Fail the release when the tag's CHANGELOG.md section has no Known issues list.
//
//   node scripts/release/verify-release-notes.mjs v2.9.1
//   node --test scripts/release/verify-release-notes.test.mjs
//
// Every release up to 2.5.0 told users what still did not work. From 2.6.0 on
// the section quietly went missing: the rule lived only in the "How to write
// an entry" notes, and nothing read the notes before they became the GitHub
// release page. This ties the two together. The section must carry a
// `### Known issues` heading with at least one bullet under it; a release with
// nothing to report says so in a bullet, so the absence is a decision rather
// than an oversight.
//
// Releases up to and including 2.9.0 shipped before the rule came back and are
// not judged. A script rather than a `run:` block for the reason
// verify-gate-evidence.mjs gives: a step that exists only in release.yml first
// executes at tag time. ci.yml runs the test file on every pull request.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHANGELOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "CHANGELOG.md",
);

// The last release that shipped without the rule. Anything newer is checked.
export const FIRST_UNCHECKED_AFTER = [2, 9, 0];

// releaseSection returns the lines under `## <tag>` up to the next `## `
// heading, matching release.yml's extraction: the tag as a whole word, with an
// optional title after a space. null when the heading is missing.
export function releaseSection(markdown, tag) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `## ${tag}` || l.startsWith(`## ${tag} `));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

// knownIssueBullets returns the bullet lines under `### Known issues`, up to
// the next heading of level three or higher. null when the heading is missing.
export function knownIssueBullets(sectionLines) {
  const start = sectionLines.findIndex((l) => /^###\s+Known issues\s*$/.test(l));
  if (start === -1) return null;
  const bullets = [];
  for (const line of sectionLines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    if (/^[-*]\s+\S/.test(line)) bullets.push(line);
  }
  return bullets;
}

function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isAfterCutoff(parts) {
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== FIRST_UNCHECKED_AFTER[i]) return parts[i] > FIRST_UNCHECKED_AFTER[i];
  }
  return false;
}

// evaluate decides on CHANGELOG.md's text and the version being tagged (with
// or without its `v`). It returns the lines to print and whether the release
// may go ahead.
export function evaluate(markdown, version) {
  const wanted = String(version ?? "")
    .trim()
    .replace(/^v/, "");
  const parts = parseVersion(wanted);
  if (!parts) {
    return { ok: false, lines: [`::error::not a release version: '${version ?? ""}'`] };
  }
  const tag = `v${wanted}`;
  if (!isAfterCutoff(parts)) {
    return {
      ok: true,
      lines: [`${tag} shipped before the Known issues rule came back; not checked`],
    };
  }
  const section = releaseSection(markdown, tag);
  if (section === null) {
    return { ok: false, lines: [`::error::CHANGELOG.md has no '## ${tag}' section`] };
  }
  const bullets = knownIssueBullets(section);
  if (bullets === null) {
    return {
      ok: false,
      lines: [
        `::error::the ${tag} section of CHANGELOG.md has no '### Known issues' heading`,
        "Add it before Under the hood, as docs/maintainers.md step 3 describes. With nothing to report, write one bullet that says so.",
      ],
    };
  }
  if (bullets.length === 0) {
    return {
      ok: false,
      lines: [
        `::error::the Known issues list of ${tag} in CHANGELOG.md is empty`,
        "List at least one item, or one bullet saying no issues are known.",
      ],
    };
  }
  return {
    ok: true,
    lines: [`${tag} lists ${bullets.length} known issue(s) in CHANGELOG.md`],
  };
}

function main() {
  const version = process.argv[2] ?? process.env.RELEASE_TAG;
  const { ok, lines } = evaluate(readFileSync(CHANGELOG_PATH, "utf8"), version);
  for (const line of lines) console.log(line);
  if (!ok) process.exit(1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
