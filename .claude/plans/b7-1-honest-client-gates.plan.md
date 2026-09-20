# Plan: B7-1 — Honest client gates locally and in CI

**Source PRD**: `docs/plans/b7-shared-client-platform-desktop-parity.prd.md`
**Selected Milestone**: B7-1 — Honest client gates locally and in CI (roadmap
B7 workstream 4, `repo-health-roadmap-2026-08-23.md:950-951`; exit-gate line
`:1011` "zero unapproved warnings and honest coverage").
**Satisfies**: PRD row B7-1 (`prd.md:304`): "A contributor cannot merge past a
lint, knip, coverage, or import-cycle regression that today only shows up if
someone runs the full suite by hand"; PRD workstream row 4 (`prd.md:172`);
Success Metrics rows "oxlint unapproved warnings", "Import cycles", "Coverage
floor" and the native-import lint rule half of "Native imports" (`prd.md:214-217`);
decision 9 (`prd.md:381`). Closes register rows C-02, C-03, C-04, C-05
(`prd.md:352`).
**Complexity**: Small wiring, Medium burn-down (test-log noise).
**Drafted**: 2026-09-20 at `dev` `48681909`. In flight beside it: B7-2
(`Client/package.json` engines, `ci.yml` setup-node) and B7-3 (new
`Client/src/platform/`). Merge order is B7-2 → B7-1 → B7-3.

**Executor rule**: Where this plan proposes a default, apply it. Where a step
needs something you do not have, do not guess and do not invent a value: mark
the task `BLOCKED` in your report with the exact error and continue with the
next independent task. Never leave a `<placeholder>` in committed text. You do
**not** edit `docs/plans/*`, `CHANGELOG.md` or any status row — the
orchestrator does that at PR time.

## Summary

B7-1 turns five measurements into blocking gates, locally (`scripts/run.mjs`
`check:client`) and in CI: (1) oxlint warning-free and `--deny-warnings`; (2)
an import-cycle ceiling using the oxlint that is already installed; (3) an
ESLint rule that stops new `@tauri-apps` importers; (4) the coverage floor at
90 % statements, enforced locally as well as in CI; (5) a unit suite whose
green run prints no unexplained console output. knip is already blocking in CI
and only needs adding to the local task.

## Verify before you implement

Facts measured at `48681909` on 2026-09-20. Rows marked **Corrected** or
**Refuted** contradict the PRD, the register or an obvious first design.

