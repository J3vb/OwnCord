# Developer maintainability: baseline (R-0)

**Status:** Observations recorded 2026-10-27 at `origin/dev` `cab72959d6a1de8450f71d00e7cab5edcaf9b272`. Supporting evidence for [developer-maintainability-execution-2026-10-24](developer-maintainability-execution-2026-10-24.md); not a plan with a status to track. Later observations get a new dated section, never an edit to this one.

The filename keeps the `2026-10-24` date of the assignment that named it. Every observation below is from 2026-10-27.

## Scope and method

- **Reference.** `origin/dev` `cab72959` (committed 2026-10-27 15:27 UTC). The working tree was clean on a new branch from it. The earlier reference in the source plan, `54df237d`, is historical.
- **What was read.** The three `CLAUDE.md`/`AGENTS.md` instruction files, `docs/STATUS.md`, `docs/plans/README.md`, `docs/contributing.md`, `package.json`, `scripts/run.mjs`, the header and tests of `scripts/ci-select.mjs`, the `ci-check` skill (header only), and the five candidate areas below. `ci.yml` was not read; the relationship between `run.mjs` and the workflow is **not checked** here.
- **What was not done.** No fresh isolated sessions, no human test, no full CI matrix, no Rust build, no audit work. The separate architecture/security/reliability audit is still pending and nothing here depends on it.
- **Session.** One Sonnet 5.5 session (`claude-sonnet-5-5`), effort level not exposed to the session. Repository instructions were loaded automatically, and the assignment named the candidate files, so every exercise below is **contaminated**: the starting point was not blind. Treat the numbers as directional.

## Active-plan overlap

- `docs/STATUS.md` (updated 2026-10-23): phase 7, "Docs that cannot drift; safe protocol changes", is **Ongoing**. Phases 0 to 6 are done or mostly done. The B0 to B10 plans are history.
- `docs/plans/README.md` has no developer-maintainability row yet. This work adds one.
- **Already delivered after the source plan's reference SHA** (so R-1 must not redo it): [#2803](https://github.com/J3vb/OwnCord/pull/2803) added the "Starting a change" task map to `docs/contributing.md`, links from both component READMEs, and focused-test examples in `docs/testing-behavior.md`. [#2804](https://github.com/J3vb/OwnCord/pull/2804) added `node scripts/run.mjs --list <task>`, `--json`, short help, startup-failure messages that name the command and directory, and output draining. Both merged 2026-10-25.
- **Open PRs into `dev` at 2026-10-27:** #2836, #2831, #2797, #2788, #2784 and #2806. None touches `scripts/run.mjs`, `scripts/ci-select.mjs` or `docs/contributing.md` by title. #2806 is a draft docs plan and may also edit `docs/plans/README.md`; expect a trivial index conflict.

## Toolchain in the measuring environment

| Item     | Required                           | Present                          | Effect                                                         |
| -------- | ---------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| Node     | 26 (`engines`, `.nvmrc`)           | 22.22.0                          | Root scripts and Vitest ran anyway; `npm ci` would refuse.     |
| Go       | 1.27.2 (toolchain pin)             | 1.27.2 via `GOTOOLCHAIN=auto`    | Server tests ran (cold module download included).              |
| Rust     | 1.98.1 plus clang 21 and libwebrtc | cargo 1.97.0, no clang 21 probed | `cargo test --lib` **not attempted**: documented prerequisite. |
| Prettier | `^3.9.10`                          | 3.9.9 installed                  | Formatting check ran with the installed version.               |

## Checks run, and their status

| Command                                                                                                               | Status           | Result                                                |
| --------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------- |
| `node scripts/run.mjs --list`                                                                                         | executed         | Prints every task with commands and directories.      |
| `node scripts/check-doc-counts.mjs`                                                                                   | executed         | 0 claims across 5 documents agree with the ledger.    |
| `node scripts/check-doc-citations.mjs`                                                                                | executed         | 140 cited paths all exist.                            |
| `node scripts/check-migrations.mjs`                                                                                   | executed         | No shipped migration changed.                         |
| `node .superpowers/render-ledger.mjs --check`                                                                         | executed         | Ledger valid, 518 findings.                           |
| `node --test scripts/run.test.mjs`                                                                                    | executed         | 16 of 16 pass.                                        |
| `node --test scripts/ci-select.test.mjs`                                                                              | executed         | 64 of 64 pass.                                        |
| `go test ./service -run 'TestValidateShortcode\|TestEmojiCreate'` (in `Server/`)                                      | executed         | ok, 30 s wall clock on a cold cache.                  |
| `go test -count=1 ./cmd/dbinventory/` (in `Server/`)                                                                  | executed         | ok.                                                   |
| `npx vitest run tests/unit/thread-dialogs.test.ts tests/contract/server-admin-static-stickers.test.ts` (in `Client/`) | executed         | 2 files, 24 tests pass, 7.5 s.                        |
| `cargo test --lib` (in `Client/src-tauri`)                                                                            | unavailable here | Needs clang 21 and a prebuilt libwebrtc; not tried.   |
| `npm run check`, `npm run check:server`, `npm run check:client`                                                       | not run          | Full gates; CI runs them. Not needed to write a plan. |
| Playwright suites, `govulncheck`, `npm audit`, coverage floors                                                        | not run          | `npm run check` does not include them either.         |
| Windows and macOS badge code paths                                                                                    | unavailable      | Cannot be exercised on Linux.                         |

