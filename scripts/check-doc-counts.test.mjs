import { strict as assert } from "node:assert";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tally, claimsIn } from "./check-doc-counts.mjs";

test("tally counts by status and total", () => {
  const t = tally({ findings: [{ status: "open" }, { status: "open" }, { status: "fixed" }] });
  assert.equal(t.open, 2);
  assert.equal(t.fixed, 1);
  assert.equal(t.total, 3);
});

test("a declared-but-unused status counts 0, not undefined", () => {
  const t = tally({ findings: [{ status: "open" }, { status: "open" }, { status: "fixed" }] });
  assert.equal(t.refuted, 0);
});

const has = (s, kind, value) => claimsIn(s).some((x) => x.kind === kind && x.value === value);

test("enumeration: reads each pair", () => {
  assert.ok(has("Ledger: **306 fixed / 38 open / 3 declined / 1 duplicate = 348**.", "open", 38));
});

test("enumeration: reads the = total", () => {
  assert.ok(has("Ledger: **306 fixed / 38 open / 3 declined / 1 duplicate = 348**.", "total", 348));
});

test("enumeration: FINDINGS.md header shape", () => {
  assert.ok(has("**38 open** · 0 blocked · 306 fixed · 3 declined", "fixed", 306));
});

test("status table with a Total row", () => {
  assert.ok(has("| open | **38** |\n| **Total** | **348** |", "open", 38));
});

test('"N records" near a ledger mention', () => {
  assert.ok(has("the ledger holds\n348 records", "total", 348));
});

// The false positives that made a looser version unusable.
test('a lone "45 open" is not a ledger claim', () => {
  assert.equal(claimsIn("The 45 open P1 rows are tracked in the register.").length, 0);
});

test("a different register is not a ledger claim", () => {
  assert.equal(claimsIn("| All 8 findings F1-F8 closed |").length, 0);
});

test('"G-05 refuted" is an id, not a count', () => {
  assert.equal(
    claimsIn("| `golangci-lint` | claimed broken (G-05) | G-05 **refuted** |").length,
    0,
  );
});

test('">=20" is not a count', () => {
  assert.equal(claimsIn('`tools/mcp-introspect/package.json` (`">=20"`)').length, 0);
});

test("a version string is not a count", () => {
  assert.equal(claimsIn('go build -ldflags "-X main.version=1.2.0-alpha.3"').length, 0);
});

test("severities are not statuses", () => {
  assert.equal(claimsIn("11 medium, 27 low").length, 0);
});

test("a bare number is not a claim", () => {
  assert.equal(claimsIn("22 sit under Client/").length, 0);
});

test('"N records" without ledger context is ignored', () => {
  assert.equal(claimsIn("348 records in some unrelated table").length, 0);
});

// Exercise the real CLI and its allow-list without editing this checkout's
// ledger or evidence. Parser-only tests cannot detect a dated file being watched.
const CURRENT = [
  "docs/README.md",
  "docs/plans/README.md",
  "docs/plans/repo-health-issue-register-2026-08-23.md",
  "CLAUDE.md",
  "README.md",
];
const DATED = [
  "docs/plans/b0-baseline-2026-08-25.md",
  "docs/plans/b1-repository-foundation-2026-08-25.md",
  "docs/plans/hp-0-scorecard-2026-08-25.md",
  "docs/plans/hp-1-scorecard-2026-08-27.md",
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "owncord-doc-counts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write("scripts/check-doc-counts.mjs", "");
  copyFileSync(
    new URL("./check-doc-counts.mjs", import.meta.url),
    join(root, "scripts/check-doc-counts.mjs"),
  );
  const ledger = { findings: [{ status: "fixed" }, { status: "open" }] };
  const writeLedger = () => write(".superpowers/findings-ledger.json", JSON.stringify(ledger));
  writeLedger();
  for (const rel of CURRENT) write(rel, "Current ledger: 1 fixed / 1 open = 2\n");
  for (const rel of DATED) write(rel, "Measured 2026-08-25: 1 fixed / 1 open = 2\n");
  const run = () =>
    spawnSync(process.execPath, [join(root, "scripts/check-doc-counts.mjs")], { encoding: "utf8" });
  return { root, write, ledger, writeLedger, run };
}

test("ledger changes require only current summaries to change, never dated evidence", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const before = DATED.map((rel) => readFileSync(join(f.root, rel), "utf8"));

  // Cover both a status transition and a new record (the total changes too).
  f.ledger.findings[1].status = "fixed";
  f.ledger.findings.push({ status: "open" });
  f.writeLedger();
  for (const rel of CURRENT) f.write(rel, "Current ledger: 2 fixed / 1 open = 3\n");

  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    DATED.map((rel) => readFileSync(join(f.root, rel), "utf8")),
    before,
  );
});

for (const rel of CURRENT) {
  test(`an incorrect current summary still fails: ${rel}`, (t) => {
    const f = fixture(t);
    f.write(rel, "Current ledger: 0 fixed / 2 open = 2\n");
    const result = f.run();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${rel}:1`), result.stderr);
    assert.match(result.stderr, /ledger says fixed = 1/);
    assert.match(result.stderr, /ledger says open = 1/);
  });
}

test("an incorrect current status table total still fails", (t) => {
  const f = fixture(t);
  f.write(CURRENT[2], "| fixed | 1 |\n| open | 1 |\n| Total | 3 |\n");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ledger says total = 2/);
});

test("a missing current summary still fails closed", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, CURRENT[1]));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/plans\/README\.md: watched file does not exist/);
});
