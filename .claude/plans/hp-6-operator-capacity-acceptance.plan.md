# Plan: HP-6 — Operator and capacity acceptance

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: HP-6 — Operator and capacity acceptance, the owner signs (roadmap "### Hold point HP-6", `repo-health-roadmap-2026-08-23.md:857-862`)
**Satisfies**: the PRD's Operator-usability metric ("an unfamiliar owner completes every HP-6 task from docs alone", `prd.md:75`), the roadmap's required-evidence bullet "operator usability record" (`:887`), and the phase's exit — HP-6 gates B7 (`prd.md:156-158`)
**Complexity**: Large (small in code — zero — and large in coordination: one release candidate, one fixture set, a stranger, and every other B6 milestone's evidence in one document)
**Drafted**: 2026-09-15 at `dev` `96258158`. B6-10 is in flight on `feat/b6-10-operational-measurements`; B6-11 through B6-15 are `pending` (`prd.md:148-152`). This plan is written **before** any of them lands, on purpose: the B5 lesson is that a hold point is planned first and its adversaries briefed, not assembled after the steps it reviews (`b5-community-content-moderation-2026-09-04.md:41-44`, `:1624-1664`). `docs/deployment.md` lines are cited from the B6-10 working tree (dev + 5 lines after `:738`)

**Executor rule**: Where this plan proposes a default for an open question, apply that default unless the owner has overridden it in this file. Where a step needs hardware, a human, a network, or a merged PR that is not available to you, do not guess and do not invent a value: mark the row `unverified`, state what was missing in the PR description, and continue with the next step. Never leave a `<placeholder>` in committed text.

## Summary

HP-0 through HP-5 reviewed code against a threat model. HP-6 reviews **a
release candidate against a stranger**: someone who has never seen the code
deploys each mode from the published documentation, is told nothing the
documentation does not say, and either finishes or gets stuck. Where they get
stuck is the finding. The scorecard then does what the earlier scorecards did —
one row per exit-gate condition, the command or record that produces the
evidence, and the owner's merge as the signature (`hp-4-scorecard-2026-09-02.md:19-24`,
`hp-5-scorecard-2026-09-05.md:16-21`).

Two things make HP-6 unlike HP-5. It sits at the **end** of the phase rather
than in the middle (`prd.md:156-158`), so nothing is "behind" it except B7 —
and it must be reached with **one** release candidate and **one** data-fixture
set whose SHA is recorded in the exit evidence (`prd.md:161-162,270`). And one
of its Success Metrics rows cannot be measured at all: the TLS mode matrix is
unmeasured because B6-3 – B6-5 are deferred, and the PRD says the hold point
"either records it as an accepted limitation or waits for the TLS work. That
is an owner decision at the hold point" (`prd.md:173-177`). This plan makes
that decision explicit (open question 2) rather than letting the scorecard
imply it.

The deliverables, and what produces each:

| #   | Deliverable                                                                       | Shape                                                                                                                                                                                                                                                        | Produced by                                             |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 1   | `docs/plans/hp-6-scorecard-<date>.md`                                             | header (hold point, RC SHA, fixture SHA, measured-at, branch `docs/hp-6-scorecard`), the chain table, one section per exit-gate condition with evidence, the Success-Metrics table with an Actual column, decisions, "What this hold does not claim", Signed | Task 1 skeleton **before** the run, Task 4 filled after |
| 2   | `docs/plans/hp-6-operator-record-<date>.md`                                       | the operator usability record: who the owner was, what they were given, the ten tasks, per task the outcome / time / documents consulted / every stall, and the findings each stall became                                                                   | Task 3, written by the recorder during the run          |
| 3   | The RC and fixture pin                                                            | the tag B6-12 rehearsed, its `dev` SHA, the alpha snapshot's hash (`TestAlphaProfileByteIdentical`) and the smoke fixture's shape — recorded in the scorecard header and nowhere else                                                                        | Task 0                                                  |
| 4   | The TLS decision                                                                  | accepted limitation, or wait — written as a decision the owner reverses at signature, with the Success-Metrics row reading what was decided                                                                                                                  | Open question 2, recorded in Task 4                     |
| 5   | The map from every exit-gate bullet and required-evidence bullet to its milestone | this plan's "Exit-gate map" table, copied into the scorecard with the evidence link per row; deferred and still-pending rows say so                                                                                                                          | This plan; Task 1 carries it forward                    |

**Nothing here is tuned to pass.** A stranger who cannot restore a backup from
`docs/deployment.md` is a B6-13 finding with the paragraph named; a TLS row
that reads "unmeasured" stays "unmeasured" until the owner writes otherwise.

## Verify before you implement

Facts established from source at `96258158`. Rows marked **Refuted**,
**Corrected** or **Unknown** contradict something the roadmap, the PRD, the
earlier scorecards or an obvious first reading would assume, and the plan is
built on the correction.

