import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditQuarantine, quarantinePattern } from "./check-quarantine.mjs";

const TODAY = new Date("2026-09-28T00:00:00Z");

/** A valid entry; each test mutates one field. */
const entry = (over = {}) => ({
  file: "tests/e2e/native/native-extra.spec.ts",
  title: "F5 and Ctrl+R never reload the app and a release build opens no DevTools",
  reason: "Windows/WebView2 only race.",
  owner: "ci",
  added: "2026-09-28",
  expires: "2026-12-31",
  ...over,
});

const SPEC = "tests/e2e/native/native-extra.spec.ts";
const files = new Map([
  [
    SPEC,
    'test("F5 and Ctrl+R never reload the app and a release build opens no DevTools", async () => {});',
  ],
]);

const audit = (entries, { today = TODAY, fileMap = files } = {}) =>
  auditQuarantine({ entries, today, readFile: (p) => fileMap.get(p) });

test("a well-formed, unexpired, present entry passes", () => {
  assert.deepEqual(audit([entry()]), []);
});

test("an empty quarantine passes", () => {
  assert.deepEqual(audit([]), []);
});

test("a missing required field is reported", () => {
  const out = audit([entry({ owner: undefined })]);
  assert.equal(out.length, 1);
  assert.match(out[0], /owner/);
});

test("an unparseable date is reported", () => {
  const out = audit([entry({ expires: "soon" })]);
  assert.match(out[0], /expires/);
});

test("expiry in the past is reported as expired", () => {
  const out = audit([entry({ expires: "2026-09-27" })]);
  assert.match(out[0], /expired/);
});

test("an expiry on today is not yet stale", () => {
  assert.deepEqual(audit([entry({ expires: "2026-09-28" })]), []);
});

test("an entry whose spec file does not exist is reported", () => {
  const out = audit([entry({ file: "tests/e2e/native/gone.spec.ts" })]);
  assert.match(out[0], /gone\.spec\.ts/);
});

test("an entry whose title is not in the named file is reported", () => {
  const out = audit([entry({ title: "a test that was renamed" })]);
  assert.match(out[0], /renamed/);
});

test("a duplicate (file, title) pair is reported", () => {
  const out = audit([entry(), entry()]);
  assert.equal(out.length, 1);
  assert.match(out[0], /duplicate/i);
});

test("the pattern matches the quarantined test and escapes regex metacharacters", () => {
  const re = quarantinePattern([entry({ title: "a (weird) title [1] + more" })]);
  assert.ok(re.test("tests/e2e/native/native-extra.spec.ts:287:1 › a (weird) title [1] + more"));
  assert.ok(!re.test("tests/e2e/native/native-extra.spec.ts:287:1 › a different test"));
});

test("an empty list yields no pattern", () => {
  assert.equal(quarantinePattern([]), undefined);
});
