# Developer maintainability: execution plan (R-0 result and R-1 plan)

**Status:** Planning only, drafted 2026-10-27 at `origin/dev` `cab72959d6a1de8450f71d00e7cab5edcaf9b272`. Nothing here is implemented, and nothing in it is approved until the owner accepts the planning PR. Evidence: [developer-maintainability-baseline-2026-10-24](developer-maintainability-baseline-2026-10-24.md).

The filename keeps the `2026-10-24` date of the assignment that named it. The content is dated 2026-10-27 and replaces the historical reference SHA `54df237d`.

**Goal.** Make correct changes easier for a human contributor to find, make, check and debug, and cheaper for an AI assistant to do the same, without changing behaviour. A change counts as an improvement only if a before/after comparison shows it; see [Measure, then compare](#measure-then-compare).

The separate architecture, security and reliability audit has **no results yet**. This plan makes no claim about it and does not depend on it.

## What changed since the source plan

The source plan was written against `54df237d` (2026-10-24). Two PRs merged on 2026-10-25 already did most of what it called R-1: [#2803](https://github.com/J3vb/OwnCord/pull/2803) (task map in `docs/contributing.md`, README links, focused-test examples) and [#2804](https://github.com/J3vb/OwnCord/pull/2804) (`run.mjs --list <task>`, `--json`, `--help`, clearer start-up failures). R-1 is therefore **smaller than planned**: it closes the gaps that remain, and it must not rebuild the task map or the runner.

## Ranked opportunities

"Verified" means seen in code or by running a command on 2026-10-27. "Hypothesis" means a benefit that was not measured. Effort is a rough size, not a measurement.

<!-- prettier-ignore -->
| # | Candidate and evidence | Mechanism to reuse | Benefit | Smallest useful change | Risk | Measurement | Effort | Overlap | Disposition |
| - | ---------------------- | ------------------ | ------- | ---------------------- | ---- | ----------- | ------ | ------- | ----------- |
| 1 | **Selector names have no public meaning.** Verified: `ci-select.mjs` emits `browser`, `integration`, `native`, `webclient` and others; a search for "capabilit" in `docs/contributing.md` and `docs/testing-behavior.md` finds nothing; the only explanation is code comments. | `ci-select.mjs` header comments, `ci.yml` job names, `Client/package.json` scripts, the existing selector paragraph in `contributing.md` | Human: knows which job a name gates and what to run locally. AI: stops opening `ci-select.mjs` and `ci.yml` to learn it (hypothesis). | One table in `docs/contributing.md` | Low. Documentation only; a wrong row would mislead, so each row is checked against `ci.yml` | Comparison task A (below) | Small | #2803 added the paragraph this extends | **Do now (R-1a)** |
| 2 | **Admin tests need Node, not stated.** Verified: no Go test covers `stickers.js`; its contract test is `Client/tests/contract/server-admin-static-stickers.test.ts`; the task-map row does not say it needs Node 26 and `Client/` dependencies. | Task map row, contract-ownership section | Human and AI: avoids a dead end for Go-only contributors (one wrong turn seen, n=1) | One sentence in the admin row | Low | Comparison task C | Trivial | #2803 | **Do now (R-1a)** |
| 3 | **Skip summary is untested.** Verified: `run.mjs` prints `passed, with <tools> skipped` and exits 0; `run.test.mjs` has no test for that line. Hypothesis: "passed" can be misread as full verification. | `run.test.mjs` helpers (`spawnSync` fixtures with an empty PATH) | Keeps edge case 2 true under future edits | One test pinning current behaviour; **no wording change** | Low. Test only | The test fails if the line or exit code changes | Small | #2804 added neighbouring tests | **Do now (R-1b)** |
| 4 | **Stale architecture claim.** Verified: `docs/architecture/server.md` (checked against `ac6ffc4e`, 2026-10-13) says moving raw `*db.DB` use behind services is "the remaining work"; `server-boundaries.md` (2026-10-24) classes all 83 rows as `adapter` (55) or `boundary` (28), none `move`. Hypothesis: some `adapter` handlers still hold a raw handle. | `cmd/dbinventory` and its doc test (passes today) | Human and AI: stops chasing finished work | Re-read the code, then fix or date the paragraph | Medium: a wrong correction is worse than a stale line | Row count from the inventory, plus a grep of handler constructors | Small to medium | Active phase 7 | **Pilot, conditional (R-1c)**, stop if code does not settle it |
| 5 | **Dialog late-reply and teardown paths are unpinned.** Verified: `thread-dialogs.test.ts` has no test of the 20 s `UNCONFIRMED` timeout, `onSendFailure`, or closing while a request is pending. Correctness of those paths is **not** established. | Existing `ws` fakes and fake timers in neighbouring tests; `Disposable`, `setOwnedTimeout` | Human: a contributor can see the contract. AI: shorter verification loop | Three tests, no production edit | Low to medium (a test may expose a real defect, which then follows the findings process) | Mutation or deliberate-break check on the three paths | Small | Client pilot A in the source plan | **Later**, as the code pilot |
| 6 | **Emoji service takes the 309-method `Store`.** Verified: five methods used; the ratchet's own comment prefers a small slice interface and three slices exist. Benefit is a hypothesis. | `datastore_ratchet_test.go`, `CallLogStore` pattern | Possibly narrower fakes for future changes | One slice interface in `emoji.go` | Low to medium | Compare the lines a fake needs to override before and after | Small | Source plan R-2 | **Later**, only if #5 is not chosen or a Go change shows the cost |
| 7 | **Sticker admin page has no direct reading guide.** Verified only that registration and tests are findable in 3 calls. | `ACTIONS`, contract suite | None demonstrated | None | None | None | None | None | **No change** |
| 8 | **Rust badge proof is split by platform.** Verified: pure helpers have unit tests; Windows, macOS and the live D-Bus send cannot be proved on Linux. Documented prerequisites exist. | `cargo test --lib`, `linux-webrtc-toolchain.sh` | None demonstrated | None | None | None | None | None | **No change** (recorded as a limit) |
| 9 | **Bare-path file to `ci-select` silently means "everything".** Verified: parsed as 0 paths, all capabilities true; the empty-diff behaviour is pinned by a test. Safe direction. | `contributing.md` command block (already shows `--name-status`) | Prevents a confused reader | Folded into row 1 as one sentence | Low | Folded into row 1 | Trivial | None | **Do now (inside R-1a)** |

Rows 1, 2, 3 and 9 are R-1. Row 4 is R-1c and may be dropped. Rows 5 and 6 are candidates for a later pilot and are **not authorized** by this plan. Row 10 is added below under [Candidate task](#candidate-task-added-2026-10-27-one-backdrop-close-for-dialogs).

## Measure, then compare

The same method applies to every area, and to a wider rollout:

1. **Pick a fixed comparison task** per area before changing anything: a small question or change whose answer is known (for example, "which checks must run for a change to `Server/admin/static/js/stickers.js`, and how do I run them locally?").
2. **Record a baseline** from the unchanged `dev` SHA: calls, files opened, wrong turns, and whether the answer matched the known one. Use a fresh session with no implementation context where affordable; otherwise label it contaminated.
3. **Make the smallest change**, then **repeat the same task** at the new SHA, on the same model and effort. Run each side at least twice where affordable and report the spread, not a single run.
4. **Keep the change only if** the recorded path got shorter or less error-prone, nothing required reading more files for the same answer, and no check got weaker. Otherwise revert it.
5. **Label the evidence honestly**: documentation/setup verified, simulated walkthrough completed, or human-tested. Only a real person doing the task is human-tested.
6. **To scale**, repeat steps 1 to 5 per area (Go services, client features, admin, Rust, contracts, CI) with one change per area at a time, and carry a result forward only if it held in a second area. An area with no demonstrated friction stays unchanged.

A report may state a saving only as the measured difference between two recorded runs.

## R-1 implementation plan

**Implementer:** one Sonnet session, medium effort. **Escalate to Opus** only for an unresolved cross-boundary question (for example, if row 4 shows the architecture docs and the code disagree on a rule). No Haiku. No subagents.

**Human-maintainability goal.** A contributor can learn what a CI check name means and how to reproduce it locally by reading `docs/contributing.md`, without opening `ci-select.mjs`, `ci.yml` or any file under `.claude/`.

**Branch.** From current `dev`, PR into `dev`. Re-resolve the SHA, re-read `CLAUDE.md`, and re-check the open PRs before starting.

### File-by-file edits

1. **`docs/contributing.md`** (R-1a), after the existing selector paragraph and command block (the one that ends "To see what your branch selects"):
   - Add one table with a row per capability emitted by `ci-select.mjs` (`server`, `client`, `rust`, `browser`, `integration`, `native`, `webclient`, `workflows`, `deps`, `permissions`, `changelog`). Columns: name, CI job(s) it gates, a local command, and whether `npm run check` covers it.
   - Job names come from `ci.yml` and must be checked against it, not copied from the comments in `ci-select.mjs`. Local commands come from `node scripts/run.mjs --list` and `Client/package.json`. A capability with no local equivalent (for example `native`, `workflows`, `deps`) says so.
   - Add one sentence: the path file uses `git diff --name-status` lines; a bare list of paths reads as no paths and selects every capability.
   - In the "Server admin panel" row of the task map, add that its tests are in `Client/` and need Node 26 and the `Client/` dependencies.
2. **`scripts/run.test.mjs`** (R-1b): add one test next to the existing CLI tests. It runs an `optional()` step whose probe is absent from an empty `PATH`, using the file's existing fixture helpers, and asserts exit code 0, a `--- SKIP` line naming the step, and a final line that states the skipped tool and that CI runs it. No change to `scripts/run.mjs`.
3. **`docs/architecture/server.md`** (R-1c, conditional): only if a read of the handler constructors and `cmd/dbinventory` output settles what is still unfinished. Then edit the "remaining work" paragraph to match, with a dated "verified against" line. If the code does not settle it in one sitting, add a single dated sentence pointing to `server-boundaries.md` and stop.
4. **`docs/plans/developer-maintainability-baseline-2026-10-24.md`**: append a new dated "R-1 after" section with the comparison results. Do not edit earlier sections.
5. **`docs/plans/README.md`**: update the execution plan's state line.

Not touched: `scripts/run.mjs`, `scripts/ci-select.mjs`, `scripts/ci-select.test.mjs`, `.github/`, any product code, dependency files, generated blocks, the ledger.

### State and file mutations, and who reads them

- `docs/contributing.md`, `docs/architecture/server.md`: read by humans and linked from `CLAUDE.md`, `AGENTS.md` and the component READMEs. Prettier checks formatting; `check-doc-citations` and `check-doc-counts` run over their watched documents.
- `scripts/run.test.mjs`: run by `node --test scripts/run.test.mjs` in the Repository Hygiene job. The new test writes only to a temporary directory it removes.
- No store, table, config key, lock or generated file changes.

### Two edge cases and their proof

1. **An unknown or cross-component input cannot silently yield an insufficient check plan.** The table must tell readers that unknown paths and empty or unreadable diffs select everything. Proof: `node --test scripts/ci-select.test.mjs` (64 tests today, including the empty-diff and unknown-path cases) passes unchanged, and the implementer reruns the selector for one unknown path and for a bare-path file and records that both select all eleven capabilities. The docs sentence is checked against that output.
2. **A missing tool, platform or failing command cannot be reported as full verification.** Proof: the new `run.test.mjs` test pins that a skipped optional step is named in the output and that its tool is listed; the existing tests already pin `FAILED` with command and directory for a missing required executable, and exit-code preservation. The documentation row for each capability must label what `npm run check` does not run.

### Checks

- **Focused:** `node --test scripts/run.test.mjs`; `node --test scripts/ci-select.test.mjs`; `npx prettier --check docs/contributing.md docs/architecture/server.md docs/plans`; `node scripts/check-doc-citations.mjs`; `node scripts/check-doc-counts.mjs`.
- **Complete, required before the PR leaves draft:** `node scripts/run.mjs check:docs` and `node scripts/run.mjs check:hygiene`. Say which optional tools were missing. If row 3 or 4 touched anything the selector maps to the server, also run `go test -count=1 ./cmd/dbinventory/` in `Server/`.
- **CI** is the authority; local runs shorten feedback only.

### Human-contributor acceptance criteria

- From `docs/contributing.md` alone, a reader can name the job behind each selector name and find a local command or a stated "none".
- Every command in the new table was either executed (status recorded) or marked "reviewed, not executed" with the reason.
- No essential statement exists only in `.claude/`, `CLAUDE.md` or a chat.
- The new table adds no more than about 15 lines of prose and one table; the task map keeps its present shape.
- Reported as "documentation/setup verified" or "simulated walkthrough completed". Never "human-tested".

### Baseline and after comparison

Three fixed tasks, run on `dev` `cab72959` before the edits and on the branch after, each in a fresh session that is told only the public starting point (`README.md`) and the task:

- **A.** "Which CI jobs does a change to `Server/service/emoji.go` trigger, and what do I run locally to cover them?"
- **B.** "Does `npm run check` fully verify a change to `Client/src-tauri/src/unread_badge.rs`? If not, what is missing?"
- **C.** "Where are the tests for `Server/admin/static/js/stickers.js`, and what do I need installed to run them?"

Record per run: calls, files opened, wrong turns, whether the answer matches the known answer (A: `server`, `integration`, `native`; B: no, Windows and macOS paths and the live Linux D-Bus send are not covered, and `npm run check:rust` needs the Linux toolchain; C: `Client/tests/contract/...`, Node 26 and `Client/` dependencies), model, effort, and any usage the session exposes. Run each twice if affordable. The agent-instruction files are still loaded automatically, so note that the runs are not blind to them.

### Rollback and stopping

- **Rollback.** Revert the PR. It changes documentation and one test file only, so no data, generated output or behaviour is affected.
- **Stop and report instead of widening** if: a capability cannot be matched to a `ci.yml` job in one pass; the new test needs a change to `run.mjs`; row 4 turns up a real defect (record it in the findings ledger process and do not fix it here); the after-comparison shows no shorter path or a worse answer on any task; or another PR changes `docs/contributing.md` or `scripts/run.mjs` first (rebase once, then stop if it overlaps).
- **Do not** change CI selection, loosen a gate, make Node required for Go-only work, or add a wrapper or skill.

## Recommended next assignment

Implement R-1 exactly as above (rows 1, 2, 3, 9 and, if the code settles it, 4), in one Sonnet session and one PR into `dev`, with the before/after comparison appended to the baseline. It is cheap, reversible and measurable. Afterwards, decide whether to stop or run a **conditional** code pilot: row 5 (three dialog tests, no production edit) is the better-evidenced candidate; row 6 only if a Go change shows the cost. Neither is authorized by this plan.

## Candidate task added 2026-10-27: one backdrop close for dialogs

**Source.** Raised by the owner from the 8.13 work (PR #2842): many dialogs close when a drag-select ends on the backdrop. Not authorized yet; it needs the same baseline, change and comparison as any pilot.

**Verified on `dev` `1afda4b2` (2026-10-27, by grep, not by running the app).**

- `Client/src/lib/modalFactory.ts` has `createModal`, 31 non-test files mention it, and it closes on a backdrop `click` whose `e.target === overlay` (line 115) plus Escape.
- Eleven other files carry their own backdrop check: `CertMismatchModal.ts` (two), `IdentityMismatchModal.ts`, `WhatsNewDialog.ts`, `message-list/attachments.ts`, `SearchOverlay.ts`, `SettingsOverlay.ts`, `QuickSwitcher.ts`, `QuickSwitchOverlay.ts`, `CategoryModals.ts`, `PollComposer.ts` and `ForwardPicker.ts`. The last three use `createModal` and add their own check on `modal.overlay`.
- The channel dialogs (`CreateChannelModal`, `EditChannelModal`, `DeleteChannelModal`) and `InviteManager` were named in the request but have no such check under that pattern; how they close was not traced.

**Shared helper (depends on #2842).** The hypothesis that `createModal` itself closed on drag-select was right: it is ledger finding OC-0520, and PR [#2842](https://github.com/J3vb/OwnCord/pull/2842) (open when this was written, not merged) fixes it in the helper by remembering where the press started, with unit tests that send a synthetic press and click. This task does not plan that fix again and starts only after #2842 merges. That fix does **not** reach the eleven files above that bypass `createModal`, and the three that add a second check on `modal.overlay` may still close on a drag-select. Whether each one does was not tested.

**Smallest useful change, in order, after #2842 merges.**

1. Confirm on one bypassing dialog (for example `SearchOverlay`) that a press inside and a release on the backdrop closes it today, using the same synthetic-event test style as #2842. Record the result per dialog family.
2. Move dialogs onto `createModal`, or onto one small exported backdrop helper, in small batches. Each batch keeps the dialog's Escape, focus and close behaviour and adds the drag-select test.
3. Add a structural test beside `Client/src/features/dispatcherDoor.test.ts` that fails on a new hand-written backdrop `e.target === ...` check under `Client/src`, with the existing files listed as a shrink-only allowlist.

**Measurement.** Count of files with a hand-written backdrop check (11 now, plus `modalFactory.ts`); the drag-select test passing for each migrated dialog; the structural test failing on a deliberately added check. No saving is claimed. **Risk:** medium, since dialogs hold focus and Escape behaviour that must stay the same. **Disposition:** later, as a client pilot; it competes with row 5 for the client slot and the owner decides the order.

## Inputs for later phases

- [#2806](https://github.com/J3vb/OwnCord/pull/2806) is a docs-only design for a measured screen-sharing performance pipeline, tied to issue #2805 (frame-rate drops on Windows). It was not read in detail for this plan. It is **not** part of R-1 and is not ranked above. It is an input to a later performance assignment, which should follow the same measure-then-compare method and keep clear of voice and E2EE code unless that assignment is scoped for it.

## Honest limits

- Measured in one contaminated session; no variance; no human has tested the contributor path.
- `ci.yml` was not read in full, so the match between `run.mjs` and the workflow is unchecked and the R-1 table must verify it.
- The Rust platform paths and the full gates (`npm run check`, Playwright, audit tools) were not run.
- No percentage or cost saving is claimed or implied.

## Candidate tasks added 2026-10-27: more shared-helper bypasses

**Source.** The owner asked for a scout of more cases like the dialog backdrop task: hand-written code that bypasses an existing shared helper, or many copies that should share one. Read-only scouting of `Client/src`, `Client/src-tauri/src` and `Server/` on `dev` `1afda4b2`. Counts below were re-run by grep; behaviour was read from code, not reproduced in the app unless stated. None of these is authorized; each needs the same baseline, change and comparison as any pilot.

**Already enforced, so not listed:** `@tauri-apps` imports outside `src/platform/desktop`, raw HTML sinks and dropped subscriptions (ESLint); truncating file writes (`clippy.toml`); raw `go` statements, raw mutexes, permission-bit checks, outbound network sites and `db` handle use (`Server/invariants/`).

<!-- prettier-ignore -->
| # | Candidate | Shared helper | Copies (verified) | What goes wrong | Measurement | Effort |
| - | --------- | ------------- | ----------------- | --------------- | ----------- | ------ |
| C1 | Context menus built by hand | `showContextMenu`, `registerSidebarMenu`, `clampMenuToViewport` in `Client/src/lib/context-menu.ts` | 7 menus in 6 files build `.context-menu` themselves; only 3 of them register with `registerSidebarMenu`, and `tile-menu.ts` and `AdminActions.ts` (two) do not clamp to the viewport | Read from code: the volume, video-tile and admin menus can stay open beside another menu, and the last two can overflow the window edge | Count of `class: "context-menu` outside `lib/context-menu.ts` (7 to 0) held by a structural test; a test that opens two menus and finds one `.context-menu` | Medium |
| C2 | Enter submits during IME composition | None yet; the guard `e.isComposing \|\| e.keyCode === 229` is copied in 7 files | 9 text-submit handlers have no guard: `LoginForm.ts:698`, `ServerPanel.ts:567`, `QuickSwitcher.ts:203`, `SearchOverlay.ts:490`, `NicknameDialog.ts:182`, `BanDialog.ts:320`, `purge-prompt.ts:130`, `GameActivityGames.ts:203` and `:368` | A Chinese, Japanese or Korean input method commits a candidate with Enter; in these fields that submits a half-typed value, for example a ban with a half-typed reason | One `isImeCommit(e)` helper in `lib/`; structural test on unguarded Enter handlers in text inputs (9 to 0); a test per field with `isComposing: true` | Small |
| C3 | Server error replies and body decoding by hand | `writeErr`, `writeJSON` (`api/middleware.go`, `api/router.go`), copied again in `admin/helpers.go` | 58 `writeJSON(w, …, errorResponse{…})` literals instead of `writeErr`; 53 `json.NewDecoder(r.Body)` sites in 32 files; 28 `http.Error` text replies in 5 files | The same bad input gets different codes (`BAD_REQUEST` vs `INVALID_INPUT` for `limit`) and messages (three spellings of "invalid body"); an over-size JSON body returns 400 instead of 413 everywhere except uploads; the plugin admin page keeps its own fetch helper because those replies are plain text | Invariant tests in `Server/invariants/` banning `errorResponse{` literals and `json.NewDecoder(r.Body)` outside the helper, ratcheted down from 58 and 53; a behaviour test that an over-size body returns 413 | Medium, batchable |
| C4 | Tauri `invoke` with no `try/catch` | None yet; `credentials.ts` and `identity.ts` each define a private `getInvoke()` | 95 lines calling `invoke(` in 21 files under `Client/src/platform/desktop`; a brace-tracking scan put about 50 outside any `try` (42 of the lines are in `nativeVoiceService.ts`). The exact unwrapped count is step 1 of the task | `CLAUDE.md` requires every `invoke` to be wrapped where it is called; unwrapped calls hand a rejection to callers that may not expect one (for example `pendingMessages.save` on a disk error) | One `invokeResult`/`tryInvoke` helper; structural test that bans a bare `invoke(` outside it, shrink-only per-file allowlist | Medium |
| C5 | `localStorage` used directly | `loadPref`/`savePref` in `lib/preferences.ts` (guarded) | 17 files touch `localStorage` directly; 5 repeat the same read-parse-validate-cap body (`emojiRecent`, `stickerRecent`, `trustedDomains`, `ui.store`, `savedDrafts`); several calls are unguarded, including `getActiveThemeName` at startup | When storage throws (blocked or full, more likely in the browser client than in Tauri) startup theme code and a member-list click throw uncaught | One `safeStorage` helper; count of files touching `localStorage` (17 to about 2) held by a lint rule or structural test | Small to medium |
| C6 | Admin path ids accept 0 and negatives | `parseIDParam` in `api/channel_handler.go` rejects `<= 0`; `admin/helpers.go` `pathInt64` does not | 8 raw `strconv.ParseInt(chi.URLParam…)` copies in `api` and `admin`; `pathInt64` has 18 callers | The same bad id gets 400, 404 or a different code depending on the route | Ratchet on raw parses (8 to 0); a table test sending `0`, `-1` and `abc` to each admin id route | Small |

**Recommended order.** C2 first (small, a real defect for input-method users, easy to prove with a synthetic event), then C1 (the closest match to the dialog task and it shares its test style), then C3 (largest server cleanup, can go in batches by package). C4 and C5 follow. C6 is a small add-on to C3.

**Recorded but not proposed.** Clipboard writes outside `copyWithToast` (5 sites, small); outside-click and Escape dismissal hand-rolled in 8 files (mostly folds into C1); five copies of a Rust `lock()` poison-recovery helper plus inline copies (style only, one policy); `window_activation.rs` temp-and-rename write that skips `json_store::write_atomic`'s fsync (small); context-less `slog` calls that drop the request id (about 735 calls in `api`, `admin`, `service`, `ws`; better done with a linter setting than a hand migration); `Result<_, String>` in Tauri commands (large, weak payoff).

**Limits.** Scouted by three read-only sessions plus a grep re-check, no app run, no tests run. Bug descriptions for C1 and C5 are read from code and need the step-1 reproduction before any fix is planned. No saving is claimed.