| Claim                                               | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "547 warnings to burn down" is 547 code fixes       | **Refuted**   | `cd Client && npx oxlint src/ -f json`: 521 of 547 are `eslint(no-underscore-dangle)`, and 449 of those are in `src/lib/livekitSession.ts` (232) and `src/lib/livekitE2EE.ts` (217) — `this._field` private members. With `["warn", { "allowAfterThis": true }]` the total drops to **38**. Renaming 449 members in the two files B7-9 decomposes is churn, not a fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The 38 that remain                                  | measured      | 12 `no-underscore-dangle` (7 Emscripten exports in `src/lib/noise-suppression.ts:127-216`: `_rnnoise_create`, `_rnnoise_process_frame`, `_rnnoise_destroy`, `_malloc`, `_free`; `__owncord` at `src/lib/livekitSession.ts:1567`; `_serverHost` `message-list/attachments.ts:35`; `_dismissAc` `channel-sidebar/volume-menu.ts:41,123`; `_currentChannelId` `main-page/ChannelController.ts:111`), 11 `unicorn(consistent-function-scoping)`, 10 `eslint(no-await-in-loop)` (`livekitReconnect.ts:139,158,168,177,217,234`, `livekitE2EE.ts:1231,1243,1284`, `connectionStats.ts:63`), 2 `eslint(no-shadow)` (`notifications.ts:172`, `livekitSession.ts:550`), 1 each `unicorn(prefer-set-has)` `themes.ts:11`, `unicorn(prefer-add-event-listener)` `audioPipeline.ts:433`, `unicorn(no-array-sort)` `channel-sidebar/drag-reorder.ts:195` |
| oxlint can fail on warnings                         | verified      | `npx oxlint --deny-warnings src/` exits 1 with warnings present; `--max-warnings=N` exits 1 above N, 0 at N (tested 28 → 1, 29 → 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| An import-cycle gate needs a new dependency (madge) | **Refuted**   | oxlint 1.80 ships `import/no-cycle`. Config `{"plugins":["import"],"categories":{},"rules":{"import/no-cycle":"warn"}}` with `--tsconfig tsconfig.json` reports **29** import-site diagnostics in 17 files, exit 0. B7-0's "22" is madge's count of distinct cycles; 29 is oxlint's count of import sites that sit on a cycle. The gate pins oxlint's own number                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| "knip is missing from CI"                           | **Refuted**   | `.github/workflows/ci.yml` `client-check` job runs `npx knip` as a blocking step (~`:311-314`). It is missing only from `scripts/run.mjs` `CHECK_CLIENT` (`:135-141`). `npx knip` prints nothing, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| "coverage is not gated"                             | **Corrected** | CI `client-tests` runs `npx vitest run --coverage` then `bash scripts/coverage-floor.sh` (~`:479-484`); `vitest.config.ts` thresholds are 70/70/70/70 and `coverage-floor.json` is `70.0`. Locally `CHECK_CLIENT` runs plain `npm test`, so no floor is enforced. Measured statements: 93.99 %                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A native-import lint rule exists                    | **Refuted**   | `Client/eslint.config.js` has no `no-restricted-imports`; the only guard is the count pin in `Client/tests/unit/platform-contracts-counts.test.ts` (21 importers), which a move-one-add-one change defeats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unit suite is quiet                                 | **Refuted**   | `npx vitest run --reporter=default`: 212 files / 5524 tests pass, and **652** `stdout \|`/`stderr \|` console blocks are printed (573 stdout, 79 stderr) from 29 test files; `tests/unit/api.test.ts` alone prints 246. Nearly all stdout is the app logger at `debug`/`info` (`src/lib/logger.ts:25` defaults `currentLevel` to `"debug"`, `:72` writes to `console[level]`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `setLogLevel` is safe to call globally in tests     | **Unknown**   | `emit()` pushes to the log buffer and notifies listeners (`logger.ts:63-78`) only for levels that pass `shouldLog`. A test asserting on a `debug`/`info` buffer entry or listener call will fail once the level is `warn` — that test must set its own level                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Patterns to Mirror

- Gate step shape: `step("npm", ["run", "lint"], "Client")` in
  `scripts/run.mjs:135-141`.
- Floor-file + script pattern: `Client/coverage-floor.json` +
  `Client/scripts/coverage-floor.sh`.
- Scoped ESLint blocks with a rationale comment: `Client/eslint.config.js:73-111`.
- "Fail loudly if the guard did not arrive": `Client/tests/setup.ts:26-40`.

## Files to Change

| File                                                                                      | Action                       | Why                                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `Client/.oxlintrc.json`                                                                   | edit                         | `no-underscore-dangle` options + `allow` list                                         |
| `Client/.oxlintrc.cycles.json`                                                            | create                       | the import-cycle config, separate so its ceiling is independent of the main run       |
| `Client/package.json`                                                                     | edit `scripts` only          | `lint:ox` gains `--deny-warnings`; new `lint:cycles`; `lint` chains all three         |
| `Client/eslint.config.js`                                                                 | edit                         | `no-restricted-imports` for `@tauri-apps/*`, allowlisting today's 12 static importers |
| `Client/tests/helpers/console.ts`                                                         | create                       | `expectConsole(level, matcher)` for Task 6                                            |
| `docs/contributing.md`                                                                    | edit                         | the four places that describe `check:client`, `npm run lint` and the pre-commit hook  |
| `Client/src/**` (only files named in the 38-warning row)                                  | edit                         | fix or justify each remaining warning                                                 |
| `Client/vitest.config.ts`                                                                 | edit                         | thresholds `statements: 90`; one-line justification on the `*.d.ts` exclusion         |
| `Client/coverage-floor.json`                                                              | edit                         | `aggregate: 90.0`                                                                     |
| `Client/tests/setup.ts`                                                                   | edit                         | default log level `warn`; fail a test on unexpected `console.warn`/`console.error`    |
| `Client/tests/**/*.test.ts` (the 29 noisy files, plus any that assert on debug/info logs) | edit                         | assert expected warnings/errors instead of printing them                              |
| `scripts/run.mjs`                                                                         | edit `CHECK_CLIENT`          | add knip, run tests with coverage                                                     |
| `.github/workflows/ci.yml`                                                                | edit `client-check` job only | oxlint step denies warnings; new cycles step                                          |
| `.githooks/pre-commit`                                                                    | edit the client block        | `npx oxlint --deny-warnings $rel`                                                     |

## Tasks

### Task 1 — oxlint: allow the private-member convention, name the external names

- **Action**: in `Client/.oxlintrc.json` `rules`, add
  `"no-underscore-dangle": ["warn", { "allowAfterThis": true, "allow": ["_rnnoise_create", "_rnnoise_process_frame", "_rnnoise_destroy", "_malloc", "_free", "__owncord"] }]`.
- **Why**: C-02's closure line is "Narrowly allow intentional generated/external
  names, fix actionable warnings". `this._x` is this codebase's private-member
  convention; the six names are Emscripten exports and one debug hook.
- **Gotcha**: do not turn the rule off and do not move it out of `suspicious`.
- **Validate**: `cd Client && npx oxlint src/ -f json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).diagnostics.length))"` prints **30** (measured 2026-09-20 with exactly this config: 11
  `consistent-function-scoping`, 10 `no-await-in-loop`, 4 `no-underscore-dangle`,
  2 `no-shadow`, 1 each `no-array-sort`, `prefer-add-event-listener`,
  `prefer-set-has`).

### Task 2 — fix the 30 remaining warnings

- **Action**: work rule by rule, one commit per rule.
  - `no-underscore-dangle` (4 sites): rename `_serverHost`, `_dismissAc`,
    `_currentChannelId` to the same name without the underscore; update every
    reference (`git grep -n` each name first — tests may reach them).
  - `consistent-function-scoping` (11): hoist the inner function to module
    scope **only if it closes over nothing**. If it closes over a local, the
    warning is a false positive for that site — leave the code and add
    `// oxlint-disable-next-line unicorn/consistent-function-scoping -- closes over <name>`.
  - `no-await-in-loop` (10): these loops are sequential on purpose (reconnect
    back-off, key ratchet order, stats polling). Do **not** parallelise. Add
    `// oxlint-disable-next-line no-await-in-loop -- sequential by design: <one reason>`
    on each. `livekitE2EE.ts` and `livekitReconnect.ts` get comment-only changes.
  - `no-shadow` (2): rename the inner binding.
  - `prefer-set-has`, `prefer-add-event-listener`, `no-array-sort` (1 each):
    apply the rule's suggestion; for `no-array-sort` use `toSorted()` only if
    the original array is not relied on being sorted in place afterwards — read
    the next ten lines first.
- **Why**: exit gate "zero unapproved warnings"; a disable with a stated reason
  is the approved form.
- **Gotcha**: oxlint silently ignores a disable comment whose rule name is
  mis-spelled. After the **first** comment of each rule, re-run
  `npx oxlint src/ -f json` and confirm the count dropped by exactly one before
  writing the rest. These are the **only** disable comments this plan authorises. The
  three local ESLint rules on the voice files (`eslint.config.js:77-95`) must
  stay green — run `npm run lint` after touching them.
- **Validate**: `cd Client && npx oxlint --deny-warnings src/` exits 0;
  `npm run typecheck` exits 0; `npm test` still reports 5524 passed.

### Task 3 — make the lint invocations blocking

- **Action**: in `Client/package.json` scripts set
  `"lint:ox": "oxlint --deny-warnings src/"`, add
  `"lint:cycles": "oxlint -c .oxlintrc.cycles.json --tsconfig tsconfig.json --max-warnings=29 src/"`,
  and set `"lint": "npm run lint:ox && npm run lint:cycles && eslint src/"`.
  Create `Client/.oxlintrc.cycles.json`:
  `{ "plugins": ["import"], "categories": {}, "rules": { "import/no-cycle": "warn" }, "ignorePatterns": ["dist", "node_modules", "public"] }`.
  In `ci.yml` `client-check`: change the oxlint step's command to
  `npx oxlint --deny-warnings src/` and add, directly after it, a step
  "Import cycles (ceiling 29, B7-10 lowers it)" running `npm run lint:cycles`.
  In `.githooks/pre-commit`, split the client block's file list in two:
  `src_rel` (staged paths under `Client/src/`) runs
  `npx oxlint --deny-warnings $src_rel`; `test_rel` (paths under
  `Client/tests/`) keeps today's `npx oxlint $test_rel`. Skip either call when
  its list is empty, and keep the `# shellcheck disable=SC2086` line above each.
- **Why**: a ceiling that only moves down is the ratchet; B7-10 owns removing
  the cycles (`prd.md:335-336`), so B7-1 must not try to.
- **Gotcha**: touch nothing else in `package.json` — B7-2 edits `engines` in
  the same file. Keep the `ci.yml` edit inside the `client-check` job.
  `Client/tests/` carries 512 oxlint warnings and is **out of scope**: the hook
  must not deny warnings there, or it rejects this plan's own Task 6 commits.
  Never commit with `--no-verify`; if the hook rejects a commit, fix the cause
  or record BLOCKED.
- **Validate**: `npm run lint` exits 0; temporarily set `--max-warnings=28`,
  confirm exit 1, restore 29.

### Task 4 — native-import rule

- **Action**: in `Client/eslint.config.js` add one config block for
  `src/**/*.ts` with
  `"no-restricted-imports": ["error", { patterns: [{ group: ["@tauri-apps/*"], message: "Native imports belong in src/platform/desktop (B7-4/B7-5). See docs/architecture/platform-contracts.md." }] }]`
  and an `ignores` array holding exactly the files that **statically** import
  `@tauri-apps` today. Get the list **from the repository root** with
  `git grep -lE "from ['\"]@tauri-apps/" -- 'Client/src/**' | sed 's|^Client/||'`
  — it must print **12** paths, each starting `src/` (flat-config `ignores`
  resolve relative to `Client/eslint.config.js`, so a `Client/` prefix matches
  nothing). If it does not print 12, stop and record it. Above the block, a
  comment: the other 9 of the 21 native importers use dynamic `import()`, which
  this rule cannot see; `tests/unit/platform-contracts-counts.test.ts` guards
  those, and leaving them out of `ignores` means a new _static_ import in them
  is still rejected.
- **Why**: `prd.md:214` — "Native-import lint rule (added B7-1)". B7-4/B7-5
  delete entries as call sites move; B7-4 adds `src/platform/desktop/**`.
- **Gotcha**: do not add a custom rule for dynamic imports. Do not add
  `src/platform/**` to `ignores` — nothing there imports natively yet.
- **Validate**: `npx eslint src/` exits 0; add
  `import "@tauri-apps/api/core";` to `src/lib/themes.ts`, confirm eslint
  fails on that line, revert. Do not run `npm test` while the probe import is
  in place — the importer count test would read 22.

### Task 5 — coverage floor 90, enforced locally

- **Action**: `coverage-floor.json` `aggregate` → `90.0`; `vitest.config.ts`
  `thresholds.statements` → `90` (leave branches/functions/lines at 70 — decision
  9 names statements only); add above `"src/**/*.d.ts"` the comment
  `// Type declarations only: no runtime statements to cover.` In
  `scripts/run.mjs` `CHECK_CLIENT` replace `step("npm", ["test"], "Client")`
  with `step("npm", ["run", "test:coverage"], "Client")` and add
  `step("npm", ["run", "knip"], "Client")` after the lint step.
- **Why**: decision 9 (`prd.md:381`); `prd.md:172` "Local CHECK_CLIENT skips
  knip and coverage floor". vitest's own threshold fails the run below 90, so
  the local task needs no bash.
  Update `docs/contributing.md` where it describes these commands: `:34`
  (what `check:client` runs — add knip and coverage), `:113` (`npm run lint` —
  now oxlint, import cycles, ESLint), `:130` (pre-commit row — warnings denied
  under `Client/src/`), `:294-296` (`check:client` invokes
  `npm run test:coverage`, not `npm test`). Read each line first; line numbers
  are pointers.
- **Validate**: `node scripts/run.mjs check:client` exits 0 and its output shows
  knip and the coverage table. Then prove the floor moved: temporarily set
  `thresholds.statements` to `95` and `coverage-floor.json` to `95.0`, confirm
  `npm run test:coverage` exits non-zero and `bash scripts/coverage-floor.sh`
  exits 1, restore 90.

### Task 6 — quiet, honest test output (C-04)

- **Action**, in this order, committing after each file group:
  1. `tests/setup.ts`: import `setLogLevel` from `../src/lib/logger` and call
     `setLogLevel("warn")` once. Re-run the suite; any test that now fails was
     asserting on a `debug`/`info` log — give that test file its own
     `beforeEach(() => setLogLevel("debug"))` and restore `"warn"` in
     `afterEach`.
  2. `tests/setup.ts`: add a guard — `beforeEach` installs
     `vi.spyOn(console, "warn")` and `vi.spyOn(console, "error")` with an
     implementation that records the call; `afterEach` throws
     `Unexpected console.<level>: <first argument>` if any call was recorded
     and the test did not claim it. A test claims output by calling an exported
     helper `expectConsole(level, matcher)` (put it in `tests/helpers/console.ts`)
     which removes matching recorded calls and fails if there were none.
  3. Fix every test the guard now fails: assert the warning/error the test
     provokes with `expectConsole`. Work through the noisy files in descending
     order (`api.test.ts`, `api-session.test.ts`, `screen-share-tracks.test.ts`,
     `embeds.test.ts`, `room-event-handlers.test.ts`, `message-list.test.ts`,
     `updater.test.ts`, `dispatcher.test.ts`, …).
- **Why**: C-04 — "Expected logs are captured/asserted; a green run has no
  unexplained runtime warnings or log flood."
- **Gotcha**: 43 test files `vi.mock` the logger module; `setLogLevel` in
  `setup.ts` configures the real module, so it has no effect in those files —
  that is fine (a mocked logger prints nothing); do not chase it. Test files
  that call `vi.restoreAllMocks()` or install their own `console` spy will
  remove or shadow the guard's spy: the guard must therefore (re)install its
  spies in `beforeEach` and read its own recorded-call list, not
  `mock.calls` of a spy a test may have replaced.
  Never satisfy the guard by setting `silent`, `onConsoleLog` or
  `disableConsoleIntercept` in `vitest.config.ts`, by passing `--silent`, by
  mocking `console` away in a test file, by lowering the level to `error`, or
  by wrapping production code in a `NODE_ENV` check. If a warning is genuinely unexpected (a real defect), do
  **not** fix production code here: claim it with `expectConsole`, add
  `// B7-1: unexpected — see report`, and list it in your report.
- **Validate**: `npx vitest run --reporter=default > out.txt 2>&1; echo $?`
  prints 0, `grep -cE "^(stdout|stderr) \| " out.txt` prints **0**, and the
  summary still shows **5524 or more** tests passed in 212 or more files.
  Delete `out.txt`. Positive proof the guard is live: temporarily add
  `console.warn("guard probe")` inside one existing test, confirm that test
  **fails** with `Unexpected console.warn: guard probe`, revert.
  `git diff origin/dev -- Client/vitest.config.ts` must show only the
  threshold and the `*.d.ts` comment.

### Task 7 — final gate

- **Action**: `node scripts/run.mjs check:client` and `npx prettier --check .`
  from the repository root.
- **Validate**: both exit 0. Capture exit codes before any pipe.

## Validation

```bash
cd Client && npx oxlint --deny-warnings src/          # exit 0
cd Client && npm run lint:cycles                      # exit 0 at 29
cd Client && npx knip                                 # no output, exit 0
cd Client && npm run test:coverage                    # >= 5524 passed, statements >= 90
node scripts/run.mjs check:client                     # exit 0
npx prettier --check .                                # exit 0
```

## Risks

| Risk                                                                                 | Likelihood | Impact | Mitigation                                                                                       |
| ------------------------------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------ |
| A rename in Task 2 misses a reference reached only from tests                        | Medium     | Low    | `git grep` each name first; typecheck + full suite after the rule's commit                       |
| The console guard makes unrelated tests flaky (async logs landing after a test ends) | Medium     | Medium | Record the offending test in the report rather than widening the guard; the orchestrator decides |
| `toSorted()` changes behaviour where in-place order was relied on                    | Low        | Medium | Read the following lines; if in doubt keep `sort()` with a justified disable                     |
| Merge conflict with B7-2 in `Client/package.json` / `ci.yml`                         | High       | Low    | Scripts-only and `client-check`-only edits; orchestrator rebases after B7-2 merges               |

## Out of scope

- Removing any import cycle (B7-10). Renaming `this._x` members (B7-9 decides).
- Raising branches/functions/lines thresholds. The `+1 per decomposition` ratchet.
- `Client/tests/e2e` log noise. Stryker. Bundle budgets.
- `docs/plans/*`, register rows, CHANGELOG — orchestrator.

## Open questions for the owner

- None blocking. Default applied: the cycle ceiling counts oxlint's import-site
  diagnostics (29), not madge's distinct cycles (22); the baseline document
  keeps 22 as the B7-0 measurement and the PR description states both.

## Acceptance

- [ ] `npx oxlint --deny-warnings src/` exits 0 with no rule switched off
- [ ] Every new disable comment is one of the two forms in Task 2 and carries a reason
- [ ] `npm run lint:cycles` exits 0 at 29 and 1 at 28
- [ ] ESLint rejects a new static `@tauri-apps` importer; the allowlist is exactly the 12 static importers, with the rationale comment
- [ ] Pre-commit denies warnings under `Client/src/` only; no commit on the branch used `--no-verify`
- [ ] The console guard fails a probe `console.warn`; `vitest.config.ts` gained no `silent`/`onConsoleLog`
- [ ] `docs/contributing.md` describes the gates as they now run
- [ ] Floor is 90 in `coverage-floor.json` and `vitest.config.ts`; `*.d.ts` exclusion justified
- [ ] `check:client` runs knip and coverage
- [ ] Unit suite prints 0 console blocks; test count not lower than 5524
- [ ] `node scripts/run.mjs check:client` and `npx prettier --check .` exit 0
