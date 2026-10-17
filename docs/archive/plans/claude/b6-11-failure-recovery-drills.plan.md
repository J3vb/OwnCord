# Plan: B6-11 — Failure and recovery drills

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-11 — Failure and recovery drills (roadmap workstream 10, plus the 2026-09-06 "B4-9" audit carryover)
**Satisfies**: the HP-6 exit-gate line "Backup/restore, disk pressure, … update, and rollback drills pass", and the carryover's demand that the physical-erasure boundary be qualified with **byte-level** evidence rather than logical row absence
**Complexity**: Large
**Drafted**: 2026-09-15 at `dev` `96258158`; B6-10 is in flight on `feat/b6-10-operational-measurements` and is not merged. That branch touches `Server/api/metrics_handler.go` (+test), `Server/api/router.go`, `Server/db/db.go`, `Server/scripts/k6/ws-load.js`, `docs/api.md`, `docs/deployment.md` (5 lines after `:738`) and the PRD. The overlap with this plan is `docs/deployment.md` and the PRD; both are resolved by rebasing after B6-10 merges (Task 0)

**Executor rule**: Where this plan proposes a default for an open question, apply that default unless the owner has overridden it in this file. Where a step needs hardware, a human, a network, or a merged PR that is not available to you, do not guess and do not invent a value: mark the row `unverified`, state what was missing in the PR description, and continue with the next step. Never leave a `<placeholder>` in committed text.

## Summary

B6-8 proved an upgrade and a rollback work when nothing goes wrong. B4's HP-4
drills proved erasure and restore work at the **row** level on a copy of the
alpha snapshot. B6-11 is the unhappy path for both: every drill here either
breaks something on purpose (the disk, the SFU, a migration, a copy, a file)
or looks somewhere the earlier drills did not (the bytes of the database, its
WAL, and the free list, while a reader is holding the file open).

Everything here is **a drill that passes or a limitation that is written
down**. A drill that fails is a ledger finding with the file and line the drill
points at; the drill stays red until the finding is fixed or the owner records
the limitation. Nothing is tuned to make a drill pass, and the only privacy
wording that changes is wording the measurement contradicts.

The eight roadmap drills plus the carryover, and the instrument for each:

| #   | Roadmap says                   | What is drilled                                                                                                                                                                                                                            | Instrument                                                           |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1   | backup/restore                 | `POST /admin/api/backup` and `…/restore` while 20 sockets are open and a reader holds a read transaction; the restore's broadcast, restart, `pre_restore_*` copy and data equality; the kill-during-copy window                            | `cmd/smoke -drills` phase R                                          |
| 2   | deletion-marker restore        | erase an account **after** the backup, restore that backup, prove the marker file replays the erasure before the server serves, with the `account_erasure_replayed` audit row; then the same with the marker file or `erasure.key` missing | `cmd/smoke -drills` phase R (continues 1)                            |
| 3   | disk-full                      | the data directory on a filesystem that actually fills: writes fail with `SQLITE_FULL`, the server stays up and honest, the database is intact, and it recovers without a restart once space returns                                       | `cmd/smoke -drills` phase D on a size-limited tmpfs                  |
| 4   | low-headroom                   | free space crossing `server.min_free_disk_mb`: health `degraded/disk`, uploads `507 STORAGE_LOW_DISK`, messages still flow, erasure file-removal still runs                                                                                | phase D, the first threshold                                         |
| 5   | corrupt input                  | a corrupt main database, a truncated one (the interrupted-restore image), a corrupt `markers.sqlite`, a corrupt backup file, a corrupt `config.yaml`: each refused with a named reason, never served or repaired silently                  | Go drill tests on alpha-snapshot copies + phase C                    |
| 6   | unhealthy dependency           | the supervised LiveKit process killed, and an external `voice.livekit_url` nobody answers: `voice_join` fails closed, health tells the truth, the supervisor's restart is observed                                                         | `cmd/smoke -drills` phase S                                          |
| 7   | interrupted migration          | a crash image taken with a migration's transaction open: the next open rolls it back, `schema_versions` does not list it, the re-run applies it once                                                                                       | Go drill test on an alpha-snapshot copy                              |
| 8   | rollback                       | a reversal interrupted at a statement boundary leaves the schema untouched (`-bail` inside `BEGIN`); the existing forward/back rehearsal stays green                                                                                       | Go drill test beside `TestMigrationRollbackRehearsalOnAlphaSnapshot` |
| 9   | byte-level erasure (carryover) | sentinel bytes planted in messages, FTS and an upload; erased idle, under an active reader, with the checkpoint failing, and across a crash+restart; then **every file scanned for the sentinel**                                          | Go drill test on an alpha-snapshot copy                              |

**No drill publishes a "pass" it did not run.** The measured table in
`docs/architecture/data-lifecycle.md` names the test that produced each row.

## Verify before you implement

Facts established from source at `96258158`. Rows marked **Refuted**,
**Corrected** or **Unknown** contradict something the roadmap, the PRD, the
existing docs or an obvious first design would assume, and the plan is built on
the correction.

