# Plan: B7-0 — Verify claims and record the entry baselines

**Source PRD**: `docs/plans/b7-shared-client-platform-desktop-parity.prd.md`
**Selected Milestone**: B7-0 — Verify claims and record the entry baselines
(roadmap workstream 13, workstream 15's mutation score deferred to B7-8,
pattern rule 1; roadmap `:928-932`, `:968-970`, `:975-976`). Entry gate item 3
(`roadmap:931`) closes only if Task 1 produces a startup/memory number;
otherwise it stays open and the baseline file says so.
**Satisfies**: PRD row B7-0 (`prd.md:302`): "Every roadmap claim entering the
phase is re-checked against HEAD and the missing baselines (startup, memory,
client coverage %, mutation score, knip hints, import cycles, bundle sizes)
are recorded once, so later milestones ratchet against real numbers instead
of guesses". Roadmap workstream 13 (`repo-health-roadmap-2026-08-23.md:968-970`)
adds the dead-command deletion; the register reconciliation follows from PRD
`:349` ("reconciled by B7-0 (all 25 B7-tagged register rows, ledger-`fixed`,
re-verified at HEAD)") and pattern rule 2.
**Complexity**: Medium
**Drafted**: 2026-09-19 at `dev` `ccd9a5d`; in flight: B6-12 tag rehearsal,
B6-16 final pass, HP-6. None touch `Client/`, but B6-16 edits
`docs/plans/repo-health-issue-register-2026-08-23.md` and
`docs/plans/README.md`, which Tasks 4 and 5 also edit — sequence after B6-16
merges or coordinate the register/README hunks.

**Executor rule**: Where this plan proposes a default for an open question,
apply that default unless the owner has overridden it in this file. Where a
step needs hardware, a human, a network, or a merged PR that is not available
to you, do not guess and do not invent a value: mark the row `unverified`,
state what was missing in the PR description, and continue with the next
step. Never leave a `<placeholder>` in committed text.

## Summary

B7-0 produces five things: (1)
`docs/plans/b7-0-client-baseline-2026-09-19.md`, shaped like
`docs/plans/b0-baseline-2026-08-25.md`, holding the measured numbers this plan
records at Task 1; (2) `docs/architecture/platform-contracts.md` corrected to
match the real inventory, its count-guard test
`Client/tests/unit/platform-contracts-counts.test.ts` updated if the pinned
constants move, and `Client/CLAUDE.md`'s "20 files" line corrected to 21; (3)
`probe_credential_store` deleted from `Client/src-tauri/src/credentials.rs`
and its registration from `Client/src-tauri/src/lib.rs`; (4) the register's
25 open-treated B7-tagged OC rows reconciled against the findings ledger,
each either marked `fixed` (mirroring the ledger) or, for any row that fails
re-verification, assigned to a milestone or re-tagged to B9 with a reason;
(5) the "Verify before you implement" verdicts below, which are this plan's
own claim audit and the reason none of B7-0's other tasks re-derive a number
already measured at HEAD.

## Verify before you implement

Facts established from source at `ccd9a5d`. Rows marked
**Refuted**, **Corrected** or **Unknown** contradict something the roadmap,
the PRD, an architecture document or an obvious first design would assume,
and this plan's tasks are built on the correction.