## Discovery exercises

Each exercise started from the public task map in `docs/contributing.md#starting-a-change`. "Calls" counts shell or file tool calls after the task map was read. Elapsed time is the span between the first and last call timestamps and **includes model thinking time**. Per-exercise token usage is not exposed; the session context counter fell by about 85,000 tokens from the start of the session to the end of exercise 4, and that figure also covers reading the source plan and orienting on the repository. No "before" or "after" claim follows from it.

| #   | Task                                         | Calls | Elapsed (clock, UTC) | Wrong turns | Outcome                                                                                             |
| --- | -------------------------------------------- | ----- | -------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| 1   | Go: a validation/error rule and its tests    | 3     | 16:18:39 to 16:18:55 | 0           | Found and tied to tests; focused command executed.                                                  |
| 2   | Client: pending/error behaviour and teardown | 3     | 16:18:55 to 16:19:08 | 0           | Found; one gap found in the tests (below).                                                          |
| 3   | Admin: a sticker action to its tests         | 3     | 16:19:08 to 16:19:16 | 1           | Found; the only tests are in `Client/`, found after a fruitless search of `Server/admin/*_test.go`. |
| 4   | Rust: unread count to platform effects       | 2     | 16:19:16 to 16:19:26 | 0           | Found; proof split between pure unit tests and platform-only code.                                  |

### 1. Go service rule: emoji shortcodes

- **Entry.** `Server/service/emoji.go`. `ValidateShortcode` (about line 70) normalizes with `NormalizeShortcode`, then checks `shortcodeRe` (`^[a-z0-9_]{2,32}$`). Errors wrap `ErrBadRequest` with `%w`.
- **Owning tests.** `Server/service/emoji_test.go`: `TestValidateShortcode_Accepts`, `TestValidateShortcode_Rejects`, `TestEmojiCreate_RejectsBadShortcodeBeforeInsert`; a fuzz test sits beside them.
- **Dependency.** `NewEmojiService(st Store, perms *PermissionService)` takes the whole `service.Store`. The service calls five methods on it: `CreateEmoji`, `DeleteEmoji`, `GetEmoji`, `GetEmojiByShortcode`, `ListEmoji`. The interface declares **309 methods** (`storeMethodBaseline` in `datastore_ratchet_test.go`).
- **Existing convention.** The ratchet's own comment says a new method should go "behind a small slice interface the new service declares", and `CallLogStore`, `GroupDMStore` and `ErasureStageStore` already do this. Emoji does not. Tests build the service from a real in-memory `*db.DB`, so the wide interface costs nothing in test setup today.
- **Friction (verified):** none found for locating the rule. The wide `Store` only matters to a future change that wants to fake the store narrowly; that benefit is a hypothesis.
- **Check.** From `Server/`: `go test ./service -run 'TestValidateShortcode|TestEmoji'`. Executed, passes.

### 2. Client dialog: `CreateThreadDialog`

- **Entry.** `Client/src/components/CreateThreadDialog.ts` (236 lines). Submit sends `thread_create` and disables the button; `settle()` releases the pending request, the socket listeners and the timer; `fail(code)` calls `settle()` then shows `createErrorText`. A 20 s `CREATE_TIMEOUT_MS` timer fails with `UNCONFIRMED`. `owner.addCleanup` repeats the release on teardown.
- **Owning tests.** `Client/tests/unit/thread-dialogs.test.ts`: send, empty name, success, `THREAD_EXISTS`, another error then retry, socket down.
- **Verified gap.** No test in `Client/tests` mentions `UNCONFIRMED`, uses fake timers for this dialog, exercises `ws.onSendFailure`, or closes the dialog while a request is pending. These are exactly the late-reply and teardown paths the source plan names as the risk boundaries. Whether they are correct is **not** established; only that no test pins them.
- **Check.** From `Client/`: `npx vitest run tests/unit/thread-dialogs.test.ts`. Executed, passes. The focused-test route is documented in `docs/testing-behavior.md#iterate-on-a-focused-check`.

