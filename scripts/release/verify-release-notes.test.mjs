import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHANGELOG_PATH,
  evaluate,
  knownIssueBullets,
  releaseSection,
} from "./verify-release-notes.mjs";

const fixture = `# Changelog

## Unreleased

## v2.10.0 — A title

Intro.

### Fixed

- Something.

### Known issues

- **One thing** still breaks.
- Another.

### Under the hood

- Internal.

## v2.9.2

### Fixed

- A fix.

### Under the hood

- Internal.

## v2.9.1

### Known issues

### Under the hood

- Internal.

## v2.9.0

### Fixed

- Shipped without the list.
`;

test("a section with Known issues bullets passes, with or without the v", () => {
  const { ok, lines } = evaluate(fixture, "v2.10.0");
  assert.ok(ok);
  assert.match(lines[0], /lists 2 known issue/);
  assert.ok(evaluate(fixture, "2.10.0").ok);
});

test("bullets under a later heading do not count as known issues", () => {
  const section = releaseSection(fixture, "v2.10.0");
  assert.deepEqual(knownIssueBullets(section), ["- **One thing** still breaks.", "- Another."]);
});

test("a section without the heading fails and says how to fix it", () => {
  const { ok, lines } = evaluate(fixture, "v2.9.2");
  assert.ok(!ok);
  assert.match(lines[0], /^::error::the v2\.9\.2 section .* no '### Known issues' heading/);
  assert.match(lines[1], /one bullet that says so/);
});

test("a heading with no bullets under it fails", () => {
  const { ok, lines } = evaluate(fixture, "v2.9.1");
  assert.ok(!ok);
  assert.match(lines[0], /is empty/);
});

test("a missing section fails", () => {
  const { ok, lines } = evaluate(fixture, "v2.11.0");
  assert.ok(!ok);
  assert.match(lines[0], /no '## v2\.11\.0' section/);
});

test("a tag is matched as a whole word, not a prefix", () => {
  assert.ok(!evaluate(fixture.replace("## v2.10.0 — A title", "## v2.10.0-rc"), "v2.10.0").ok);
});

test("2.9.0 and older shipped before the rule and are not checked", () => {
  const { ok, lines } = evaluate(fixture, "v2.9.0");
  assert.ok(ok);
  assert.match(lines[0], /not checked/);
  assert.ok(evaluate(fixture, "v2.5.0").ok);
  assert.ok(evaluate(fixture, "v1.2.0-alpha.4").ok);
});

test("no version, or not a version, fails", () => {
  assert.ok(!evaluate(fixture, "").ok);
  assert.ok(!evaluate(fixture, undefined).ok);
  assert.ok(!evaluate(fixture, "latest").ok);
});

test("the real CHANGELOG.md has an Unreleased Known issues list ready for the next release", () => {
  const section = releaseSection(readFileSync(CHANGELOG_PATH, "utf8"), "Unreleased");
  assert.ok(section, "CHANGELOG.md has no '## Unreleased' section");
  const bullets = knownIssueBullets(section);
  assert.ok(bullets && bullets.length > 0, "Unreleased has no Known issues bullets");
});
