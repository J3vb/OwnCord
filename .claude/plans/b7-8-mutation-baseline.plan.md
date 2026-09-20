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

**Resolved since the plan merged (owner).** Where the schedule lives (Q1): the
sharded workflow lands on `dev` only; the carry to `main` that would actually
register it is deferred until the beta release ships. The definition is landed
complete so the later carry is a verbatim copy. Note a fact the merged plan's
framing did not have: GitHub registers a workflow only when it exists on the
default branch, so a `dev`-only file is **not runnable at all** — not on the
cron and not by `workflow_dispatch` either (verified 2026-09-20: the file is
absent from `gh workflow list`, and `gh workflow run nightly-test-depth.yml
--ref dev` returns `HTTP 404: not found on the default branch`). So the
"run it on demand meanwhile" mitigation is not available until the carry; the
`workflow_dispatch:` trigger is kept for that carry, and the nightly runs by
no path until then. The threshold flip trigger (Q2) is not "until B7-9 lands"
but the error population triaged plus ~5 consecutive runs establishing the
spread, per shard. The 90-minute ceiling (Q3) is wall-clock per night, enforced
with a matrix of parallel shard jobs, `fail-fast: false`, and
`timeout-minutes: 90` per shard. The three open questions at the foot of this
file are answered accordingly.

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
| `Client/stryker.config.mjs`                                  | unchanged — the base surface the shards must sum to                                               |
| `Client/stryker.shard.config.mjs`                            | **new**: one `STRYKER_SHARD` selector over five explicit per-subsystem file lists                 |
| `Client/scripts/check-mutation-shards.mjs`                   | **new**: proves the union of shard lists equals the base config's surface (76 files)              |
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
- **Validate:** dry run exits 0; the three counts match this table or the
  discrepancy is written into the PR description. **No number is copied from
  B7-0 without being re-run.**
- **Result at HEAD (`7682c4c5`, Node 26.9.0):** dry run exits 0 —
  `Found 76 of 595 file(s)`, `Instrumented 76 source file(s) with 12387
mutant(s)`, initial run `5527 tests in 2 minutes and 55 seconds`. Rows 2–3's
  counts match; the initial-run time is 2 m 55 s here against the table's
  2 m 51 s (same shape, run-to-run noise). No number was copied from B7-0.

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
- **Result at HEAD.** Five shards, each an exact file list (not a glob), mutant
  totals measured by instrumenting each `--mutate` list in isolation:

  | Shard            | Files | Mutants | Subsystem                                                          |
  | ---------------- | ----: | ------: | ------------------------------------------------------------------ |
  | `livekit`        |     7 |   2 901 | LiveKit session/E2EE/reconnect/diagnostics/room events/screenshare |
  | `audio-media`    |     8 |   1 954 | audio pipeline/elements, RNNoise, devices, PTT, media visibility   |
  | `transport-auth` |    17 |   3 103 | ws/api/dispatcher, identity, E2EE crypto, credentials, permissions |
  | `lib-rest`       |    35 |   2 511 | the remaining `src/lib` modules                                    |
  | `stores`         |     9 |   1 918 | `src/stores/**` (the measured 22 m run)                            |
  | **sum**          |    76 |  12 387 | equals the configured surface                                      |

  Each shard is an explicit list, so the union check is exact. At the measured
  ~87 mutants/min the longest shard (`transport-auth`, 3 103) is ~36 min plus
  the initial run and `npm ci` — inside the 90-minute ceiling with margin. The
  shards are named and driven by `Client/stryker.shard.config.mjs` via
  `STRYKER_SHARD`, and the union is proved by
  `Client/scripts/check-mutation-shards.mjs`.

- **Validate:** record the projected wall time per shard; the sum of shard
  mutants equals 12 387. **Done:** table above sums to 12 387, and the union
  check exits 0 at 76 files. Measured wall times (serial local run,
  2026-09-20): `livekit` 49 m 34 s, `audio-media` 25 m 02 s, `transport-auth`
  30 m 49 s, `lib-rest` 44 m 08 s, `stores` 19 m 52 s — every shard inside the
  90-minute ceiling. In CI the shards are parallel jobs, so the night costs the
  longest shard, not the 169-minute serial sum.

