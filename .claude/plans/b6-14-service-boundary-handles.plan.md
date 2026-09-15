# Plan: B6-14 — Service-boundary handle reconciliation

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-14 — Service-boundary handle reconciliation (roadmap workstream 17, the 2026-09-06 "B3-0/B3-8" audit carryover)
**Satisfies**: PRD row B6-14 (`prd.md:151`): "Every direct database-handle use, not only imports, has a named service, adapter or transaction-boundary owner, and the guard rejects unclassified access — with replay locking and persister ordering preserved". Must land before HP-6 (`prd.md:157-158`)
**Complexity**: Medium
**Drafted**: 2026-09-15 at `dev` `96258158`; B6-10 is in flight on `feat/b6-10-operational-measurements` and touches one inventory row (`api/router.go`, see the claims table) — nothing else this plan edits is on that branch

## Summary

B3-0 built a guard on **imports**: a production file above the domain layer
that imports `Server/db` needs a row in `DBImportAllow`
(`Server/invariants/db_import_boundary.go:45-115`), and
`Server/cmd/dbinventory` prints what each importer does with the package. B3-8
drove the `move` disposition to zero. The carryover's point is that this proves
the wrong thing: the handle is stored on `Hub.db` (`Server/ws/hub.go:25`), on
`App.database` (`internal/app/app.go:63`) and on the maintenance worker
(`internal/app/maintenance.go:23`), so any file in those packages can call
`h.db.X` **without importing `db` at all** — and the inventory never looks at a
file that has no import (`cmd/dbinventory/main.go:121-124`).

The census below found exactly that shape twice, plus one `adapter` row that
makes a handle call the disposition says it must not, plus two `adapter` rows
that pass the bare handle where a seam already exists. Seven sites in five
files. B6-14 gives each an owner, pins every `boundary` row to the exact
multiset of handle calls it makes (the `authz-chokepoint` pattern), makes the
existing two gates reject the unclassified shapes, and leaves the replay
critical section and the persister/close ordering byte-for-byte where they are.

**No new rule, no new binary, no new framework.** The guard is the pair that
already runs in CI — `db-import-boundary` (`go test ./...`, `ci.yml:165`) and
`TestServerBoundariesDocIsCurrent` (`go test -count=1 ./cmd/dbinventory/`,
`ci.yml:175`, `scripts/run.mjs:112`) — with one struct extended and one blind
spot removed.

| #   | Row asks for                     | What is done                                                                                                                                                                                                       | Instrument                                                          |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | handle **use**, not only imports | the inventory analyses every production file in a package that holds a `*db.DB` field, not only importers; a file that calls the handle without importing `db` becomes a row                                       | `cmd/dbinventory/main.go` `inventory`/`analyze`                     |
| 2   | a named owner per access         | `DBImportEntry` gains `Calls` (exact method multiset) and `Hands` (exact hand-off multiset); `adapter` rows must measure empty; `boundary` rows must measure exactly what they pin                                 | `invariants/db_import_boundary.go`, `TestDBImportAllowIsLive`       |
| 3   | the guard rejects unclassified   | the doc gate exits 1 on a call in an unlisted file, a call in an `adapter` row, or a multiset that drifted; `db-import-boundary` rejects the per-file-visible shapes (`*sql.Tx`/`*sql.DB`, `SQLDb()`, `BeginTx()`) | `printTable` problems, `checkDBImportBoundary`                      |
| 4   | replay locking preserved         | the two replay-purge deletes stay direct and inside `seqMu`; their row pins them; `-tags deadlock` and `-race` on `./ws/` stay green                                                                               | `DBImportAllow["ws/hub_events.go"].Calls`, `run.mjs:106`            |
| 5   | persister ordering preserved     | nothing moves `persistEvent` out of the broadcast critical section or reorders the close steps; the plan names the four ordering facts and touches none                                                            | `hub_broadcast.go:390-421`, `app.go:125-135`                        |
| 6   | the inventory document           | block regenerated, a "Handle carriers" table for the interface-carried hand-offs, prose counts re-pointed                                                                                                          | `docs/architecture/server-boundaries.md:214`, `doc_test.go` regexes |

## Verify before you implement

Facts established from source at `96258158` (and the B6-10 branch where
noted). Rows marked **Refuted**, **Corrected** or **Unknown** contradict
something the roadmap, the PRD, the boundaries document or an obvious first
design would assume, and the plan is built on the correction.

