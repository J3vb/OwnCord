import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluate, releaseRows, STATUS_PATH } from "./verify-release-status.mjs";

const fixture = `# Project status

## Current release

**v2.2.0-beta.3**. The next one is v2.2.0-beta.4.

## Releases

| Version | Date | What it brought |
| --- | --- | --- |
| v2.2.0-beta.3 | 2026-10-11 | Things. |
| \`v2.2.0-beta.1\` | 2026-10-07 | Things. |

## Roadmap

| v9.9.9 | not a release row |
`;

test("a version with a Releases row passes", () => {
  const { ok, lines } = evaluate(fixture, "v2.2.0-beta.3");
  assert.ok(ok);
  assert.match(lines[0], /v2\.2\.0-beta\.3 is recorded/);
});

test("the version is accepted with or without its v, and in backticks", () => {
  assert.ok(evaluate(fixture, "2.2.0-beta.3").ok);
  assert.ok(evaluate(fixture, "v2.2.0-beta.1").ok);
});

test("a missing version fails and says how to fix it", () => {
  const { ok, lines } = evaluate(fixture, "v2.2.0-beta.2");
  assert.ok(!ok);
  assert.match(lines[0], /^::error::v2\.2\.0-beta\.2 has no row/);
});

test("a mention outside the Releases table does not count", () => {
  assert.ok(!evaluate(fixture, "v2.2.0-beta.4").ok);
  assert.ok(!evaluate(fixture, "v9.9.9").ok);
});

test("a prefix of a recorded version does not count", () => {
  assert.ok(!evaluate(fixture, "v2.2.0-beta").ok);
  assert.ok(!evaluate(fixture.replace("beta.3 |", "beta.30 |"), "v2.2.0-beta.3").ok);
});

test("no version given fails", () => {
  assert.ok(!evaluate(fixture, "").ok);
  assert.ok(!evaluate(fixture, undefined).ok);
});

test("a file without a Releases table fails rather than passing everything", () => {
  const { ok, lines } = evaluate("# Project status\n", "v2.2.0-beta.3");
  assert.ok(!ok);
  assert.match(lines[0], /no Releases table rows/);
});

test("the real docs/STATUS.md parses and records the current release", () => {
  const rows = releaseRows(readFileSync(STATUS_PATH, "utf8"));
  assert.ok(rows.length > 0);
  const manifest = JSON.parse(
    readFileSync(new URL("../../Client/package.json", import.meta.url), "utf8"),
  );
  assert.ok(
    rows.includes(manifest.version),
    `docs/STATUS.md has no Releases row for the client version ${manifest.version}`,
  );
});
