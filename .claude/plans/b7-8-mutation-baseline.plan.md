# Plan: B7-8 — Mutation baseline refreshed before decomposition

> **Milestone:** B7-8 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-8-mutation-baseline`.
> **Worktree:** `.claude/worktrees/b7-8`.
> **Drafted:** 2026-09-20. **Base commit:** `3634cb0d` (`dev`).

## Summary

The register's C-16 and every B7 document since call the Stryker score "stale
at 67.04 %". The plan's first job is to say plainly what that number is: it is
**not** a score for `src/lib/**` + `src/stores/**`. It is one pass over **13
risky modules** in a pre-fix tree, on **2026-08-19**, and it was never re-run
(`docs/audit-test-coverage-2026-08-19.md:12,137`). B7-0 recorded the
_harness cost_, not a score: a dry run in **2 m 48 s**
(`docs/plans/b7-0-client-baseline-2026-09-19.md:48`). Nothing in the repo
records a score for the surface B7-9/B7-10 will decompose.

This milestone therefore delivers two things: **(1)** one full-surface mutation
score for `src/lib/**` + `src/stores/**`, recorded as a dated, tracked baseline
file with per-module rows; and **(2)** a nightly job that actually runs and
re-records it, because the run is measured here to be far outside the owner's
90-minute ceiling and cannot live on PR CI.

**The blocker the plan has to solve first.** The owner's decision (PRD Open
Question 5, `prd.md:381`) places the full-client run on
`nightly-test-depth.yml`, with a 90-minute ceiling and a fallback to splitting
by directory. Two tree facts defeat that as written. First, the file exists on
`dev` but **not** on `main`, and GitHub schedules only from the default branch:
the API returns `HTTP 404: workflow nightly-test-depth.yml not found on the
default branch`, and `gh workflow run ... --ref dev` returns the same 404
(`.github/workflows/nightly-test-depth.yml:5-6`; `docs/plans/ci-cost-2026-09-20.md:121-124`).
The workflow has never run. Second, the directory split the decision names is
not cheap enough: measured throughput says `src/lib/**` alone (67 files,
10 469 mutants) is about two hours, and the whole surface about 2.4 hours
(estimates anchored on the measured `src/stores/**` run below), so neither half
fits 90 minutes. The plan's core is therefore a **shard scheme** that fits the
ceiling, plus a decision on **where the schedule lives** so the number is
re-recorded rather than pasted once.

## Verify before you implement

Every row was checked at `3634cb0d` with the command shown. If a row is false
at your HEAD, **stop that task and record it**; do not improvise around it.
Numbers in B7-0's baseline file are re-derived here because two of them moved.

| #   | Claim                                                                                                                                                                                  | How to re-check                                                                                                                                                                                            | Verified at `3634cb0d`                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | `stryker.config.mjs` mutates `src/lib/**/*.ts` + `src/stores/**/*.ts`, excludes `src/lib/types.ts` and `src/**/*.d.ts`, thresholds `80/60/50`, `concurrency: 4`                        | `sed -n '21,31p' Client/stryker.config.mjs`                                                                                                                                                                | yes — `stryker.config.mjs:21-31`                                                                              |
| 2   | The full surface is **76 files / 12 387 mutants** at this base (B7-0 recorded 12 822 at its base — stale)                                                                              | `cd Client && npm run test:mutate:dry`                                                                                                                                                                     | yes — `Found 76 of 595 file(s)`, `Instrumented 76 source file(s) with 12387 mutant(s)`                        |
| 3   | The initial test run is **5 527 tests in 2 m 51 s** (B7-0 recorded 5 412 in 2 m 48 s — stale)                                                                                          | same command                                                                                                                                                                                               | yes — `Ran 5527 tests in 2 minutes and 51 seconds`                                                            |
| 4   | `src/stores/**` is **9 files / 1 918 mutants**; a real run scores **86.60 %** in **22 m 06 s** (1043 killed, 158 survived, 4 timeout, 4 no-cov, **709 errors**)                        | `cd Client && npx stryker run --mutate "src/stores/**/*.ts" --reporters clear-text,progress`                                                                                                               | yes — `Done in 22 minutes and 6 seconds`; table `All files 86.60`                                             |
| 5   | `src/lib/**` is **67 files / 10 469 mutants** (same command with the `lib` glob and the two base exclusions)                                                                           | `cd Client && npx stryker run --dryRunOnly --mutate "src/lib/**/*.ts,!src/lib/types.ts,!src/**/*.d.ts"`                                                                                                    | yes — `Found 67 of 595 file(s)`, `Instrumented 67 … with 10469 mutant(s)`                                     |
| 6   | Extrapolated full-surface wall time is **≈ 2.4 h** at the measured `stores` throughput (~87 mutants/min): well over the owner's 90-minute ceiling; `lib` alone (≈ 2 h) also exceeds it | arithmetic on rows 4–5; **an estimate, not a measurement** — Task 3 confirms it on a real `lib` slice                                                                                                      | estimate                                                                                                      |
| 7   | `nightly-test-depth.yml` runs the **narrow** `stryker.ci.config.mjs` (`src/lib/permissions.ts`, thresholds 100/95/90) with a 25-minute job timeout and 7-day artifact retention        | read `.github/workflows/nightly-test-depth.yml:16-38`; `Client/stryker.ci.config.mjs:5-6`                                                                                                                  | yes — `.github/workflows/nightly-test-depth.yml:31`, `:19`, `:37-38`                                          |
| 8   | The file is on `dev` but **not** `main`; the default branch is `main`; a schedule from it 404s and it has never run                                                                    | `git cat-file -e origin/main:.github/workflows/nightly-test-depth.yml` → fatal; `gh api repos/J3vb/OwnCord --jq .default_branch` → `main`; `gh workflow run nightly-test-depth.yml --ref dev` → `HTTP 404` | yes — `MISSING` on `origin/main`; default branch `main`; dispatch 404s                                        |
| 9   | The only CI reference to Stryker outside that workflow is a comment about a transitive advisory                                                                                        | `git grep -n "stryker\|mutat" -- .github/workflows/`                                                                                                                                                       | yes — `.github/workflows/ci.yml:436` only                                                                     |
| 10  | The 67.04 % provenance is 13 client modules on 2026-08-19, **not** the full surface, and it was not re-run after the round-2 fixes                                                     | `docs/audit-test-coverage-2026-08-19.md:12,137`                                                                                                                                                            | yes — `mutation testing over 13 risky client modules — score 67.04 %`, `Stryker was not re-run after round 2` |
| 11  | `reports/` and `.stryker-tmp/` are gitignored, so a recorded baseline must be a **written file**, not the HTML artifact                                                                | `grep -n "stryker-tmp\|reports" .gitignore`                                                                                                                                                                | yes — `.gitignore:47-48`                                                                                      |
| 12  | PR CI currently runs **no** mutation job; `stryker.ci.config.mjs` is exercised only by the never-run nightly                                                                           | row 9 + read `Client/package.json:39-40`                                                                                                                                                                   | yes — `Client/package.json:39-40` are scripts, not CI steps                                                   |