| Claim                                                                     | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The guard checks imports only                                             | **Confirmed** | `db_import_boundary.go:127-147`: `checkDBImportBoundary` returns on a listed file, otherwise scans `f.Imports` for the `db` path. No call is inspected                                                                                                                                                                                                                                                              |
| The inventory counts `*db.DB` method calls                                | **Corrected** | It does (`main.go:323-347`) — but only in files that import `db`: `inventory` skips a file whose `dbAlias` is empty (`main.go:121-124`). A file that reaches the handle through a package field and never names the type is not a row                                                                                                                                                                               |
| Every file that calls the handle is in the inventory                      | **Refuted**   | `ws/hub_events.go:173,213` (`h.db.DeleteEventsForMessages`, `h.db.DeleteEventsForUser`) and `ws/moderation_queue.go:88,111` (`h.db.GetReport`, `h.db.GetAppeal`) import no `db` (`hub_events.go:3-13`) and have no row. Both are invisible to both gates today                                                                                                                                                      |
| `adapter` means "no persistence call" and that is enforced                | **Refuted**   | The definition is at `db_import_boundary.go:25-26`; nothing compares the measured calls column to the disposition. Live run: `ws/serve_ready.go` is `adapter` with `MessageDeliveryFloorMS` (`serve_ready.go:422`, `h.db.MessageDeliveryFloorMS()`)                                                                                                                                                                 |
| `adapter` rows reach the handle only through their named seam             | **Refuted**   | `ws/hub_visibility.go:400` passes `h.db` to `computeAllowedChannels(ctx, database VisibilityReader, …)` (`:474`) while the same function read the user through `h.readers.Visibility` three lines earlier (`:397`); `ws/deps.go:224` passes `h.db` to `subjectFor(ctx, database DispatchReader, …)` (`:205`). Same handle, bare instead of narrowed — the row's own note (`db_import_boundary.go:96,106`) says seam |
| `service/` makes no raw handle use                                        | **Confirmed** | grep of `service/` for `SQLDb`, `SQLReaderDb`, `*sql.DB`, `*sql.Tx`, `BeginTx`, `dbgen.`, `"database/sql"`: 0 hits. Services see `service.Store` (`service/datastore.go:11-20`), which `*db.DB` satisfies; `service.New(st Store, …)` (`service/service.go:68`)                                                                                                                                                     |
| `dbgen` is used outside `db/`                                             | **Refuted**   | 0 production hits outside `Server/db/`. The sqlc layer is fully encapsulated by `db.DB.q` (`db/db.go:43,292`)                                                                                                                                                                                                                                                                                                       |
| Raw `*sql.DB` / `*sql.Tx` escapes are widespread                          | **Refuted**   | Three files: `admin/handlers_backup.go:269` (`SQLDb().ExecContext` for `wal_checkpoint(TRUNCATE)`), `api/router.go:552` (`SQLDb().Stats()`; `:553` `SQLReaderDb().Stats()` on the B6-10 branch only), `cmd/seed/profile_alpha.go:186` (`BeginTx`) with `*sql.Tx` threaded through eight funcs (`:290,337,407,515,534,611,647,676`) and twelve `tx.Exec` sites. All three are `boundary` rows already                |
| `database/sql` imports outside `db/` are all handle use                   | **Corrected** | Four importers; two are not handles: `api/metrics_handler.go:103-104` (`sql.DBStats` values) and `api/plugins_handler.go:185` (`sql.ErrNoRows`). The rule must key on `*sql.DB`/`*sql.Tx`/`*sql.Conn` types and the accessor methods, not on the import                                                                                                                                                             |
| The `*db.DB` wrapper methods are used outside `db/`                       | **Confirmed** | `cmd/gendocs/main.go:440,470` (`QueryContext`), `cmd/seed/main.go:332`, `cmd/seed/profile_alpha.go:173,253,261` — all `boundary` rows; `db.go:429-457` is the wrapper surface (`QueryRowContext`, `ExecContext`, `QueryContext`, `BeginTx`)                                                                                                                                                                         |
| B3-8's exit criterion still holds                                         | **Confirmed** | Live `go run ./cmd/dbinventory`: `Dispositions: adapter 42, boundary 20`, `move` 0, 62 rows, 41 type-only, 0 unlisted                                                                                                                                                                                                                                                                                               |
| The 2026-09-06 audit is a document in `docs/`                             | **Refuted**   | No `docs/audit-2026-09-06*` exists (newest is `audit-2026-08-23-*`). The carryover lives only as roadmap item 17 (`repo-health-roadmap-2026-08-23.md:836-841`), PRD row B6-14 (`prd.md:151`) and the PRD's "three audit carryovers dated 2026-09-06" sentence (`prd.md:28`). What evidence it examined is **unknown**; this plan's census is the evidence                                                           |
| The handle reaches `ws` only through `HubOptions.DB`                      | **Corrected** | Also `ws.DBReaders(database)` (`internal/app/hub.go:56` → `readers.go:108-110`, all four seams wired to the same `d`), `ws.NewEventPersister(database, …)` (`persistence.go:33`), `hub.SetEventStore(database)` (`:41`), `ws.StartEventPruner(bgCtx, database, …)` (`:45`). And once stored on `Hub.db` (`hub.go:25`) every `ws` file can call it                                                                   |
| The handle reaches `plugin/`, `auth/`, `permissions/` as a handle         | **Corrected** | As interfaces: `plugin.Config.Store` is `PluginStore` (`plugin/registry.go:35`, `pluginstore.go:12`); `auth.NewPersistentRateLimiter(store LockoutPersister)` (`auth/ratelimit.go:98`); `permissions.NewChecker(db DB)` (`permissions/checker.go:45,63`). Their call sites (`plugin/host_storage.go:40-56`, `registry.go:198,523,541`, `ratelimit.go:220,285,337`) are seam calls, not handle calls                 |
| Persister enqueue happens inside the broadcast critical section           | **Confirmed** | `hub_broadcast.go:390-421`: under `seqMu` — `nextSeq` (`:416`) → `replayBuf.Push` (`:420`) → `persistEvent` (`:421`) → `Enqueue` (`hub_events.go:339`); `event_persister.go:142-144` documents that `Enqueue` runs under the caller's `seqMu` and must never block                                                                                                                                                  |
| Reconnect replay registers under the same lock                            | **Confirmed** | `replay.go:421-487` `reconnectRegister` takes `h.seqMu` (`:431`) "inside the SAME critical section deliverBroadcast uses"; the cold-tier read goes through `h.eventStore.Load()` (`:297`), outside it                                                                                                                                                                                                               |
| The replay purge's database delete is inside `seqMu` on purpose           | **Confirmed** | `hub_events.go:186-216` `PurgeUserFromReplay`: `awaitDispatch` → `persister.Flush` → `seqMu.Lock` → tombstone, watermark, ring drop, `h.db.DeleteEventsForUser` — the doc comment says "in the order the pipeline runs … under seqMu — so no broadcast is sequenced in between". `PurgeMessagesFromReplay` (`:151-183`) is the same shape                                                                           |
| Routing those deletes through `EventStore` would be a pure refactor       | **Refuted**   | `h.eventStore` is set only when `cfg.EventPersistence.Enabled` (`persistence.go:29-31,41`); `h.db` is set whenever a database exists. A purge gated on the store seam would skip the delete on a server that persisted rows in an earlier enabled boot — an erasure regression (HP-4 decision 1). The deletes stay on the direct handle and are **pinned**, not moved                                               |
| Shutdown order: persistence and audit drain before the handle closes      | **Confirmed** | `app.go:125-135` (audit writer stops before `database.Close`; persistence cancels `bgCtx` and joins the pruner before it); `persistence.go:54-72` `stopEventPersister`. Task 2 touches no closer                                                                                                                                                                                                                    |
| The lock order is recorded in `hub.go`'s package comment (B3-5's promise) | **Unknown**   | `server-boundaries.md:385-390` says B3-5 would record it there; grep of `ws/` finds only per-site edge comments (`voice_e2ee.go:44`, `replay.go:99`, `hub_registry.go:147`). Not B6-14's to write — the plan adds no lock edge, which is the property that matters here                                                                                                                                             |
| A symbol-keyed exact-multiset allowlist already exists to mirror          | **Confirmed** | `authz_chokepoint.go` `AuthzResidueEntry.Calls` — "the exact multiset of raw helper calls the symbol may contain … one with fewer fails TestAuthzResidueAllowIsLive, which compares the multiset exactly". Same shape, keyed by file here because the inventory is per file                                                                                                                                         |
| Both gates run in CI and locally                                          | **Confirmed** | `ci.yml:165` `go test -tags deadlock -count=1 ./...` (includes `./invariants/`); `ci.yml:174-175` "Run document gates (-count=1)" → `./cmd/dbinventory/`; `run.mjs:106,112`; `Makefile:32`                                                                                                                                                                                                                          |
| The doc gate's prose regexes survive a changed summary line               | **Refuted**   | `doc_test.go:167` `summaryRe` anchors on `^(\d+) files import …`; `:229-239` pin "down/up from N rows to M", "N of the M rows are type-only, K of them adapter", "Type-only rows (N, of which K are adapter)". Adding no-import rows changes N and the sentence — every pattern must be re-pointed in the same PR or the gate fails, and the test says so on purpose (`:245`)                                       |
| B6-10 leaves the inventory document consistent                            | **Refuted**   | On `feat/b6-10-operational-measurements`, `db.go:472` adds `SQLReaderDb` and `router.go:553` calls it; the live run's `api/router.go` row reads `PingRead SQLDb SQLReaderDb` while `server-boundaries.md:214` still reads `PingRead SQLDb`. `TestServerBoundariesDocIsCurrent` will fail on that branch until the block is regenerated — B6-10's fix, told to it in Task 0, not made here                           |
| `.claude/plans/` is tracked and Prettier-gated                            | **Confirmed** | `.gitignore:9-18` whitelist; PRD decision 2026-09-08                                                                                                                                                                                                                                                                                                                                                                |

