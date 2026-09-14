import { strict as assert } from "node:assert";
import { test } from "node:test";
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