**Rows 2–6 are the ones that reshape the milestone.** The surface is larger and
the wall time longer than the 2026-08-19 pass implied, and the owner's fallback
(directory split) does not by itself restore the 90-minute ceiling.

**Measurement caveat to carry forward, not hide.** The `stores` run reported
**709 errors** of 1 918 mutants (37 %). Stryker excludes errored mutants from
the score denominator, so an honest baseline must publish the error count next
to the score or it records an inflated number. Triage of those errors is part of
this milestone's "honest" clause (Task 4), not a later one.

## Patterns to Mirror

- **Dated evidence file:** `docs/plans/b7-0-client-baseline-2026-09-19.md` and
  `docs/plans/b3-bench-baseline-2026-09-01.md` — every number carries the
  command and date that produced it, and a later milestone compares against the
  file, never against memory.
- **Narrow gated subset + full advisory run:** OQ5's two-tier shape
  (`prd.md:381`) — PR CI keeps `stryker.ci.config.mjs`; the full number is a
  nightly baseline, not a required check.
- **Schedule in its own workflow file, never a schedule on `ci.yml`:**
  `.github/workflows/nightly-docker-smoke.yml:1-15` names the reason (a
  scheduled run attaches check runs to the default branch's tip, where skipped
  required contexts would block release gating). A mutation nightly must copy
  that isolation.