### The census

Production Go outside `Server/db/`, `_test.go` excluded, at `96258158`. This
is the plan's evidence for "handle use, not only imports".

| Package        | Import rows (live run) | Handle **calls** the inventory sees                                                                                                 | Handle use the inventory does **not** see                                                                                                                                             | Raw `*sql.*`                                                         |
| -------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `admin`        | 12 (8 type-only)       | `backup_maintenance.go` `BackupToSafe`; `handlers_backup.go` `BackupToSafe×2 Close LogAudit SQLDb`; `update_handlers.go` `LogAudit` | —                                                                                                                                                                                     | `handlers_backup.go:269` `SQLDb().ExecContext(wal_checkpoint)`       |
| `api`          | 16 (14 type-only)      | `router.go` `PingRead SQLDb` (+`SQLReaderDb` on B6-10)                                                                              | —                                                                                                                                                                                     | `router.go:552-553` `.Stats()` only                                  |
| `auth`         | 2 (2 type-only)        | —                                                                                                                                   | `ratelimit.go:220,285,337` through `LockoutPersister` (seam)                                                                                                                          | —                                                                    |
| `internal/app` | 7 (3 type-only)        | `database.go` 2; `erasure.go` `Close×2`; `maintenance.go` 6; `persistence.go` 4                                                     | **hand-offs**: `hub.go:40,46,52,56`; `persistence.go:33,41,45`; `plugins.go:23` — eight places the bare handle is passed to another package                                           | —                                                                    |
| `plugin`       | 1 (type-only)          | —                                                                                                                                   | `host_storage.go:40,48,56`, `registry.go:198,523,541` through `PluginStore` (seam)                                                                                                    | —                                                                    |
| `service`      | 0 (excluded layer)     | n/a                                                                                                                                 | everything through `service.Store` (`datastore.go:20`)                                                                                                                                | **0**                                                                |
| `ws`           | 20 (16 type-only)      | `serve_ready.go` `MessageDeliveryFloorMS` — an **`adapter` row with a call**                                                        | **no row**: `hub_events.go:173,213` (2 calls, under `seqMu`), `moderation_queue.go:88,111` (2 calls); **bare hand-off from an `adapter` row**: `hub_visibility.go:400`, `deps.go:224` | —                                                                    |
| `cmd/seed`     | 2 (0 type-only)        | `main.go` 9 typed calls + `QueryRowContext`; `profile_alpha.go` `BeginTx ExecContext×2 QueryRowContext`                             | —                                                                                                                                                                                     | `profile_alpha.go:186` `BeginTx`; `*sql.Tx` in 8 funcs; 12 `tx.Exec` |
| `cmd/gendocs`  | 1                      | `Close×2 QueryContext×2`                                                                                                            | —                                                                                                                                                                                     | —                                                                    |
| `.` (root)     | 1 (`token_cli.go`)     | `Close`                                                                                                                             | —                                                                                                                                                                                     | —                                                                    |