| Claim                                      | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "20 native import files"                   | **Corrected** | `Client/CLAUDE.md:19` says "20 files hold the native imports"; the live count is 21 (`docs/architecture/platform-contracts.md:51`)                                                                                                                                                                                                                                                                  |
| `ptt_get_key` registered and uncalled      | **Refuted**   | No command named `ptt_get_key` exists anywhere in `.rs` or `.ts` (zero hits via `git grep -w ptt_get_key`); `docs/architecture/platform-contracts.md:80-81` claims it is a registered, uncalled, dead-surface candidate — the command does not exist to be dead                                                                                                                                     |
| `store_cert_fingerprint` registered        | **Refuted**   | `Client/src-tauri/src/lib.rs:108-142` registers `get_cert_fingerprint` (`:111`) only; no `store_cert_fingerprint` in `generate_handler!` or anywhere else in the tree. `docs/architecture/platform-contracts.md:78-80` claims it is registered and used by `Client/tests/e2e/helpers.ts` — that file's only fingerprint stub is `get_cert_fingerprint` (`helpers.ts:740`)                           |
| `livekitSession.ts` is a proxy invoke site | **Refuted**   | The real invoke sites for native proxies are `lib/httpProxy.ts:13` (`start_http_proxy`) and `lib/livekitUrlResolver.ts:4` (`start`/`stop_livekit_proxy`); `docs/architecture/platform-contracts.md:101`'s "Native proxies" row lists `lib/livekitSession.ts` instead, and its "Files today" column omits `lib/pendingMessages.ts` and `lib/livekitUrlResolver.ts` entirely                          |
| Four production import cycles              | **Unknown**   | No dependency-cruiser/madge/import-cycle tool or config exists anywhere in the repo; C-11 (register :214) asserts four cycles in LiveKit/audio and attachment/media/embed with no tool backing the count                                                                                                                                                                                            |
| 471 oxlint warnings                        | **Unknown**   | The number is B0's (`docs/plans/b0-baseline-2026-08-25.md:42`), not re-measured at HEAD; Task 1 re-runs `oxlint` and records HEAD's count                                                                                                                                                                                                                                                           |
| Mutation baseline 67.04%                   | **Unknown**   | C-16 (register :219) calls the Stryker baseline "stale at 67.04%" with no re-run since; `Client/stryker.config.mjs` thresholds (80/60/50) have not been checked against a fresh score                                                                                                                                                                                                               |
| Client coverage measured                   | **Refuted**   | Grepped over `b0-baseline` and `hp-0..hp-5` scorecards, client coverage % is nowhere recorded; `Client/vitest.config.ts` sets 70/70/70/70 thresholds and `coverage-floor.json` = 70.0, but no baseline percentage has ever been written down                                                                                                                                                        |
| Protocol fixtures available to clients     | **Corrected** | `protocol/fixtures/epoch-1/` (13 journey transcripts) is driven only by `Server/ws/protocol_epoch1_contract_test.go`; no client code consumes the fixtures — three prose mentions only: `Client/src/lib/livekitSession.ts:230` and two unit tests                                                                                                                                                   |
| Server stable through B6                   | **Unknown**   | B6 PRD (`docs/plans/b6-server-deployment-operations-capacity.prd.md`) milestone table on `dev` `ccd9a5d`: B6-12 (tag rehearsal, all 12 acceptance boxes unticked) and B6-16 (final pass, all 10 unticked) are in-progress; HP-6 (`.claude/plans/hp-6-operator-capacity-acceptance.plan.md`) is pending and unsigned, and cannot start before B6-12's tag run. Entry gate item 1 is not formally met |
| OC-0313/0329/0353/0354 open                | **Refuted**   | All four are already fixed and register-closed: OC-0313, OC-0329 (B4-12a), OC-0353 (#1530), OC-0354 (B4-7) (`docs/plans/repo-health-issue-register-2026-08-23.md`); they are excluded from the 25-row open B7 OC set this plan triages at Task 4                                                                                                                                                    |

## Patterns to Mirror

| Category                 | Source                                                                                                                                   | Pattern                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline doc shape       | `docs/plans/b0-baseline-2026-08-25.md`                                                                                                   | one dated evidence file per phase, measured-not-estimated numbers under named headings, a closing "budget baseline" sentence the next phase ratchets against           |
| Scorecard verdict tables | `docs/plans/hp-1-scorecard-2026-08-27.md` (and `.claude/plans/b6-14-service-boundary-handles.plan.md:47-81` for the in-plan table shape) | Claim / Status / Evidence tables with the Confirmed/Refuted/Corrected/Unknown vocabulary, each row anchored to a live re-check rather than a restated assumption       |
| Count-guard test         | `Client/tests/unit/platform-contracts-counts.test.ts`                                                                                    | a test that fails CI when `docs/architecture/platform-contracts.md`'s pinned counts disagree with a fresh `git grep` of the tree — the doc cannot silently drift again |
| Dead-command deletion    | `Client/src-tauri/src/lib.rs` `generate_handler!` + `Cargo.toml`                                                                         | remove the function, its registration line, and any doc/test reference in the same commit; no unused-command residue                                                   |
| Register re-tag wording  | b5 plan `:2869-2872` SEC-03 precedent                                                                                                    | a re-tag is one sentence naming the new milestone and the reason the current one cannot close it — never a bare tag edit                                               |

## Files to Change

| File                                                         | Action | Why                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/plans/b7-0-client-baseline-2026-09-19.md`              | CREATE | the dated evidence file holding every measurement from Task 1, shaped like `b0-baseline-2026-08-25.md`                                                                                                                                                                                                 |
| `docs/architecture/platform-contracts.md`                    | UPDATE | fix the "Native proxies" row (`lib/httpProxy.ts` / `lib/livekitUrlResolver.ts`, not `lib/livekitSession.ts`), add the missing `lib/pendingMessages.ts` and `lib/livekitUrlResolver.ts` rows, drop the `ptt_get_key`/`store_cert_fingerprint` claims, and reflect the `probe_credential_store` deletion |
| `Client/tests/unit/platform-contracts-counts.test.ts`        | UPDATE | update only if a pinned count moves as a result of the doc corrections or the `probe_credential_store` deletion (34 → 33 `#[tauri::command]` handlers)                                                                                                                                                 |
| `Client/CLAUDE.md`                                           | UPDATE | "20 files hold the native imports" → 21 (`:19`)                                                                                                                                                                                                                                                        |
| `Client/src-tauri/src/credentials.rs`                        | UPDATE | remove the whole `Diagnostics` block (`:391-453`): the `CredentialStoreProbe` struct and its doc comment (`:395-404`), the function doc (`:406-412`) and `probe_credential_store` itself (`:413-453`), checking whether the `Backend` and `Serialize` imports are still used                           |
| `Client/src-tauri/src/lib.rs`                                | UPDATE | delete the `credentials::probe_credential_store` registration (`:128`)                                                                                                                                                                                                                                 |
| `docs/credential-storage.md`                                 | UPDATE | remove the `probe_credential_store` live-check section (`:198-206`, through the closing fence) — the command is deleted                                                                                                                                                                                |
| `docs/plans/b7-shared-client-platform-desktop-parity.prd.md` | UPDATE | flip the B7-0 row's status; note the OC reconciliation result in "What each milestone closes in the register" (`prd.md:345`) only for any row Task 4 re-tags or reassigns                                                                                                                              |
| `docs/plans/README.md`                                       | UPDATE | B7 row status only                                                                                                                                                                                                                                                                                     |
| `docs/plans/repo-health-issue-register-2026-08-23.md`        | UPDATE | add the ledger's `fixed` prefix to the 25 OC rows Task 4 verifies as fixed; re-tag to B9 (with a written reason) only a row that fails re-verification; no other register edit                                                                                                                         |

Explicitly out of these files: no `Client/src/platform/` (that is B7-1), no
vite/lint config changes (B7-1/B7-3).

## Tasks

### Task 0: Branch and the verify table

- **Action**: branch `feat/b7-0-verify-and-baseline` from `dev` **after** the
  `docs/b7-prd` PR (PRD + this plan + the README B7 row) has merged; until
  then, branch from `docs/b7-prd`. Record the dependency in the PR
  description. Commit the "Verify before you implement" table above as the
  PR's opening evidence before any other file changes land, so reviewers see
  the claim audit before the corrections it justifies.
- **Why**: pattern rule 1 — a phase's execution plan must re-verify roadmap
  claims against HEAD and record each verdict before acting on them.
- **Validate**: `git status` clean on branch creation; the table renders.

### Task 1: Measure and record the baselines

- **Action**: create `docs/plans/b7-0-client-baseline-2026-09-19.md`, shaped
  like `docs/plans/b0-baseline-2026-08-25.md`. Record, with the exact command
  run for each:
  - **Unit/integration test counts**: `cd Client && npx vitest run tests/unit tests/integration --reporter=json`
    for the B0-comparable figure (files and test counts, comparable to B0's
    5257 unit+integration tests / 192 files), and record
    `cd Client && npx vitest run` (all suites including `tests/contract`)
    separately.
  - **Coverage**: `cd Client && npm run test:coverage`, then read
    `coverage/coverage-summary.json` for the overall percentage against the
    70/70/70/70 threshold. This is a number no B0 baseline or HP-0..HP-5
    scorecard has ever recorded — recording it here closes that gap.
  - **oxlint warnings**: `cd Client && npx oxlint src/ 2>&1 | tail -1`,
    compared against B0's 471 (`b0-baseline-2026-08-25.md:42`).
  - **knip hints**: `cd Client && npx knip`, raw hint count.
  - **Import cycles**: add nothing to `package.json`. Run
    `cd Client && npx --yes madge --circular --extensions ts --ts-config tsconfig.json src`
    as a one-off measurement (`--ts-config` is required to resolve the
    `@lib/*`/`@stores/*`/`@components/*`/`@pages/*`/`@styles/*` path aliases
    `Client/tsconfig.json` and `Client/vite.config.ts` both declare — without
    it madge silently drops those edges and undercounts) and record the
    result plus the sentence "no tool in this repo gates import cycles; the
    count depends on alias resolution via `--ts-config`; C-11's four-cycle
    figure is otherwise unmeasured" — do not wire madge into CI or scripts
    here (that would be a new gate, out of scope for B7-0).
  - **Bundle sizes**: `cd Client && npm run build`, then for each asset under
    `dist/assets` record minified and gzip size (`gzip -c <file> | wc -c`),
    compared line-for-line against the B0 chunk table
    (`b0-baseline-2026-08-25.md:51-57`: livekitSession, livekit, MainPage,
    index, SettingsOverlay).
  - **Playwright count**: `cd Client && npx playwright test --list | tail -1`
    for the default config, plus `--config playwright.config.admin.ts`,
    `--config playwright.config.native.ts` and
    `--config playwright.config.fullstack.ts` — record each separately and
    state that B0's 293 (`b0-baseline-2026-08-25.md:43`) was the full suite
    across all configs.
  - **Timer/listener/AbortController counts**: rerun the same grep commands
    used to establish today's counts (AbortController construction sites,
    `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` counts,
    `addEventListener`/`removeEventListener` counts) — and record whether
    they moved from 45 files constructing their own `AbortController` (69
    constructing one or taking a signal) / 76 timers (67 clear + 7 clear) /
    392 vs 28 listeners.
  - **Native import count**: `git grep -l "@tauri-apps" -- 'Client/src/**' | wc -l`
    (the same command `docs/architecture/platform-contracts.md:67` already
    documents), expected 21 per this plan's verify table.
  - **Rust command count**: count entries in `Client/src-tauri/src/lib.rs`'s
    `generate_handler!` after Task 3's deletion — expected 31 entries: 30
    unconditional plus `open_devtools` behind `#[cfg(feature = "devtools")]`
    (32 entries today, minus `probe_credential_store`).
  - **Stryker**: the mutation _score_ is B7-8's (PRD open question 5,
    `b7-shared-client-platform-desktop-parity.prd.md:375`); B7-0 records only
    that `cd Client && npm run test:mutate:dry` completes, and leaves the
    PRD's "mutation score" baseline explicitly deferred to B7-8. Do not run
    the full `test:mutate` here.
  - **Startup time and memory**: state the method, do not invent a number.
    Either record a measurement taken with the Tauri devtools performance
    timeline on a debug build, with the exact steps used, or record: "not
    measurable in CI; measured manually on the developer machine with
    `npm run tauri dev` plus the Tauri devtools performance timeline; no CI
    job produces this number and none is added here." If no number is
    produced, this plan does not close roadmap entry gate item 3
    (`repo-health-roadmap-2026-08-23.md:931`); record that explicitly in the
    baseline file and in the PR description.
