# HP-0 — Baseline acceptance scorecard

**Hold point:** HP-0, defined in
[repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md)
**Commit:** `6a1561fa` on `dev` (B0 integration commit, PR #1409)
**Measured:** 2026-08-25
**Evidence base:** [b0-baseline-2026-08-25.md](b0-baseline-2026-08-25.md)

**Decision: ACCEPTED — 2026-08-25 by J3vb (repository owner).**

This is the single artifact HP-0 requires. It answers the hold point's four
questions and records what was accepted with known gaps rather than claimed as
complete. Part-closes `R-08`.

Acceptance is not a claim that OwnCord is beta-ready. It is a claim that the
baseline is **truthful, reproducible, and sufficient to begin B1**.

## Question 1 — what is green, red, unavailable, and unverified

| Metric                                | Baseline                     | Target             | Actual                                         | Evidence                                                                               |
| ------------------------------------- | ---------------------------- | ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Required checks green                 | refresh in B0                | 100%               | **green** — 10 pinned checks pass              | PR #1410 on `dev`; pinned set below                                                    |
| Open P0                               | 4 (G-01, G-02, G-03, C-06)   | 0 for B0           | **0** — all four closed                        | [b0-baseline](b0-baseline-2026-08-25.md) dispositions                                  |
| Open P1                               | 45                           | 0 by B10           | **45**, none in B0 scope                       | [register](repo-health-issue-register-2026-08-23.md), phases B1–B10                    |
| Unresolved security findings          | private count                | 0 by B10           | **7**, all publicly owned, 0 unmapped          | Question 4 below                                                                       |
| Requirement rows release-qualified    | 0                            | 100% by B10        | **0**                                          | [traceability](beta-requirements-traceability-2026-08-23.md)                           |
| Server aggregate coverage             | 74.6%                        | ratchet in B3      | **74.6%** measured                             | b0-baseline, measured                                                                  |
| Client honest coverage                | refresh in B0                | ratchet in B7      | **not measured** — see gaps                    | `C-03`, B7                                                                             |
| Static-analysis warnings              | 471 Oxlint                   | 0 unapproved by B7 | **471**, unchanged                             | `C-02`, B7                                                                             |
| Server builds (4 tag variants)        | —                            | pass               | **pass** ×4                                    | measured                                                                               |
| `go vet` / `-race` / `-tags deadlock` | —                            | pass               | **pass**                                       | measured                                                                               |
| `golangci-lint`                       | claimed broken (G-05)        | pass               | **0 issues**, 19 linters, 1.18s                | G-05 **refuted**                                                                       |
| Client unit + integration             | 2 failing                    | green              | **5257 passed / 0 failed**                     | G-01, G-02 fixed                                                                       |
| Client `tsc` / `lint` / `prettier`    | —                            | pass               | **pass**                                       | measured                                                                               |
| Playwright                            | never terminated             | green and exits    | **293 passed, exit 0, 37s**                    | `C-06` fixed                                                                           |
| Rust tests + clippy                   | **carried, not re-measured** | pass               | **115 passed, clippy `-D warnings` exit 0**    | **re-measured 2026-08-25**; CI `Rust Unit Tests` green on Linux                        |
| Docker build + boot smoke             | unavailable                  | pass               | **pass**, 50.1 MB, boots `:8443`               | `ENV-02` closed                                                                        |
| Largest lazy chunk                    | —                            | budget in B7       | 1,998.25 kB min / 1,344.96 kB gzip             | measured                                                                               |
| Generated/doc drift                   | refresh in B0                | 0                  | **0** — `sqlc-verify`, `protocol-verify` green | CI                                                                                     |
| Ledger path resolution                | —                            | 0 dead             | **0 dead paths / 383 records**                 | 378 re-verified 2026-08-29; OC-0379–0383 path-verified at their 2026-08-31/09-01 fixes |
| Desktop/browser/device matrix         | incomplete                   | 100% by B10        | **incomplete**                                 | B6–B8                                                                                  |
| 250/100/25 capacity profile           | unproven                     | met by B6          | **unproven**                                   | `S-14`, B6                                                                             |
| Upgrade/rollback/restore              | unproven                     | green by B6        | **unproven**                                   | B6                                                                                     |

### Accepted with known gaps

Three items are accepted as _stated limitations_, not as green:

1. **Every measured row was produced on local Node 26, not CI's Node 24**
   (`ENV-01`). `.nvmrc` is now 24 and CI pins 24, but the local runtime is 26.
   The full single-source-of-truth work is B1 (`RL-17` / `C-01`). The CI-side
   confirmation now exists — PR #1410 ran the complete matrix on Node 24 and
   passed — but the _numbers_ in the table above remain the Node 26 ones.
2. **Client coverage percentage is not measured.** `C-03` recorded that coverage
   could not complete while G-01/G-02 failed. Both are fixed, so it is now
   obtainable; establishing the honest baseline and its exclusions is B7 work.
3. **The 38 open `OC-*` records are counted and verified non-stale, not
   individually adjudicated.** See Question 2.

Nothing here is a B1 blocker.

## Question 2 — which confirmed issues block each later phase

**No confirmed issue blocks B1.**

Open ledger, re-verified 2026-08-29; counts re-derived 2026-08-31 after B3-9
(PR #1454) closed `OC-0345`, `OC-0346`, `OC-0376`, `OC-0377`, `OC-0378`, the
2026-08-31 post-merge audit recorded `OC-0379` fixed on arrival, the B3-8
role family closed `OC-0374`, and its message/read-state family closed
`OC-0323`, `OC-0357` and `OC-0358`; B4-12(d) closed `OC-0340` and `OC-0341`:

| Status    | Count   |
| --------- | ------- |
| fixed     | 331     |
| open      | **48**  |
| declined  | 3       |
| duplicate | 1       |
| **total** | **383** |

Of the 48 open records:

- **1 high, 12 medium, 35 low. Zero critical.** The high is `OC-0350`, an
  admin-panel login defect raised by the 2026-08-29 hunt and not yet phased.
- Three hunts: 24 from `general-2026-08-22-b`, 23 from `general-2026-08-29`,
  1 from `b2-1-fixture-capture-2026-08-28` (the 2026-08-29 hunt count is down one: `OC-0374` closed with the role family; the 2026-08-22 count is down two more: `OC-0340` and `OC-0341` closed in B4-12(d)). The three
  `b3-1-auth-characterization-2026-08-29` records (defects the auth
  characterization rows pinned as-is) were fixed in B3-9 on 2026-08-30.
- **All 48 resolve to a live `file:line`** — 0 dead paths, re-checked
  2026-08-29; the five B3-9 closed were live then and are fixed now.
  `OC-0323` used to be the exception (its line had drifted past end of file
  when B2 work shortened `Server/service/channel.go`); the message/read-state
  family fixed it, so the exception is gone rather than carried.
- 33 sit under `Client/`, 15 under `Server/`.
- **None of the 2026-08-22 records is assigned to B1**; their register phases
  span B2–B10. The 2026-08-29 records are not yet phased in the register.

The 2026-08-22 records are therefore accepted as _counted, non-stale, and
assigned_ rather than individually adjudicated; the 2026-08-29 records are
counted and path-checked but not yet phased. Deciding each is bughunt-fix work. The 22 under the
client path are a **sequencing input to B1-1**, not a blocker: the flatten must
re-point their recorded paths, and the same dead-path check above is the proof.

Planning rows by phase are in the
[register](repo-health-issue-register-2026-08-23.md). The 45 open P1 rows are
distributed across B1–B10; the B1-owned ones are `L-01`, `L-10`, `L-16`, `C-01`,
`R-04`, `R-09`, and are the subject of
[b1-repository-foundation-2026-08-25.md](b1-repository-foundation-2026-08-25.md).

## Question 3 — which checks protect the integration branch

`dev` is protected and **status checks are now pinned** (2026-08-25), closing
B0's one outstanding step. Applied by
[`b0-dev-branch-protection.sh`](b0-dev-branch-protection.sh); verified against
the live API.

| Setting                  | Value               |
| ------------------------ | ------------------- |
| Pull request required    | yes                 |
| Approvals required       | 0 (solo maintainer) |
| Applies to admins        | yes                 |
| Force pushes / deletions | disabled            |
| Required status checks   | **12**              |

Pinned:

```
Server Build & Test (ubuntu-latest)     Client E2E (Playwright)
Server Build & Test (windows-latest)    Client E2E (parity subset, blocking)
Client Static Checks                    Analyze (go)
Client Unit Tests                       Analyze (javascript-typescript)
Rust Unit Tests                         Analyze (actions)
Repository Hygiene                      Docs & Ledger Consistency
```

`Repository Hygiene` was added 2026-08-26 (B1-3, S-05) and
`Docs & Ledger Consistency` 2026-08-27 (B1-6, L-07); both names were read off a
live PR after the job reported, per the rule below.

Deliberately **not** pinned, with the observed reason:

| Check                                         | Why not                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Server Docker Build (verify)`                | Reports **skipping** on a dev PR (`if: ref_name=='main' \|\| base_ref=='main'`).                                               |
| `Tauri Full Build (${{ matrix.os }})`         | Reports **skipping** on a dev PR, under the _unexpanded_ matrix name — the job is skipped before matrix expansion.             |
| `Admin Panel E2E (real server, non-blocking)` | `continue-on-error: true`, so it reports success unconditionally. Requiring it would be theatre. Graduating it is `R-01`, B10. |
| `CodeQL`                                      | Default-setup aggregate over the three `Analyze` jobs; pinning those is sufficient.                                            |

A required check that never reports blocks every PR forever, so the list was
read off a live dev-targeted PR with `gh pr checks`, not inferred from
`ci.yml`. That mattered: **three of the twelve exist in no workflow file**, because
CodeQL runs from GitHub default setup configured in repository settings.

Two consequences to carry into B1:

- **The CI Docker job is skipped on every dev-targeted PR.** Docker evidence for
  a dev change must be produced locally.
- **Full Tauri packaging never runs on a dev PR.** It is not an integration gate
  (`C-15`, B1/B10).

## Question 4 — which security details remain private

The independent source review of `5cc08889` is reconciled. Its detailed reports
stay untracked and gitignored (`docs/security-findings/`, 0 tracked files); this
section is deliberately content-free per [docs/security.md](../security.md).

|                                          |                                                |
| ---------------------------------------- | ---------------------------------------------- |
| Private findings                         | **7** — 5 medium, 2 low. No high, no critical. |
| Confirmed fixed at the reviewed revision | **0**                                          |
| Mapped to an existing public row         | **7 of 7**                                     |
| Unmapped / untracked                     | **0**                                          |

Public owners, already opaque in the register: `SEC-01`, `SEC-02`, `SEC-03`,
`SEC-04`, plus `C-09`, `S-01`, and one `OC-*` ledger record. Every private
finding has exactly one public owner; no finding is tracked only in private.

Remediation reproduction detail, source-to-sink traces, exploit conditions, and
affected-release analysis remain in the private reports and any advisory raised
from them. **None of it belongs in a public commit, issue, or PR description** —
this repository is public. `RL-22` is likewise tracked publicly as `L-16` with
no mechanism described.

None of the seven is a B1 blocker; they are phased B2–B6.

## What acceptance does and does not authorise

**Authorises:** starting B1, per
[b1-repository-foundation-2026-08-25.md](b1-repository-foundation-2026-08-25.md).

**Does not authorise:** treating any row above as release-qualified, starting
server feature work (B2+), client architecture extraction (B7), or browser work
(B8). The phase exits remain serial.

## Corrections this scorecard records

Two B0-era statements did not survive checking, and are corrected here rather
than left to propagate:

- **`golangci-lint` (G-05)** — refuted in B0; recorded again because the
  register still carries the original claim.
- **"Repository-settings writes are blocked from the agent sandbox"** —
  `b0-dev-branch-protection.sh` was written on that assumption and marked
  run-it-yourself. The `PUT` succeeded on 2026-08-25. The script remains the
  record of intent and the way to re-apply or undo the settings.