Fields typed `*db.DB` outside `db/`: `internal/app/app.go:63`,
`internal/app/maintenance.go:23`, `ws/hub.go:25`, `ws/hub_options.go:28`.
Files in those packages that call through the field **without importing
`db`**: two, both in `ws` (above). `internal/app` has none — every file that
touches `a.database` also imports `db`.

**Measured violations under the extended guard, at HEAD: 5 files, 7 sites.**
Three shapes: an `adapter` row making a call (1 site), a call in a file with
no row (4 sites), an `adapter` row handing the bare handle where its own seam
exists (2 sites). Thirteen `boundary` rows make calls and become pinned rather
than flagged.

### What the corrections change

- **The blind spot is a package-field shape, and the fix is in the
  measurement, not a new rule.** `dbinventory` already has the two-pass
  package walk that finds `*db.DB` fields (`main.go:95-115`); it only needs
  to stop skipping non-importers. The invariants rule is per-file and cannot
  see `h.db`, so the doc gate — which runs in CI already — is where
  unclassified field access is rejected. The per-file rule takes only what a
  single file can prove: `*sql.Tx`/`*sql.DB`/`*sql.Conn` types, and
  `SQLDb()`/`SQLReaderDb()`/`BeginTx()` calls, in a file that is not
  `boundary`.
- **`hub_events.go` is a `boundary` row, not a seam conversion.** The
  replay-purge deletes are part of a critical section whose order is the
  erasure guarantee. They stay direct, inside `seqMu`, and the row pins the
  exact two calls so moving one is a reviewable edit of the allowlist, never a
  side effect.
- **`moderation_queue.go` is a seam conversion, not a service call.**
  `ReportService.Get` / `AppealService.Get` (`service/report.go:536`,
  `appeal.go:442`) take an actor and apply confidentiality; a hub broadcast
  resolving its audience has no actor. Two methods on `DispatchReader`
  (`readers.go:71`) — the consumer-side seam pattern the channel family's part
  3 chose by owner decision — keep the semantics and make the row an
  `adapter` with zero direct calls.
- **The audit's evidence is unknown, so the census is written into the
  document.** The carryover names no file; the reconciliation is only
  checkable if the document says what was counted and how.
- **B6-10 gets a heads-up, not a fix.** Its `SQLReaderDb` accessor is a new
  handle escape (`db.go:468-474`) used at one `boundary` row; the row's pin
  will include it once that branch merges. Regenerating the block is B6-10's
  duty on its own branch.

## Patterns to Mirror

| Category                           | Source                                                          | Pattern                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact call multiset per row        | `Server/invariants/authz_chokepoint.go` `AuthzResidueEntry`     | `Calls calls` — helper → count; extra or different call fails the rule at the line, fewer fails the liveness test; raising a count is an allowlist edit |
| Row liveness in both directions    | `Server/invariants/db_import_boundary_test.go:85-112`           | every row must name a file that exists and still does what the row says; unknown disposition and missing reason are failures                            |
| Doc gate derives counts from block | `Server/cmd/dbinventory/doc_test.go:159-209`                    | tallies are read out of the generated block, never recomputed, so one classification lives in one program                                               |
| Prose count patterns must match    | `doc_test.go:218-261`                                           | a reworded sentence is a failure, not a pass — re-point the regex when the sentence changes                                                             |
| Receiver detection                 | `cmd/dbinventory/main.go:282-347`                               | `collectDBVars` + `dbDBFields` + `countMethodCalls` — the only `*db.DB` receiver logic in the tree; extend, do not duplicate                            |
| Consumer-side read seam            | `Server/ws/readers.go:23-110`, `internal/app/hub.go:56`         | interface in `ws`, `*db.DB` satisfies it, `DBReaders` wires all seams to the same handle at the composition root; the row names the seam                |
| Handle narrowed at the call        | `ws/hub_visibility.go:397` (`h.readers.Visibility.GetUserByID`) | the file already does it right three lines above the site it does it wrong                                                                              |
| RED proof for a rule change        | B3-0 evidence, `b3-…-2026-08-29.md:171-181`                     | a probe file / probe edit that must turn the gate red, then deleted; `git status` clean in the PR text                                                  |
| Ordering facts named, not touched  | `internal/app/app.go:125-135`                                   | three ordering facts written into the close comment; this plan's Task 2 cites them and changes none                                                     |
| Regenerate, never hand-edit        | `server-boundaries.md:36-39`                                    | `cd Server && go run ./cmd/dbinventory`, paste between the markers, `npx prettier --write`                                                              |

## Files to Change