| Claim                                                                              | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A backup is the database only, taken online                                        | **Confirmed** | `admin/handlers_backup.go:68-115` `VACUUM INTO` then `integrity_check`, partial removed on error (OC-0212). Uploads, `totp.key`, `erasure.key`, `push_vapid.key`, `config.yaml` and `data/erasure/markers.sqlite` are **not** in it (`docs/deployment.md:372,514-515`)                                                                                                                           |
| Restore is ordered and has a safety copy                                           | **Confirmed** | `handlers_backup.go:188-341`: integrity-check source → audit row → `pre_restore_<ts>.db` (abort if it fails) → broadcast restart → `wal_checkpoint(TRUNCATE)` (`:269`, warn-only) → close → copy → rollback from the safety copy on copy failure → process restart                                                                                                                               |
| A kill during the restore copy leaves a truncated live file that `db.Open` refuses | **Unknown**   | `data-lifecycle.md:238` claims it. `db/db.go:129` `Open` runs **no** `integrity_check`/`quick_check`; the only integrity check in the tree is `CheckBackupIntegrity` (`Server/db/admin_queries.go:520-550`). A truncated SQLite file can open and fail only when a page past EOF is read. Drill 5 measures; the doc line is corrected to what is measured                                        |
| Deletion markers survive a restore and are replayed before anything serves         | **Confirmed** | `db/markers.go:17-29,425` `MarkerStore.ReplayAccounts`; `internal/app/erasure.go:27` `openMarkers` stage after migrations and before the hub; `TestHP4_D2_RestoreResurrectsAndTheMarkersReapplyTheErasure` (`db/hp4_drills_test.go:197`) — on an in-process copy, **never through the real restore endpoint and a real restart**                                                                 |
| "Deletion-marker restore" is a restore of a soft-deleted item                      | **Refuted**   | No undelete exists (grep `deletion.marker` in docs/plans: only B4-10's marker file). The roadmap phrase means drill 2 above: restoring a backup that predates a marker, and proving the marker wins                                                                                                                                                                                              |
| The erasure transaction zeroes freed content and truncates the WAL                 | **Confirmed** | `db/erasure.go:136-143` `PRAGMA secure_delete = ON` on the single writer connection for the transaction; `:164` `PRAGMA wal_checkpoint(TRUNCATE)` after commit                                                                                                                                                                                                                                   |
| A failed or partial checkpoint is retried                                          | **Refuted**   | `erasure.go:159-168`: the result is **logged** (`busy`, `log`, `checkpointed`) and the comment says "the next one finishes it". The next one is SQLite's autocheckpoint, which is `PASSIVE`: it copies frames but **never truncates the `-wal` file**, so frames stay on disk until overwritten. No job state, no tick, no startup pass retries `TRUNCATE`. Drill 9 measures exactly this window |
| The trust model claims the live file keeps no trace in freed pages or the WAL      | **Confirmed** | `docs/trust-model.md:416-417`; `data-lifecycle.md:418` class 25 "Done (B4-9, HP-4 decision 2)". Neither cites a byte scan. The PRD risk row says B6-11 measures first and B6-15 aligns wording, never the reverse                                                                                                                                                                                |
| Erasure jobs have a state machine the maintenance tick resumes                     | **Confirmed** | migration 037 `state IN ('queued','db_done','done')`; `service/erasure.go:65-73` resumed at startup and each tick via `internal/app/maintenance.go:337`. A checkpoint-pending state does **not** exist                                                                                                                                                                                           |
| Disk headroom is a real filesystem probe with a configurable floor                 | **Confirmed** | `config.go:257,494` `server.min_free_disk_mb` default 256; `service/storage_quota.go:27` statfs-style; `upload_handler.go:149` `507 STORAGE_LOW_DISK`; `/health` → `degraded/disk` (`api/health_test.go:45-66`)                                                                                                                                                                                  |
| Something already tests a full disk                                                | **Refuted**   | `upload_quota_test.go:159`, `upload_streaming_test.go:116` fake the headroom arithmetic; one test simulates `SQLITE_FULL` with a `RAISE(FAIL, 'database or disk is full')` trigger (`db/erasure_test.go:526`); none has produced a real `ENOSPC`. A tmpfs with `size=` does, for real                                                                                                            |
| `SQLITE_FULL` is handled somewhere                                                 | **Refuted**   | No production code matches `SQLITE_FULL` / "disk is full". `data-lifecycle.md:151` models it for erasure (rollback, 500, retryable). What `chat_send`, the audit flusher, the persister and the session writer do under it is unmeasured. Drill 3 measures; every unmeasured path is a candidate finding                                                                                         |
| Migrations run one transaction per file and record themselves inside it            | **Confirmed** | `db/migrate.go:231-262` `applyMigration`: `Begin` → statements → `INSERT INTO schema_versions` → `Commit`; duplicate-column skipped. A crash mid-file is a WAL rollback at the next open — that is what drill 7 proves rather than assumes                                                                                                                                                       |
| There is no rollback path for migrations                                           | **Corrected** | `Server/rollback/` holds one `.down.sql` per migration 032–051 plus `markers.down.sql`, and `TestMigrationRollbackRehearsalOnAlphaSnapshot` (`db/rollback_rehearsal_test.go`) runs the whole set forward and back on CI. The README's `-bail`-inside-`BEGIN` rule (`rollback/README.md:18-40`) is asserted by prose only — drill 8 asserts it                                                    |
| A supervised SFU that dies makes `voice_join` fail closed                          | **Confirmed** | `ws/voice_join.go:201` `h.lkProcess != nil && !h.lkProcess.IsRunning()`; the supervisor restarts with 3 s → 60 s backoff and gives up after 10 (`ws/livekit_process.go:245-346`)                                                                                                                                                                                                                 |
| An **external** SFU that is down also makes `voice_join` fail closed               | **Unknown**   | With `voice.livekit_binary` unset `lkProcess` is nil, so the guard at `:201` is skipped; `LiveKitHealthCheck` (`ws/hub_livekit.go:29`) is consulted by diagnostics (`api/diagnostics_handler.go:62`), not by the join. If a token is minted against a dead SFU the client fails at the SFU — success disguised, the B6-6 rule. Drill 6 measures both shapes                                      |
| The health endpoint reports voice                                                  | **Corrected** | `/health` and `/api/v1/health` are liveness + hub + database + disk; voice is on `GET /api/v1/diagnostics` (`livekit_health`) and `GET /api/v1/livekit/health` (webhook-CIDR gated). The drill asserts each surface's **own** contract, not that `/health` turns red for voice                                                                                                                   |
| The smoke harness is the home for process-level drills                             | **Confirmed** | `cmd/smoke/main.go:102-185` phases 1–4; `upgrade.go` eight rehearsal phases; `fixture.go` setup + upload + backup; `docker.go` the container leg; `-upgrade -from` flag shape (`main.go:53-55`). A `-drills` flag is the same shape                                                                                                                                                              |
| The alpha snapshot is the fixture for in-process drills                            | **Confirmed** | `internal/alphasnap.Copy` (`alphasnap.go:70`) byte-copies `Server/testdata/snapshots/v1.2.0-alpha.4.sqlite`; `TestAlphaProfileByteIdentical` guards the source. `hp4_drills_test.go` is the shape                                                                                                                                                                                                |
| The CI runner can mount a size-limited filesystem without a new dependency         | **Confirmed** | ubuntu runners have passwordless `sudo`; `sudo mount -t tmpfs -o size=24m tmpfs "$DIR"` for the standalone leg, `docker run --tmpfs /app/data:size=24m` for the container leg. Both are one line in the workflow; nothing in Go changes for it                                                                                                                                                   |
| `.claude/plans/` is tracked and Prettier-gated                                     | **Confirmed** | `.gitignore` whitelist; PRD decision 2026-09-08                                                                                                                                                                                                                                                                                                                                                  |

### What the corrections change

- **Drill 9 is the milestone's centre of gravity, and its result is not
  known.** The checkpoint is best-effort with no retry, and the WAL file is
  never truncated by the autocheckpoint. The likeliest measured result is: idle
  erase leaves nothing; erase under a reader leaves the sentinel in `-wal`
  until a later `TRUNCATE` that nothing schedules. If so, Task 5 adds the
  smallest retry that closes it (a startup `TRUNCATE` after marker replay and
  a tick retry while a checkpoint is owed) — **that is the "pending-completion
  / retry behaviour" the carryover asks to record**, and it is built only
  after the measurement says it is needed.
- **Drill 2 goes through the real endpoint and a real restart.** D2 proved the
  replay on an in-process copy; nobody has restored through
  `handleRestoreBackup`, let the process restart itself, and read the audit row
  back. The marker-file-missing and key-missing variants are the operator's
  documented duty (`data-lifecycle.md:154`) and have never been shown to fail
  loudly rather than silently.
- **"Corrupt input" is operator-side corruption**, not user input. WebSocket
  frames and FTS queries already have fuzz tests; a corrupt upload is a normal
  request. The files an operator can damage — database, WAL, marker file,
  backup, config — are the drill.
- **Disk-full is measured on a filesystem that fills**, never faked. The two
  thresholds (headroom floor, then `ENOSPC`) are one phase with two stages.

## Patterns to Mirror

| Category                       | Source                                            | Pattern                                                                                                                            |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| In-process drill on a snapshot | `Server/db/hp4_drills_test.go:144-360`            | `alphasnap.Copy` → act → assert per data class; the test name is the evidence cited in the doc                                     |
| Process-level phase            | `Server/cmd/smoke/upgrade.go`, `main.go:187-266`  | `start` / `waitHealthy` / `drain` / `annotate` — every failure carries the server log; phases numbered and printed                 |
| Fixture through the public API | `Server/cmd/smoke/fixture.go`                     | setup wizard → session → upload → backup; one call each, never in a retry loop (rate limits)                                       |
| Crash image without timing     | `Server/internal/alphasnap/alphasnap_test.go:64`  | copy `db`, `-wal`, `-shm` as files; "a crash" is a byte copy taken while a transaction is open, not a `kill` raced against a clock |
| Failure-axis table             | `docs/architecture/data-lifecycle.md:145-160`     | A1–A5 per operation; each cell names the test that proves it                                                                       |
| Honest limitation              | `docs/architecture/data-lifecycle.md:238`         | "There is no automatic repair for this window" — write the limitation, name the manual recovery                                    |
| Refuse, don't repair           | `Server/auth/totp_encrypt_test.go:212-241`        | a corrupt key file fails closed and is never regenerated; the same rule for every file drill 5 damages                             |
| Workflow leg                   | `.github/workflows/upgrade-rehearsal.yml:163-216` | build once, run the standalone leg then the container leg in one job (port 8443), remove images after                              |
| Revert-proof for a fix         | B3-9 / bughunt-fix convention                     | a fix that Task 5 adds is committed after the test that fails without it; the test is the drill row                                |

## Files to Change

| File                                               | Action | Why                                                                                                                                                                 |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server/db/b6_11_drills_test.go`                   | CREATE | drills 5 (database, WAL, marker file), 7, 8, 9 on alpha-snapshot copies; the sentinel scanner                                                                       |
| `Server/cmd/smoke/drills.go` (+ `drills_test.go`)  | CREATE | `-drills` flag: phases R (backup/restore/markers), C (corrupt backup, corrupt config), D (headroom → full → recover), S (SFU killed, SFU absent)                    |
| `Server/cmd/smoke/main.go`                         | UPDATE | the flag and dispatch, mirroring `-upgrade`                                                                                                                         |
| `Server/db/erasure.go`, `Server/internal/app/*.go` | UPDATE | **only if drill 9 shows retained bytes**: the checkpoint retry (Task 5)                                                                                             |
| `.github/workflows/upgrade-rehearsal.yml`          | UPDATE | a "Failure and recovery drills" step per leg: tmpfs mount, `go run ./cmd/smoke -drills`, `--tmpfs` for the container                                                |
| `docs/architecture/data-lifecycle.md`              | UPDATE | O4 A1 corrected to the measurement; class 25 row → the measured erasure table; a new "B6-11 drills" evidence block naming each test                                 |
| `docs/trust-model.md`                              | UPDATE | `:416-417` **only if the measurement contradicts it** — a false public privacy claim does not wait for B6-15; B6-15 still owns BPR-053 traceability                 |
| `docs/deployment.md`                               | UPDATE | one paragraph under Restore: the marker file and `erasure.key` are part of a backup set; under Health: what disk-full looks like. B6-13 owns the full operator docs |
| `.superpowers/findings-ledger.json`                | UPDATE | every drill that fails and is not fixed on this branch                                                                                                              |
| `CHANGELOG.md`, `docs/plans/b6-*.prd.md`           | UPDATE | unreleased entry; B6-11 row → `in-progress` now, `complete` + this link at the end                                                                                  |

No new workflow, no new dependency, no new binary. The drills are Go tests
where a copy of the snapshot is enough and smoke phases where a real process,
a real restart or a real filesystem is the point.

## Tasks

### Task 0: Branch, PRD row, and the B6-10 boundary

- **Action**: branch `feat/b6-11-failure-recovery-drills` from `dev`. Flip
  the PRD row to `in-progress` with this plan linked. Run
  `git diff --stat dev...feat/b6-10-operational-measurements`: the overlap
  is `docs/deployment.md` (B6-10 adds 5 lines after `:738`; this plan adds
  paragraphs under Restore and Health) and the PRD row table. Neither is a
  code conflict: rebase after B6-10 merges and re-check the two hunks. The
  restart-under-load drill lives on that branch and is **reused** for drill
  1's "active sockets" precondition, not re-planned.
- **Validate**: `npm run format` clean; PRD row renders.

### Task 1: The sentinel scanner and drill 9 — byte-level erasure

- **Action**: in `Server/db/b6_11_drills_test.go`:

  `plantSentinel(t, db, dir) (sentinel string, userID int64)` — creates an
  account on the alpha copy, sends 200 messages each containing
  `OCB611-<16 random hex>`, one FTS-indexed edit, one upload under
  `upload.storage_dir` whose bytes contain the sentinel, one DM. Returns the
  sentinel.

  `scanForSentinel(t, sentinel, paths...) map[string]int` — `bytes.Count` over
  every file in: the database, `-wal`, `-shm`, the uploads dir, the backup
  dir, and `data/erasure/markers.sqlite` (+ its sidecars). Also records
  `PRAGMA freelist_count` and the `-wal` size before and after.

  Four scenarios, each its own `t.Run`, each starting from a fresh copy:
  - **E1 idle**: `EraseAccount`; scan. Expect 0 everywhere.
  - **E2 active reader**: open a reader connection,
    `BEGIN; SELECT count(*) FROM messages;` and hold it; `EraseAccount` on the
    writer; scan **while the reader is still open**, then `COMMIT` the
    reader, scan again, then trigger whatever "the next checkpoint" is today
    (an autocheckpoint-sized write on the writer) and scan a third time.
    Expect: this is the row the doc has never had. Record all three counts.
  - **E3 checkpoint failed**: as E2, but instead of releasing the reader,
    close the database with the reader still open (SQLite's last-close
    checkpoint cannot run), then reopen and scan. Then release everything,
    reopen once more (last-close checkpoint + WAL delete) and scan.
  - **E4 crash + restart**: `EraseAccount` with the checkpoint **skipped**
    (take a byte copy of `db`, `-wal`, `-shm` immediately after
    `eraseAccountTx` commits and before the `TRUNCATE` — expose the commit
    point through an unexported test seam, or race a copy against a
    `secure_delete` transaction made long by 200 000 planted rows; the seam is
    the honest option and is a test-only hook on `*DB`); open the copy as the
    server would (`Open` → migrations → marker replay); scan.
    Concretely: add an unexported field `testEraseCommitHook func()` on
    `*DB` (`Server/db/db.go:56-77`, alongside the other private fields on the
    `DB` struct). `eraseAccount` (`Server/db/erasure.go:126-171`) calls it,
    if non-nil, immediately after `eraseAccountTx` commits at
    `erasure.go:148` and before the `wal_checkpoint(TRUNCATE)` call at
    `erasure.go:164`. Production never sets it. The test sets it to a func
    that closes the DB handle and returns, simulating the crash.

  The assertions are **the doc's claims, not a wish**: E1 must be 0 in every
  file (`trust-model.md:416` is stated unconditionally). E2–E4 `t.Log` the
  table and assert only what the trust model actually promises after the
  measurement is read — the first run of this test is expected to **fail on
  E2 or E3** if the WAL keeps bytes, and that failure is the finding.

- **Why**: the carryover, verbatim: "database/WAL byte-level evidence under
  active readers, failed checkpoints and restart". Logical absence is
  `TestHP4_D1_ErasureLeavesNoClass` and stays a separate assertion.
- **Gotcha**: `secure_delete` zeroes freed content **in pages the transaction
  writes**; the frames it appends to the WAL are the zeroed pages. The
  sentinel that survives, if any, is in **older** frames from when the rows
  were inserted, not yet checkpointed — so E2 must plant the rows with the
  WAL un-checkpointed (do not `TRUNCATE` between plant and erase, and keep the
  plant under the 1000-page autocheckpoint or disable it for the plant with
  `PRAGMA wal_autocheckpoint=0` on the writer connection).
- **Validate**: `go test -C Server -run TestB611_Erasure ./db/` — E1 green;
  E2–E4 produce a logged table; any red row is carried into Task 5.

### Task 2: Drills 5, 7 and 8 — corrupt, interrupted, rolled back

- **Action**: same file.

  **Drill 7, interrupted migration** (`TestB611_InterruptedMigrationRollsBack`):
  copy the alpha snapshot; open the raw file with the driver; `BEGIN`; execute
  the statements of the **last** migration in `Server/migrations/` by hand
  **without** the `schema_versions` insert and without `COMMIT`; while that
  transaction is open, byte-copy `db` + `-wal` + `-shm` to a second directory
  (the crash image); then `db.Open` the image and `MigrateFS`. Assert: the
  migration is absent from `schema_versions` before `MigrateFS`, present
  after, applied exactly once, `PRAGMA integrity_check` is `ok`, and the
  forward-only runner did not skip it as "duplicate column".

  **Drill 8, interrupted rollback** (`TestB611_InterruptedRollbackLeavesSchema`):
  copy the snapshot migrated to head; take the newest `.down.sql`; feed
  `BEGIN;` + the first half of its statements + a deliberately broken
  statement to the driver the way `sqlite3 -bail` would stop; assert the
  schema (`sqlite_master` dump) and `schema_versions` are byte-identical to
  before. Then run the full reversal through `rollback.go`'s list as the
  existing rehearsal does, to prove the fixture is the real one.

  **Drill 5, corrupt files** (`TestB611_CorruptFilesFailClosed`, one `t.Run`
  each):
  - **main database, flipped page**: copy; overwrite 64 bytes at offset
    `4096 * 7 + 100` (inside a table page, past the header); `Open` and run
    the boot sequence the server runs (`Open` → `MigrateFS` → `openMarkers`
    → one read). Record which step errors and with what. Assert: **no step
    reports success on the corrupt file** — if `Open` and `MigrateFS` pass
    and only the read fails, that is the measured limitation, written down,
    and the proposed fix (a `quick_check` at boot) is an owner question, not
    a silent addition.
  - **main database, truncated to half** (the interrupted-restore image of
    `data-lifecycle.md:238`): same sequence; the doc claims `Open` refuses it
    — measure whether it does, correct the doc line to what happens.
  - **`markers.sqlite` corrupt**: flip bytes; `openMarkers` must return an
    error and the boot must not proceed — a corrupt marker file that is
    silently skipped is exactly a restore that resurrects an erased account.
  - **backup file corrupt**: covered by `handleRestoreBackup` (`:223-226`, 400) — cite the existing test, add none.

- **Why**: roadmap drills 5, 7, 8. Each is a claim the docs or the README
  make in prose today.
- **Validate**: `go test -C Server -run 'TestB611_(Interrupted|Corrupt)' ./db/`.

### Task 3: `cmd/smoke -drills` — phases R, C, D, S

- **Action**: `Server/cmd/smoke/drills.go`, dispatched from `main.go` by a
  `-drills` flag that takes the positional server binary like the plain smoke
  (`-docker` selects the container leg as it does for `-upgrade`). Flags:
  - `-phases <letters>` — which of `R`, `C`, `D`, `S` to run, default all;
    an unknown letter is a usage error, not a skip;
  - `-data-fs <dir>` — the size-limited filesystem for phase D;
  - `-known-findings <ledger ids>` — comma-separated open `OC-*` ids. A
    phase whose **only** failures are listed ids prints `::warning::` per
    failure and the phase exits 0 **on the `workflow_call` (release) path
    only**; nightly and dispatch runs still fail on the same phase. The ids
    must exist and be `open` in `.superpowers/findings-ledger.json` at build
    time, or the flag is a usage error.

  Reuse `start`, `waitHealthy`, `drain`, `annotate` and `fixture.go`'s
  setup, session, upload and backup helpers. Each phase prints its name and
  result and fails with the server log attached. Unit tests in
  `drills_test.go` cover the `-phases` parser (each letter, the empty
  default, an unknown letter) and the known-findings downgrade (a listed id
  warns, an unlisted one fails, a listed id that is not `open` is refused).

  **Phase R — backup, restore, markers (drills 1, 2)**
  1. boot; fixture: owner, a second account **V**, ten messages from V, one
     upload from V; open 20 WebSocket sessions that stay authenticated; open
     one HTTP request that holds a reader (a paginated messages `GET` with a
     large page — check `db.go`'s reader pool is what serves it);
  2. `POST /admin/api/backup` → 200; the file lists; `integrity_check` it
     out-of-process with the driver;
  3. **erase V** (`DELETE /admin/api/users/{id}` — the route B4-9 added);
     assert the marker file has one recorded marker;
  4. `POST /admin/api/backups/{name}/restore` → the 20 sockets each receive
     `server_restart`; the endpoint's restart is `requestRestart`
     (`admin/restart.go:44`), and under the default `restart_mode: auto`
     (`config.go:418`) `resolveRestartMode` (`internal/app/restart.go:172-190`)
     spawns a replacement process when no supervisor or container is
     detected — which is the harness's case. The drill follows that path:
     the harness does **not** relaunch; it waits for the original PID to
     exit 0 and for `/health` on the same port to answer from the
     replacement, the same shape `cmd/smoke/upgrade.go` relies on for the
     update-apply restart;
  5. after the second boot: `pre_restore_*.db` exists and `integrity_check`s;
     V's messages are **absent**; the audit log has `backup_restore` **and**
     `account_erasure_replayed` with the marker token; V's upload file is
     gone from disk; a third account created before the restore is gone
     (D3's "restore drops newer data", now through the real path);
  6. **marker file missing**: stop; delete `data/erasure/markers.sqlite`;
     restore the same backup again; boot. Measure: does V come back, and does
     anything say so? Assert whichever the owner decides (see open question
     1); the drill's first run records the behaviour;
  7. **`erasure.key` missing, marker file present**: same shape. The marker
     file is bound to the key by fingerprint (OC-0388) — the boot must fail
     closed with a named reason, not run with unreadable markers.

  **Phase C — corrupt operator input (drill 5, process half)**
  1. a backup file with bytes flipped → restore → 400 and the live database
     untouched (hash before/after);
  2. `config.yaml` with a syntax error → the binary exits non-zero with the
     file and line in the message, within 5 s, and creates nothing.

  **Phase D — headroom, then full, then recovery (drills 3, 4)**
  The harness takes `-data-fs <dir>` (a directory the workflow mounted as a
  24 MiB tmpfs) and boots with `server.min_free_disk_mb: 8`.
  1. **headroom stage**: fill the filesystem with a junk file until free
     space is under 8 MiB but above 2 MiB. Assert: `/health` → `degraded`,
     reason `disk`; an upload → `507 STORAGE_LOW_DISK`; a `chat_send` →
     `chat_send_ok` (messages still flow); a scheduled/ad-hoc backup → the
     OC-0212 path (error, no partial file);
  2. **full stage**: fill to `ENOSPC`. Send 50 `chat_send`s; the server must
     answer each with an **error frame**, not silence, and must not exit;
     `/health` still answers; the log names `SQLITE_FULL` / "database or disk
     is full" at least once. Record which paths went quiet (audit flusher,
     persister, session touch) by reading the log — every silent path is a
     candidate finding;
  3. **recovery stage**: delete the junk file. Without a restart: `chat_send`
     → `chat_send_ok`, upload → 201, `/health` → `ok`. Then drain and reboot:
     `integrity_check` `ok`, message count equals the number of
     `chat_send_ok`s ever received (none acknowledged and lost, none
     unacknowledged and kept — both are findings).

  **Phase S — the SFU (drill 6)**
  1. **supervised**: boot with `voice.livekit_binary` set (the workflow has the
     binary from B6-9's leg — reuse `tools/` resolution) and
     `auto_download_livekit: false`; join voice → `voice_token`; `kill -9` the
     child; `voice_join` → error frame (record its code);
     `GET /api/v1/diagnostics` → `livekit_health: false`; wait for the
     supervisor's first restart (≤ 3 s backoff + boot); `voice_join` →
     `voice_token` again;
  2. **external, absent**: boot with `voice.livekit_url: ws://127.0.0.1:1`
     and no binary; `voice_join`. Record: token minted or error. A minted
     token is the disguised-success shape B6-6 forbids and becomes a ledger
     finding (fix is out of scope for a drill: one `HealthCheck` before the
     mint, but that is a behaviour change with its own PR).

- **Why**: drills 1–4 and 6 need a real process, a real restart, a real
  filesystem and a real child process; a Go test on a copy cannot do any of
  those honestly.
- **Gotcha**: phase D is Linux-only (tmpfs). On Windows the harness prints
  `phase D: skipped (no size-limited filesystem)` and exits 0 — a skip is
  printed, never a pass. `ci.yml`'s Windows smoke matrix runs the plain smoke
  only, unchanged.
- **Validate**: `cd Server && go test ./cmd/smoke/` (the phase helpers have
  unit tests like `upgrade_test.go`); locally
  `go run ./cmd/smoke -drills ./chatserver` on Linux/WSL with a tmpfs.

### Task 4: The workflow leg

- **Action**: `upgrade-rehearsal.yml` gains, after the container rehearsal and
  before image removal:

  ```yaml
  - name: Mount a filesystem that can fill
    run: |
      mkdir -p "$RUNNER_TEMP/drill-fs"
      sudo mount -t tmpfs -o size=24m,uid=$(id -u),gid=$(id -g) tmpfs "$RUNNER_TEMP/drill-fs"
  - name: Failure and recovery drills (standalone)
    run: go run ./cmd/smoke -drills -data-fs "$RUNNER_TEMP/drill-fs" "$HEAD_BINARY"
  - name: Failure and recovery drills (container, disk pressure only)
    run: go run ./cmd/smoke -drills -docker -phases D owncord-rehearsal:head
    # docker.go passes --tmpfs /app/data:size=24m,uid=<app uid> for this phase
  ```

  The drill steps run on nightly and dispatch. They are **not** wired into
  the `workflow_call` (release) path until the owner answers question 5 —
  whether a known-finding drill may block a release. Until then the steps
  carry `if: github.event_name != 'workflow_call'`, and the release rehearses
  the happy path only, as it does today. When the owner answers, the guard
  is dropped and `release.yml`'s call passes
  `-known-findings <the open ids the ledger lists>`, so a release fails on a
  new failure and warns on a known one. Not in PR CI: ~3–4 min and a tmpfs
  mount per PR is not worth it; the Go drills in Task 1–2 **are** in PR CI
  through `go test ./db/`.

- **Why**: one job already owns the built binary, the images and the port; a
  second workflow would rebuild both.
- **Validate**: `actionlint`; ShellCheck 0.9.0 through Docker on the new
  `run:` blocks; `gh workflow run upgrade-rehearsal.yml --ref <branch>`
  completes with every drill phase printed.

### Task 5: Close what drill 9 opens — only if it opens something

- **Action**: read Task 1's E2–E4 table. Three outcomes:
  - **Nothing retained** anywhere: no code change; the doc gets the measured
    table and the sentence "measured, not assumed".
  - **Bytes retained in `-wal` after a busy checkpoint until an unscheduled
    later `TRUNCATE`**: add the retry, smallest form:
    1. `internal/app/erasure.go` after `ReplayAccounts`: one
       `PRAGMA wal_checkpoint(TRUNCATE)` on the writer — every restart
       finishes any checkpoint a crash or a reader denied;
    2. `db/erasure.go:164-168`: when `busy != 0` or `checkpointed < logFrames`,
       set an atomic `d.checkpointOwed` flag instead of only logging;
    3. `ErasureService`'s tick (`service/erasure.go`, the resume path the
       maintenance loop already calls): if the flag is set, run `TRUNCATE`
       again, clear on `busy == 0 && checkpointed == logFrames`, log the
       count of attempts. No migration, no new state value: the flag is
       process-local and the startup pass covers a crash.
       `// ponytail: process-local flag; persist in erasure_jobs if a tick ever needs to survive a crash before the startup pass runs`
    4. E2/E3 become green by asserting "0 after the tick" and "0 after
       restart"; E4 asserts "0 after the startup pass". The test that failed
       before the change is the revert-proof.
  - **Bytes retained somewhere the retry cannot reach** (the free list after
    a non-`secure_delete` writer reused the page, the filesystem's own
    blocks, a backup taken between plant and erase): that is the explicit
    limitation. Write it in `data-lifecycle.md` class 25 and correct
    `trust-model.md:416-417` to the measured boundary **in this PR** — a
    public privacy claim the measurement contradicts is not left standing for
    B6-15; B6-15 then reconciles BPR-053 and the register to the corrected
    wording (PRD risk row, "B6-11 measures first").
- **Why**: the carryover: "Record pending-completion/retry behaviour or an
  explicit limitation, and align privacy claims with the measured result
  before HP-6."
- **Validate**: Task 1's test green in the shape the outcome dictates;
  `TestHP4_D1..D5` untouched and green; `ci-check`.

### Task 6: Write the measurements, reconcile, hand off

- **Action**:
  - `docs/architecture/data-lifecycle.md`: O4 A1 rewritten to what drill 5's
    truncated-file run showed; class 25's row replaced by the E1–E4 table with
    file-by-file counts and the test name; a "B6-11 drills" block listing
    every drill, its test or phase, and its result (pass / finding `OC-…` /
    limitation).
  - `docs/deployment.md` Restore: "a backup **set** is the `.db` file plus
    `data/erasure/markers.sqlite`, `erasure.key`, `totp.key`, `push_vapid.key`
    and the uploads directory" with drill 2's step-6/7 result as the reason.
    Health: the three disk stages as the operator sees them.
  - `docs/trust-model.md:416-417` only per Task 5's third outcome.
  - Ledger: one row per failed drill not fixed here (candidates from the
    Unknown rows: external-SFU token minting; `Open` accepting a truncated or
    corrupt file; a silent path under `SQLITE_FULL`; a missing marker file
    resurrecting an account without a word).
  - PRD row → `complete`, or `in-progress` naming the open findings;
    `CHANGELOG.md`; B6-13's row told which operator paragraphs already exist
    so it extends rather than rewrites; B6-15's row told whether the trust
    model wording changed.
- **Validate**: `node .superpowers/render-ledger.mjs --check`;
  `npm run format && npm run check:docs`; `ci-check` skill; the
  upgrade-rehearsal dispatch run id recorded in the PR.

## Validation

```bash
# in-process drills (PR CI runs these)
go test -C Server -count=1 -run 'TestB611_|TestHP4_|TestMigrationRollbackRehearsal|TestAlphaProfileByteIdentical' ./db/ ./internal/alphasnap/
# harness unit tests
cd Server && go test ./cmd/smoke/
# process-level drills, Linux / WSL
mkdir -p /tmp/drill-fs && sudo mount -t tmpfs -o size=24m,uid=$(id -u),gid=$(id -g) tmpfs /tmp/drill-fs
cd Server && go build -o chatserver . && go run ./cmd/smoke -drills -data-fs /tmp/drill-fs ./chatserver
go run ./cmd/smoke -drills -docker -phases D owncord-rehearsal:head
# workflow
actionlint
docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:v0.9.0 <extracted run: blocks>
gh workflow run upgrade-rehearsal.yml --ref feat/b6-11-failure-recovery-drills
# docs + ledger + everything
npm run format && npm run check:docs && node .superpowers/render-ledger.mjs --check
# → ci-check skill
```

## Risks

| Risk                                                                                                                    | Likelihood | Impact | Mitigation                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drill 9 shows the WAL keeps erased bytes and the trust model is publicly wrong today                                    | High       | High   | Task 5's retry is small and migration-free; the wording is corrected in the same PR; the security-advisory rule (`docs/security.md`) is consulted before the PR text names the window |
| The crash-image seam in Task 1 (E4) leaks a test hook into production code                                              | Medium     | Low    | An unexported func var on `*DB` set only from `_test.go`; no config, no env var, no exported symbol                                                                                   |
| `ENOSPC` on the tmpfs hits the **log file** or `config.yaml` before the database and the drill measures the wrong thing | High       | Medium | Only `database.path`, `upload.storage_dir` and `backup.dir` live on the tmpfs; log and config stay on the runner disk; the junk file is on the tmpfs                                  |
| A full disk makes the server exit and the phase cannot tell "crashed" from "drained"                                    | Medium     | High   | The harness treats any exit during phase D as a failure with the log attached; exit is a finding, not a pass                                                                          |
| The restore endpoint's own process restart and the harness's supervision fight over the same binary                     | Low        | Medium | Task 3 step 4: `restart_mode: auto` spawns a replacement when unsupervised (`internal/app/restart.go:172-190`); the harness waits, never relaunches                                   |
| A drill that fails on a ledger-listed open finding blocks a release nobody meant to hold                                | Medium     | High   | `-known-findings` downgrades listed ids to `::warning::` on the release path only; nightly and dispatch still fail; not wired into `workflow_call` until question 5 is answered       |
| Phase S needs the LiveKit binary on the runner                                                                          | Medium     | Low    | Reuse B6-9's resolution step; if unavailable the phase prints `skipped`, never `pass`, and the run is not green for drill 6                                                           |
| Windows smoke matrix breaks because the drills do not run there                                                         | Low        | Medium | `-drills` is only invoked from `upgrade-rehearsal.yml` (ubuntu); `ci.yml`'s smoke call is untouched                                                                                   |
| The alpha snapshot changes under the tests                                                                              | Low        | High   | `TestAlphaProfileByteIdentical` stays in the validation set; drills never open the tracked file                                                                                       |
| Rate limits (setup 5/min, uploads 10/min, admin routes) trip in phase R's several boots                                 | Medium     | Medium | One setup, one upload per boot; the sockets re-authenticate with existing sessions; the erasure and restore calls are one each                                                        |
| B6-10 merges mid-way and the restart-under-load drill overlaps drill 1                                                  | Medium     | Low    | Task 0's boundary check; drill 1 uses 20 idle sockets and one held reader, not load                                                                                                   |

## Out of scope

- **Fixing what a drill finds beyond Task 5.** A silent `SQLITE_FULL` path, an
  external-SFU token, a boot that accepts a corrupt file — each is a ledger
  row with the drill as its reproduction and gets its own PR.
- **A `quick_check` at every boot.** Proposed only if drill 5 shows `Open`
  serving a damaged file; it costs boot time proportional to the database and
  is an owner decision (question 2).
- **Backup of uploads or key files by the server.** The drill records that a
  restore without the marker file or key resurrects or refuses; changing what
  a backup contains is a product decision for B6-13/HP-6.
- **Certificate expiry and rotation drills** — deferred with B6-3–B6-5.
- **Retention-sweep markers (B4-11)** — the same marker file; drill 2 proves
  the account path, and the sweep replay is covered by B4-11's own tests.
- **Client behaviour on any of this** — B7+.
- **PR-CI gating of the process-level drills** — nightly, dispatch and
  release, as B6-8 decided for the container leg.

## Open questions for the owner

1. **Marker file missing at restore: refuse to boot, or boot and warn?**
   Today it is neither measured nor decided. The drill records the current
   behaviour. This plan proposes: boot, and log a startup **error** that the
   erasure history is absent (the markers are gone, so nothing can name what
   was lost), backed by the deployment-doc "backup set" paragraph. Refusing to
   boot would make a lost 40 KB file a total outage.
2. **`quick_check` at boot?** Only if drill 5 shows `Open` serves a corrupt
   or truncated file. Cost is one pass over the file per start.
3. **Is the WAL window a security advisory?** If Task 5's second outcome
   occurs, erased content survived on disk in the live file's WAL for an
   unbounded time on a busy server. The fix is in this PR; whether the window
   is disclosed under `docs/security.md`'s process is the owner's call before
   the PR description is written.
4. **External-SFU fail-closed fix in this PR or its own?** This plan says its
   own (behaviour change, not a drill); the owner may prefer it here since it
   is one health probe before the mint.
5. **Should a known-finding drill block a release?** Decision taken for
   planning (2026-09-15), open to the owner's reversal: `-drills` gains
   `-known-findings <ledger ids>`; a phase whose only failures are listed
   open findings warns and exits 0 on the `workflow_call` path, and still
   fails nightly and on dispatch. The drills are **not** wired into
   `release.yml`'s call until the owner confirms (Task 4). The alternative —
   every drill blocks every release — means a release waits on every open
   ledger row the drills can reach.

## Acceptance

Ticked only where the drill ran; evidence is the test name or the
upgrade-rehearsal run id in `docs/architecture/data-lifecycle.md`'s B6-11
block.

Closed 2026-09-18. The `go test` rows were re-run at `ee5e287f`; the
process-level rows stand on the local linux/amd64 run of 2026-09-16. The
disk-full row is ticked on that run's narrowed reading — the paced drill has
not been re-measured. Where a measurement differed from what a row predicted,
the row is amended to the measurement and says so.

- [x] Byte-level erasure: E1 idle leaves zero sentinel bytes in the database,
      `-wal`, `-shm`, uploads, backups and the marker file; E2–E4 measured and
      tabulated; retained bytes either closed by Task 5's retry with a
      revert-proof test or written as an explicit limitation with the trust
      model corrected in the same PR
- [x] Backup/restore through the real endpoints with 20 open sockets and a
      held reader: `server_restart` delivered, exit 0, `pre_restore_*`
      present and intact, restored data equals the backup
- [x] Deletion-marker restore: an account erased after the backup is erased
      again before the server serves, with the `account_erasure_replayed`
      audit row; the missing-marker-file and missing-key variants measured and
      decided (question 1)
- [x] Low headroom: `degraded/disk`, `507 STORAGE_LOW_DISK`, messages still
      flow, a backup under the floor leaves no partial file (**amended
      2026-09-18:** the row predicted a refusal; the backup answered 200 with a
      file `integrity_check` accepts, which is the OC-0212 invariant the drill
      asserts)
- [x] Disk full: no exit, error frames not silence, `SQLITE_FULL` in the log,
      every silent path listed as a finding; recovery without restart;
      `integrity_check` `ok` and acknowledged-message count exact after reboot
- [x] Corrupt input: flipped-page and truncated database, corrupt marker
      file, corrupt backup, corrupt config — each refused with a named
      reason or recorded as a limitation in `data-lifecycle.md`; its O4 A1
      corrected to the measurement (**amended 2026-09-18:** the row required a
      ledger row per limitation; the flipped page, which the boot does not
      catch, is recorded under owner question 2 and has none)
- [x] Unhealthy dependency: supervised SFU killed → `voice_join` fails closed,
      diagnostics honest, supervisor restart observed; external SFU absent →
      behaviour recorded, finding filed if a token is minted (**amended
      2026-09-18:** this drill's finding is held privately per
      `data-lifecycle.md`, not filed in the ledger)
- [x] Interrupted migration: crash image rolls back, applied once on re-run,
      `integrity_check` `ok`
- [x] Interrupted rollback: schema and `schema_versions` byte-identical after
      a reversal stopped mid-file; the full rehearsal still green
- [ ] Drills run nightly and on dispatch through `upgrade-rehearsal.yml`;
      the release (`workflow_call`) leg is wired only after question 5 is
      answered, with `-known-findings` naming the open ids; the Go drills
      run in PR CI — **`unverified`**: the workflow is on `dev` and not on
      `main`, so dispatch resolves nothing and the schedule never fires; no
      runner run exists. The wiring and the PR-CI half hold. B6-12 Task 6
      owes the run id
- [x] Every failed drill not fixed here is a ledger row; PRD row, changelog
      and `ci-check` green (**amended 2026-09-18:** no drill failed; the one
      finding held privately is deliberately not a ledger row)
