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

## MX-6 after (2026-10-28)

Roadmap item MX-6 (scout candidate C1, hand-built context menus), run with the owner's go on the pre-flight plan. Based on `origin/dev` `91d7e54a`. Evidence level: **counted by grep and a structural test, behaviour reproduced by a unit test on the base commit**. No app run.

### What changed

- `Client/src/lib/context-menu.ts`: one shell, `openMenuShell`, builds the `.context-menu` root, closes whatever menu is open, mounts the new one (inside the full-screen element when there is one), keeps it inside the window and re-places it on resize, installs the keyboard model and wires the dismissal and the owner's teardown. `showContextMenu` runs on it. `registerSidebarMenu` and the per-class sweep are gone.
- Migrated onto the shell, behaviour kept (each menu keeps its own close rule: sidebar menus on any click, the rest on a click outside): channel, category and thread sidebar menus; voice-user volume menu; video-tile menus; member menu (`AdminActions.ts`, with `MemberList.ts`'s own placement and outside-click code removed).
- `createChannelContextMenu` in `AdminActions.ts` had no caller outside its tests and is deleted. Its purge tests now test `appendPurgeSection` directly (`purge-prompt.test.ts`), so purge coverage is kept.
- Guard: `Client/tests/unit/context-menu-roots.test.ts` fails on a hand-built `.context-menu` root outside the shell; shrink-only allowlist, empty.
- Finding OC-0521 (two menus open at once) recorded as fixed.

### Counts

| Measure                                                                                          | Before (`91d7e54a`) | After             |
| ------------------------------------------------------------------------------------------------ | ------------------- | ----------------- |
| Hand-built `.context-menu` roots outside `lib/context-menu.ts`                                   | 7 in 6 files        | 0                 |
| `clampMenuToViewport` / `registerSidebarMenu` / `enableMenuKeyboard` calls outside the shell     | 4 / 3 / 6           | 0 / 0 / 0         |
| Copies of placement code (shared clamp plus inline copies in `MemberList.ts` and `tile-menu.ts`) | 3                   | 1 (two fit modes) |
| Production lines in `Client/src` (diff)                                                          | n/a                 | +347, -637        |
| Menus open after opening two (mouse right-click or Shift+F10)                                    | 2                   | 1                 |

Correction to the scout row: `tile-menu.ts` and the member menu did keep inside the window, each with its own copy of the placement code; the real defect was only the second open menu.

### Deliberate-break check

`one-open-menu.test.ts` run against `origin/dev` `91d7e54a`: the three "one open menu" tests fail with 2 menus open (sidebar plus volume menu; volume after thread; thread by keyboard beside volume). The four `openMenuShell` tests fail there because the shell does not exist. All 7 pass after.

### Commands run

| Command (in `Client/`)                                   | Status   | Result                                                                                                                                                                                           |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx tsc --noEmit -p tsconfig.json`                      | executed | clean.                                                                                                                                                                                           |
| `npx eslint` on every changed file                       | executed | clean. `npm run lint` on the whole tree fails on one `await-thenable` error in `src/lib/audioPipeline.ts`, which this change does not touch and which fails the same on the clean base checkout. |
| `npm run knip`, `node scripts/check-mutation-shards.mjs` | executed | clean.                                                                                                                                                                                           |
| `npm run test:coverage`                                  | executed | 683 files, 14929 passed, 0 failed.                                                                                                                                                               |
| `npm run build:budget && npm run check:budgets`          | executed | all budgets ok.                                                                                                                                                                                  |

### Verdict against the stop rules

No gate weakened, no assertion loosened; the deleted tests belonged to deleted code, and the purge ones moved. The count goes from 7 to 0 and is held by a test. Kept.

## MX-5 IME Enter guard (2026-10-28)

Scout candidate C2 in the execution plan. Based on `origin/dev` `91d7e54a`. Evidence level: **executed** (unit tests and a deliberate-break check in jsdom; no input method was run in the app).

### Baseline count

Counted with the new structural test, `Client/tests/unit/ime-enter-guard.test.ts`, run against unchanged `dev`. It reads every function in `Client/src` that compares a key to `"Enter"` and skips Enter-or-Space button activation.

| Measure                                                  | Scout (2026-10-27) | Re-count before | After                     |
| -------------------------------------------------------- | ------------------ | --------------- | ------------------------- |
| Enter handlers on a text field with no composition guard | 9                  | 13              | 0, held by the test       |
| Handlers with an inline `isComposing` guard              | 7 files            | 8 (7 files)     | 0; all call `isImeCommit` |
| Inline `e.isComposing \|\| e.keyCode === 229` copies     | 7 files            | 8 in 7 files    | 0 outside `lib/ime.ts`    |
| Exempt Enter handlers (no text field)                    | n/a                | n/a             | 1: `miniPlayer.ts`        |

The scout missed four unguarded fields: the custom status in `StatusPicker.ts` and `SelfProfileCard.ts`, the prompt input in `lib/modalFactory.ts`, and the sticker search in `StickerPicker.ts`. All 13 are fixed here, since the defect and the fix are the same. `GlobalKeybinds.ts`'s Ctrl+Enter ring answer checked `isComposing` only; it now uses the helper, which adds the `keyCode` 229 case.

### What changed

- `Client/src/lib/ime.ts`: `isImeCommit(e)`, true while an input method owns the key.
- 13 unguarded handlers return early on it. `SearchOverlay` and `QuickSwitcher` check it at the top of the handler, so composing arrows and Escape also stay with the input method.
- The 8 inline guards call the helper instead.
- `ime-enter-guard.test.ts`: fails on a new Enter handler without the helper, on an exemption that no longer exists, and on an inline copy of the guard.
- One test per field (12 tests; one covers both game activity fields) that sends Enter with `isComposing: true` and checks nothing was submitted.

### Deliberate-break check

`isImeCommit` was made to return `false` and the 12 test files were run, then the change was reverted.

| Break                         | Before: tests that fail | After: tests that fail |
| ----------------------------- | ----------------------- | ---------------------- |
| No composition guard on Enter | 0 (no test sent one)    | 12 of 12 new tests     |

### Not done

Escape during composition still closes `createModal` dialogs and the self profile card, because their Escape listeners are on `document`. That is a different key and a different fix (the dialog helper), so it is left for a follow-up and not counted here.

### Verdict against the stop rules

No gate was weakened, no existing test changed, and the count went from 13 to 0 with a test that holds it. The change is kept.

## MX-7 batch 1: api error replies and body decoding (2026-10-28)

Measured on a branch from `origin/dev` `91d7e54a`. Evidence level: **executed**. Batch 1 is the `Server/api` package. `Server/admin` decoders are batch 2 and plain-text `http.Error` replies batch 3; both are counted here so later batches have a baseline.

### Counts

Counted with the new `reply-helpers` invariant (`Server/invariants/reply_helpers.go`) run against `dev`, and checked by `grep` over non-test files. The scout's numbers from 2026-10-27 (58, 53, 28) had grown by the time this ran.

| Measure (non-test files)                                | Before                                                                                                                                                    | After                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `errorResponse{…}` built by hand outside `writeErr`     | 60 (all in `api`, 10 files)                                                                                                                               | 0, held by the invariant                        |
| `json.NewDecoder` outside the shared decoder, `api`     | 32 in 17 files                                                                                                                                            | 0, held by the invariant                        |
| `json.NewDecoder` outside the shared decoder, `admin`   | 23 in 17 files                                                                                                                                            | 23, frozen per file in `DecodeAllow`            |
| `http.Error` plain-text replies                         | 31 in 6 files (17 in the plugin admin API)                                                                                                                | 31 (batch 3)                                    |
| Different replies to a body that does not decode, `api` | 6 code and message pairs (`INVALID_INPUT` or `BAD_REQUEST`; "malformed request body", "malformed JSON body", "invalid request body", "invalid JSON body") | 1: `400 INVALID_INPUT` "malformed request body" |
| `api` JSON routes answering an over-size body with 413  | 0 of 32 decode sites                                                                                                                                      | 32 of 32 (`413 PAYLOAD_TOO_LARGE`)              |

### What changed

- `api/decode.go`: `decodeJSON`, `decodeOptionalJSON` (an empty body is allowed, as the invite and 2FA-disable routes did by hand) and `decodeStrictJSON` (unknown fields and trailing data refused, as the privacy route did by hand). A body past the route's `http.MaxBytesReader` cap answers `413 PAYLOAD_TOO_LARGE`, the code the upload route already used.
- 60 hand-built error replies became `writeErr` calls with the same status, code and message.
- Where a handler folded a field check into the decode condition (user note, nickname, privacy), the decode now fails with the shared reply and the field check keeps its own message.
- `docs/api.md`: the error table now lists `PAYLOAD_TOO_LARGE`, and no longer says the plugin route has the API's only 413.

### Checks

| Check                                                                                                               | Before (`dev` + the new test)                  | After                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `TestJSONBodyRoutes_ShareOneReplyForTheSameBadBody` (5 routes × malformed and over-size)                            | 2 of 10 cases pass                             | 10 of 10                                                                      |
| `reply-helpers` invariant on the tree                                                                               | 92 violations (60 literals, 32 `api` decoders) | 0                                                                             |
| `api/decode_test.go` (helper: valid, 5 bad bodies, cap mid-value, cap after the value, empty optional body, strict) | did not exist                                  | 6 tests pass                                                                  |
| `TestPushSubscriptions_RejectsMalformed`, 9 KiB body                                                                | expected 400                                   | expects 413 `PAYLOAD_TOO_LARGE`; the one existing test whose contract changed |

### Verdict

Kept. One reply per bad body instead of six, 413 for an over-size body on every `api` JSON route, and a ratchet that stops new hand-built replies. The visible change for clients is the code on 8 routes that answered `BAD_REQUEST` for a malformed body (DM create, group DM create, rename, add members and owner transfer, invite create, channel purge, sticker edit) and 413 instead of 400 for an over-size body. The client never branches on `BAD_REQUEST` from REST, and shows the server's message for a code it has no copy for. No savings in time or tokens are claimed.

## MX-9 guarded storage access (2026-10-28)

Scout candidate C5 in the execution plan. Based on `origin/dev` `09d27cc4`. Evidence level: **executed** (unit tests and a deliberate-break check in jsdom; the app was not run with storage blocked).

### Baseline count

Counted the way the new structural test, `Client/src/features/storageDoor.test.ts`, counts: every non-test `.ts` file under `Client/src` that names `localStorage` outside a comment.

| Measure                                                           | Scout (2026-10-27) | Re-count before | After                        |
| ----------------------------------------------------------------- | ------------------ | --------------- | ---------------------------- |
| Files touching `localStorage`                                     | 17                 | 20              | 3, held by the test          |
| App files (outside `lib/preferences.ts` and the browser platform) | 17                 | 17              | 0                            |
| Copies of the read-parse-validate body                            | 5                  | 5               | 0; all call `loadStoredJson` |
| Unguarded calls                                                   | "several"          | 15 in 6 files   | 0                            |

The scout's 17 left out `lib/preferences.ts` and the two browser-platform stores. Those three stay: `preferences.ts` is the door, and `platform/browser/settings.ts` and `credentials.ts` are the browser's settings and credential stores, which have their own guards and report failure through the platform contract. The allowlist is shrink-only (the test also fails on an entry that no longer touches storage).

### What changed

- `Client/src/lib/preferences.ts`: guarded `readStored`, `writeStored`, `removeStored`, `storedKeys`, `loadStoredJson(key, parse, fallback)` and `saveStoredJson` beside `loadPref`/`savePref`. A failed read reads as absent, a failed write returns `false`, nothing throws. `readMigratedStringPref` reads through them too.
- The 17 app files call those helpers. Keys and stored values are unchanged.
- `legacyKeyMigration.ts` migrates nothing when the legacy key cannot be removed, as before (it used to get that from the throw).
- Six test files that mocked `@lib/preferences` with only `loadPref`/`savePref` now spread the real module.
- New tests: blocked storage in `themes.test.ts` (startup read, apply), `sidebar-member-section.test.ts` (collapse click), `legacy-key-migration.test.ts` (remove fails), and the helpers in `preferences.test.ts`.

### Defect found

Blocked storage made `getActiveThemeName`, `applyThemeByName`, the system-theme repaint and the member list's collapse click throw. Ledger entry OC-0523 (low; storage is only blocked in unusual browser setups).

### Deliberate-break check

`readStored`/`writeStored`/`removeStored` were made to call storage without their `try` and the new tests were run, then the change was reverted.

| Break                    | Before: tests that fail     | After: tests that fail                                   |
| ------------------------ | --------------------------- | -------------------------------------------------------- |
| Unguarded storage access | 0 (no test blocked storage) | 9: the 5 new tests plus 4 existing storage-failure tests |

### Verdict against the stop rules

No gate was weakened and no assertion changed; the only edits to existing tests make their `@lib/preferences` mocks keep the real module's new exports. The count went from 20 to 3 with a test that holds it. The change is kept.

## MX-8 Tauri invoke wrapping (2026-10-28)

Scout candidate C4 in the execution plan. Based on `origin/dev` `09d27cc4`. Evidence level: **executed** (lint, unit tests and a deliberate-break check; no native host was run).

### Baseline count

The repo already had the guard: `local/invoke-needs-try-catch` in `Client/eslint-rules.js`, set to `warn` for `src/platform/desktop/**`. Counted with `npx eslint -f json src/platform/desktop` on unchanged `dev`.

| Measure                                                | Scout (2026-10-27) | Re-count before | After                      |
| ------------------------------------------------------ | ------------------ | --------------- | -------------------------- |
| `invoke-needs-try-catch` warnings                      | about 50           | 47 in 11 files  | 0; the rule is now `error` |
| of which in `nativeVoiceService.ts`                    | 42 lines           | 25              | 0                          |
| Files that import `@tauri-apps/*` (platform-contracts) | n/a                | 29              | 25                         |

The scout's 42 for the voice file counted lines that mention `invoke(`, including the ones already in a try. A plain AST scan (call named `invoke` not inside a try-with-catch in its own function) finds 48: it misses `socket.ts`'s two `tauriInvoke` calls and wrongly counts `externalContent.ts`'s two callback calls and `nativeProxies.ts`'s `.catch` call. The lint rule's 47 is the number used.

### What changed

- `Client/src/platform/desktop/nativeInvoke.ts`: `tryInvoke` (never rejects; `{ ok, value }` or `{ ok: false, error }`) and `invokeOrThrow` (rejects with a `NativeCallError` whose `message` is the host's reason and whose `reason` is the raw value).
- The helper sends the command before its first await, so fire-and-forget calls (`stop_livekit_proxy`, `frontend_ready`) reach the host in the same order as before. `message-list-media-release.test.ts` now mocks the core API with a pending call: its GIF used to fail to load only after the test ended, and now fails inside it.
- `notifier.setUnreadBadge` is the worked example: a host with no badge command logs and resolves.
- Every other site keeps its contract: it still rejects, now always with an `Error`. Callers that read the host's text (`ws.ts`'s "channel full", the camera "no frame" check, `connectErrorCode`) read `message`, which is unchanged. `externalContent.ts` maps `error.reason` to its failure class as before.
- `nativeVoiceService.ts`: the 25 bare calls go through `invokeOrThrow`; no voice logic changed.
- `eslint.config.js`: `invoke-needs-try-catch` from `warn` to `error`, with `nativeInvoke.ts` as the one skipped file; its canary moved to severity 2.
- `tests/helpers/platform-command-inventory.ts` counts commands named through the two helpers, so the platform-contracts table still sees all 95.

### Deliberate-break check

| Break                                          | Before: what fails  | After: what fails                                                    |
| ---------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `systemIdle.ts` restored to a bare `invoke`    | nothing (a warning) | `npm run lint` (error)                                               |
| `tryInvoke`'s catch rethrows the raw rejection | n/a                 | 18 tests in the `nativeInvoke`, notifier and external-content suites |

### Verdict against the stop rules

No existing assertion was weakened. `ipcBytes.test.ts`'s raw-bytes pattern now also matches the helpers, so it still finds `externalContent.ts`. `ws-cert.test.ts` expected the raw string a declined certificate rejects with; it now checks the `NativeCallError` carries that string as both `reason` and `message`. The count went from 47 to 0 and the existing lint rule now holds it as an error. The change is kept.

## MX-4 one backdrop close for dialogs (2026-10-28)

Candidate "one backdrop close for dialogs" from the execution plan, on `dev` `fd5fb934`. It follows the `createModal` fix for OC-0520 (#2842), which did not reach dialogs with their own backdrop check.

### Baseline count

Counted with the structural test's pattern (a `.target` compared with an overlay, backdrop, root or scrim element) over non-test files in `Client/src`.

| Measure                              | Before                                        | After                      |
| ------------------------------------ | --------------------------------------------- | -------------------------- |
| Dialog files with their own check    | 15 (16 sites; `CertMismatchModal.ts` has two) | 0                          |
| Shared guard (`lib/modalFactory.ts`) | 1                                             | 1 (`closeOnBackdropClick`) |
| Other matches, allowlisted           | 1 (`miniPlayer.ts`, a keydown guard)          | 1                          |
| Drag-select tests on those dialogs   | 0                                             | 18                         |

The scout counted 11. The four it left out (`CreateChannelModal`, `EditChannelModal`, `DeleteChannelModal`, `InviteManager`) do have the check, written as `e.target === instance?.overlay`.

Before the change, a press inside and a release on the backdrop closed one dialog of each kind in a throwaway test: `SearchOverlay` (mounted overlay), `CreateChannelModal` (`createModal` plus its own check) and `WhatsNewDialog` (hand-built overlay).

### What changed

- `Client/src/lib/modalFactory.ts`: the #2842 logic moved into an exported `closeOnBackdropClick(overlay, onClose, signal)`; `createModal` calls it.
- The 15 files call it in place of their click listener. Each keeps its own close callback, so Escape, focus, the forward picker's "wait while sending" guard and the certificate and identity prompts' "backdrop rejects" are unchanged.
- `Client/src/features/dialogBackdropDoor.test.ts` fails on a new hand-written check outside the helper; its allowlist is shrink-only (an entry that no longer matches fails too).
- Ledger entry OC-0524 (low): the same drag-select close in the 15 files, plus an image pan in the lightbox that ended on the backdrop.

### Deliberate-break check

| Break                                                   | Result                                                |
| ------------------------------------------------------- | ----------------------------------------------------- |
| The 15 files reverted to `dev` with the new tests kept  | all 18 new drag-select tests fail                     |
| A new `e.target === overlay` added to `PollComposer.ts` | `dialogBackdropDoor.test.ts` fails and names the file |

### Verdict against the stop rules

No gate was weakened and no existing assertion changed. The count went from 15 files to 0 with a test that holds it. The change is kept.

## MX-7 batch 2 + MX-10: admin body decoding and path ids (2026-10-28)

Measured on a branch from `origin/dev` after batch 1 (`757138e`). Evidence level: **executed**. Batch 2 moves the 23 `json.NewDecoder` calls left in `Server/admin` to the shared decoder and drops `DecodeAllow`. MX-10 is the path ids: `pathInt64` let `0` and negative ids reach the service on every admin id route, and nine api handlers parsed an id by hand.

### Counts

Counted by `grep` over non-test files in `Server/admin` and `Server/api`, and held after the change by the `reply-helpers` invariant.

| Measure (non-test files)                                   | Before                                                                                                                                                                                | After                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `json.NewDecoder` outside the shared decoder, `admin`      | 23 in 17 files, frozen in `DecodeAllow`                                                                                                                                               | 0; `DecodeAllow` deleted, so any new one fails                          |
| Replies to a body that does not decode, `admin`            | 4 messages ("invalid request body", "invalid JSON body", "invalid support bundle request", "expected one JSON object") plus 3 field-specific ones that also fired on a decode failure | 1: `400 BAD_REQUEST` "malformed request body"                           |
| `admin` JSON routes answering an over-size body with 413   | 0 of 23 decode sites                                                                                                                                                                  | 23 of 23 (`413 PAYLOAD_TOO_LARGE`), the support bundle at its own 1 KiB |
| Raw path-id parses (`strconv.ParseInt(chi.URLParam(...))`) | 9: 8 direct (`admin` 1, `api` 7) and the two-step one in `parsePluginID`                                                                                                              | 0 outside `pathInt64` and `pathID`, held by the invariant               |
| `pathInt64` call sites accepting `0` and negative ids      | 17                                                                                                                                                                                    | 0                                                                       |

### What changed

- `admin/decode.go`: `decodeJSON`, `decodeOptionalJSON` and `decodeStrictJSON`, the same three as `api/decode.go`. A body that does not decode answers `400 BAD_REQUEST` "malformed request body" (admin keeps its `BAD_REQUEST` code; `api` uses `INVALID_INPUT`), and a body past the route's `http.MaxBytesReader` cap answers `413 PAYLOAD_TOO_LARGE`. No admin route accepted an empty body before, so none uses the optional form.
- Where a handler folded a field check into the decode condition (AFK channel, config overrides, category order, access preview), the decode now fails with the shared reply and the field check keeps its own message.
- The retention preview and the support bundle routes use `decodeStrictJSON`. The support bundle keeps its 1 KiB cap, set before the helper runs, and its "expected one JSON object" reply is now the shared malformed reply.
- `admin.pathInt64` refuses an id below 1. `api` gets `pathID` (a positive id or false, writes nothing) in `api/path_id.go`; `parseIDParam` uses it, and the sticker, emoji, user-note, moderation and plugin handlers read their ids through it with the reply each already had (`BAD_REQUEST`, `INVALID_INPUT`, `http.NotFound`, plain-text `http.Error`). The registration route's own parse now goes through `pathInt64`.
- The `reply-helpers` invariant also fails a `strconv.ParseInt`, `ParseUint` or `Atoi` of a `chi.URLParam` (directly or through a local variable) in `api` and `admin` outside `pathInt64` and `pathID`.
- `docs/api.md` error table: `BAD_REQUEST` for the admin surface, 413 on every JSON route, and non-positive path ids.

### Checks

| Check                                                                                                         | Before                                            | After         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------- |
| `TestAdminAPI_PathIDRoutes_RefuseNonPositiveAndNonNumericIDs` (31 id positions × `0`, `-1`, `abc`)            | 58 of 93 subtests fail with `pathInt64` as it was | 93 of 93 pass |
| `TestAdminAPI_JSONBodyRoutes_OverTheCapIs413AndMalformedIs400` (14 routes × malformed and over the cap)       | did not exist                                     | 28 of 28      |
| `TestAdminAPI_SupportBundle_OverItsOneKiBCapIs413` (over the cap, padded after the value, strict, malformed)  | did not exist                                     | 6 of 6        |
| `admin/decode_test.go` (valid, 5 bad bodies, cap mid-value, cap after the value, empty optional body, strict) | did not exist                                     | 6 tests pass  |
| `reply-helpers` path-id and admin-decoder cases (violating and passing snippets)                              | did not exist                                     | pass          |

### Verdict

Kept. One reply for a bad admin body, 413 for an over-size one, and one rule for what a path id is on both surfaces. The visible change for clients is the message and status on the admin routes: "invalid request body" and its variants became "malformed request body", an over-size body is 413 instead of 400, and `/0` and `/-N` ids are refused at the handler instead of answering 404 or reaching the service. No existing test assertion changed.

## MX-15 one listen helper for preference changes (2026-10-28)

Candidate D5 from scout round 2, on `dev` `4a5e0b2b`.

### Baseline count

Counted with a grep for the event name over non-test files in `Client/src`, comments left out.

| Measure                                                | Before                                                       | After                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Files naming `owncord:pref-change` (besides its own)   | 20                                                           | 0                                                           |
| Hand-written subscriptions                             | 21 (20 `addEventListener`, 1 `eventSource`)                  | 0 (20 `onPrefChange`, 1 `eventSource` on the exported name) |
| Ways the changed key was read                          | 3 (8 `as EventListener`, 5 `as CustomEvent`, 2 `instanceof`) | 1 (inside `onPrefChange`)                                   |
| App-lifetime pref listeners in the lifecycle allowlist | 6                                                            | 6 (now found as `onPrefChange` without a signal)            |

### What changed

- `Client/src/lib/preferences.ts`: `PREF_CHANGE_EVENT` and `onPrefChange(keys, handler, signal?)`. `keys` is a list or `"any"`; the handler gets the changed key; an event without a key reaches only `"any"` listeners. It returns a remove function, which `onUserStatusChange` and `onStatusTimerChange` pass on.
- The 20 files call it. Each handler body is unchanged apart from the key check moving into the key list.
- `Client/src/features/prefChangeDoor.test.ts` fails on the event name in any other file and pins the helper's filtering.
- `tests/unit/lifecycle-ownership.test.ts` counts `onPrefChange` without a signal as a bare window listener, so its R1 allowlist and the 16 app-lifetime floor are unchanged.
- Four tests that mocked `lib/preferences` with only `loadPref`/`savePref` now spread the real module (the MX-9 pattern); no assertion changed.

### Deliberate-break check

| Break                                                      | Result                                            |
| ---------------------------------------------------------- | ------------------------------------------------- |
| The event name added to `lib/timeFormat.ts`                | `prefChangeDoor.test.ts` fails and names the file |
| The helper fires a keyed listener for an event with no key | `prefChangeDoor.test.ts` fails                    |

### Verdict against the stop rules

No gate was weakened and no existing assertion changed. The count went from 21 to 0 with a test that holds it. The change is kept.

## MX-17 one clipboard door for text copies (2026-10-28)

Candidate D7 from scout round 2, on `dev` `54568145`.

### Baseline count

Counted with a grep for `.writeText(` over non-test files in `Client/src`, comments left out.

| Measure                                         | Before                                                   | After                  |
| ----------------------------------------------- | -------------------------------------------------------- | ---------------------- |
| Direct `clipboard.writeText` calls              | 9 in 8 files (the scout's 8 plus `copyWithToast` itself) | 1 (`lib/clipboard.ts`) |
| Copy-then-toast written out                     | 5                                                        | 0 (`copyThenToast`)    |
| Copy-then-relabel written out                   | 3 (`content-parser.ts`, `LogsTab.ts` two)                | 0 (`copyThenRelabel`)  |
| Discarded `setTimeout` in the lifecycle R3 list | 3 (2 in `content-parser.ts`)                             | 1                      |

### What changed

- `Client/src/lib/clipboard.ts`: `copyText` (resolves true or false, never rejects, a missing clipboard is a failure), `copyThenToast`, and `copyThenRelabel`, whose label reset is dropped when its owner's signal aborts and restarted by a second press.
- The 8 files call it. `copyWithToast` in `developerTools.ts` keeps its signature and calls `copyThenToast`. `RecoverySections.ts` keeps its own reset, which also clears the screen-reader status.
- `Client/src/features/clipboardDoor.test.ts` fails on `.writeText(` in any other file and pins the helpers.
- The two `content-parser.ts` entries left the lifecycle R3 allowlist; `lib/clipboard.ts` joined the `lib-rest-6` Stryker shard.
- `pendingResets` (a `WeakMap` keyed by the button) joined `tests/session-state-allowlist.json` as dom-owned.
- Startup closure 102768 B to 102792 B (budget 102800 B).

Not a defect fix, but two behaviours are new: a copy on a page with no clipboard now shows the failure text instead of throwing in the click handler, and a second press of a code block's Copy no longer has its label reset early by the first press's timer.

### Deliberate-break check

| Break                                                   | Result                                           |
| ------------------------------------------------------- | ------------------------------------------------ |
| A `navigator.clipboard.writeText` added to `lib/dom.ts` | `clipboardDoor.test.ts` fails and names the file |
| `copyThenRelabel` stops cancelling the earlier reset    | "a second press restarts the wait" fails         |

### Verdict against the stop rules

No gate was weakened and no existing assertion changed. The count went from 9 to 1 with a test that holds it. The change is kept.
