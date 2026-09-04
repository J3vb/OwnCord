#!/usr/bin/env node
// Fail when a migration that has already shipped is edited or removed
// (OC-0395).
//
//   node scripts/check-migrations.mjs
//   node scripts/check-migrations.mjs --selftest
//
// Why this exists rather than trusting review: Server/db/migrate.go records an
// applied migration by FILENAME and stores no content hash, so editing a file
// that is already on someone's disk changes nothing for them — forever. The
// change looks correct in the diff, passes every test (a fresh database
// applies the new text), and silently splits installations into two schemas.
// That is exactly how 039_retention.sql lost retention_runs.purge_pending for
// anyone who migrated between 607fd4d7 and 15ba7c9a, which 044 now repairs.
//
// The rule: a shipped migration is immutable. A change to one is not a fix, it
// is a fix that only new installations receive. Write a new migration instead.
//
// Deliberately git-level, not content-aware: whitespace-only edits are flagged
// too. A migration file is a handful of lines that nobody needs to reformat,
// and "harmless enough to skip" is a judgement this script would get wrong in
// the one case that matters.
//
// Dependency-free, like scripts/check-workflow-guards.mjs — node: and git.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "Server/migrations";

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The branch this work will merge into. dev is the integration branch every
// change targets; main is the release branch and the fallback for a checkout
// that only has it.
export const BASE_REFS = ["origin/dev", "origin/main", "dev", "main"];

function resolveBaseRef() {
  for (const ref of BASE_REFS) {
    const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (sha) return { ref, sha };
  }
  return null;
}

// Statuses git reports for a path that already existed in the base. "A" (added)
// is the only one a migration may have: a new file is what this script asks for.
const VERDICT = {
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "had its file type changed",
};

/**
 * Parse `git diff --name-status -M` output and return one violation per
 * already-shipped migration the change touches. Exported so --selftest can
 * exercise it without a repository in a particular state.
 */
export function auditNameStatus(out) {
  const violations = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [rawStatus, ...paths] = line.split("\t");
    const status = rawStatus[0];
    if (status === "A" || !paths.length) continue;
    const path = paths[0];
    if (!path.startsWith(`${MIGRATIONS}/`) || !path.endsWith(".sql")) continue;
    violations.push({
      path,
      what: VERDICT[status] ?? `changed (git status ${rawStatus})`,
      to: status === "R" || status === "C" ? paths[paths.length - 1] : null,
    });
  }
  return violations;
}

const NUMBERED = /(\d{3})_[a-z0-9_]+\.sql$/;

const numbersIn = (paths) =>
  paths
    .map((p) => NUMBERED.exec(p.trim()))
    .filter(Boolean)
    .map((m) => Number(m[1]));

/**
 * Return one violation per newly added migration that does not extend the base
 * branch contiguously (OC-0414).
 *
 * MigrateFS applies unrecorded files in lexicographic order, so a number is
 * not a label — it is the position in a total order that every installation
 * has to agree on. Allocating 040 while 038 and 039 are unwritten produces two
 * different orders: a server that migrated before they merged applied 040
 * first and 038/039 after it, a fresh install applies them the other way. That
 * happened (PR #1517 shipped 040 three PRs ahead of 038 and 039) and was safe
 * only because the statements happened to commute. Contiguity is what makes it
 * safe by construction rather than by luck.
 */
/** The migrations among a list of paths. A .go test or a README beside them is
 *  not one — auditNumbering has always filtered on this, and the summary line
 *  below must use the same predicate or it counts files it never audited. */
const migrationsAmong = (paths) =>
  paths.filter((p) => p.startsWith(`${MIGRATIONS}/`) && p.endsWith(".sql"));

export function auditNumbering(basePaths, addedPaths) {
  const baseNums = numbersIn(basePaths);
  const next = baseNums.length ? Math.max(...baseNums) + 1 : 1;
  const added = migrationsAmong(addedPaths).sort();

  const violations = [];
  let expected = next;
  for (const path of added) {
    const m = NUMBERED.exec(path);
    if (!m) {
      violations.push({ path, want: null });
      continue;
    }
    if (Number(m[1]) !== expected) violations.push({ path, want: expected });
    expected++;
  }
  return violations;
}

/** The same path with its NNN_ prefix replaced, for the suggested `git mv`. */
const renumber = (path, want) =>
  path.replace(/(\d{3})(_[a-z0-9_]+\.sql)$/, `${String(want).padStart(3, "0")}$2`);