- **Prove a gate can fail:** B7-6's Task 4 and B7-1's Task 2 both require
  deliberately breaking the check before trusting it. The baseline run's
  thresholds get the same treatment.

## Files to Change

| Path                                                         | Change                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `docs/plans/b7-8-mutation-baseline-<date>.md`                | **new**: the dated full-surface score, per-module rows, error counts, provenance                  |
| `Client/stryker.config.mjs`                                  | split the full run into shard configs or a shard selector the nightly drives                      |
| `Client/stryker.shard-*.config.mjs` (one per shard)          | **new**: one directory/subsystem shard each, sized under the ceiling                              |
| `Client/stryker.ci.config.mjs`                               | keep the narrow hotspot subset; if B7-9/B7-10 land first, add their modules — otherwise unchanged |
| `.github/workflows/nightly-test-depth.yml`                   | the `mutation` job becomes the sharded full-client baseline, still on `dev`                       |
| `docs/contributing.md`                                       | the "Mutation testing" command rows and how the baseline is recorded                              |
| `docs/plans/b7-shared-client-platform-desktop-parity.prd.md` | the B7-8 Delivery Milestones cell links this plan; C-16 closure noted at completion (owner)       |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, `CHANGELOG.md`, the
register, or any status row. The plan **is** the deliverable of this task; the
implementation is a separate PR.

## Tasks

Commit after every task — conventional subject, scope `b7-8`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Baseline and provenance recount

- **Action:** reproduce rows 2–5 at HEAD and record them in the
  `Verify before you implement` table of this plan's own PR. Re-run
  `cd Client && npm run test:mutate:dry` and record files/mutants/tests/time.
  Record the 67.04 % provenance sentence from `audit-test-coverage-2026-08-19.md`
  so no later document repeats it as a full-surface score.
- **Validate:** dry run exits 0; the three counts (76 / 12 387 / 5 527) match
  this table or the discrepancy is written into the PR description. **No number
  is copied from B7-0 without being re-run.**

### Task 1: Size the run and choose the shards

- **Action:** use row 4's measured throughput (~87 mutants/min) and row 5's
  mutant count to project the `lib` and full-surface wall time. Break
  `src/lib/**` into shards by subsystem so each lands under the ceiling and each
  is a coherent ownership unit — the natural seams are LiveKit/voice
  (`livekit*.ts`, `audioPipeline.ts`, `noise-suppression.ts`), transport/auth
  (`ws.ts`, `api.ts`, `dispatcher.ts`, `identity.ts`), and the rest. Keep
  `src/stores/**` as one shard (22 m measured). Pick the shard count so the
  **longest** shard plus its initial run is under the ceiling with margin.
- **Why:** OQ5's fallback ("split by directory") is measured insufficient
  (rows 5–6); the plan must name a split that actually fits.
- **Gotcha:** a shard that excludes a file another shard mutates is fine, but a
  file in **no** shard silently drops out of the baseline. Task 3 checks the
  union of shards equals the 76-file surface exactly.
- **Validate:** record the projected wall time per shard; the sum of shard
  mutants equals 12 387.

### Task 2: Where the schedule lives