### Task 2: Where the schedule lives

- **Action:** decide and implement the trigger placement. The file is on `dev`;
  schedules fire only from `main` (row 8). **Resolved (owner, Q1):** land the
  sharded workflow on **`dev` only** and do **not** open a PR into `main`. The
  reviewer found real precedent for carrying a workflow file to `main` so its
  schedule can fire (`3d3875f9` carried `nightly-docker-smoke.yml`; `1e250ebd`
  did the same for `dependabot.yml`) and recommended that; the owner has
  deferred the carry until the beta release ships, with no date set, so it is a
  standing constraint. Keep the file separate from `ci.yml`, mirroring
  `nightly-docker-smoke.yml:6-15`.
- **Consequence, stated plainly rather than worked around:** on `dev` only the
  workflow is not registered by GitHub, so the nightly runs by **no** path yet —
  neither the cron nor `workflow_dispatch` (verified: the file is absent from
  `gh workflow list` and a dispatch returns HTTP 404). Make the job
  `workflow_dispatch`-capable anyway so the trigger is already in place, land
  the sharded definition complete and correct so the later carry is a verbatim
  copy with no rework, and say so in the workflow header, this plan, and the PR
  description. Do **not** invent a substitute trigger (a schedule on `ci.yml`, a
  push trigger) to make it fire anyway. The measured score in Task 4 is produced
  by running the shard configs locally, not by this workflow.
- **Gotcha:** do not add a `schedule:` to `ci.yml` to sidestep this — the
  docker-smoke comment names exactly why that breaks release gate-evidence.
  Do not make the mutation job a required context.
- **Validate:** `npx actionlint .github/workflows/nightly-test-depth.yml` if
  available; the job's name matches no required context in
  `docs/plans/b0-dev-branch-protection.sh`. **Note:** no `actionlint` binary is
  present locally; validate by YAML parse and a `workflow_dispatch` run.
  **Done:** the workflow parses; the `mutation` job's per-shard name
  (`Nightly mutation baseline (<shard>)`) and `mutation-permissions` match no
  context in `b0-dev-branch-protection.sh:61-77`. The `workflow_dispatch:` entry
  point is present for the later carry. **No run is observed by any path, by
  owner decision (Q1):** the file is `dev`-only, so GitHub does not register it
  — the file is absent from `gh workflow list`, and
  `gh workflow run nightly-test-depth.yml --ref dev` returns the same HTTP 404
  as a schedule attempt. The acceptance item for a "real scheduled run" is
  intentionally not met and is recorded here instead. The baseline score (Task 4) was therefore measured by running the shard configs locally.

### Task 3: Implement the shards and prove the union is complete

- **Action:** add the per-shard Stryker config (a single
  `Client/stryker.shard.config.mjs` driven by a `STRYKER_SHARD` env var), each
  shard carrying the base config's exclusions, `thresholds`, and `tempDirName`.
  Rewrite the `mutation` job to run every shard as a parallel matrix job and
  upload each shard's report.
- **Gotcha:** Stryker's vitest runner forces `pool: "threads"`, which is why
  `stryker.config.mjs:11` sets `OC_ALLOW_UNPINNED_TZ = "1"`; a new config
  **must import the base module** so the flag survives, or the TZ-pinned blocks
  abort (`stryker.config.mjs:3-11`). `stryker.shard.config.mjs` imports the
  base for exactly this reason.
- **Validate:** the union of all shards' file lists equals
  `mutate: ["src/lib/**/*.ts", "src/stores/**/*.ts", "!src/lib/types.ts",
"!src/**/*.d.ts"]` — prove it with `Client/scripts/check-mutation-shards.mjs`,
  not by eye. Run one shard's dry run green. **Done:** the check exits 0 at 76
  files; each shard instruments to its table count in Task 1.

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
  **Done:** `docs/plans/b7-8-mutation-baseline-2026-09-20.md` records the
  headline **69.80 %** over 12 387 mutants (76 files), per-shard and per-module
  tables with error counts beside every score, the error triage (3 744
  `CompileError`, 2 `RuntimeError`), and the command for each figure.