| File                                                                                       | Action | Why                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server/invariants/db_import_boundary.go`                                                  | UPDATE | `DBImportEntry` gains `Calls` and `Hands` (exact multisets); two new rows (`ws/hub_events.go` boundary, `ws/moderation_queue.go` — none, see Task 2); 13 `boundary` rows pinned; `checkDBImportBoundary` gains the per-file raw-handle check |
| `Server/invariants/db_import_boundary_test.go`                                             | UPDATE | liveness accepts "imports `db` **or** pins calls"; `adapter`/`remove` rows must pin nothing; RED cases for the raw-handle shapes                                                                                                             |
| `Server/invariants/invariants.go`                                                          | —      | untouched: the registry (`:65`) already lists `dbImportBoundary`                                                                                                                                                                             |
| `Server/cmd/dbinventory/main.go`                                                           | UPDATE | analyse every production file in a package that declares a `*db.DB` field; record hand-offs; compare measured multisets to the row; new problem classes in `printTable`                                                                      |
| `Server/cmd/dbinventory/doc_test.go`                                                       | UPDATE | `summaryRe` and the three prose patterns re-pointed to the new sentences; a fourth pattern for the "no-import" count                                                                                                                         |
| `Server/cmd/dbinventory/main_test.go`                                                      | UPDATE | fixtures for: field call without import, adapter with a call, boundary multiset drift, hand-off recorded                                                                                                                                     |
| `Server/ws/readers.go`                                                                     | UPDATE | `ReadySnapshotReader` + `MessageDeliveryFloorMS() int64`; `DispatchReader` + `GetReport`, `GetAppeal`                                                                                                                                        |
| `Server/ws/serve_ready.go`, `ws/hub_visibility.go`, `ws/deps.go`, `ws/moderation_queue.go` | UPDATE | one token per site: `h.db` → the named seam (4 sites, 5 calls)                                                                                                                                                                               |
| `Server/ws/hub_events.go`                                                                  | —      | **untouched**; pinned by its new row                                                                                                                                                                                                         |
| `docs/architecture/server-boundaries.md`                                                   | UPDATE | regenerated block; "Handle carriers" table; the measurement section's two new sentences; prose counts; a B6-14 paragraph in the running header                                                                                               |
| `CHANGELOG.md`, `docs/plans/b6-*.prd.md`                                                   | UPDATE | unreleased entry; B6-14 row → `in-progress` now, `complete` + this link at the end                                                                                                                                                           |

No new rule id, no new command, no new test file in `invariants/`. Runtime
behaviour changes in exactly zero code paths: every seam the four `ws` sites
switch to resolves to the same `*db.DB` (`readers.go:109`), and the two
replay-purge deletes do not move.

## Tasks

### Task 0: Branch, PRD row, the B6-10 boundary, the RED baseline

- **Action**: branch `feat/b6-14-service-boundary-handles` from `dev`. Flip
  the PRD row to `in-progress` with this plan linked. Run
  `git diff --stat dev...feat/b6-10-operational-measurements` — expected:
  `Server/api/router.go`, `Server/db/db.go`, `Server/api/metrics_handler.go`
  (+test), `Server/scripts/k6/ws-load.js`, `docs/api.md`,
  `docs/deployment.md` and the PRD; no workflow file; none of this plan's
  files. Leave a note on the B6-10 PR that its `api/router.go` row now reads
  `PingRead SQLDb SQLReaderDb`, that `TestServerBoundariesDocIsCurrent` is
  red on that branch today, and that the block at
  `server-boundaries.md:214` must be regenerated there.
  Record the RED baseline before any code moves: the measured 5 files / 7
  sites above, from `go run ./cmd/dbinventory` **after Task 1** and from a
  grep **before** it (the grep is the proof that Task 1 measures what the
  census found and nothing else).
- **Why**: the carryover says an import-only pass is insufficient evidence;
  the PR must show the before-state the extended guard is red on.
- **Validate**: `npm run format` clean; PRD row renders.

### Task 1: Measure handle use, not imports — `dbinventory` and `DBImportEntry`

- **Action**:

  **`invariants/db_import_boundary.go`.** `DBImportEntry` gains two fields,
  both exact multisets in the `AuthzResidueEntry.Calls` sense:

  ```go
  // Calls is the exact multiset of *db.DB method calls the file may make
  // (method name → count), including the raw accessors SQLDb, SQLReaderDb,
  // BeginTx and the ExecContext/QueryContext/QueryRowContext wrappers.
  // adapter and remove rows pin nothing and must measure nothing.
  Calls map[string]int
  // Hands is the exact multiset of callees the file passes the bare handle
  // to (callee → count): the composition root's wiring. A hand-off is a
  // handle use — the callee's parameter type is the owner it names.
  Hands map[string]int
  ```

  The 13 `boundary` rows that make calls are pinned from the live run (the
  table under "The census"); the 8 hand-offs in `internal/app` are pinned on
  `hub.go` (`auth.NewPersistentRateLimiter`, `service.New`, `ws.DBReaders`,
  `ws.NewHub` via `HubOptions.DB` — record the composite literal as a hand-off
  to `ws.HubOptions`), `persistence.go` (`ws.NewEventPersister`,
  `(*ws.Hub).SetEventStore`, `ws.StartEventPruner`) and `plugins.go`
  (`plugin.Config`). Two rows are added: `ws/hub_events.go` —
  `{"boundary", "", "replay purge: ring drop and persisted-row delete are one seqMu critical section (HP-4 decision 1); the handle stays direct so the delete is never gated on the persistence seam being wired", Calls: {DeleteEventsForMessages: 1, DeleteEventsForUser: 1}}`
  — and, if the owner answers question 1 the other way, `ws/moderation_queue.go`.

  `checkDBImportBoundary` gains the per-file half, after the import check,
  for any listed file whose disposition is not `boundary` and any unlisted
  file: a `*sql.DB`, `*sql.Tx` or `*sql.Conn` type expression, or a call
  whose selector is `SQLDb`, `SQLReaderDb` or `BeginTx` on an identifier
  `collectDBVars` resolves, is a violation with sub-id
  `db-handle-owner`. A sub-id, not a new rule: the registry already keys
  allow comments on what the rule emits (`v.Rule`), not on `r.ID`, exactly
  so a rule can report a sub-id (`invariants.go:218-222`) — one registry
  entry, one document, and an `//invariant:allow` must name
  `db-handle-owner`. To keep one implementation, `isDBPtr`,
  `collectDBVars` and `countMethodCalls` move from `cmd/dbinventory` into
  `invariants` as exported helpers (`DBHandleVars`, `DBHandleCalls`) and the
  command imports them — it already imports `invariants` (`main.go:386`).

  **`cmd/dbinventory/main.go`.** `inventory` no longer skips a file with no
  `db` import when its package (`fieldsByPkg[dir]`) declares a `*db.DB`
  field: `analyze` runs on it with an empty alias, and it becomes a row iff it
  records at least one call or hand-off. `countMethodCalls` also records
  **hand-offs**: a `*ast.CallExpr` argument that is a resolved `*db.DB`
  identifier or a `*db.DB` field selector adds the callee's printed form
  (`pkg.Func`, `pkg.Type` for a composite literal field, `(*T).Method`) to a
  new `hands` map. `printTable` gains a `Hands` column and four problem
  classes beside unlisted/stale: **unlisted-by-use** (a row with no import
  and no entry), **adapter-makes-calls** (entry `adapter`/`remove` with a
  measured non-empty `Calls` or `Hands`), **calls-drifted** and
  **hands-drifted** (entry multiset ≠ measured multiset, either direction).
  Each prints a line naming the file, the measured multiset and the pinned
  one; the exit code and `TestServerBoundariesDocIsCurrent` (`doc_test.go:44-47`)
  already fail on any problem count.

  The summary line becomes
  `N files use `db`outside`db/`and`service/` (… ); I import it, U use the handle without importing it; T are type-only; P unlisted.`
  and `doc_test.go`'s `summaryRe` (`:167`) and the three prose patterns
  (`:229-239`) are re-pointed in the same commit, plus one for `U`.

  **RED proof**, B3-0 style, recorded in the PR: (1) add
  `_ = h.db.GetUserByID` in a `ws` file with no row → unlisted-by-use; (2)
  add `database.SQLDb()` to `api/dm_handler.go` → `db-handle-owner` from the
  rule **and** adapter-makes-calls from the gate; (3) delete one call from
  `internal/app/maintenance.go` → calls-drifted. Each reverted, `git status`
  clean.