- **Why**: PRD row B7-0's "the missing baselines are recorded in one dated
  evidence file"; roadmap workstream 15's baseline half; startup time,
  memory, client coverage %, mutation score, knip hint count and import-cycle
  count have never been recorded in any B0 baseline or HP-0..HP-5 scorecard.
- **Gotcha**: `Client/tests/setup.ts` has no `afterEach` and
  `vitest.config.ts` has no `clearMocks`/`restoreMocks`/`unstubGlobals` — a
  coverage or test-count run on this branch measures the suite as it exists
  today, not a suite this plan is asked to harden; do not fix that here.
- **Mirror**: `docs/plans/b0-baseline-2026-08-25.md`'s structure and its
  closing "budget baseline" framing.
- **Validate**: every number in the new file has the command that produced it
  next to it; no number is copied from B0 without being re-run.

### Task 2: Fix `platform-contracts.md` drift, the count test, and `CLAUDE.md`

- **Action**:
  - `docs/architecture/platform-contracts.md`: correct the "Native proxies"
    row (`:101`) to `lib/httpProxy.ts`, `lib/livekitUrlResolver.ts`; add rows
    or column entries for `lib/pendingMessages.ts` (the only project use of
    the SDK's `isTauri`, per `Client/src/lib/pendingMessages.ts:5,34,38,42`)
    and confirm `lib/livekitUrlResolver.ts`
    is not duplicated once moved into the corrected proxies row; remove the
    `store_cert_fingerprint` and `ptt_get_key` claims at `:78-82` and replace
    them with: `get_cert_fingerprint` is registered with no caller in
    `Client/src/` (it is invoked only from the e2e helpers,
    `Client/tests/e2e/native/helpers.ts:75`); `probe_credential_store` was a
    second dead-surface candidate, now deleted (Task 3) — leaving one
    unresolved registered-but-unconsumed-in-production command,
    `get_cert_fingerprint`, referred to open question 2.
  - `Client/tests/unit/platform-contracts-counts.test.ts:56` pins
    `commandHandlers` to 34 `#[tauri::command` attributes; Task 3's deletion
    moves it to 33, so update that constant and the
    `#[tauri::command]` handlers row at `docs/architecture/platform-contracts.md:53`
    (34 → 33), plus the prose at `:59-62`. Re-derive every number there
    from the tree rather than by subtraction: the attribute split ("21
    `#[tauri::command]` plus 13 `#[tauri::command(async)]`") loses one
    `async` entry since `probe_credential_store` is
    `#[tauri::command(async)]` (`Client/src-tauri/src/credentials.rs:413`),
    and the sentence "One of the 34 … a default build registers 33" is
    already wrong today — `generate_handler!` (`lib.rs:108-142`) holds 32
    entries including `open_devtools`, so attributes (34) and registrations
    (32) are two different counts and the doc conflates them. Write both
    numbers as measured after Task 3, and say which is which.
    The `@tauri-apps` importer count stays 21 and the invoke-name count
    stays 29.
  - `Client/CLAUDE.md:19`: "20 files" → "21 files".
- **Why**: PRD row B7-0's "`docs/architecture/platform-contracts.md` matches
  the real inventory".
- **Validate**: `cd Client && npx vitest run tests/unit/platform-contracts-counts.test.ts`.

### Task 3: Delete `probe_credential_store`

- **Action**: remove the whole `Diagnostics` block at
  `Client/src-tauri/src/credentials.rs:391-453`: the `CredentialStoreProbe`
  struct and its doc comment (`:395-404`), the function doc (`:406-412`) and
  `probe_credential_store` itself (`:413-453`), checking whether the
  `Backend` and `Serialize` imports are still used; remove the registration
  at `Client/src-tauri/src/lib.rs:128`. Also remove the
  `probe_credential_store` live-check section from
  `docs/credential-storage.md:198-206` (through the closing ` ``` ` fence) —
  the command is deleted. Leave
  `get_cert_fingerprint` in place — it has no caller in `Client/src/` either,
  but it is not this task's claim (see open question 2).
- **Why**: PRD row B7-0's "`probe_credential_store` is gone"; HP-1 scorecard
  named it a B7 dead-surface candidate (`docs/plans/hp-1-scorecard-2026-08-27.md:339`).
- **Validate**: `cd Client/src-tauri && cargo test`; `cd Client/src-tauri && cargo clippy`;
  `git grep -n probe_credential_store -- Client/ docs/credential-storage.md docs/architecture/`
  returns no hits (historical mentions in roadmap/scorecard/PRD are expected).

### Task 4: Reconcile the register's B7-tagged OC rows against the ledger

- **Action**: reconcile the 29 B7-tagged OC rows in
  `docs/plans/repo-health-issue-register-2026-08-23.md` against
  `.superpowers/findings-ledger.json` and HEAD. The ledger records all 25
  rows this plan's draft treated as open — OC-0311, OC-0312, OC-0315,
  OC-0316, OC-0317, OC-0322, OC-0325, OC-0326, OC-0328, OC-0330, OC-0333,
  OC-0334, OC-0335, OC-0336, OC-0343, OC-0347, OC-0348, OC-0352, OC-0359,
  OC-0360, OC-0362, OC-0363, OC-0365, OC-0366, OC-0369 — as `status: "fixed"`
  (spot-checked at HEAD: OC-0311 is fixed at
  `Client/src/lib/dispatcher.ts:1144`; OC-0359 is fixed at
  `Client/src-tauri/src/secret_store.rs:161-178`
  (`purge_stale_keyring_after_fallback_commits`) with a pinning test at
  `:621`). Verify each of the 25 against the tree and add the ledger's
  `fixed` prefix to the register row (date and commit from the ledger's
  `fix` field per row — they are not all the same commit), mirroring the
  four already-closed rows (OC-0313, OC-0329, OC-0353, OC-0354). Only a row
  that fails re-verification at HEAD is assigned to a B7 milestone or
  re-tagged to B9 with a written reason, mirroring the SEC-03 precedent (b5
  plan `:2869-2872`).
- **Note**: this overlaps `.claude/plans/b6-16-register-roadmap-reconciliation.plan.md`,
  whose first Files-to-Change row already does this reconciliation for other
  register rows — sequence or coordinate the register hunks (see
  **Drafted** above).
- **Why**: PRD `:349` ("reconciled by B7-0 (all 25 B7-tagged register rows,
  ledger-`fixed`, re-verified at HEAD)"); pattern rule 2 — a phase cannot exit while any OC-\* tagged to it
  is open unless re-tagged with a written reason.
- **Validate**: `node .superpowers/render-ledger.mjs --check` (no ledger
  change expected — this task edits the register, not the findings ledger);
  every one of the 25 rows carries either the ledger's `fixed` prefix or a
  milestone/B9 assignment with a written reason.

### Task 5: PRD and README status flip

- **Action**: flip the PRD's B7-0 row to `complete` with this plan linked;
  update `docs/plans/README.md`'s B7 row status only (not its full content —
  the README's "Adding a plan" rules require a dated status line and nothing
  more here).
- **Why**: README rows are the status authority (pattern rule 1).
- **Validate**: `ci-check` skill.

## Validation

```bash
# the corrected doc and its guard
cd Client && npx vitest run tests/unit/platform-contracts-counts.test.ts

# probe_credential_store is gone
git grep -n probe_credential_store -- Client/ docs/credential-storage.md docs/architecture/   # no hits (historical mentions in roadmap/scorecard/PRD are expected)
cd Client/src-tauri && cargo test
cd Client/src-tauri && cargo clippy

# the baselines this plan records, independent of the doc
cd Client && npx vitest run tests/unit tests/integration --reporter=json
cd Client && npx vitest run --reporter=json   # all suites incl. tests/contract
cd Client && npm run test:coverage
cd Client && npx oxlint src/ 2>&1 | tail -1
cd Client && npx knip
cd Client && npx --yes madge --circular --extensions ts --ts-config tsconfig.json src
cd Client && npm run build
cd Client && npx playwright test --list | tail -1
cd Client && npx playwright test --list --config playwright.config.admin.ts | tail -1
cd Client && npx playwright test --list --config playwright.config.native.ts | tail -1
cd Client && npx playwright test --list --config playwright.config.fullstack.ts | tail -1
cd Client && npm run test:mutate:dry

# the register reconciliation leaves the findings ledger unchanged
node .superpowers/render-ledger.mjs --check

npm run format && npm run check:docs
# → ci-check skill
```

## Risks

| Risk                                                                                                                                          | Likelihood | Impact | Mitigation                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| A re-run number (oxlint, coverage, Playwright) has drifted enough since B0/HP-0 to look like a regression when it is really progress or noise | Medium     | Low    | the baseline doc states the command and the date for every number; a future plan compares against this file, not against memory of B0 |
| `probe_credential_store`'s deletion breaks a test that referenced it indirectly                                                               | Low        | Medium | `cargo test` and `git grep` both run in Task 3's validation before the commit lands                                                   |
| The OC re-tag assignments in Task 4 are contested by the owner at review                                                                      | Medium     | Low    | every re-tag carries a one-sentence reason in the register row, reviewable and revertable per-row without touching the others         |
| `madge --circular` reports a different cycle count than C-11's "four", inviting scope creep to fix them here                                  | Medium     | Low    | Task 1 records the number and states plainly that wiring a gate is out of scope; no cycle is touched in this plan                     |
| The count-guard test's constants shift in a way this plan did not anticipate (e.g. a second dead command found while auditing)                | Low        | Medium | Task 2's validate step runs the test itself before commit; a failing test blocks the PR rather than landing a silent drift            |
| Coverage or mutation numbers recorded here become stale again before B7-1 starts, repeating B0's problem                                      | Medium     | Low    | out of this plan's scope to prevent; named as a known limitation, not solved                                                          |

## Out of scope

- **Everything B7-1 and later**: building `Client/src/platform/`, adapters,
  browser implementations, the lint rule enforcing the native seam, the CSP
  allowlist, bundle-budget CI gates, Stryker's full mutation run (B7-8),
  import-cycle gating.
- **`get_cert_fingerprint`'s disposition**: it is registered with no caller
  in `Client/src/`, same shape as the deleted `probe_credential_store`, but
  it is invoked for real by the native e2e harness
  (`Client/tests/e2e/native/helpers.ts:75`) and stubbed by
  `Client/tests/e2e/helpers.ts:740` — left to open question 2 rather
  than deleted here.
- **Fixing `Client/tests/setup.ts`'s missing `afterEach`/mock-reset
  hygiene** — noted as a gotcha in Task 1, not remediated.
- **Adding any new tool to CI or `package.json`** (madge, a bundle-size
  gate, an import-cycle rule) — measured as a one-off only.

## Open questions for the owner

1. **If a row fails Task 4's re-verification at HEAD, does it default to a
   B9 re-tag rather than a B7 milestone assignment?** Task 4 expects all 25
   rows to verify as fixed per the ledger; this only matters for a row that
   does not. Unless the owner overrides before Task 4 starts, apply: assign
   any such row to the B7 milestone whose workstream it falls under (voice/
   E2EE → B7-9, replay/ordering/listener → B7-11, profile → B7-13, emoji/
   blocks/status → B7-10), and re-tag to B9 only a row with no B7 workstream
   home, each with a written reason recorded in the register row.
2. **Should `get_cert_fingerprint` be deleted alongside
   `probe_credential_store`, given it also has no caller in `Client/src/`?**
   `get_cert_fingerprint` has no caller under `Client/src/`, but it is
   invoked for real by the native e2e harness
   (`Client/tests/e2e/native/helpers.ts:75`) and stubbed in
   `Client/tests/e2e/helpers.ts:740` — it is consumed, not dead, which is a
   further reason not to delete it here. Unless the owner overrides before
   Task 3 starts, apply: leave it; B7-0's claim only names
   `probe_credential_store`; a second deletion is a separate, reviewable
   change.
3. **Should B7-0 start before HP-6 signs, given entry gate item 1 ("the
   complete beta server is stable through B6") is not yet formally met?**
   Unless the owner overrides before Task 0 starts, apply: start — none of
   B7-0's tasks touch `Server/`, and B6-12 and B6-16 are confirmed in flight
   without touching `Client/`; this plan records that dependency in its
   header rather than blocking on it.

## Acceptance

Ticked only where the gate actually ran; evidence is the baseline file, the
corrected doc, and the diff.

- [x] `docs/plans/b7-0-client-baseline-2026-09-19.md` created with every
      number in Task 1 attributed to the command that produced it
- [x] `docs/architecture/platform-contracts.md`'s "Native proxies" row,
      missing files, and `ptt_get_key`/`store_cert_fingerprint` claims are
      corrected
- [x] `Client/tests/unit/platform-contracts-counts.test.ts` green, updated if
      a pinned constant moved
- [x] `Client/CLAUDE.md:19` reads 21 files
- [x] `probe_credential_store` removed from `credentials.rs` and `lib.rs`;
      `cargo test` and `cargo clippy` green
- [x] All 25 formerly-open-treated B7-tagged OC rows are verified against
      HEAD and either carry the ledger's `fixed` prefix in the register or,
      for any that fails re-verification, a milestone assignment or a B9
      re-tag with a written reason
- [x] Updated rows land in `docs/plans/repo-health-issue-register-2026-08-23.md`
- [x] PRD's B7-0 row flipped to `complete`; `docs/plans/README.md`'s B7 row
      status updated
- [x] `node .superpowers/render-ledger.mjs --check` passes with no ledger
      change
- [ ] `ci-check` skill green