| Claim                                                                                     | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HP-6 sits at the end of B6 and gates B7; B6-14 and B6-15 must land before it              | **Confirmed** | `prd.md:156-158`; roadmap workstreams 17 and 18 both say "before HP-6" (`roadmap:836-848`)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The hold point needs one release candidate and one fixture set, with the SHA recorded     | **Confirmed** | `prd.md:161-162`; risk row "Freeze one RC and one fixture set before HP-6; record its SHA in the exit evidence" (`prd.md:270`); roadmap safe-parallelism "The same release candidate and data fixtures must be used before HP-6 closes" (`roadmap:891-893`)                                                                                                                                                                                                                                                                    |
| A "release candidate" already exists                                                      | **Refuted**   | `release.yml:3-6` runs only on a `v*` tag push; `git log` on `dev` shows no B6 tag. B6-12 "rehearses one tag against `gate-evidence` and `environment: release`" (`prd.md:149`) — that rehearsed tag **is** the RC, so HP-6 cannot start before B6-12 lands and its tag run is green                                                                                                                                                                                                                                           |
| The fixture set is the alpha snapshot plus the smoke fixture                              | **Confirmed** | `Server/testdata/snapshots/v1.2.0-alpha.4.sqlite` guarded by `TestAlphaProfileByteIdentical` (B6-11 plan `:68`); `cmd/smoke/fixture.go` (setup wizard → upload → backup, B6-8 plan `:89`). No third fixture exists, so "one fixture set" is these two by construction; the scorecard names both hashes                                                                                                                                                                                                                         |
| The TLS-mode Success-Metrics row can be measured by a later milestone                     | **Refuted**   | `prd.md:73` requires "4/4 pass (domain, public IP, LAN, offline)"; `prd.md:164-177` defers B6-3/4/5 and says HP-6 "either records it as an accepted limitation or waits… an owner decision at the hold point, not something a later milestone silently resolves". `docs/port-forwarding.md:164-182` and `docs/deployment.md:831-836` already tell operators the paths are unqualified                                                                                                                                          |
| "Rotate trust" means rotating a certificate                                               | **Corrected** | Certificate rotation is B6-5, deferred (`roadmap:788-789`, `prd.md:142`). What an operator **can** rotate today: the self-signed pair (`Server/auth/tls.go:122-135` regenerates only when `cert.pem`/`key.pem` are absent — rotation is delete-and-restart; `docs/deployment.md:540-547` says so), `push_vapid.key` (operator action: replace file, restart — `Server/auth/push_vapid_key.go:19-22`, HP-5 decision 7 `hp-5-scorecard:Question 9 item 7`), and the LiveKit API secret in `config.yaml`. HP-6 drills those three |
| `totp.key` and `erasure.key` can be rotated                                               | **Refuted**   | `docs/deployment.md:516-534`: a missing `totp.key` locks out every 2FA user with no recovery path but the archive; `erasure.key` is fingerprint-bound to the marker file (`Server/db/markers.go:94-99`, OC-0388) and a mismatch is a refused boot. `totp_encrypt.go:194` mentions "key rotation" in a comment only. The stranger's task for these is to **conclude from the docs that rotation is not offered** — a stranger who tries anyway and loses 2FA is a documentation finding, not a user error                       |
| After a certificate rotation the desktop client offers a way to re-pin                    | **Unknown**   | `docs/trust-model.md:167-169` a mismatch rejects before the auth frame; `:293` "a user who can edit `certs.json` can re-pin". `Client/src-tauri/src/tofu.rs` exposes no pin-removal function (grep `remove_pin\|clear_pin\|forget`). Whether the mismatch modal itself offers "trust the new fingerprint" is not documented for the operator. Task 3 T7 measures it; if the only path is editing `certs.json`, that is a B6-13 finding                                                                                         |
| Backup and restore are one operation                                                      | **Corrected** | Two: `POST /admin/api/backup` + `…/restore` is the database only (`docs/deployment.md:362-366,372-398`); a **full** restore is the archive — `data/` wholesale, `config.yaml`, the previous binary (`:440-552,587-642`). The stranger does both, because a database-only restore that loses every attachment "looks like success"                                                                                                                                                                                              |
| Failure interpretation can be staged by hand                                              | **Corrected** | B6-11 builds `cmd/smoke -drills` with phases R (backup/restore/markers), C (corrupt config/backup), D (headroom → full → recovery), S (SFU killed/absent) (B6-11 plan `:239-324`). HP-6 stages each failure by running the drill's **recipe** against the stranger's own install — not the harness — so what they see is what an operator sees: the log line, the `/health` verdict, the 507. If B6-11 has not merged, the recipe is the plan's phase text and the result is marked "staged by hand"                           |
| The previous scorecards' "owner signs" mechanic is a signature line                       | **Corrected** | Neither HP-4 nor HP-5 was signed in the owner's name. The owner **merged** the scorecard PR (`hp-4:308-310` "#1515… recorded by B4-9's PR, not signed in the owner's name"; `hp-5:Signed` "#1547… recorded by a follow-up docs PR"). Decisions are "made under the owner's delegation… open to reversal at signature" (`hp-4:266-268`). HP-6 uses the same shape: branch `docs/hp-6-scorecard`, the merge is the signature, the decisions list is what the owner reverses by editing before merging                            |
| Every exit-gate bullet has a milestone that produces it                                   | **Refuted**   | Two do not: "Domain, public-IP, LAN, and offline TLS modes pass their owned matrix" (`roadmap:867`) and the "certificate rotation" clause of the drills bullet (`:874-875`) — both B6-3/4/5, deferred. Required-evidence bullet 2 ("ACME staging, public-IP, local-CA, expiry, and rotation reports", `:882`) and the TLS half of bullet 3 ("network-mode integration matrix", `:883`) likewise. See the Exit-gate map                                                                                                         |
| The "resource" measurements in exit bullet 5 are produced by B6-9                         | **Unknown**   | `roadmap:870-871` asks for "p95/p99 latency, **resource**, and failure measurements". `docs/capacity.md:211-230` records the cgroup limits and latencies, not the server's CPU or memory **usage** under the profile. B6-10's Task 4 samples `cpu.stat` per phase (B6-10 plan `:302-304`); nothing samples memory. Task 1 asks B6-10 to publish both from the artifact it already uploads, or the scorecard row says "latency and CPU throttling measured; memory not"                                                         |
| B6-1 is complete                                                                          | **Corrected** | `prd.md:138` says `complete` (PR #1581 flipped it); `prd.md:225-231` says it "stays `in-progress` until the first tag run proves the three unchecked acceptance rows"; the plan's acceptance has three rows "awaits a tag run" (`b6-1 plan:220-224`). B6-2 has two (`b6-2 plan:217-218`); B6-8 has one (`:378`). Every one of those is proven by the **same** tag run B6-12 rehearses — the RC. HP-6 condition 1 cites that run, and B6-16 reconciles the row wording                                                          |
| Support-bundle generation is not built, so the "interpret failure" task cannot include it | **Refuted**   | HP-4's exit said so on 2026-09-03 (`hp-4:437-439`), but `Server/admin/api.go:234-235` routes `/support-bundles/preview` and `/download`, and `docs/architecture/diagnostics.md:29,149-204` documents the contract. T10 has the stranger produce one. B6-16 notes the HP-4 statement is stale                                                                                                                                                                                                                                   |
| The desktop client is part of what the stranger deploys                                   | **Corrected** | HP-6 is a **server** hold (`roadmap:759-762`), and B6's out-of-scope says "any client-side experience — B7, B8, B9" (`prd.md:110-111`). But "understands the network and trust limits" cannot be shown without one client connecting through the TOFU prompt (`trust-model.md:157,172-183`). The stranger uses the **released** desktop client as a black box to connect, accept a fingerprint, and observe a mismatch; nothing about the client is scored                                                                     |
| A non-developer reading a document is an accepted evidence shape here                     | **Confirmed** | BPR-051's exit evidence: "one non-developer reading 'The short answer' and answering 'who can read my messages?' correctly" (`docs/trust-model.md:549-551`, recorded in B2-7). HP-6's record is that shape scaled to ten tasks                                                                                                                                                                                                                                                                                                 |
| The phase scorecard table in the roadmap is filled by this hold                           | **Corrected** | `roadmap:1315-1336` has empty Actual/Evidence columns and says "The actual values and links belong in phase evidence, not as optimistic edits to this plan" — so the HP-6 scorecard carries the B6 rows (250/100/25 profile: met; upgrade/rollback/restore: green) and the roadmap is not edited by HP-6. B6-16 owns any roadmap wording                                                                                                                                                                                       |
| `.claude/plans/` is tracked and Prettier-gated                                            | **Confirmed** | `.gitignore` whitelist; PRD decision 2026-09-08 (`prd.md:232-236`)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### What the corrections change

- **HP-6 cannot start until B6-12's tag run is green**, because that run is
  the release candidate and the only thing that closes the "awaits a tag run"
  rows in B6-1, B6-2 and B6-8. Task 0 is a gate, not a formality.
- **"Rotate trust" is three concrete operator actions plus one refusal.**
  Regenerate the self-signed certificate and re-pin a client; rotate
  `push_vapid.key`; rotate the LiveKit secret; and read the documentation well
  enough to **not** touch `totp.key` or `erasure.key`. Certificate rotation in
  the B6-5 sense is deferred and the scorecard says so.
- **The TLS row is an owner decision written into the scorecard's decisions
  list**, reversible at signature like every HP-4/HP-5 decision, not a
  footnote. Open question 2 proposes the wording.
- **Failures are staged from B6-11's recipes, observed from the operator's
  seat.** The harness proves the server; the record proves the documentation
  lets a stranger name what happened.

## Exit-gate map

Every exit-gate bullet (`roadmap:864-877`) and required-evidence bullet
(`:879-887`), the milestone that produces it, and its state at draft. The
scorecard copies this table and fills the evidence column.

| Bullet                                                                                   | Producing milestone(s)                                                                                                                                             | State at `96258158`                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1 Every artifact installs/starts, migrates, healthy, serves, drains, restarts, restores | B6-1 (#1580, `cmd/smoke` per asset), B6-2 (#1583, image lifecycle smoke), B6-8 (#1590, restore), **B6-12** (the tag run that runs all four assets and both images) | Merged except B6-12; six acceptance rows across B6-1/2/8 await the tag run                                                                                         |
| E2 Domain, public-IP, LAN, offline TLS modes pass their matrix                           | **B6-3, B6-4, B6-5 — deferred** (`prd.md:164-177`)                                                                                                                 | **No producer.** Owner decision (question 2)                                                                                                                       |
| E3 Direct port forwarding works; limits actionable, never disguised                      | B6-6 (#1588; `docs/port-forwarding.md`, reachability report, banner qualifiers)                                                                                    | Merged; the stranger's T4 is the usability half                                                                                                                    |
| E4 Browser hosting off by default, cannot expose an incomplete bundle                    | B5-3 (#1542, posture) + B6-7 (#1585, `server-info` reports the flag)                                                                                               | Merged                                                                                                                                                             |
| E5 250/100/25 met with published hardware, configuration, p95/p99, resource, failure     | B6-9 (#1592, `docs/capacity.md` runs 34701291805 / 34701991385) + B6-10 (operational profile, `cpu.stat`) + B6-11 (failure)                                        | B6-9 merged; B6-10 in flight; B6-11 pending; **memory usage has no producer** (Unknown row)                                                                        |
| E6 Backup/restore, disk pressure, certificate rotation, update, rollback drills pass     | B6-11 (backup/restore, disk pressure), B6-8 (update, rollback); self-signed rotation drilled at T7(a); **renewal and rotation-with-margin — B6-5, deferred**       | Partial; renewal and rotation-with-margin have no producer                                                                                                         |
| E7 Release inputs and outputs traceable and signed                                       | **B6-12**                                                                                                                                                          | Pending. `release.yml:665-670,724-728,782` already produce checksums, minisign verification and a source tarball; SBOM and provenance do not exist in the workflow |
| R1 artifact and container install/boot matrix                                            | B6-1, B6-2, B6-12's tag run                                                                                                                                        | Awaits the tag run                                                                                                                                                 |
| R2 ACME staging, public-IP, local-CA, expiry, rotation reports                           | **B6-3/4/5 — deferred**                                                                                                                                            | **No producer.** Owner decision (question 2)                                                                                                                       |
| R3 network-mode integration matrix                                                       | B6-6 for port-forward / CGNAT / hairpin / dynamic-IP / firewall (`b6-6 plan:514-527`); the four TLS network modes — deferred                                       | Half; the TLS half has no producer                                                                                                                                 |
| R4 load-test dataset and reproducible commands                                           | B6-9 (`docs/capacity.md:6-10` publish-before-run), B6-10                                                                                                           | B6-9 merged; B6-10 in flight                                                                                                                                       |
| R5 upgrade/rollback/restore drill                                                        | B6-8 (`upgrade-rehearsal.yml`), B6-11 phase R                                                                                                                      | B6-8 merged (its "runs at release" row awaits the tag); B6-11 pending                                                                                              |
| R6 SBOM, provenance, signatures, checksums, source snapshot                              | B6-12                                                                                                                                                              | Pending; three of five exist today                                                                                                                                 |
| R7 operator usability record                                                             | **HP-6 — this plan, Task 3**                                                                                                                                       | This plan                                                                                                                                                          |

Success Metrics rows (`prd.md:66-75`) and who measures them: registered
users / connections / voice — met by B6-9, cited; latency budgets — met
against `docs/capacity.md`, cited; reference hardware — B6-9, cited; **TLS
mode matrix — unmeasured, owner decision**; artifact matrix — B6-12's tag run;
operator usability — Task 3.

## Patterns to Mirror

| Category                        | Source                                                    | Pattern                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scorecard header                | `docs/plans/hp-5-scorecard-2026-09-05.md:1-21`            | Hold point → plan section → roadmap; "Commits reviewed"; "Measured at" SHA and branch; "Evidence base"; the Decision line filled at merge                             |
| The chain under review          | `hp-4-scorecard-2026-09-02.md:26-61`                      | One row per PR: number, step, `dev` SHA; "merged after measurement" where true; `refs/pull/<n>/head` for pre-squash commits                                           |
| Condition → command → output    | `hp-4-scorecard-2026-09-02.md:64-130`                     | Each question answered with the command that produces the evidence and what it printed on the measured tree                                                           |
| Decisions open to reversal      | `hp-4-scorecard-2026-09-02.md:266-294`, `hp-5:Question 9` | Numbered, "made under the owner's delegation… open to reversal at signature"; the owner edits before merging to reverse one                                           |
| Signature by merge              | `hp-4:308-310`, `hp-5:Signed`                             | "Accepted <date> — the owner merged this scorecard as #n (`sha`)… not signed in the owner's name"; states what acceptance authorises and what it claims nothing about |
| What this exit does not claim   | `hp-4-scorecard-2026-09-02.md:431-451`                    | Limits stated "so nobody has to infer them from silence" — the TLS row, the memory row and the rotation clause go here                                                |
| Non-developer reading evidence  | `docs/trust-model.md:549-551` (BPR-051, B2-7)             | A named non-developer answers a question from the document alone; the answer is the evidence                                                                          |
| Publish before run              | `docs/capacity.md:6-10`                                   | The scorecard skeleton, the task list and the pass criteria are committed before the stranger starts, so tasks are not chosen to pass                                 |
| Adversary briefed               | `b5-community-content-moderation-2026-09-04.md:1307`      | A reviewer "briefed to assume a bypass exists"; here a second reader is briefed to assume the stranger was helped, and audits the record's transcript for it          |
| Staged failure with named cause | B6-11 plan `:281-313` (phases D and S)                    | Fill the disk to a threshold, kill the SFU child, corrupt `config.yaml`; the expected operator-visible symptom is written **before** the stage                        |
| Honest limitation               | `docs/port-forwarding.md:164-182`                         | "Stated plainly so it is not discovered at the worst moment" — the scorecard's deferred rows read the same way                                                        |

## Files to Change

| File                                                                   | Action | Why                                                                                                                                                               |
| ---------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/hp-6-scorecard-<date>.md`                                  | CREATE | The scorecard: header with RC/fixture SHAs, chain table, Exit-gate map with evidence, Success-Metrics Actuals, decisions, "What this hold does not claim", Signed |
| `docs/plans/hp-6-operator-record-<date>.md`                            | CREATE | The operator usability record (R7): who, what they were given, the ten tasks, outcomes, stalls, and the finding each stall became                                 |
| `docs/plans/b6-server-deployment-operations-capacity.prd.md`           | UPDATE | HP-6 row → `in-progress` at Task 0, `complete` + scorecard link at signature; the TLS-row decision noted under "TLS block deferred"                               |
| `docs/plans/README.md`                                                 | —      | **Not edited by HP-6.** B6-16 owns the B6 status line; Task 5 hands it the sentence                                                                               |
| `.superpowers/findings-ledger.json`                                    | UPDATE | Every stall that is a server defect rather than a documentation gap (a doc gap is a B6-13 row in the record, not a ledger finding)                                |
| `docs/deployment.md`, `docs/port-forwarding.md`, `docs/quick-start.md` | —      | **Not edited by HP-6.** Documentation findings go to B6-13 (or a follow-up docs PR after signature); the hold measures the docs as published with the RC          |

No code. No workflow. No new fixture — the RC's assets and the alpha snapshot
are the inputs, and anything else would be a second fixture set.

## Tasks

### Task 0: Gate — one RC, one fixture set, B6-14 and B6-15 in

- **Action**: before anything else, establish and record:
  1. B6-12's rehearsed tag: its name, the `dev` SHA it was cut from, the
     `release.yml` run id, and that `gate-evidence` (`release.yml:32-47`)
     passed. **That tag is the release candidate.** If B6-12 has not landed,
     stop: the hold cannot be measured against `dev`, because "every server
     artifact installs" (E1) is only provable from a tag run. Then
     `git merge-base --is-ancestor <squash SHA> <tag SHA>` exits 0 for each
     of B6-11, B6-13, B6-14 and B6-15 — against the **tag SHA**, not `dev`
     (decision taken 2026-09-15, B6-12 question 4: the tag is cut only after
     those four are on `dev`; B6-14 and B6-15 are "before HP-6" by the
     roadmap `:836-848`, B6-11 is E6's only producer and T6/T8's recipes,
     B6-13 is the docs the stranger reads). A tag that predates any of them
     is not this hold's RC; wait for the next tag (question 3);
  2. the fixture set: `sha256sum Server/testdata/snapshots/v1.2.0-alpha.4.sqlite`
     and `go test -C Server -run TestAlphaProfileByteIdentical ./internal/alphasnap/`
     green at the RC SHA; the smoke fixture is `cmd/smoke/fixture.go` at the
     same SHA;
  3. the status of B6-10: in the tag or not. B6-10 is the one milestone the
     owner may sign around (question 3): if it is not in the tag, E5's
     operational clause and R4's B6-10 half read "pending" in the scorecard
     and the owner decides at signature. Every other B6 milestone is in the
     tag by item 1;
  4. branch `docs/hp-6-scorecard` from `dev`; PRD HP-6 row → `in-progress`.
- **Why**: `prd.md:161-162,270` and `roadmap:891-893` — one RC, one fixture,
  SHA recorded. Parallel workstreams that qualified against different
  candidates is a named phase risk.
- **Gotcha**: the RC must be the tag's SHA, not `dev` HEAD at the time of the
  run. `dev` moves; the assets do not. Every `docs/` page the stranger reads is
  taken from the **source snapshot** of that tag (`release.yml:782`
  `owncord-src-*.tar.gz`), not from the working tree.
- **Validate**: the scorecard header has five filled lines (tag, SHA, run id,
  snapshot hash, fixture file) before Task 1's skeleton is committed.
- **If gated**: stop here — write a short report naming each missing
  prerequisite (milestone id and what evidence is absent) and do not start
  Task 1. Do not poll or wait.

### Task 1: The scorecard skeleton and the task list — committed before the run

- **Action**: write `docs/plans/hp-6-scorecard-<date>.md` with every section
  present and every evidence cell **empty**:
  - header in the HP-5 shape;
  - "The chain under review": every B6 PR (#1566 PRD, #1580, #1581, #1583,
    #1585, #1588, #1590, #1592, and B6-10 through B6-15's numbers as they
    land), `dev` SHA each, in merge order;
  - the Exit-gate map above, with a fourth column "Evidence" empty;
  - the Success-Metrics table (`prd.md:66-75`) with "Actual" and "Evidence"
    columns, the TLS row pre-filled "unmeasured — decision 1" (use the
    question 2 wording verbatim);
  - "Decisions this scorecard records" with the decisions from open questions
    1–5 as proposed, numbered, "open to reversal at signature";
  - "What this hold does not claim": the TLS matrix, certificate rotation,
    memory usage under the profile, and any B6 milestone still pending;
  - the operator task list T1–T10 (Task 3) with the **pass criterion per
    task written now**;
  - "Signed:" empty.

  Ask B6-10 (if not yet merged) to publish CPU throttling and memory from
  its constrained-leg artifact so E5's "resource" clause has a producer; if
  B6-10 is merged without it, E5 reads "memory not measured" in the
  not-claimed section rather than being re-run.

- **Why**: the capacity rule (`docs/capacity.md:6-10`) applied to a hold:
  criteria chosen after seeing the stranger struggle are criteria chosen to
  pass. The commit order is the audit trail.
- **Mirror**: `hp-5-scorecard-2026-09-05.md:1-60` for the header and chain;
  `hp-4:431-451` for the not-claimed section.
- **Validate**: `npm run format` clean; the skeleton's commit precedes the
  record's first commit in `git log docs/plans/hp-6-*`.

### Task 2: Choose and brief the unfamiliar owner, build their sandbox

**Fallback when no VMs or second person are available**: run every step
yourself on the local machine as a model-only dry run, record each result in
the scorecard with the suffix `(model dry run, owed before B10)`, and list the
owed items in the PR description. The gotcha below explains why this is not
equivalent; it is still the required output when the real run is impossible.

- **Action**: per open question 1's answer, the stranger is either a named
  person with ordinary sysadmin skill and no OwnCord history, or a fresh
  Claude session. Either way their inputs are **exactly**:
  - the RC's release assets (all four server archives, the two image tags,
    `checksums.sha256`, the `.minisig` files, the source snapshot's `docs/`
    directory only — no `Server/`, no `Client/src`);
  - the released desktop client installer, as a black box;
  - two machines or VMs: one Linux x64 (Docker installed, systemd), one
    Windows x64 (NSSM available); a router or equivalent they can port-forward
    on, or a note that T4 runs against a simulated topology;
  - a recorder — a second person or session — who logs but does not answer.

  The **brief**, verbatim in the record: "Deploy this server from the
  documentation you have. Ask no one. When you are stuck for more than ten
  minutes, say so, say which page you were on, and move to the next task.
  Do not read source code." The recorder logs wall-clock time per task, every
  page consulted, every stall and its cause, and every point where the
  stranger did something the documentation did not say to do.

  A third reader is briefed as the adversary (the B5 pattern, `:1307`): after
  the run, they read the transcript assuming the stranger was helped or read
  source, and either find it or sign that they did not.

- **Why**: "an owner unfamiliar with the code deploys each mode from current
  documentation" (`roadmap:859-861`) is only evidence if unfamiliarity and
  documentation-only are both enforced and both audited.
- **Gotcha**: a fresh Claude session given `docs/` will read every file in
  seconds and never "stall" the way a person does; if that is the choice, the
  stall criterion becomes "the documentation did not contain the instruction
  the model needed and it either invented one or stopped", and the record says
  which. The two are not comparable and the scorecard names the choice.
- **Validate**: the record's first section lists the inputs by file name and
  hash, and the brief verbatim, before T1 starts.

### Task 3: The run — ten tasks, each with its pass criterion and failure stage

- **Action**: the stranger runs, in order; the recorder writes. Pass criteria
  were committed in Task 1. "From the docs" means `docs/quick-start.md`,
  `docs/deployment.md`, `docs/port-forwarding.md`, `docs/trust-model.md`,
  `docs/server-configuration.md`, `docs/capacity.md`,
  `docs/architecture/diagnostics.md` and whatever else the snapshot's `docs/`
  holds.

  | Task | What the stranger does                                                                                                                                                                                                                                                                                                                       | Pass criterion                                                                                                                                                                                                                                                                                                                                           | Stage / source                                                                                                                    |
  | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
  | T1   | Standalone Linux x64: verify the checksum and signature, install, run under systemd (`deployment.md:203-233`), complete first-run setup, connect one desktop client, accept the fingerprint, send a message                                                                                                                                  | Server healthy (`/health` `ok`), owner account created, message delivered; the stranger compared the fingerprint out of band because the docs told them to (`trust-model.md:27-33`)                                                                                                                                                                      | None                                                                                                                              |
  | T2   | Standalone Windows x64 under NSSM (`deployment.md:235-260`), same steps                                                                                                                                                                                                                                                                      | Same                                                                                                                                                                                                                                                                                                                                                     | None                                                                                                                              |
  | T3   | Docker: compose on a named volume (`deployment.md:53-171`), `config.yaml` read-only mount, same steps; then `docker compose pull` + `up -d` to the same tag (a no-op upgrade)                                                                                                                                                                | Healthy via `.State.Health`; data survives the recreate; the stranger did **not** try to change a startup setting from the admin panel after reading `:672-682`, or did and understood the `ERROR` line                                                                                                                                                  | None                                                                                                                              |
  | T4   | Port-forward one install; read `port-forwarding.md`; turn on `server.reachability_report_enabled`; read `/api/v1/diagnostics`; state in their own words which of the five limits apply to their network and what the server cannot know                                                                                                      | A remote client connects, **or** the stranger names the limit that stops it (CGNAT/blocked port/…) using the doc's check, not a guess; they can say why "the server never verifies inbound reachability" (`port-forwarding.md:180-182`)                                                                                                                  | Optional: recorder blocks the forwarded port mid-task; stranger must diagnose from `:103-114`                                     |
  | T5   | Answer five questions in writing from `trust-model.md` alone: who can read messages; is media E2EE and against whom; why the desktop shows a fingerprint; whether a raw public IP gets HTTPS in this build; what the operator must back up beside the database                                                                               | Five correct answers (the BPR-051 shape, `trust-model.md:549-551`); the fourth answer says "no" (`port-forwarding.md:168-172`); the fifth names `uploads/`, the three key files and `erasure/`                                                                                                                                                           | None                                                                                                                              |
  | T6   | Backup and restore, both kinds: `POST /admin/api/backup`, delete a message, restore that backup through the endpoint, observe the restart notice; then stop, take the archive (`deployment.md:440-552`), delete `data/` entirely, restore the archive, start                                                                                 | Endpoint restore: the message is back, `pre_restore_*` exists. Archive restore: every attachment still downloads, 2FA still works for a user who enabled it before, the erased test account (below) stays erased                                                                                                                                         | B6-11 phase R recipe: erase an account after the backup and before the restore; pass = the marker replays and the account is gone |
  | T7   | Rotate trust: (a) regenerate the self-signed certificate — the docs say how or the stranger works out "delete `cert.pem`/`key.pem`, restart" from `deployment.md:540-547`; connect the client; handle the mismatch; (b) rotate `push_vapid.key`; (c) change the LiveKit API secret; (d) decide what to do about `totp.key` and `erasure.key` | (a) client reconnects only after an explicit re-trust, and the stranger can say what the mismatch meant; (b) server boots, log says subscriptions invalidated; (c) voice still joins after restart; (d) the stranger **declines** to rotate them and says why (`:516-534`)                                                                               | The mismatch is the stage. Record the exact re-pin path the client offered (Unknown row)                                          |
  | T8   | Interpret failure, four stages, each staged by the recorder on the stranger's install: low disk (fill until under `server.min_free_disk_mb`); SFU child killed; `config.yaml` with a syntax error; the marker file removed before a restore                                                                                                  | For each, the stranger names the cause from what the server showed — `degraded/disk` + 507; `livekit_health: false` in diagnostics; the exit message's file and line; whatever B6-11 decided for the missing marker (its question 1) — resolvable only after B6-11 merges; if it has not, mark T8 `unverified (B6-11 unmerged)` — without reading source | B6-11 phases D, S, C, R step 6; the expected symptom per stage is written in the scorecard before staging                         |
  | T9   | Update and roll back: on a fresh install of the **previous** release (`v1.2.0-alpha.4`, the newest tag before the RC), apply the in-place self-update **to** the RC from the admin panel (`deployment.md:772-807`), verify the version changed; then roll back per `deployment.md:587-642` to the archive from T6                            | Version changes and changes back; the stranger removed `data/` before restoring it rather than merging (`:611-617`); the old binary starts on the restored install                                                                                                                                                                                       | `upgrade-rehearsal.yml` (`-upgrade -from`) is the automated twin; this is the human one                                           |
  | T10  | Produce a support bundle from the admin panel (`diagnostics.md:199-204`), preview it, and say what it contains and what it does not                                                                                                                                                                                                          | A bundle downloaded; the stranger can state it never left the machine and names one thing redacted                                                                                                                                                                                                                                                       | None                                                                                                                              |

  Every stall is classified on the spot as one of: **doc gap** (the
  instruction does not exist — B6-13 row), **doc wrong** (it exists and is
  false — B6-13 row, plus a ledger finding if the server misbehaves), **server
  defect** (the docs are right and the server did not do it — ledger finding,
  the drill or step as reproduction), or **stranger error** (the docs said it
  and they missed it — recorded, not a finding, but three of the same kind is
  a doc-structure finding).

- **Why**: `roadmap:859-862` verbatim: deploy each mode, understand limits,
  recover a backup, rotate trust, interpret failure. Ten tasks are the five
  clauses made concrete, with the deployment modes that exist (`prd.md:138-139`).
- **Gotcha**: T6's archive restore and T9's rollback share the archive; take
  it once, in T6, and label it. T9 needs a predecessor to update **from**:
  the RC is the newest release, so nothing is newer than it — the stranger
  installs `v1.2.0-alpha.4` first (its assets are still published) and the
  RC is the update target; the T6 archive was taken on the RC, so rolling
  back to it after the update is a same-version restore of a known state —
  say so in the record. T7(a) on Docker regenerates inside the volume
  — the stranger must find where `data/` lives in the container
  (`deployment.md:134-138`). T8's disk stage on Windows has no tmpfs; fill a
  small VHD or skip with "not staged on Windows", never "passed".
- **Validate**: the record has ten sections, each with outcome, wall clock,
  pages consulted, stalls with classification; the adversary's sign-off is
  appended.

### Task 4: Fill the scorecard

- **Action**: with the record and every milestone's evidence:
  - Exit-gate map: each row's Evidence cell gets the PR, the run id, the test
    name or the record section (T-number). Deferred rows keep "no producer —
    decision 1" (the question 2 default, unless overridden); pending rows say
    "pending, not signed around" or "signed around — decision n" per the
    owner;
  - Success-Metrics Actuals: the capacity.md numbers by run id; the tag-run id
    for the artifact matrix; "n of 10 tasks completed from docs alone, m
    stalls: k doc gaps, j doc-wrong, i server defects" for usability;
  - the roadmap phase-scorecard rows B6 owns (`:1315-1336`), as a table in the
    scorecard: 250/100/25 profile met (run ids), upgrade/rollback/restore green
    (rehearsal run id + T6/T9);
  - "What this hold does not claim": the four TLS network modes, certificate
    rotation with margin, memory under load (if unproduced), any pending
    milestone, and the honest sentence about who the stranger was;
  - ledger rows for every server defect from Task 3; the record's B6-13 rows
    listed under a "Documentation findings" heading so the docs PR that follows
    has its worklist.
- **Why**: a hold that cites a milestone's row without the run id is the
  HP-4 "row-level evidence" problem again.
- **Validate**: `node .superpowers/render-ledger.mjs --check`;
  `npm run check:docs` (the doc-count checker reads status enumerations —
  write "k doc gaps" in prose, not as `<n> open`, or it is misread as a ledger
  claim, `scripts/check-doc-counts.mjs:20-30`).

### Task 5: Decisions, PR, signature, hand-off

- **Action**: PR from `docs/hp-6-scorecard` to `dev` titled
  `docs(hp-6): operator and capacity acceptance scorecard`. The description
  lists the decisions by number and says which rows are unmeasured. The owner
  reverses a decision by editing the file before merging; the merge is the
  signature. After merge, a one-line follow-up fills the "Signed:" line with
  the PR number and SHA, as HP-5 did. Then: PRD HP-6 row → `complete` with the
  link. `docs/plans/README.md`'s B6 line is **not edited here** — B6-16 owns
  it; this task hands B6-16 the sentence verbatim (in the PR description and
  the PRD row): `**B6 ACCEPTED at HP-6 <date> (#<pr>), with the TLS block
(B6-3 – B6-5) deferred to the release as an accepted limitation.**`, plus
  which register and roadmap lines the scorecard's decisions changed (the
  TLS deferral wording, the stale HP-4 support-bundle statement, the
  B6-1/B6-2 "awaits a tag run" rows now closed by the RC run).
- **Why**: `hp-4:308-310`, `hp-5:Signed` — the mechanic that has worked five
  times.
- **Validate**: `gh pr view --json mergedAt,mergeCommit`; the Signed line
  names that SHA; B6-16's plan lists the hand-off items.

## Validation

```bash
# gate — against the tag SHA, not dev
for s in <b6-11-sha> <b6-13-sha> <b6-14-sha> <b6-15-sha>; do git merge-base --is-ancestor "$s" <tag-sha> || echo "not in the RC: $s"; done
gh run view <release.yml run id for the RC tag> --json conclusion,jobs   # gate-evidence green
sha256sum Server/testdata/snapshots/v1.2.0-alpha.4.sqlite
go test -C Server -count=1 -run 'TestAlphaProfileByteIdentical' ./internal/alphasnap/
# the stranger's inputs are the tag's, not the tree's
tar -tzf owncord-src-<tag>.tar.gz | grep '^[^/]*/docs/' | wc -l
# order of commits: skeleton before record
git log --format='%h %s' -- docs/plans/hp-6-scorecard-*.md docs/plans/hp-6-operator-record-*.md
# docs + ledger
npm run format && npm run check:docs && node .superpowers/render-ledger.mjs --check
# → ci-check skill (docs-only branch, but the gate is the gate)
```

## Risks

| Risk                                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B6-12 slips and there is no tag run, so E1/R1/R6 cannot be evidenced                                 | Medium     | High   | Task 0 is a hard stop; the scorecard is not opened against `dev`. The PRD row stays `pending` with the reason                                                                                   |
| The stranger is quietly helped, and the record is fiction                                            | Medium     | High   | The recorder does not answer; the adversary reads the transcript for it; the brief is verbatim in the record                                                                                    |
| A fresh Claude session is chosen and its "stalls" mean nothing a person would recognise              | High       | Medium | Question 1 names the trade; if chosen, the record's stall criterion is the model-specific one and the scorecard says the human run is owed before beta (B10 repeats every verification anyway)  |
| The TLS row is read as "passed" because the other rows are green                                     | Medium     | High   | The row reads "unmeasured — decision 1" in the Success-Metrics table, the Exit-gate map and the not-claimed section; three places, same words                                                   |
| T7(a) has no documented re-pin path and the stranger edits `certs.json` by hand                      | Medium     | Medium | That is the finding; recorded as doc gap + product question for B7 (the client owns the modal), not scored as a stranger error                                                                  |
| T8's staged failures are staged wrong and the stranger diagnoses the recorder's mistake              | Medium     | Medium | Each stage's expected symptom is written in the scorecard first, and the recorder confirms the symptom before the stranger looks                                                                |
| Doc findings from the run are fixed in the same PR, so the docs measured are not the docs published  | Low        | High   | HP-6 edits no operator doc; findings go to a follow-up docs PR after signature, and the record cites the source snapshot's `docs/`                                                              |
| The tag is cut before B6-13 (owner overturns B6-12 question 4), so the stranger reads pre-B6-13 docs | Low        | Medium | Task 0 item 1 refuses a tag that predates B6-13; if the owner overturns it, the record says so and the owner decides at signature whether B6-13's docs need a second, smaller run (T5, T8, T10) |
| The record contains a secret (a token, a fingerprint that is also the RC's cert)                     | Low        | Medium | The recorder redacts tokens; a self-signed fingerprint of a throwaway install is not sensitive, but the LiveKit secret from T7(c) is, and is never written                                      |
| The `check:docs` count checker misreads "k doc gaps / j server defects" as a ledger claim            | Medium     | Low    | Prose, not `<n> <status>` pairs (`check-doc-counts.mjs:20-30`)                                                                                                                                  |

## Out of scope

- **Fixing anything the run finds.** Doc gaps → a follow-up docs PR (or B6-13
  if still open); server defects → ledger rows with their own PRs. The hold
  measures; it does not repair.
- **The four TLS network modes and certificate rotation with margin** —
  deferred with B6-3/4/5. HP-6 records the decision, not the work.
- **A second release candidate.** If the RC fails a task badly enough that the
  owner wants a fix in it, that is a new tag, a new Task 0, and a new run —
  not an amended scorecard against a moved target.
- **Scoring the desktop client.** It is used as a black box for T1–T3 and T7;
  what its modal says is recorded, not judged (B7).
- **Editing the roadmap or the register.** B6-16.
- **B10's repetition.** Every verification here is repeated against the
  immutable release candidate in B10 (`beta-requirements-traceability-2026-08-23.md:19-21`);
  HP-6 acceptance claims nothing about beta readiness, as every scorecard
  before it said.

## Open questions for the owner

1. **Who is the unfamiliar owner?** A real person with sysadmin skill and no
   OwnCord history is the honest reading of `roadmap:859` and the only one
   whose stalls mean what the metric means. A fresh Claude session with only
   the tag's `docs/` is cheap, reproducible and available tonight, but it
   does not stall like a person and reads every page at once. Unless the
   owner overrides before Task 2 starts, apply: **a person for T1–T3, T6, T7
   and T9** (the hands-on tasks), and
   accepts a fresh session for T4, T5, T8 and T10 **only if no person is
   available**, with the scorecard saying which tasks were which. If no person
   is available at all, the record is a model run and the human run is
   recorded as owed before B10.
2. **The TLS Success-Metrics row: accepted limitation, or wait?** The PRD
   makes this the owner's call at the hold point (`prd.md:173-177`). Unless
   the owner overrides before Task 1 starts, use this wording verbatim: "TLS
   mode matrix — unmeasured.
   B6-3, B6-4 and B6-5 are deferred to the release (owner decision 2026-09-11);
   E2, R2 and the TLS half of R3 have no producer and are carried to the
   release as B6-3/4/5's own exit evidence. `docs/port-forwarding.md:164-182`
   and `docs/deployment.md:831-836` tell operators so." The alternative —
   waiting — holds B7 on certificate work the owner already moved out of
   this phase.
3. **Can HP-6 sign with B6-10 or B6-11 pending?** The roadmap only names
   B6-14 and B6-15 as "before HP-6". Decision taken for planning
   (2026-09-15, with B6-12 question 4), open to the owner's reversal: the RC
   tag is cut only after B6-11, B6-13, B6-14 and B6-15 are on `dev`, so all
   four are in the tag by construction (Task 0 item 1 checks each against
   the tag SHA) — B6-11 because T6 and T8 are its recipes and E6 has no
   other producer, B6-13 because the stranger reads its docs. B6-10 alone
   may be signed around, with E5's operational clause marked pending, since
   the 250/100/25 profile itself is met by B6-9. Reversing this means an
   earlier tag and a second run for whatever it lacked.
4. **Does "rotate trust" require a `totp.key` rotation path to exist?** None
   does (`deployment.md:516-524`). This plan proposes no: the task is that the
   stranger reads and declines. If the owner wants a rotation path (re-encrypt
   every stored secret under a new key), it is a B6+ feature with its own
   plan, not a hold-point finding.
5. **The stall threshold.** Ten minutes is proposed as "stuck". A lower
   number produces more doc findings; a higher one hides them. The number is
   written in the brief before the run and not changed after.

## Acceptance

Ticked only where the evidence exists in the scorecard or the record; the
scorecard's Signed line is the last tick.

- [ ] Task 0's five header lines filled: RC tag, `dev` SHA, `release.yml` run
      id with `gate-evidence` green, alpha-snapshot hash, fixture file — and
      B6-11, B6-13, B6-14, B6-15 ancestors of the **tag** SHA; B6-10 in the
      tag or recorded as signed around
- [ ] The scorecard skeleton, the ten pass criteria and the staged-failure
      symptoms are committed **before** the record's first entry (`git log`
      order)
- [ ] The stranger's identity, inputs (by file and hash) and the verbatim
      brief are in the record; the adversary's transcript audit is appended
- [ ] T1–T3: three deployment modes stood up from the docs alone, each with a
      client connected through the fingerprint prompt
- [ ] T4 + T5: the network and trust limits stated correctly in the
      stranger's words, with the raw-public-IP answer "no"
- [ ] T6: endpoint restore and archive restore both done; the post-backup
      erasure stays erased after the restore
- [ ] T7: self-signed certificate regenerated and the client re-trusted
      through a recorded path; `push_vapid.key` and the LiveKit secret
      rotated; `totp.key` and `erasure.key` left alone on purpose
- [ ] T8: four staged failures each named from the server's own output
- [ ] T9: update applied and rolled back to the T6 archive, `data/` replaced
      not merged
- [ ] T10: a support bundle produced and described
- [ ] Every stall classified (doc gap / doc wrong / server defect / stranger
      error); server defects in the ledger; doc findings listed for the docs
      PR
- [ ] Exit-gate map filled: every row has evidence, "no producer — decision
      1", or "pending" — none blank
- [ ] Success-Metrics Actuals filled; the TLS row reads the owner's decision
- [ ] "What this hold does not claim" names the TLS matrix, certificate
      rotation, memory under load (if unproduced) and who the stranger was
- [ ] PR `docs/hp-6-scorecard` merged by the owner; Signed line names the PR
      and SHA; PRD row `complete`; B6-16 handed the README sentence and its
      list