- **Why**: PRD "not only imports" and "the guard rejects unclassified
  access". The census shape that escaped was the package field; the
  measurement is where it is caught.
- **Gotcha**: `TestDBImportAllowIsLive` (`db_import_boundary_test.go:93-95`)
  currently requires every row's file to contain the `db` import string. It
  must accept a row whose file has no import but a non-empty `Calls`, and
  must **still** reject a row with neither — the list only shrinks. Also:
  `parser.ParseFile` with mode 0 (`main.go:99`) drops comments, so the
  `//invariant:allow` hatch is not available to the doc gate — that is
  deliberate; a doc-gate problem is fixed by classifying, never by
  suppressing.
- **Mirror**: `authz_chokepoint.go` `AuthzResidueEntry`;
  `db_import_boundary_test.go:85-112`.
- **Validate**: `go test ./invariants/` red on HEAD with exactly the 5 files
  / 7 sites listed (the per-file rule sees 0 of them — all seven are field
  shapes — and `go test -count=1 ./cmd/dbinventory/` sees all seven: 2
  unlisted-by-use files, 1 adapter-makes-calls file with a call, 2
  adapter-makes-calls files with a hand-off). Unit fixtures in `main_test.go`
  for each problem class.

### Task 2: Give the seven sites an owner — without moving a lock or a delete

- **Action**, one token per site:
  - `ws/serve_ready.go:422`: `h.db.MessageDeliveryFloorMS()` →
    `h.readers.Ready.MessageDeliveryFloorMS()`; add
    `MessageDeliveryFloorMS() int64` to `ReadySnapshotReader`
    (`readers.go:49`). `service.Store` already lists it (`datastore.go:37`)
    and `*db.DB` satisfies it. Keep the `if h.db != nil` guard at `:421` as
    is — it is a nil test, not a call, and bare test hubs rely on it.
  - `ws/hub_visibility.go:400`: `h.computeAllowedChannels(ctx, h.db, user)`
    → `h.computeAllowedChannels(ctx, h.readers.Visibility, user)` — the
    parameter is already `VisibilityReader` (`:474`); `:397` already reads
    through the seam.
  - `ws/deps.go:224`: `subjectFor(ctx, h.db, …)` →
    `subjectFor(ctx, h.readers.Dispatch, …)` — the parameter is already
    `DispatchReader` (`:205`).
  - `ws/moderation_queue.go:88,111`: `h.db.GetReport` / `h.db.GetAppeal` →
    `h.readers.Dispatch.GetReport` / `.GetAppeal`; add both signatures to
    `DispatchReader` (`readers.go:71`) with the doc line "audience resolution
    for queue broadcasts: no actor, so the actor-scoped service `Get` does not
    apply". The `h.db == nil` guards at `:85,108` stay. The file gains **no**
    row: after the change it imports nothing from `db` and calls the handle
    nowhere. (If the owner prefers the service route — question 1 — the file
    instead calls `h.services.Reports`/`Appeals` with a system actor, and
    that is a behaviour change with its own tests.)
  - `ws/hub_events.go:173,213`: **no change.** The row added in Task 1 pins
    the two deletes. The plan's assertion about them is the four ordering
    facts, each cited and each untouched:
    1. broadcast: `seqMu` → `nextSeq` → `replayBuf.Push` → `persistEvent`
       (`hub_broadcast.go:390-421`; `hub_events.go:322-339`);
    2. resume: `reconnectRegister` under the same `seqMu`
       (`replay.go:431-487`); cold-tier read via `eventStore` outside it
       (`:297`);
    3. purge: `awaitDispatch` → `persister.Flush` → `seqMu{tombstone,
watermark, ring drop, h.db.Delete…}` (`hub_events.go:151-216`);
    4. close: persister `Stop` + pruner join, then audit writer, then
       `database.Close` (`app.go:125-135`, `persistence.go:54-72`).

  Regenerate the block; `DBReaders` (`readers.go:108-110`) needs no change —
  every seam is still the same `d`.