- **Action:** decide and implement the trigger placement. The file is on `dev`;
  schedules fire only from `main` (row 8). The options are in Open Question 1;
  the plan's default is **(a) land the sharded workflow on `main` through the
  release path** (a PR targeting `main` that carries only
  `.github/workflows/nightly-test-depth.yml`), preserving the file's own
  comment that it stays `dev`-targeted via `ref: dev`
  (`.github/workflows/nightly-test-depth.yml:23`). Keep it a **separate file**
  from `ci.yml`, mirroring `nightly-docker-smoke.yml:6-15`.
- **Gotcha:** do not add a `schedule:` to `ci.yml` to sidestep this — the
  docker-smoke comment names exactly why that breaks release gate-evidence.
  Do not make the mutation job a required context.
- **Validate:** `npx actionlint .github/workflows/nightly-test-depth.yml` if
  available; the job's name matches no required context in
  `docs/plans/b0-dev-branch-protection.sh`.

### Task 3: Implement the shards and prove the union is complete

- **Action:** add the per-shard Stryker configs (or a single config driven by a
  `--mutate` argument the workflow supplies), each carrying the base config's
  `mutate` exclusions, `thresholds`, and `tempDirName`
  (`stryker.config.mjs:21-34`). Rewrite the `mutation` job to run every shard
  and upload each report.
- **Gotcha:** Stryker's vitest runner forces `pool: "threads"`, which is why
  `stryker.config.mjs:11` sets `OC_ALLOW_UNPINNED_TZ = "1"`; a new config
  **must import the base module** so the flag survives, or the TZ-pinned blocks
  abort (`stryker.config.mjs:3-11`).
- **Validate:** the union of all shards' `mutate` globs equals
  `mutate: ["src/lib/**/*.ts", "src/stores/**/*.ts", "!src/lib/types.ts",
"!src/**/*.d.ts"]` — prove it with a one-liner, not by eye. Run one shard's
  dry run green.

### Task 4: The recorded baseline, honestly