- **Conscious call — public artifacts (record, do not hide).** The nightly
  publishes per-module mutation-score files and full HTML reports as artifacts
  on a public repository, including for auth and E2EE modules. Surviving
  mutants are test gaps rather than defects, and the existing nightly already
  uploads the `permissions.ts` report, so this is accepted. It is noted here,
  and in the PR description, as a decision rather than an oversight, because the
  repo's "no unfixed defects in public" rule (`docs/security.md`) is the reason
  it needs the explicit call.

### Task 5: Thresholds and the advisory gate

- **Action:** set the full-run `thresholds` against the recorded baseline and
  decide whether the nightly fails on a drop. **Resolved (owner, Q2):** start
  **report-only** (no `break`, `high`/`low` colours only) and record the flip
  condition as: **(i)** the error population is triaged, and **(ii)** about five
  consecutive nightly runs have established the spread, with the tolerance set
  to at least that spread, per shard. "Until B7-9 lands" is **not** the trigger:
  the measured `stores` run had 709 errored mutants of 1 918 (37 %), Stryker
  drops errors from the denominator, so triaging them moves the score by points
  on its own, and run-to-run variance is unknown because timeouts count as
  kills. A threshold armed before both are known is either flaky or toothless.
  Decomposition PRs stay gated meanwhile because the extracted modules are
  already in PR CI's subset.
- **Validate:** prove the threshold can fail — temporarily set `break` above
  the recorded score, confirm the shard run exits non-zero, revert. Record both
  exit codes. **Done:** a throwaway run over `src/lib/hostValidation.ts`
  (scored 97.06 %) with `break: 99.9` exited **1**
  (`Final mutation score 97.06 under breaking threshold 99.9, setting exit code
to 1`), while all five shipped shard runs (no `break`) exited **0**, as did
  `stryker.ci.config.mjs` (100.00 %, exit **0**). The mechanism works; it is
  deliberately unarmed.

### Task 6: Docs and the PRD link

- **Action:** update `docs/contributing.md`'s mutation rows (`:107-108`) to say
  the full run is the nightly baseline and PR CI is the narrow subset; add the
  one-cell PRD link for B7-8 in the Delivery Milestones table.
- **Validate:** `node scripts/run.mjs check:docs` exits 0 (it already passes at
  the base).
- **Note (Q1):** do not mark the B7-8 cell "done" on the strength of a
  scheduled run; the schedule is inert on `dev`. Record the milestone as landed
  with the schedule deferred.

## Validation

```
cd Client && npm run test:mutate:dry                          # 76 files / 12 387 mutants / 5 527 tests
cd Client && node scripts/check-mutation-shards.mjs           # union equals the 76-file surface
cd Client && STRYKER_SHARD=<name> npx stryker run stryker.shard.config.mjs --dryRunOnly  # each shard
cd Client && npx stryker run stryker.ci.config.mjs            # narrow subset still green
node scripts/run.mjs check:docs
node scripts/run.mjs check:hygiene
npx prettier --check .claude/plans/b7-8-mutation-baseline.plan.md docs/plans/b7-8-mutation-baseline-*.md docs/contributing.md Client/stryker.shard.config.mjs Client/scripts/check-mutation-shards.mjs
# → then the ci-check skill
```

## Risks

| Risk                                                                                  | Likelihood | Impact | Mitigation                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The nightly is landed on `dev` only, so its cron never fires (owner decision)         | Certain    | Medium | Stated plainly, not hidden: `workflow_dispatch`-capable, definition complete for a verbatim carry to `main` when the beta ships; the schedule is knowingly inert until then |
| The baseline is recorded with errored mutants silently excluded, inflating the number | High       | Medium | Task 0/Task 4 publish the error count beside every score and triage the class                                                                                               |
| A shard split drops a file, so the "full" score is not full                           | Medium     | High   | Task 3 proves the union of shard globs equals the configured surface                                                                                                        |
| The 2.4 h extrapolation is wrong and shards are sized on a bad number                 | Medium     | Medium | Task 0 re-measures; Task 3 records a real shard wall time before the score is called a baseline                                                                             |
| The PRD's C-16 row is treated as closed by this milestone when it also spans B7-10    | Medium     | Low    | Record "C-16 (B7 half)" explicitly; survivor triage for critical modules is B7-10's, not here                                                                               |