- **Why**: PRD "named service, adapter or transaction-boundary owner" per
  access; roadmap "preserve replay locking and persister ordering when
  assigning ownership". Three sites were already narrowed in intent and
  bare in code; two were unclassified reads with a seam pattern waiting; two
  are a critical section that is correct as written and now cannot drift
  unreviewed.
- **Gotcha**: `HubReaders` interfaces holding a nil `*db.DB` are non-nil
  interfaces — a test hub built with `DBReaders(nil)` would pass the seam's
  nil check and panic inside `MessageDeliveryFloorMS` (an atomic load on a
  nil receiver). Check how `ws` tests construct bare hubs before relying on
  the seam's nil-ness; keep the `h.db != nil` guards for exactly that reason.
- **Mirror**: `hub_visibility.go:397`; `readers.go:23-88` seam doc comments.
- **Validate**: `go test -race -count=1 ./ws/`;
  `go test -tags deadlock -count=1 ./ws/` (`run.mjs:106`); `go run
./cmd/dbinventory` exits 0 with 0 problems; `go test ./invariants/` green;
  `TestHP4_*` (`db/hp4_drills_test.go`) green — the purge path's tests.

### Task 3: The document — what was counted, how, and the carriers

- **Action**: `docs/architecture/server-boundaries.md`:
  - a dated paragraph in the running header (the `Re-measured:` list at
    `:4-35`): 2026-09-15 (B6-14) — the inventory now analyses every file in
    a package holding a `*db.DB` field; two files used the handle without a
    row (`ws/hub_events.go`, `ws/moderation_queue.go`), one `adapter` row
    made a call, two handed the bare handle past their seam; the counts
    after: 63 rows (62 + `hub_events.go`), `boundary` 21, `adapter` 42;
  - "How the measurement works" (`:137-181`): the two new sentences — a file
    with no import is analysed when its package declares a `*db.DB` field;
    `Hands` records where the composition root passes the handle; the
    "shape the walker cannot see" paragraph (`:156-163`) rewritten to what
    it cannot see **now** (a handle stored in an `any`/interface field and
    called through it — none in the tree, and `Hands` names every place one
    could start);
  - a **Handle carriers** table after the block: interface → declared at →
    wired at → what it narrows to — `service.Store` (`datastore.go:20`,
    `hub.go:46`), `ws.HubReaders` (`readers.go:90`, `hub.go:56`),
    `ws.EventStore` (`eventstore.go:14`, `persistence.go:33,41,45`),
    `plugin.PluginStore` (`pluginstore.go:12`, `plugins.go:23`),
    `auth.LockoutPersister` (`ratelimit.go:98`, `hub.go:40`),
    `permissions.DB` (`checker.go:45`, via `service.Store`). The measured
    `Hands` column is the generated half; this table is the judged half —
    the same split the shape/disposition columns already make (`:165-170`);
  - the disposition table (`:86-91`) and every prose count `doc_test.go`
    pins, updated;
  - the regenerated block.
- **Why**: the audit's evidence is unknown; the document is where the next
  audit reads what B6-14 counted.
- **Validate**: `go test -count=1 ./cmd/dbinventory/`; `npm run format`;
  `npm run check:docs`.

### Task 4: Hand off