- **Action:** write `docs/plans/b7-8-mutation-baseline-<date>.md` shaped like
  `b7-0-client-baseline-2026-09-19.md`, holding for the full surface and for
  each module: mutation score, killed/survived/timeout/no-coverage/errors, the
  command, the date, and the runner image. Add the explicit sentence that
  **errored mutants are excluded from the score**, with the error count beside
  every score (Task 0's caveat), and triage the error population at least to a
  class (compile vs runtime/test-harness) so the number's honesty is auditable.
- **Why:** OQ5 and `prd.md:221` — "the number every later decomposition
  milestone is measured against". `reports/` is gitignored (row 11), so without
  this file the number exists only in a 7-day artifact.
- **Gotcha:** do not copy the 67.04 % row forward as a comparison unless its
  13-module scope is stated next to it; it is a different surface.
- **Validate:** every number in the file has the command that produced it; the
  file records a single headline full-surface score and a per-module table.

### Task 5: Thresholds and the advisory gate

- **Action:** set the full-run `thresholds` against the recorded baseline and
  decide, with the owner if needed (Open Question 2), whether the nightly fails
  on a drop. The baseline is an accepted pre-decomposition number, so the
  default is **report-only (no `break` failure) until B7-9 lands**, then a
  `break` at the recorded baseline minus a small tolerance.
- **Validate:** prove the threshold can fail — temporarily set `break` above
  the recorded score, confirm the shard run exits non-zero, revert. Record both
  exit codes.

### Task 6: Docs and the PRD link

- **Action:** update `docs/contributing.md`'s mutation rows (`:107-108`) to say
  the full run is the nightly baseline and PR CI is the narrow subset; add the
  one-cell PRD link for B7-8 in the Delivery Milestones table.
- **Validate:** `node scripts/run.mjs check:docs` exits 0 (it already passes at
  the base).

## Validation

```
cd Client && npm run test:mutate:dry                          # 76 files / 12 387 mutants / 5 527 tests
cd Client && npx stryker run stryker.ci.config.mjs            # narrow subset still green
# each shard dry run, and the union-of-globs check
node scripts/run.mjs check:docs
node scripts/run.mjs check:hygiene
npx prettier --check .claude/plans/b7-8-mutation-baseline.plan.md docs/plans/b7-8-mutation-baseline-*.md docs/contributing.md
# → then the ci-check skill
```

## Risks

| Risk                                                                                  | Likelihood | Impact | Mitigation                                                                                      |
| ------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------- |
| The nightly is landed but still never schedules (a `dev`-only file)                   | High       | High   | Task 2 lands it where schedules fire and verifies a real scheduled run, not just a dispatch     |
| The baseline is recorded with errored mutants silently excluded, inflating the number | High       | Medium | Task 0/Task 4 publish the error count beside every score and triage the class                   |
| A shard split drops a file, so the "full" score is not full                           | Medium     | High   | Task 3 proves the union of shard globs equals the configured surface                            |
| The 2.4 h extrapolation is wrong and shards are sized on a bad number                 | Medium     | Medium | Task 0 re-measures; Task 3 records a real shard wall time before the score is called a baseline |
| The PRD's C-16 row is treated as closed by this milestone when it also spans B7-10    | Medium     | Low    | Record "C-16 (B7 half)" explicitly; survivor triage for critical modules is B7-10's, not here   |

## Out of scope

- **Decomposing any module** — B7-9/B7-10. This milestone only measures.
- **Fixing survivors or errored mutants** beyond the triage needed to state the
  score honestly; survivor fixes for transport/auth/E2EE are C-16's B10 half
  (`repo-health-issue-register-2026-08-23.md:219`).
- **Raising PR-CI mutation coverage** beyond the existing narrow subset.
- **Any non-client mutation** (Go, Rust).
- The implementation itself: this task delivers the plan and the PRD link only.

## Open questions for the owner

1. **Where does the nightly schedule live, now that the run cannot be a PR
   check?** `nightly-test-depth.yml` is `dev`-only and has never run (row 8).
   Options: **(a, recommended)** carry that one workflow file to `main` through
   a targeted PR so both its existing jobs and the new sharded mutation job
   start scheduling, keeping `ref: dev` so it still smokes `dev`; **(b)** leave
   it on `dev` and accept manual `workflow_dispatch` only, which cannot produce
   a "recorded once, honestly" number without a human; **(c)** move the mutation
   job into a new workflow that is deliberately landed on `main` and leave the
   rest of `nightly-test-depth.yml` untouched. (a) is smallest and revives a
   workflow the audit already flagged as dead. A PR to `main` is normally a
   release action, so this is the owner's call, not the plan's.
2. **Does the nightly fail on a mutation-score drop, or report only?** Default:
   report-only until B7-9 lands, then a `break` at the baseline minus a small
   tolerance — a ratchet that moves with decomposition, mirroring the coverage
   and cycle decisions (`prd.md:381`).
3. **Is 90 minutes still the ceiling once the surface is known to be ~12 400
   mutants?** With shards the ceiling holds, but it means **parallel shard jobs**
   (wall-time cost) rather than one serial job. Confirm the ceiling, or confirm
   that shards may run as separate jobs in the same workflow.

## Acceptance

- [ ] `Verify before you implement` re-run at HEAD, with 76 / 12 387 / 5 527
      recorded or the discrepancy written into the PR description
- [ ] 67.04 %'s 13-module provenance stated wherever it is cited; it is never
      presented as a full-surface score
- [ ] Shards chosen such that each fits the ceiling; the union of shard globs
      equals the configured 76-file surface exactly
- [ ] A decision and implementation for where the schedule lives, with a real
      scheduled run (not just a dispatch) observed
- [ ] `docs/plans/b7-8-mutation-baseline-<date>.md` records one headline
      full-surface score plus per-module scores and error counts, each with the
      command that produced it
- [ ] The narrow PR-CI subset (`stryker.ci.config.mjs`) still runs green
- [ ] No implementation code, no test changes, no PR-CI gate changes beyond the
      narrow subset's own config
- [ ] `npm run check:docs` and `npx prettier --check` on touched files pass