## Out of scope

- **Decomposing any module** — B7-9/B7-10. This milestone only measures.
- **Fixing survivors or errored mutants** beyond the triage needed to state the
  score honestly; survivor fixes for transport/auth/E2EE are C-16's B10 half
  (`repo-health-issue-register-2026-08-23.md:219`).
- **Raising PR-CI mutation coverage** beyond the existing narrow subset.
- **Any non-client mutation** (Go, Rust).
- The implementation itself: this task delivers the plan and the PRD link only.

## Open questions for the owner — resolved 2026-09-20

1. **Where does the nightly schedule live, now that the run cannot be a PR
   check?** **Resolved: on `dev` only; no PR into `main`.** The reviewer
   recommended option (a), carrying `.github/workflows/nightly-test-depth.yml`
   to `main` through a targeted PR so the cron fires (real precedent:
   `3d3875f9` carried `nightly-docker-smoke.yml`; `1e250ebd` did the same for
   `dependabot.yml`). The owner deferred that carry until the beta release
   ships, with no date set, so it is a standing constraint. Consequence handled
   honestly: GitHub registers a workflow only from the default branch, so the
   `dev`-only file runs by no path at all — not the cron, and **not**
   `workflow_dispatch` either (the file is absent from `gh workflow list`; a
   dispatch returns HTTP 404). The `workflow_dispatch:` trigger is kept for the
   later carry, the definition is complete so that carry is a verbatim copy, and
   the workflow header, this plan and the PR description all say the nightly
   does not run yet. No substitute trigger is added; the baseline score was
   measured locally.
2. **Does the nightly fail on a mutation-score drop, or report only?**
   **Resolved: report-only first, then a threshold; flip trigger changed.** The
   flip condition is **(i)** the error population is triaged and **(ii)** about
   five consecutive nightly runs have established the spread, tolerance set to
   at least that spread, per shard — **not** "until B7-9 lands". The `stores`
   run's 709 errors of 1 918 (37 %) move the score when triaged, and run-to-run
   variance is unknown because timeouts count as kills. Decomposition PRs stay
   gated meanwhile because their modules are already in PR CI's subset.
3. **Is 90 minutes still the ceiling once the surface is known to be ~12 400
   mutants?** **Resolved: yes, read as wall-clock per night.** Shards run as
   parallel jobs; the repo is public so standard-runner minutes are free and the
   only real cost is the repeated `npm ci` + initial test run per shard. The
   workflow uses a matrix with `fail-fast: false` and `timeout-minutes: 90` per
   shard so the ceiling is enforced, not hoped for.

## Acceptance

- [ ] `Verify before you implement` re-run at HEAD, with 76 / 12 387 / 5 527
      recorded or the discrepancy written into the PR description
- [ ] 67.04 %'s 13-module provenance stated wherever it is cited; it is never
      presented as a full-surface score
- [ ] Shards chosen such that each fits the ceiling; the union of shard globs
      equals the configured 76-file surface exactly
- [ ] The schedule lives on `dev` only (owner decision); the job is
      `workflow_dispatch`-capable and the plan, workflow header and PR
      description each state the nightly runs by no path until the `main`
      carry (GitHub does not register a `dev`-only workflow, so dispatch 404s
      too)
- [ ] `docs/plans/b7-8-mutation-baseline-<date>.md` records one headline
      full-surface score plus per-module scores and error counts, each with the
      command that produced it, and states errored mutants are excluded
- [ ] Thresholds are report-only; the flip condition (errors triaged + ~5 runs)
      is recorded, not "until B7-9"
- [ ] The public-artifact decision for auth/E2EE mutation reports is recorded
- [ ] The narrow PR-CI subset (`stryker.ci.config.mjs`) still runs green
- [ ] No implementation code, no test changes, no PR-CI gate changes beyond the
      narrow subset's own config
- [ ] `npm run check:docs` and `npx prettier --check` on touched files pass
