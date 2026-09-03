# HP-4 — Irreversible-data review scorecard

**Hold point:** HP-4, defined in
[b4-identity-recovery-data-lifecycle-2026-09-01.md](b4-identity-recovery-data-lifecycle-2026-09-01.md)
§HP-4 (roadmap
[repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md), B4)
**Commits reviewed:** the identity chain's squash merges on `dev` (table
below); every step of the chain has merged since measurement
**Measured at:** `dev` `b5e9d4a` (#1510, B4-8), branch `docs/hp-4-scorecard`
**Measured:** 2026-09-02
**Evidence base:** [data-lifecycle.md](../architecture/data-lifecycle.md)
(the failure models, the data-class inventory, the drill protocol and its
appendix); the plan's B4-0..B4-8 evidence blocks; the drills in
`Server/db/hp4_drills_test.go`; the schema drafts in
[hp-4-drafts/](hp-4-drafts/README.md)

**Decision: ACCEPTED 2026-09-03** — the owner merged this scorecard as #1515
(`9598c51`) with all six decisions standing; recorded by B4-9's PR (the
last section). Acceptance authorises B4-9, B4-10 and B4-11; it claims
nothing about beta readiness.

HP-4 asks five questions. Each is answered below with the command that
produces the evidence and what it printed on the measured tree, in the shape
of [hp-3-scorecard-2026-08-29.md](hp-3-scorecard-2026-08-29.md).

## The chain under review

`dev` is squash-merge only; each step's pre-squash commits survive on its
pull-request ref (`git fetch origin 'refs/pull/<n>/head:pr-<n>'`).

| PR    | Step                                                                                                                                                                                      | On `dev`                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| #1497 | B4-0 — failure models, data-class inventory, drill protocol, alphasnap                                                                                                                    | `d8653ea`                            |
| #1498 | B4-2 — absence proofs                                                                                                                                                                     | `920b034`                            |
| #1499 | B4-3 — OC-0321, durable second factor, recovery codes                                                                                                                                     | `9587c9e`                            |
| #1500 | B4-7 — sign-out-everywhere                                                                                                                                                                | `21080e2`                            |
| #1501 | B4-12(d) — OC-0340, OC-0341                                                                                                                                                               | `9515174`                            |
| #1502 | B4-12(a) — OC-0313, OC-0329                                                                                                                                                               | `12dbc88`                            |
| #1503 | B4-12(b) — OC-0314                                                                                                                                                                        | `366f199`                            |
| #1504 | B4-4 — admission budget                                                                                                                                                                   | `eecf99b`                            |
| #1505 | B4-12(a) follow-up — quota-safe migrations                                                                                                                                                | `a595786`                            |
| #1506 | owner decisions (closed; the content landed via #1507)                                                                                                                                    | closed, not merged                   |
| #1507 | B4-7 — new-login signal, OC-0354                                                                                                                                                          | `dc69fbb`                            |
| #1508 | B4-1 — registration modes                                                                                                                                                                 | `8bd4212`                            |
| #1510 | B4-8 — diagnostics inventory, egress-sites, no-telemetry capture                                                                                                                          | `b5e9d4a`                            |
| #1509 | B4-12(c) — OC-0324                                                                                                                                                                        | `fc4c562` (merged after measurement) |
| #1511 | B4-1 review fixes the #1508 squash missed, the four cited tests, the untracked symlink, the README repair                                                                                 | `2b6bfbf` (merged after measurement) |
| #1512 | B4-5 — recovery kit                                                                                                                                                                       | `52f3df7` (merged after measurement) |
| #1513 | B4-6 — owner-assisted recovery                                                                                                                                                            | `33f82a8` (merged after measurement) |
| #1514 | B4-8 review fixes                                                                                                                                                                         | `5587454` (merged after measurement) |
| #1515 | HP-4 — this scorecard                                                                                                                                                                     | `9598c51` (merged after measurement) |
| #1516 | B4-9 — complete account erasure                                                                                                                                                           | `c9f06da` (merged after measurement) |
| #1517 | B4-9 review fix — the replay-pipeline purge and the persisted-envelope predicate                                                                                                          | `7907c16` (merged after measurement) |
| #1520 | B4-10 — deletion markers and unlinkable audit history                                                                                                                                     | `87ad997` (merged after measurement) |
| #1521 | B4-11 — retention                                                                                                                                                                         | `607fd4d` (merged after measurement) |
| #1522 | B4-10 and B4-11 review fixes — the audit-writer barrier, replay past the last-admin guard, pending markers applied, id floors, the actor's token column, the swept messages' replay purge | `15ba7c9` (merged after measurement) |
| #1523 | #1522's own review fixes — the unlink rule at commit time, seeded floors, the 038-era token backfill, first-run setup closed durably                                                      | `b973d21` (merged after measurement) |
| #1524 | #1523's last review finding and the hardening its squash missed — an account marker closes the setup gate across a pre-setup restore; only `0` opens it                                   | `5263b13` (merged after measurement) |