### 3. Admin sticker action

- **Entry.** `Server/admin/static/js/stickers.js` (149 lines, classic script). Line 149 registers `confirmDeleteSticker`, `deleteSticker`, `openRenameSticker`, `saveSticker`, `uploadSticker` into `ACTIONS`, which `core.js` defines and dispatches from `data-action` attributes. Requests go through `stickerApi` to `/api/v1/stickers`. The page loads from `Server/admin/static/index.html` (line 122).
- **Owning tests.** `Client/tests/contract/server-admin-static-stickers.test.ts`. The admin panel has no JavaScript runner on the Go side, so the contract suite lives in `Client/` and loads the real page into jsdom. `npm run check:admin-types` adds a non-strict `checkJs` pass.
- **Verified friction.** A search of `Server/admin/*_test.go` for "sticker" finds no test of `stickers.js`, so a Go contributor reasonably looks there first. The task map names "Client contract tests" and the contributor guide explains the membership rule, so the route exists; it just needs Node and the `Client/` dependencies, which Go-only contributors otherwise never install. That Node requirement is not stated on the map row.
- **Check.** From `Client/`: `npx vitest run tests/contract/server-admin-static-stickers.test.ts`. Executed, passes.

### 4. Rust unread badge

- **Entry.** The frontend computes the count (`Client/src/features/unread-badge/unreadBadge.ts`) and calls `platform/desktop/notifications.ts`, which does `invoke("set_unread_badge", { count })`. Rust handles it in `Client/src-tauri/src/unread_badge.rs` (485 lines, `#[tauri::command] set_unread_badge`, registered in `lib.rs`).
- **Pure versus effect.** Pure and unconditionally tested: `badge_label`, `linux_badge_plan`, `dot_needs_swap`, `dot_recorded`, `with_red_dot`, `render_overlay`. Effects behind `cfg`: Windows overlay icon and tray dot, macOS dock count, Linux D-Bus launcher signal (`launcher_entry_update`, `send_launcher_count`) and tray title. Two tests are `#[cfg(target_os = "linux")]`.
- **Platform proof.** The Windows overlay and macOS badge calls cannot be exercised on Linux. The Linux D-Bus send is covered only through its message-building test, not by a live session bus.
- **Side observation.** `setUnreadBadge` in `notifications.ts` awaits `invoke` without `try/catch`. `CLAUDE.md` already calls such calls backlog; it is noted, not a finding for this plan.
- **Check.** From `Client/src-tauri`: `cargo test --lib` after `eval "$(Client/scripts/linux-webrtc-toolchain.sh)"` on Linux. **Not executed here.**

## Selector and runner observations

- `scripts/ci-select.mjs --paths-file` expects `git diff --name-status` lines (`M<TAB>path`). A bare list of paths parses as **0 paths** and selects every capability. That is the safe direction, but nothing says why a plain list "selects everything".
- Selection for `M` lines, run 2026-10-27:

  | Changed path                                  | Capabilities selected                           |
  | --------------------------------------------- | ----------------------------------------------- |
  | `Server/service/emoji.go`                     | server, integration, native                     |
  | `Server/admin/static/js/stickers.js`          | server, client, integration, native             |
  | `Client/src/components/CreateThreadDialog.ts` | client, browser, integration, native, webclient |
  | `Client/src-tauri/src/unread_badge.rs`        | client, rust, native                            |
  | `docs/plans/README.md`                        | none                                            |
  | `weird/unknown.xyz`                           | all eleven                                      |

- The capability names (`browser`, `integration`, `native`, `webclient`) are explained only in comments inside `ci-select.mjs`. A search for "capabilit" in `docs/contributing.md` and `docs/testing-behavior.md` finds nothing. The contributor guide tells readers how to run the selector but not what each name means, which CI job it gates, or which local command (if any) reproduces it. `run.mjs` has tasks only for the static, unit and drift gates; the Playwright jobs have `npm run test:e2e*` scripts in `Client/package.json`.
- `run.mjs` prints `<task>: passed, with <tools> skipped (not installed). CI runs them.` when an optional step is skipped, and `FAILED: ...` with the command and directory when a required tool is missing. `docs/contributing.md` already says a skipped tool is "a verification limitation, not a passing check". `scripts/run.test.mjs` has no test that pins the skip summary line (search for "skipped" found nothing).

## Public contributor path (documentation only)