function nextNumber() {
  // -co: an uncommitted new migration counts too, or the suggested number
  // collides with the file the contributor just wrote.
  const listed = git(["ls-files", "-co", "--exclude-standard", MIGRATIONS]) ?? "";
  const nums = listed
    .split("\n")
    .map((p) => /(\d{3})_[a-z0-9_]+\.sql$/.exec(p.trim()))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return nums.length ? String(Math.max(...nums) + 1).padStart(3, "0") : "001";
}

function main() {
  const base = resolveBaseRef();
  if (!base) {
    console.error(
      `ERROR: cannot resolve a base branch to compare against (tried ${BASE_REFS.join(", ")}).\n` +
        "Without one this check cannot tell a new migration from an edited one, so it fails\n" +
        "rather than passing blind. Fetch the integration branch and re-run:\n" +
        "  git fetch origin dev\n" +
        "  node scripts/check-migrations.mjs",
    );
    process.exit(1);
  }

  const mergeBase = git(["merge-base", base.sha, "HEAD"]) ?? base.sha;
  // No HEAD on the right-hand side: comparing the merge base to the working
  // tree catches an edit that has not been committed yet, which is when a
  // contributor most wants to hear about it.
  const out = git(["diff", "--name-status", "-M", mergeBase, "--", MIGRATIONS]);
  if (out === null) {
    console.error(
      `ERROR: git diff against ${base.ref} (${mergeBase.slice(0, 8)}) failed, so no migration was\n` +
        "checked. Re-run in a full clone:\n" +
        "  git fetch --unshallow origin\n" +
        "  node scripts/check-migrations.mjs",
    );
    process.exit(1);
  }

  const violations = auditNameStatus(out);
  if (violations.length) {
    console.error(`\n${violations.length} already-shipped migration(s) changed:\n`);
    for (const v of violations) {
      console.error(`  ${v.path} was ${v.what}${v.to && v.to !== v.path ? ` to ${v.to}` : ""}`);
    }
    console.error(
      `\nThese files exist in ${base.ref} and have therefore already been applied on installations\n` +
        "that track this repository. Server/db/migrate.go records a migration by filename and\n" +
        "keeps no content hash, so editing one changes nothing for them: they keep the old schema\n" +
        "forever while fresh installations get the new one, and no error is ever raised.\n" +
        "\n" +
        "Restore the file and put the change in a new migration instead:\n" +
        `  git checkout ${base.ref} -- ${violations.map((v) => v.path).join(" ")}\n` +
        `  # write the forward-only fix in ${MIGRATIONS}/${nextNumber()}_<what_it_does>.sql\n` +
        "  # and add its row to the Migration History table in docs/schema.md",
    );
    process.exit(1);
  }

  const basePaths = (
    git(["ls-tree", "-r", "--name-only", mergeBase, "--", MIGRATIONS]) ?? ""
  ).split("\n");
  // Committed additions, plus the ones still untracked: `git diff` only reports
  // tracked paths, and a migration a contributor has written but not yet added
  // is exactly the one this check is worth running on.
  const added = [
    ...out
      .split("\n")
      .filter((l) => l.startsWith("A\t"))
      .map((l) => l.split("\t")[1]),
    ...(git(["ls-files", "-o", "--exclude-standard", "--", MIGRATIONS]) ?? "")
      .split("\n")
      .filter(Boolean),
  ];
  const misnumbered = auditNumbering(basePaths, added);
  if (misnumbered.length) {
    console.error(`\n${misnumbered.length} new migration(s) numbered out of order:\n`);
    for (const v of misnumbered) {
      console.error(
        v.want === null
          ? `  ${v.path} is not named NNN_lower_snake_case.sql`
          : `  ${v.path} should be numbered ${String(v.want).padStart(3, "0")}`,
      );
    }
    console.error(
      `\nMigrateFS applies unrecorded files in lexicographic order, so a number is a position in\n` +
        "an order every installation must agree on, not a label. Leaving a gap means a server that\n" +
        "upgrades before the gap is filled applies the migrations in a different order from a fresh\n" +
        "install, and the two schemas can diverge with nothing to detect it.\n" +
        "\n" +
        "Renumber to run straight on from the last migration on " +
        `${base.ref}, then re-run:\n` +
        misnumbered
          .filter((v) => v.want !== null)
          .map((v) => `  git mv ${v.path} ${renumber(v.path, v.want)}\n`)
          .join("") +
        "  # then update its row in the Migration History table in docs/schema.md\n" +
        "  node scripts/check-migrations.mjs",
    );
    process.exit(1);
  }

  console.log(
    `no already-shipped migration changed, and ${migrationsAmong(added).length} new ` +
      `migration(s) extend ${base.ref} (${mergeBase.slice(0, 8)}) in order`,
  );
}