The chain's `service/auth.go` line — B4-3 → B4-4 → B4-5 → B4-6 — is
serialized as the plan required; #1512 and #1513 carry #1511's commits until
it merges, so their diffs read larger than their steps.

## Question 1 — are the failure models complete against the chain?

**Every destructive operation the chain ships has its rows.**

```bash
grep -c '^### O[1-8] ' docs/architecture/data-lifecycle.md   # operations modelled
grep -c '^| A[1-5] ' docs/architecture/data-lifecycle.md     # axis rows
```

8 operations, 40 axis rows: O1 account deletion, O2 message
deletion and purge, O3 the orphan sweep, O4 backup and restore, O5 replay
retention, O6 session sweeps, O7 the TOTP key, O8 recovery-secret rotation —
each with A1 interrupted, A2 disk full, A3 crash between database and
filesystem, A4 concurrency, A5 restore. O8 was written as a requirement at
B4-0 and is now shipped code (B4-5 in #1512, B4-6 in #1513): the kit and the
credential redeem in one transaction (A1,
`TestRedeemRecoveryKit_RollsBackAsAWhole`,
`TestRedeemRecoveryAssist_RollsBackAsAWhole`), a spent or expired secret
admits nobody (A4, the concurrent-redemption tests), and restore is the
kit's A5 — a backup holds only verifiers.

**What B4-9, B4-10 and B4-11 will build maps onto these rows, with the
additions each step owes — the model already states each as a requirement:**

| Target                          | Model rows it inherits                                        | What the step must add                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4-9 erasure                    | O1 (all axes), O2 (FTS), O3 A1/A3/A5 (files), O5 (the window) | disconnect the subject's sockets before the transaction (O1 A4); a journaled, resumable file removal plus a reconciliation pass (O3 A3); purge the subject's `events` rows (O5 — decided below); freed-page honesty (decided below) |
| B4-10 markers, unlinkable audit | O1 A5, O4 (restore)                                           | markers that survive the restore they defend against (decided below: outside the database file); audit rows that keep integrity without the subject (the `audit_unlinking` draft)                                                   |
| B4-11 retention                 | O2, O3, O5                                                    | the same journal-and-reconcile shape as erasure for files; a marker per sweep so a restore does not resurrect what the policy removed (the `deletion_markers` draft, scope `messages`)                                              |

**Private threat coverage, counted.** `docs/architecture/data-lifecycle.md`
§"The private half": writing the models needed **no new advisory**; the one
pre-existing private item touching these operations, **SEC-01**, is closed
by B4-4 (#1504) through its advisory, per the register row. Count at this
scorecard: 0 open private items against O1–O8.

```bash
grep -n 'no new advisory' docs/architecture/data-lifecycle.md
grep -n 'SEC-01' docs/plans/repo-health-issue-register-2026-08-23.md | head -3
```

## Question 2 — are the data contracts fixed?

**Schema drafts, each with its rollback:** [hp-4-drafts/](hp-4-drafts/README.md).

| Draft                            | Step  | Shape                                                                                                                                                                                     |
| -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `erasure_jobs.{up,down}.sql`     | B4-9  | one row per subject; `state` queued → db_done → done; the file list captured inside the transaction; resumed at startup until every file is gone                                          |
| `deletion_markers.{up,down}.sql` | B4-10 | `subject_token` = HMAC-SHA256(marker key, user id), scope `account` or `messages` (+ channel, cutoff); lives in `data/erasure/markers.sqlite`, **never in the file a restore overwrites** |
| `audit_unlinking.{up,down}.sql`  | B4-10 | `audit_log.subject_token`; the erasure zeroes `actor_id`/`target_id` and rewrites free-text detail, the token keeps the chain                                                             |
| `retention.{up,down}.sql`        | B4-11 | `settings.retention_days` (0 = forever), `channel_retention` (per-channel override either direction), `retention_runs` (the sweep log with its own file journal)                          |

The drafts are not applied: `Server/migrations/` gains them when each step
lands, renumbered after 035/036 (B4-5, B4-6). Every rollback was written with
its shape; the two that forfeit a guarantee (markers, erasure jobs mid-flight)
say so in the file.

**The alpha snapshot's boundary is respected.** The snapshot stays an
alpha.4 artifact (31 applied migrations baked in); every drill below opened a
copy through `alphasnap.Copy` and the canary stayed green:

```bash
go test -C Server -count=1 -run 'TestAlphaSnapshotMigratesOnHead|TestAlphaProfileByteIdentical|TestAlphasnap' ./db/ ./internal/alphasnap/
git status --short Server/testdata/snapshots/
```

Both `ok`; `git status` prints nothing for the snapshot directory.

## Question 3 — the baseline drills

`Server/db/hp4_drills_test.go`, one test per drill of the protocol, each on
its own migrated copy; the subject is the Member with the most messages,
attachments, reactions and DM channels (`user015`: 491 messages, 7 uploads,
6 reactions, 3 DMs — the snapshot's scrub leaves members no mentions, read
states, invites, emoji, blocks or overrides, so those classes read 0 on both
sides and the leftovers the protocol predicts for them are vacuously met).

```bash
go test -C Server -count=1 -v -run TestHP4 ./db/
```

**D1 — O1 on a member with everything**
(`TestHP4_D1_DeleteAccountLeavesExactlyThePredictedClasses`, ok 0.08 s).
Exactly the predicted leftovers: the attributed message rows (content
cleared, every row soft-deleted, the FTS text gone with it), the attachment
rows, nothing else; the identity row anonymised.

| Class                           | Before | After |
| ------------------------------- | -----: | ----: |
| 1 identity row (not anonymised) |      1 |     0 |
| 2 sessions                      |      0 |     0 |
| 3 api tokens                    |      0 |     0 |
| 4 second factor                 |      0 |     0 |
| 6 rate-limit keys               |      0 |     0 |
| 7 login attempts                |      0 |     0 |
| 8a messages attributed          |    491 |   491 |
| 8b messages with content        |    491 |     0 |
| 9 mentions naming the subject   |      0 |     0 |
| 10 reactions                    |      6 |     0 |
| 11 read states                  |      0 |     0 |
| 12 attachment rows uploaded     |      7 |     7 |
| 14a dm participation            |      3 |     0 |
| 14b dm open state               |      3 |     0 |
| 15 invites                      |      0 |     0 |
| 16 emoji                        |      0 |     0 |
| 17 blocks                       |      0 |     0 |
| 18 channel user overrides       |      0 |     0 |
| 19 voice state                  |      0 |     0 |
| 20 replay events                |      0 |     0 |
| 21 audit rows                   |      0 |     0 |

**D2 — Resurrection, the negative control for B4-10**
(`TestHP4_D2_RestoreResurrectsADeletedAccount`, ok 0.16 s). `BackupToSafe`
before D1, D1, then the backup copied over the database and reopened as the
admin restore does: every class is back at its Before value, the username is
`user015` again, and no `account_deleted` row exists — nothing records that
a deletion happened. This is O1 A5 made visible; B4-10's post-restore proof
is this drill with the opposite expectation.

| Class                           | Before | After restore |
| ------------------------------- | -----: | ------------: |
| 1 identity row (not anonymised) |      1 |             1 |
| 8a messages attributed          |    491 |           491 |
| 8b messages with content        |    491 |           491 |
| 10 reactions                    |      6 |             6 |
| 12 attachment rows uploaded     |      7 |             7 |
| 14a dm participation            |      3 |             3 |
| 14b dm open state               |      3 |             3 |
| every other class               |      0 |             0 |

**D3 — Restore over newer data** (`TestHP4_D3_RestoreDropsNewerData`, ok
0.13 s). Backup, then a new user and five messages, then restore: `messages
20000 (want 20000), users 100 (want 100), newcomer rows 0 (want 0),
schema_versions 34 → 34` — what arrived after the backup is gone and the
schema is HEAD's on the next open (34 = the alpha.4 set plus 032, 033, 034).

**D4 — The replay window**
(`TestHP4_D4_ReplayEventsSurviveDeletionUntilPruned`, ok 0.08 s). Three
`events` rows naming the subject (two `chat_message` frames with a nested
`user`, one state frame with `user_id`), then D1: `20 replay events 3 → 3` —
O1 leaves the window alone, so a reconnecting client could still be served
the subject's content for up to the retention window. Then
`PruneEventsOlderThan` with a cutoff after them: `pruned 3 rows … 0 left
naming the subject`. The O5 limitation, visible; the decision it forces is
below.

**D5 — Stranded files** (`TestHP4_D5_OrphanSweepCanStrandAFile`, ok 0.05 s).
Two linked attachments, their messages soft-deleted, the rows aged past the
grace period, a placeholder file per row (size per the row) in a temporary
storage directory. `DeleteOrphanedAttachments` returns both names; the
removal loop stops after the first, as a kill or a failed unlink would:
`rows for the swept files: 2 → 0; files on disk: 2 → 1; stranded (file, no
row): 1`. The O3 A1 class exists on demand now — the fixture B4-9's and
B4-11's reconciliation pass is written against.

**Invariants after every drill:** the tracked snapshot is byte-identical
(`git status` clean, `TestAlphaProfileByteIdentical` green), and every drill
ran on a copy `alphasnap.Copy` wrote into `t.TempDir()`.

## Question 4 — is the legal/operator wording decided?

Owner questions 4, 5 and 9 were answered on 2026-09-02 (the plan's
amendments under the questions, landed with #1507):

- **4 — retention:** minimum window one day; a channel policy overrides the
  server policy in either direction; pinned messages are exempt; server and
  channel scope only, DMs untouched.
- **5 — holds:** no hold mechanism in beta; retention is absolute and the
  exit gate's hold rule does not apply.
- **9 — erasure:** erased users' messages are hard-deleted rows; channel
  history shows nothing where they were.

They are reflected in the specs as dated amendments under §B4-9, §B4-10 and
§B4-11 of the plan (this scorecard's PR adds them), and the drafts encode
them: `retention.up.sql` has no hold column and no DM scope; the erasure job
has no tombstone state; `deletion_markers.scope` carries `messages` so a
restore cannot undo a retention sweep.

## Question 5 — are the B4-tagged findings on track?

The plan's B4-12 set, at `dev` `b5e9d4a`:

```bash
node .superpowers/render-ledger.mjs --check
node -e 'const l=require("./.superpowers/findings-ledger.json");for(const id of ["OC-0313","OC-0314","OC-0321","OC-0324","OC-0329","OC-0340","OC-0341","OC-0354"])console.log(id,l.findings.find(f=>f.id===id).status)'
```

| Finding | Status                                    | Where |
| ------- | ----------------------------------------- | ----- |
| OC-0313 | `fixed`                                   |       |
| OC-0314 | `fixed`                                   |       |
| OC-0321 | `fixed`                                   |       |
| OC-0324 | `fixed` (#1509, merged after measurement) |       |
| OC-0329 | `fixed`                                   |       |
| OC-0340 | `fixed`                                   |       |
| OC-0341 | `fixed`                                   |       |
| OC-0354 | `fixed`                                   |       |

All eight are `fixed` on `dev` (#1509 merged after this scorecard was
measured, `fc4c562`). Roadmap rule 2 — zero open B4-tagged findings at exit
— holds; nothing else in the ledger is B4-tagged.

## Decisions this scorecard records

Made under the owner's delegation of 2026-09-02 and open to reversal at
signature:

1. **Replay events are purged by erasure (O5).** B4-9 deletes the subject's
   `events` rows in the erasure transaction (class 20 → 0), rather than
   disclosing the window: D4 shows the window is real and the delete is one
   statement. Retention (B4-11) leaves `events` to the pruner — its window is
   at most the retention setting and the content is already deleted from
   `messages`.
2. **Freed-page honesty (O1 A5, trust-model "No secure deletion").** The
   erasure connection runs `PRAGMA secure_delete = ON` for its transaction
   and checkpoints the WAL with `TRUNCATE` after commit, so the erased rows'
   bytes do not survive in free pages or the WAL of the live file. What a
   backup taken before the erasure holds is B4-10's problem, not this one;
   the trust-model paragraph is rewritten to that split at B4-9.
3. **Markers live outside the database file.** `data/erasure/markers.sqlite`,
   applied like the main migrations, replayed against the main database on
   every open and after every restore — because the backup a restore brings
   in predates the marker (D2). A marker names its subject only through an
   HMAC under a key generated beside the TOTP key.
4. **Audit history keeps its integrity, not the subject.** Rows about an
   erased subject keep action, time and order; `actor_id`/`target_id` become
   0, free-text detail is rewritten, `subject_token` carries the marker.
5. **No hold mechanism, no DM retention, pinned exempt** — the owner's
   decisions 4 and 5 as the drafts encode them.
6. **B4-10 ∥ B4-11 is not relaxed:** B4-11's sweep marker depends on B4-10's
   marker file, so the order stays B4-9 → B4-10 → B4-11.

## Pre-squash SHAs of the chain's PRs

Recorded as B4-9, B4-10 and B4-11 land; each step's pre-squash commits
survive on its PR ref (`refs/pull/<n>/head`). The already-merged steps' PR
refs are in the chain table above.

| Step  | Branch                        | Pre-squash head                                                                                                                                                                                                        | PR           |
| ----- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B4-9  | `feat/b4-9-account-erasure`   | `8032d70` → squash `c9f06da`; Codex's two findings fixed in `9880604`, which landed after the merge and followed as #1517 (`fix/b4-9-replay-purge`): Codex's four findings on it fixed in `2f48505` → squash `7907c16` | #1516, #1517 |
| B4-10 | `feat/b4-10-deletion-markers` | `6634863`; `a9aa6da` → squash `87ad997`; Codex's five findings fixed in `3d8bfb7` and `aeb48da`, which landed after the merge and follow as #1522 (`fix/b4-10-review`: `c82cd31`, `63082dc`)                           | #1520, #1522 |
| B4-11 | `feat/b4-11-retention`        | `972f82f`; `ac24eb7` → squash `607fd4d`; Codex's finding (the replay tiers) fixed in `c815593`, which landed after the merge and follows in #1522 with B4-10's fixes                                                   | #1521, #1522 |

**Signed:** Accepted 2026-09-03 — the owner merged this scorecard as #1515
(`9598c51`) with all six decisions standing; recorded by B4-9's PR, not
signed in the owner's name. Acceptance authorises B4-9 → B4-10 → B4-11.

## B4 exit — 2026-09-03, measured at `dev` `1133a26`

The B4 plan's exit gate says the exit evidence is appended to this scorecard
as a dated section, measured at the exact exit SHA with the gate green there.
This is that section. `1133a26` is the squash of
[#1525](https://github.com/J3vb/OwnCord/pull/1525), the last of the
B4-9 → B4-10 → B4-11 chain and the commit that closed its review fixes.

Every result below was run on `1133a26` rather than cited from the step that
first produced it. Where a condition is met by a named suite, the suite was
re-run here and its count is the count of tests that passed.

### The seven roadmap conditions

| #   | Condition                                                                                                      | Evidence at `1133a26`                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | All registration modes enforce their documented default and transitions                                        | **Met.** 15 tests, 0 failures: `TestMigration034_MapsRegistrationOpenWithoutOpening` (a fresh install defaults to invite, an upgrade never opens), `TestSettings_RegistrationModeTransitionsChainUnderConcurrency`, the normalise/reject pair, `TestAdminAPI_Registrations_*`          |
| 2   | Recovery works without SMTP, rotates secrets, revokes sessions, rate-limits, content-free audit                | **Met.** 32 tests, 0 failures: `TestRecoverRoute_*` (kit and owner-issued credential), `TestAdminAPI_RecoveryCredential_OwnerOnlyIssueAndRedeem`, `TestEraseAccount_PurgesTheRecoveryKit`/`Credential`, and the five `TestAbsenceContract_*` proofs that no mail path exists           |
| 3   | Multi-device session contracts list and revoke only the correct account's devices                              | **Met.** 18 tests, 0 failures: `TestListUserSessions_DoesNotReturnOtherUsers`, `TestGetUserSessions_IsolatedByUser`, `TestRevokeAllSessions_OnlyTheCallersAccount`, `TestDeleteUserSessions_RemovesEveryOneOfTheUsersOnly`, `TestListSessions_NewLoginIsUnseenUntilAnotherDeviceLists` |
| 4   | Deletion removes every required data class and backup restore cannot resurrect the account                     | **Met.** 71 tests, 0 failures: `TestEraseAccount_EveryInventoryClassIsZero`, `TestErasureService_LineageChecklistOnAlphaSnapshot`, and `TestHP4_D1`–`D5` on snapshot copies — `D2` is the post-restore proof (restore resurrects, the markers re-apply the erasure)                    |
| 5   | Retention removes messages and attachments consistently without bypassing legal/operator holds (if introduced) | **Met, holds deliberately absent.** 14 tests, 0 failures: window precedence, indefinite-by-default, budget/resume, the run journal and the replay purge. No hold mechanism ships — owner decision 5 in this scorecard. The condition's "if introduced" is answered: not introduced     |
| 6   | Support bundles are user initiated, reviewed for secrets, and no automatic telemetry occurs                    | **Met at the slim scope.** `TestNoAutomaticTelemetry_Capture` plus the four `TestDiagnosticsConnectivity_*`, 5 tests, 0 failures. The export endpoint itself is B6/B9 under BG-15 — owner question 10, recorded as the slim scope when B4-8 landed, not discovered at exit             |
| 7   | Alpha-shaped data migrates forward and rolls back according to the declared boundary                           | **Met at the exit, after work.** Three of the twelve B4 migrations had a reversal when the chain finished. All twelve now do, plus the marker file, and `TestMigrationRollbackRehearsalOnAlphaSnapshot` rehearses the whole set on a snapshot copy. Report below                       |
| —   | _(roadmap rule 2)_ No B4-tagged `OC-*` finding open                                                            | **Met.** OC-0313, OC-0314, OC-0321, OC-0324, OC-0329, OC-0340, OC-0341, OC-0354 all `fixed`; `node .superpowers/render-ledger.mjs --check` → `ledger valid: 383 finding(s)`                                                                                                            |

### Migration and rollback rehearsal report

The roadmap asks for this as its own evidence artifact, and it is the one
condition that was not a matter of measuring something already true. The B4
plan's traps say the steps carrying migrations do so "each with a rollback
rehearsed on an alpha-snapshot copy". At `1133a26`, three of twelve did.

Twelve migrations landed in B4, `032` through `043`.
`docs/plans/hp-4-drafts/` held four reversals, written with the HP-4 data
contracts before those migrations landed — `037`, `038`, `039` and the
deletion-marker file. The other nine had none: `032`, `033`, `034`, `035`,
`036`, `040`, `041`, `042`, `043`. Two defects also sat in the four that
existed:

- **None cleared its own `schema_versions` row.** The runner records a
  migration by filename and skips what it finds recorded, so a reversal that
  leaves the row behind leaves the database claiming a schema it no longer
  has, and the next server start does not put it back.
- **`deletion_markers.down.sql` was stale.** It predates `sequence_floors`
  and `floor_probes`, so it dropped one of the marker file's three tables.

`Server/rollback/` is the completed set: one reversal per migration in the
order to run them, the marker file's separately, each clearing its own
`schema_versions` row, each carrying in its own comment what reversing it
costs (`Server/rollback/README.md` collects those for an operator).

The rehearsal runs on a copy of the committed alpha snapshot, per the drill
protocol — the tracked file is never opened. The snapshot sits at `031`, so
the forward run is exactly the B4 delta and a full reversal has to land back
on the snapshot's own schema:

| Stage                 | Result at `1133a26`                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forward               | 12 migrations applied, `schema_versions` 31 → 43, clean                                                                                                                                                                                                                                                                                                                                                             |
| Completeness          | every migration past the snapshot's level has a reversal, and every reversal names a migration the head applied                                                                                                                                                                                                                                                                                                     |
| Reverse, newest first | 12 reversals, 35 statements, clean — 043, 042, 041, 040, 039, 038, 037, 036, 035, 034, 033, 032                                                                                                                                                                                                                                                                                                                     |
| Round trip            | schema fingerprint, `schema_versions` (43 → 31), `settings` and the row counts of seven data classes all identical to the snapshot's                                                                                                                                                                                                                                                                                |
| Convergence           | migrating forward again reaches the same head schema and the same 43 rows — a rolled-back database is one a server can start on                                                                                                                                                                                                                                                                                     |
| Marker file           | `TestMarkerFileRollback`: all three tables dropped, `OpenMarkerStore` rebuilds the schema on the next open, the marker is gone                                                                                                                                                                                                                                                                                      |
| Operator path         | `TestReversalFilesAreOperatorSafe`: no reversal carries transaction control of its own, and every one ends on its own `schema_versions` delete with nothing touching the tracker earlier — the two properties the documented command depends on (added after Codex's review of #1528, which found the command targeting a database path no installation uses and running without a wrapping transaction or `-bail`) |

Two reversals are documented to lose something, and the rehearsal pins each
loss to the row it is documented for rather than letting it pass silently:

- **`042` then `041` (audit tokens).** An audit row naming two erased
  principals holds a token for each, and the pre-`041` schema has one column.
  `042`'s reversal moves an actor-only token back into `subject_token`, so
  `041`'s column drop cannot be what discards it; a two-principal row keeps
  the target's token and forfeits the actor's. That is the loss migration
  `041` exists to prevent, made visible in the direction that gives it up.
- **`034` (registration modes).** `approval` and `open` have no boolean
  spelling, so a rollback puts registration back to closed. On the snapshot
  the round trip is exact (`registration_open` `0` → `closed` → `0`); on a
  server running approval or open it is not, and the reversal's comment says
  to note the mode first.

Every other reversal round-trips exactly on this fixture.

### The gate, run on the exit SHA

| Check                                                 | Result                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Four build-tag variants (default, otel, wazero, both) | all OK                                                                                                                  |
| `go vet ./...`                                        | clean                                                                                                                   |
| `golangci-lint run ./...` (pinned v2.11.3)            | **0 issues**                                                                                                            |
| `go test ./...`                                       | ok, all packages                                                                                                        |
| `go test -tags otel,wazero ./...`                     | ok, all packages                                                                                                        |
| `go test -race`, one package at a time                | ok, all packages — run one package at a time, not in parallel                                                           |
| `go test -tags deadlock ./ws/`                        | ok, 63.4s                                                                                                               |
| Coverage floors                                       | aggregate 81.7 (80.9), auth 91.9 (91.4), db 80.7 (79.3), permissions 100.0 (100.0), service 77.7 (74.3), ws 87.6 (86.7) |
| `make sqlc-verify`                                    | no drift in `Server/db/dbgen`                                                                                           |
| `go run -tags otel,wazero ./cmd/gendocs`              | no drift in the `gendocs:*` blocks                                                                                      |
| `node scripts/check-doc-counts.mjs`                   | 21 claims across 9 documents agree with the ledger                                                                      |
| `node .superpowers/render-ledger.mjs --check`         | `ledger valid: 383 finding(s)`                                                                                          |
| Client unit suite, `tsc --noEmit`, lint               | 192 files, 5273 tests pass; `tsc --noEmit` clean; lint no errors                                                        |

### Integration evidence for the exit commits

`dev` is squash-merge-only and its pushes run no `ci.yml` matrix, so what
transfers the PR-head result to the squash commit is
`required_status_checks.strict` plus tree identity (G-03 as amended). The
whole chain, as a command with output:

```
PASS 1133a26 (PR #1525): squash tree == PR head tree ff85f81fd25490093d1069a9ebf5181b8aa6dd76
PASS 5263b13 (PR #1524): squash tree == PR head tree 1de9774a78900a75dd89b7fbf5f22c2f36ca623c
PASS b973d21 (PR #1523): squash tree == PR head tree 3bf643feda637311c7ba355fa6d6ee7ba7db4144
PASS 15ba7c9 (PR #1522): squash tree == PR head tree cbed29d525249e48be0e39c6368f309f5160bee7
PASS 607fd4d (PR #1521): squash tree == PR head tree b919e6854b5ed81c06449cafb52ebe26b85b3581
PASS 87ad997 (PR #1520): squash tree == PR head tree 31752440fdf61cbc62b045e7822e362404fef045
PASS 7907c16 (PR #1517): squash tree == PR head tree b3658696c50a84f3b67b6341a79bba5061dbaf7c
PASS c9f06da (PR #1516): squash tree == PR head tree 5c562d9102534a427946b8176f528f992b814d46
```

### What this exit does not claim

Four limits, stated here so nobody has to infer them from silence:

- **No hold mechanism exists.** Condition 5 is met because holds were not
  introduced, which is owner decision 5, not because a hold was tested. If
  legal or operator holds are ever wanted, retention is where they land and
  this row stops being an absence.
- **The support-bundle endpoint is not built.** Condition 6 covers the
  contract and the no-telemetry proof, which is the slim scope owner question
  10 set. B6/B9 carries the export itself under BG-15.
- **Condition 7 was closed at the exit, not per step.** Nine reversals were
  written here rather than alongside their migrations, so they were rehearsed
  once, together, against the alpha snapshot — not against the schema each
  migration actually met on the day it landed. The rehearsal test is what
  stops the next migration repeating it.
- **The reversals are rehearsed, not exercised in anger.** They round-trip a
  100-user snapshot in a test. Nobody has rolled one of them back on a
  running installation, and the ones that discard credentials or forfeit the
  anti-resurrection guarantee are meant to be rare, deliberate acts.

**Prepared:** 2026-09-03 by the B4 exit PR, measured at `1133a26`. The seven
conditions and roadmap rule 2 are met, with the four limits above.
**Awaiting the owner's sign-off** — recorded factually here rather than
signed in the owner's name, the same way this scorecard's own acceptance was
recorded.