Judged by reading, not by a person doing it. **Documentation/setup verified for the paths below; simulated walkthrough not run separately; not human-tested.**

| Question                           | Reachable from `docs/contributing.md` without Claude files?                                                                                | Gap                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which tools do I need              | Yes (Prerequisites)                                                                                                                        | None found.                                                                                                                                                                                                          |
| Where is feature X                 | Yes (task map, six task rows)                                                                                                              | Row for admin does not say its tests need Node 26 and `Client/` dependencies.                                                                                                                                        |
| What checks apply to my change     | Partly                                                                                                                                     | Selector is documented; its capability names and their local equivalents are not.                                                                                                                                    |
| Which checks `npm run check` skips | Yes                                                                                                                                        | None found.                                                                                                                                                                                                          |
| Rust prerequisites on Linux        | Yes (clang 21 section)                                                                                                                     | None found.                                                                                                                                                                                                          |
| Stale claim                        | `docs/architecture/server.md` (verified against `ac6ffc4e`, 2026-10-13) calls moving raw `*db.DB` use behind services "the remaining work" | `server-boundaries.md` (last touched 2026-10-24) classifies all 83 rows as `adapter` (55) or `boundary` (28), none as `move`. Reconcile against code before editing; `adapter` handlers may still hold a raw handle. |

## Limits

- Contaminated, single-session, no repetition: no variance estimate.
- Timings include model thinking and tool latency.
- Cold Go cache and warm Node cache differ, so the command timings are not comparable with each other.
- No savings are claimed.

## R-1 after (2026-10-27)

Measured on the R-1 branch, based on `origin/dev` `cab72959`. Evidence level: **documentation/setup verified, plus a simulated walkthrough**. Nobody outside the author ran the three tasks, and the author had read the plan and the code, so every run is contaminated (not blind). Each task was walked once, not twice, so there is no spread to report. The agent-instruction files were loaded in both cases.

### What changed

- `docs/contributing.md`: one table mapping each selector name to the CI jobs it gates, a local command and whether `npm run check` covers it; one sentence on the path file format; a Node note on the admin row. Job names were read from `ci.yml` job `name:` and `if:` lines, and local commands from `node scripts/run.mjs --list` and `Client/package.json`.
- `scripts/run.test.mjs`: one test pinning the skipped-optional-tool summary. `scripts/run.mjs` is unchanged.
- `docs/architecture/server.md`: the "remaining work" paragraph now matches the code and the inventory.

### Commands run