function selftest() {
  let failed = 0;
  const assert = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
    if (!cond) failed++;
  };
  const names = (out) => auditNameStatus(out).map((v) => `${v.path}:${v.what}`);

  assert(
    auditNameStatus(`A\t${MIGRATIONS}/044_retention_purge_pending_backfill.sql`).length === 0,
    "adding a new migration is what this check asks for, and passes",
  );

  // The two real incidents, as the name-status lines their commits produce.
  // 15ba7c9a rewrote 039_retention.sql fifty minutes after 607fd4d7 shipped
  // it, which is OC-0395.
  assert(
    names(`M\t${MIGRATIONS}/039_retention.sql`).includes(
      `${MIGRATIONS}/039_retention.sql:modified`,
    ),
    "the 039 rewrite that cost retention_runs.purge_pending is caught",
  );
  // 25449eb2 changed the Member permission bitmask seeded by
  // 001_initial_schema.sql, four months before alpha.1.
  assert(
    names(`M\t${MIGRATIONS}/001_initial_schema.sql`).length === 1,
    "the 001 permission-bitmask rewrite is caught",
  );
  // 5aa216d9's whitespace-only edit to 003_audit_log.sql is caught too: git
  // reports it as M, and this check does not read the content.
  assert(
    names(`M\t${MIGRATIONS}/003_audit_log.sql`).length === 1,
    "a whitespace-only edit is caught, because git cannot tell us it was harmless",
  );

  assert(
    names(`D\t${MIGRATIONS}/029_drop_sounds_table.sql`)[0]?.endsWith(":deleted"),
    "deleting a shipped migration is caught",
  );
  assert(
    auditNameStatus(`R096\t${MIGRATIONS}/039_retention.sql\t${MIGRATIONS}/039_retention_v2.sql`)[0]
      ?.what === "renamed",
    "renaming a shipped migration is caught",
  );

  // Shapes that must NOT trip it.
  assert(
    auditNameStatus(`M\t${MIGRATIONS}/migrations.go`).length === 0,
    "the embed file next to the migrations is not a migration",
  );
  assert(
    auditNameStatus("M\tServer/db/queries/messages.sql").length === 0,
    "a sqlc query file outside Server/migrations is not a migration",
  );
  assert(auditNameStatus("").length === 0, "an empty diff reports nothing");

  // --- numbering (OC-0414) ---
  const base037 = ["035_a.sql", "036_b.sql", "037_erasure_jobs.sql"].map(
    (n) => `${MIGRATIONS}/${n}`,
  );

  // The real incident: PR #1517 added 040 when the base branch ended at 037,
  // leaving 038 and 039 to be allocated by later PRs and applied after it on
  // any server that upgraded in between.
  const gap = auditNumbering(base037, [`${MIGRATIONS}/040_erasure_replay_purge.sql`]);
  assert(
    gap.length === 1 && gap[0].want === 38,
    "a migration numbered past the end of the base is caught",
  );
  assert(
    renumber(`${MIGRATIONS}/040_erasure_replay_purge.sql`, 38) ===
      `${MIGRATIONS}/038_erasure_replay_purge.sql`,
    "the suggested rename keeps the name and only moves the number",
  );

  assert(
    auditNumbering(base037, [`${MIGRATIONS}/038_audit_unlinking.sql`]).length === 0,
    "the next number in sequence is accepted",
  );
  assert(
    auditNumbering(base037, [`${MIGRATIONS}/038_a.sql`, `${MIGRATIONS}/039_b.sql`]).length === 0,
    "two migrations added at once are accepted when they run straight on",
  );
  assert(
    auditNumbering(base037, [`${MIGRATIONS}/038_a.sql`, `${MIGRATIONS}/040_b.sql`]).length === 1,
    "a gap inside one change is caught",
  );
  assert(
    auditNumbering(base037, [`${MIGRATIONS}/037_again.sql`])[0]?.want === 38,
    "reusing a number already on the base is caught",
  );
  assert(
    auditNumbering(base037, [`${MIGRATIONS}/upgrade.sql`])[0]?.want === null,
    "an unnumbered migration filename is caught",
  );
  assert(auditNumbering(base037, []).length === 0, "a change that adds no migration is fine");
  assert(
    auditNumbering([], [`${MIGRATIONS}/001_initial_schema.sql`]).length === 0,
    "the first migration in an empty repository is 001",
  );
  assert(
    auditNumbering(base037, [`${MIGRATIONS}/migrations.go`]).length === 0,
    "a non-.sql file added beside the migrations is not numbered",
  );

  console.log(failed ? `\n${failed} selftest failure(s)` : "\nselftest ok");
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();
else main();
