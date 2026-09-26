import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditNameStatus, auditNumbering, renumber } from "./check-migrations.mjs";

const MIGRATIONS = "Server/migrations";
const names = (out) => auditNameStatus(out).map((v) => `${v.path}:${v.what}`);

test("adding a new migration is what this check asks for, and passes", () => {
  assert.equal(
    auditNameStatus(`A\t${MIGRATIONS}/044_retention_purge_pending_backfill.sql`).length,
    0,
  );
});

// The two real incidents, as the name-status lines their commits produce.
// 15ba7c9a rewrote 039_retention.sql fifty minutes after 607fd4d7 shipped
// it, which is OC-0395.
test("the 039 rewrite that cost retention_runs.purge_pending is caught", () => {
  assert.ok(
    names(`M\t${MIGRATIONS}/039_retention.sql`).includes(
      `${MIGRATIONS}/039_retention.sql:modified`,
    ),
  );
});

// 25449eb2 changed the Member permission bitmask seeded by
// 001_initial_schema.sql, four months before alpha.1.
test("the 001 permission-bitmask rewrite is caught", () => {
  assert.equal(names(`M\t${MIGRATIONS}/001_initial_schema.sql`).length, 1);
});

// 5aa216d9's whitespace-only edit to 003_audit_log.sql is caught too: git
// reports it as M, and this check does not read the content.
test("a whitespace-only edit is caught, because git cannot tell us it was harmless", () => {
  assert.equal(names(`M\t${MIGRATIONS}/003_audit_log.sql`).length, 1);
});

test("deleting a shipped migration is caught", () => {
  assert.ok(names(`D\t${MIGRATIONS}/029_drop_sounds_table.sql`)[0]?.endsWith(":deleted"));
});

test("renaming a shipped migration is caught", () => {
  assert.equal(
    auditNameStatus(`R096\t${MIGRATIONS}/039_retention.sql\t${MIGRATIONS}/039_retention_v2.sql`)[0]
      ?.what,
    "renamed",
  );
});

// Shapes that must NOT trip it.
test("the embed file next to the migrations is not a migration", () => {
  assert.equal(auditNameStatus(`M\t${MIGRATIONS}/migrations.go`).length, 0);
});

test("a sqlc query file outside Server/migrations is not a migration", () => {
  assert.equal(auditNameStatus("M\tServer/db/queries/messages.sql").length, 0);
});

test("an empty diff reports nothing", () => {
  assert.equal(auditNameStatus("").length, 0);
});

// --- numbering (OC-0414) ---
const base037 = ["035_a.sql", "036_b.sql", "037_erasure_jobs.sql"].map((n) => `${MIGRATIONS}/${n}`);

// The real incident: PR #1517 added 040 when the base branch ended at 037,
// leaving 038 and 039 to be allocated by later PRs and applied after it on
// any server that upgraded in between.
test("a migration numbered past the end of the base is caught", () => {
  const gap = auditNumbering(base037, [`${MIGRATIONS}/040_erasure_replay_purge.sql`]);
  assert.equal(gap.length, 1);
  assert.equal(gap[0].want, 38);
});

test("the suggested rename keeps the name and only moves the number", () => {
  assert.equal(
    renumber(`${MIGRATIONS}/040_erasure_replay_purge.sql`, 38),
    `${MIGRATIONS}/038_erasure_replay_purge.sql`,
  );
});

test("the next number in sequence is accepted", () => {
  assert.equal(auditNumbering(base037, [`${MIGRATIONS}/038_audit_unlinking.sql`]).length, 0);
});

test("two migrations added at once are accepted when they run straight on", () => {
  assert.equal(
    auditNumbering(base037, [`${MIGRATIONS}/038_a.sql`, `${MIGRATIONS}/039_b.sql`]).length,
    0,
  );
});

test("a gap inside one change is caught", () => {
  assert.equal(
    auditNumbering(base037, [`${MIGRATIONS}/038_a.sql`, `${MIGRATIONS}/040_b.sql`]).length,
    1,
  );
});

test("reusing a number already on the base is caught", () => {
  assert.equal(auditNumbering(base037, [`${MIGRATIONS}/037_again.sql`])[0]?.want, 38);
});

test("an unnumbered migration filename is caught", () => {
  assert.equal(auditNumbering(base037, [`${MIGRATIONS}/upgrade.sql`])[0]?.want, null);
});

test("a change that adds no migration is fine", () => {
  assert.equal(auditNumbering(base037, []).length, 0);
});

test("the first migration in an empty repository is 001", () => {
  assert.equal(auditNumbering([], [`${MIGRATIONS}/001_initial_schema.sql`]).length, 0);
});

test("a non-.sql file added beside the migrations is not numbered", () => {
  assert.equal(auditNumbering(base037, [`${MIGRATIONS}/migrations.go`]).length, 0);
});