- **Action**: PRD row → `complete` with this link; `CHANGELOG.md` unreleased
  entry ("the boundary guard now rejects handle use, not only imports; two
  unclassified replay/moderation sites given owners; no behaviour change");
  B6-10's PR told about its stale row (Task 0); B6-16's row told that the
  register needs no new `OCV-` entry — nothing here was a defect, it was an
  unmeasured shape. If question 1 went the service route, the behaviour
  change is named in the changelog as such.
- **Validate**: `ci-check` skill; `node .superpowers/render-ledger.mjs --check`
  (no ledger change expected).

## Validation

```bash
# the two gates, exactly as CI runs them
cd Server && go test -count=1 ./invariants/
cd Server && go test -count=1 ./cmd/dbinventory/
cd Server && go run ./cmd/dbinventory            # exit 0, 0 problems, paste the block
# the ordering the carryover protects
cd Server && go test -race -count=1 ./ws/
cd Server && go test -tags deadlock -count=1 ./ws/
cd Server && go test -count=1 -run 'TestHP4_' ./db/
# the census, independent of the tool (must agree with the tool's row set)
grep -rn --include='*.go' --exclude='*_test.go' -E '\bh\.db\.[A-Z]' Server/ws   # 0 after Task 2
grep -rn --include='*.go' --exclude='*_test.go' -E '\.SQLDb\(\)|\.SQLReaderDb\(\)|BeginTx\(|\*sql\.(DB|Tx|Conn)\b' Server | grep -v '^Server/db/'   # boundary files only
# docs + everything
npm run format && npm run check:docs && npm run check:hygiene
# → ci-check skill
```

## Risks

| Risk                                                                                                    | Likelihood | Impact | Mitigation                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A seam switch in Task 2 changes which pool a read runs on                                               | Low        | Medium | Every seam is the same `*db.DB` (`readers.go:109`); routing is by statement text (`db.go:339-345`), not by caller. No new interface implementation is introduced               |
| The `hub_events.go` row invites "just route it through `EventStore`" in review                          | Medium     | High   | The claims table's refutation (store is nil when persistence is disabled, `persistence.go:29-31`) is quoted in the row's note; the pin makes the move a visible allowlist edit |
| Prettier re-pads the wider table and the doc gate compares bytes                                        | Low        | Low    | `normalize` (`doc_test.go:89-108`) compares trimmed cells; the new column is one more cell                                                                                     |
| The prose regexes are re-pointed to match a sentence that no longer states a count                      | Medium     | Medium | Each pattern keeps a capture per count and the test still fails on zero matches (`doc_test.go:243-247`); the PR shows each regex beside the sentence it pins                   |
| Hand-off detection over-counts (a `*db.DB` passed to a `db.` package func, e.g. `db.Migrate(database)`) | High       | Low    | Callees in the `db` package itself are excluded from `Hands` — they are the handle's own package, not an owner                                                                 |
| `parser.ParseFile` without type info misses a handle reached through an interface-typed field           | Medium     | Medium | Declared as the remaining limitation in the document (Task 3); the carriers table lists every interface the handle satisfies, so a new one is a reviewable doc edit            |
| B6-10 merges first and its `SQLReaderDb` row conflicts with the pinned `api/router.go` multiset         | High       | Low    | Rebase; the pin gains `SQLReaderDb: 1`; the accessor is a `boundary`-only escape either way                                                                                    |
| The nil-receiver panic through a seam in bare test hubs                                                 | Medium     | Medium | The `h.db != nil` guards stay; Task 2's gotcha checks test-hub construction before the first seam switch                                                                       |
| The moderation-queue seam is read as "the hub bypasses moderation confidentiality"                      | Low        | Medium | The seam doc line states the audience path has no actor and the service `Get` is actor-scoped; the broadcast payload is a public id and a state, unchanged                     |

## Out of scope

- **Moving the replay-purge deletes behind any seam.** Refuted above as a
  pure refactor; if the owner wants it, it is a behaviour change with a test
  that persists rows in an enabled boot, restarts disabled, and purges.
- **Recording the hub lock order in `hub.go`** (B3-5's promise, status
  unknown). B6-14 adds no lock edge; writing the order is a `ws`
  documentation task.
- **Removing `SQLDb()` / `SQLReaderDb()`.** They serve the backup checkpoint
  and the metrics pair; both are `boundary`. A typed `Checkpoint()` method on
  `*db.DB` would let the backup handler drop `database/sql` — one row's
  multiset shrinks — but it is not what the carryover asks for.
- **A `cmd/seed` cleanup.** The alpha profile's raw transaction is a dev tool
  writing a fixture; it is `boundary` and pinned, not refactored.
- **Type-checked analysis (`go/types`, `x/tools`).** The invariants package's
  go/ast-only promise (`invariants.go:6-10`) holds; the remaining blind spot
  is documented rather than closed with a dependency.
- **Client, protocol, schema** — nothing here touches them.

## Open questions for the owner

1. **`ws/moderation_queue.go`: seam or service?** This plan adds `GetReport`
   / `GetAppeal` to `DispatchReader` (no behaviour change, zero rows). The
   alternative is `ReportService.Get` / `AppealService.Get` with a system
   actor, which changes what a broadcast can see and needs its own tests.
2. **Is `Hands` worth pinning, or only printing?** Pinning makes every new
   place the composition root passes the handle a reviewable allowlist edit
   (eight today). Printing alone would document without gating. This plan
   pins; it is one more map per `boundary` row.

## Acceptance

Ticked only where the gate actually ran; evidence is the RED-proof output and
the regenerated block in the PR.

- [ ] Census recorded in the PR before Task 1: 5 files / 7 sites, listed with
      file:line, and Task 1's first run reports exactly those
- [ ] `DBImportEntry.Calls` and `.Hands` pin every `boundary` row that makes a
      call or hand-off (13 + 1 new); `adapter` rows measure empty; the
      liveness test fails a row with neither an import nor a pinned call
- [ ] The doc gate exits 1 on: a handle call in a file with no row, a call or
      hand-off in an `adapter` row, a drifted multiset — each proven RED with
      a probe and reverted
- [ ] `db-import-boundary` reports `db-handle-owner` on a `*sql.Tx`/`*sql.DB`
      type or `SQLDb()`/`SQLReaderDb()`/`BeginTx()` call in a non-`boundary`
      file — proven RED with a probe and reverted
- [ ] `ws/hub_events.go` has a `boundary` row pinning exactly
      `DeleteEventsForMessages: 1, DeleteEventsForUser: 1`; the file is
      unchanged; `-race` and `-tags deadlock` on `./ws/` green; `TestHP4_*`
      green
- [ ] `serve_ready.go`, `hub_visibility.go`, `deps.go`, `moderation_queue.go`
      call the handle nowhere; the two new seam methods are documented on
      their interfaces
- [ ] `server-boundaries.md`: block regenerated, Handle carriers table,
      measurement section states the field-walk and the remaining
      interface-field limitation, every `doc_test.go` pattern matches a
      sentence that states the count it checks
- [ ] B6-10 told about its stale `api/router.go` row; PRD row, changelog and
      `ci-check` green