| Command                                                                          | Status                 | Result                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/run.mjs --list`                                                    | executed               | Every `npm run` task named in the table exists.                                                                                                                   |
| `node --test scripts/run.test.mjs`                                               | executed               | 17 of 17 pass (16 before). Changing the final line to end in `!` fails it.                                                                                        |
| `node scripts/ci-select.mjs` on `M Server/service/emoji.go`                      | executed               | `server`, `integration`, `native`.                                                                                                                                |
| the same path without the `M` status, an empty file, an unknown path             | executed               | Bare path reads as 0 paths; empty and unknown select all eleven.                                                                                                  |
| `M Client/src-tauri/src/unread_badge.rs`, `M Server/admin/static/js/stickers.js` | executed               | `client`, `rust`, `native`; and `server`, `client`, `integration`, `native`.                                                                                      |
| `go test -count=1 ./cmd/dbinventory/` (in `Server/`)                             | executed               | ok; 83 rows, 55 `adapter`, 28 `boundary`, 0 `move`.                                                                                                               |
| `check-doc-counts`, `check-doc-citations`                                        | executed               | pass.                                                                                                                                                             |
| Every local command in the new table                                             | reviewed, not executed | Each names an existing script or tool; the Playwright, Tauri, `zizmor`, `osv-scanner` and Stryker runs need browsers, a Windows host or tools not installed here. |

### Comparison

"Before" is the `dev` documentation read as a newcomer would, with the extra files that reading needed.

| Task | Before: files opened for the answer                                                                        | After: files opened                        | Answer matches the known one?                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | 3: `contributing.md`, then `ci-select.mjs` comments for the names, then `package.json` or `run.mjs --list` | 1: `contributing.md` plus one selector run | Yes both times: `server`, `integration`, `native`, now with job names and local commands in the table.                                                          |
| B    | 3, and "covered by `npm run check`" had to be inferred                                                     | 1                                          | Partly after. The table says `rust` is covered on your OS only and `native` has no local equivalent off Windows. The live Linux D-Bus send is not in the guide. |
| C    | 1 plus one wrong turn (searching `Server/admin/*_test.go`, as in exercise 3)                               | 1, no wrong turn from the guide            | Yes: the admin row now says the tests are in `Client/` and need Node 26. It does not name `server-admin-static-stickers.test.ts`.                               |

Wrong turns went from 1 to 0 on task C. The file counts are the author's walkthrough, not recorded session tool calls, and no token usage was recorded. Under the plan's rule they support "one fewer file to open on A and B and one avoided dead end on C", not a time or cost saving.

### Verdict against the stop rules

No task got a longer path or a worse answer, no gate was weakened, and no CI selection changed. Task B stays partly answered and is the one open gap. The change is kept.

## R-2 emoji seam (2026-10-27)

Measured on a branch from `origin/dev`. Evidence level: **executed**. The change is a type narrowing: `EmojiService` and `NewEmojiService` take `EmojiStore` instead of `Store`. `service.go` passes the same `Store` value, so no wiring changed. Behaviour is unchanged: `db.WriteAudit` still receives the same `*db.DB` and its `AsyncEntryAuditor` check still sees the dynamic type.

| Measure                                                    | Before                                                    | After                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Methods a fake that does not embed `*db.DB` must implement | 318 (`reflect` count of `Store`, 309 source + 9 promoted) | 6 (`EmojiStore`: the five emoji methods plus `LogAudit`)              |
| Methods a fake that embeds `*db.DB` must override          | 1 (`raceEmojiStore`)                                      | 1 (unchanged; embedding already hid the width)                        |
| Emoji tests passing (`go test -run Emoji ./service/`)      | 18                                                        | 19 (18 plus `TestEmojiService_RunsOnASixMethodFake`, a 6-method fake) |
| `storeMethodBaseline` (distinct methods in `Store`)        | 309                                                       | 309 (the slice is embedded, so `Store` is unchanged; 287 direct)      |
| Lines in `Store` body                                      | five emoji lines                                          | one embed line                                                        |

### Verdict

Kept. The seam is smaller (318 to 6 for a standalone fake) with the same tests passing. The benefit is only real for a fake that does not embed `*db.DB`; every existing fake embeds it, so no current test got shorter. The gain is for the next emoji change, not for today's tests. No savings in time or tokens are claimed.

## R-3 after (2026-10-27)

Row 5 of the execution plan, run as a code pilot with the owner's go. Based on `origin/dev` `deb491fd`. Evidence level: **simulated walkthrough plus a deliberate-break check**. The author wrote both the breaks and the tests, so the check is not blind.

### What changed

- `Client/tests/unit/thread-dialogs.test.ts`: three tests for `CreateThreadDialog`. One for the 20 s `UNCONFIRMED` timeout, which also checks that Send is enabled again, the forward claim is released and a late `thread_create_ok` is ignored. One for `ws.onSendFailure`, which checks the `OFFLINE` line and a retry. One for closing while a request is pending, which checks the claim is released, late `thread_create_ok` and `THREAD_EXISTS` replies are ignored, and no timer is left.
- No production file changed.

### Deliberate-break check

Each break was a one-line edit to `Client/src/components/CreateThreadDialog.ts`, run against the dialog test file, then reverted.

| Break                                                    | Before: 8 tests | After: 11 tests             |
| -------------------------------------------------------- | --------------- | --------------------------- |
| B1. The 20 s timer does nothing                          | all pass        | 1 fails (timeout)           |
| B2. A send failure is ignored                            | all pass        | 1 fails (send fail)         |
| B3. The teardown cleanup (`owner.addCleanup`) is removed | all pass        | 1 fails (close)             |
| B4. `settle()` leaves the Send button disabled           | all pass        | 2 fail (timeout, send fail) |

Caught: 0 of 4 before, 4 of 4 after. The new tests found no defect in the dialog: all three paths behave as the code comments describe.

### Commands run

| Command (in `Client/`)                             | Status   | Result                                                |
| -------------------------------------------------- | -------- | ----------------------------------------------------- |
| `npx vitest run tests/unit/thread-dialogs.test.ts` | executed | 11 of 11 pass, five runs in a row, 1.8 to 2.5 s each. |
| `npx eslint tests/unit/thread-dialogs.test.ts`     | executed | clean.                                                |
| `npx tsc --noEmit -p tsconfig.json`                | executed | clean.                                                |

### Comparison with discovery exercise 2

Before, the answer to "are the late-reply and teardown paths pinned?" was "no", found in 3 calls. After, the same 3 calls (the dialog, the test file, a search for `UNCONFIRMED`) give "yes": each path has one named test. The file count did not change. The gain is the guard, not a shorter search.

### Verdict against the stop rules

No production code changed, no gate was weakened, and every break that survived before now fails a test. The change is kept.
