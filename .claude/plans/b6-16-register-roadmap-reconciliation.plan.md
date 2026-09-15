# Plan: B6-16 — Register and roadmap reconciliation

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-16 — Register and roadmap reconciliation (PRD row `:154`, roadmap workstream "exit")
**Satisfies**: the PRD outcome "The issue register and roadmap match what B6 actually shipped" (`prd.md:154`); the traceability rule that the primary phase "records the first acceptance evidence" (`beta-requirements-traceability-2026-08-23.md:14-15`); B5-12's precedent that a phase's bookkeeping is one dated PR, not silent edits in later ones (`b5-community-content-moderation-2026-09-04.md:2796-2830`)
**Complexity**: Small (documents only; the work is an inventory and exact wording)
**Drafted**: 2026-09-15 at `dev` `96258158`. Runs **after HP-6 signs** — it records what shipped, so it cannot run before the last thing ships. A first pass may run earlier for the rows already stale (Task 1's "stale today" column); the final pass is at the exit SHA, as B5-12's carryover demanded (`b5:2802-2810`)

## Summary

B5-12 established the shape: for every register row the phase touched, open
the cell with `**Fixed** — ledger `fixed`, closed by <step> (#pr, `sha`),
test <name>` verbatim from the ledger; for every roadmap workstream the phase
narrowed, refuted or deferred, an in-place dated amendment
`_(amended <date> by B6-16 …)_` (`roadmap:706,710,730,734` are the B5-12
examples); for every traceability row, a landing sentence in the style of
BPR-013's (`traceability:59`). Preserve signed decisions and historical
evidence blocks; never count a merged implementation as an accepted exit
(`b5:2806-2809`).

What B6-16 reconciles, and the source of truth for each:

| Surface                                                | Rows in scope                                                                                                  | Truth                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Roadmap `## B6` workstreams 1–18, HP-6, exit, evidence | `roadmap:774-887`                                                                                              | The PRD milestone table (`prd.md:136-154`) and the HP-6 scorecard's Exit-gate map |
| Issue register `OC-*` rows tagged B6                   | OC-0320, 0331, 0332, 0339, 0344, 0346, 0350, 0353, 0355, 0361, 0364, 0367, 0373 (`register:124-177`)           | `.superpowers/findings-ledger.json` `status` and `fix.*`                          |
| Register work packages tagged B6                       | S-07, S-14, S-17 (`:233-243`); R-04, R-07, R-09 (`:252-257`); BG-06, BG-15, BG-20 (`:300-314`)                 | The PRs that landed each, or the deferral                                         |
| Traceability rows B6 owns                              | BPR-011, 012, 013, 014, 015, 016, 030 (`traceability:57-62,79`); BPR-053 (`:105`, B6-15's)                     | B6-1/2/6/8/9/12 PRs; B6-15 for BPR-053; the TLS deferral                          |
| `docs/plans/README.md` status lines                    | `:22` (roadmap: "B5 is next… B6–B10 not started"), `:36` (PRD: "B6 NOT STARTED", amended 2026-09-11)           | The PRD table and the HP-6 signature                                              |
| The PRD's own internal contradictions                  | `prd.md:138` vs `:225-231` (B6-1 complete vs stays in-progress); `:33-40` and `:122-126` (workstream 13 stale) | The RC tag run                                                                    |

No ledger rows are added — this is bookkeeping, not a hunt (`b5:2798-2800`).

## Verify before you implement

Facts established from source at `96258158`. Every row is something a
reader of the register, roadmap or traceability document would believe today
and that is already, or will be at the exit, wrong.

| Claim                                                                             | Status        | Evidence                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Roadmap workstream 13's four ARM64 defects are open                               | **Refuted**   | `roadmap:819-823` lists OC-0320, 0332, 0344, 0339 as "must-close before any ARM64 server asset ships"; the ledger has all four `fixed`; the PRD already records them as a satisfied precondition (`prd.md:33-40,122-126`). The roadmap item carries no amendment                                                                                 |
| The register rows for those four say they are fixed                               | **Refuted**   | `register:124` (OC-0320), `:136` (OC-0332), `:143` (OC-0339), `:148` (OC-0344) carry only the original acceptance text. Compare `:150` (OC-0346), which B3-9 annotated `**Fixed 2026-08-30, PR #1454**` — the shape to copy                                                                                                                      |
| The admin-panel batch rows (OC-0331, 0350, 0355, 0361, 0364, 0367, 0373) are open | **Refuted**   | All seven `fixed` in the ledger; rows `:135,154,159,165,168,171,177` carry no closure. OC-0350's row still reads "rides the admin-panel batch". Phase tags `B6/B9`; the closing PR must be found (`git log -S` on the ledger's `fix.commit`) — Unknown which PR, Task 1 finds it                                                                 |
| OC-0353 (LiveKit proxy Origin) closes "in the B6 deployment rehearsal"            | **Corrected** | Row `:157` says so; ledger `fixed`. B6-8's rehearsal (#1590) does not drive a reverse-proxy voice join (`b6-8 plan` acceptance `:343-385` names none). The row's closure text should cite the fix's own test, not a rehearsal that did not run it                                                                                                |
| R-09 is a B1/B10 row                                                              | **Corrected** | `register:257` phase `B1/B10`; roadmap workstream 15 (`:827-830`) says "B6 rehearses one tag against both before HP-6". Once B6-12 lands, R-09's row gains a B6 landing sentence and phase `B1/B6/B10`; until then the roadmap and register disagree                                                                                             |
| S-14 (no published capacity result) is still `confirmed`                          | **Refuted**   | `register:240`; B6-9 (#1592) published the 250/100/25 result in `docs/capacity.md:211-256` with runs 34701291805 and 34701991385. S-14 → `resolved/superseded` with the run ids (the vocabulary has no bare `resolved`, `register:62-64`); S-07's "reference load baselines" half is met by the same, its microbenchmark half by B3-6 (#1459)    |
| BG-15 (support bundle) is unbuilt                                                 | **Refuted**   | `register:309` generic; HP-4's exit said "The support-bundle endpoint is not built" (`hp-4:437-439`); `Server/admin/api.go:234-235` routes preview and download; `docs/architecture/diagnostics.md:149-204` documents the contract. Which PR landed it is **Unknown** — Task 1 runs `git log -S'support-bundles' --oneline`                      |
| BG-06 and BPR-014/015/016 can be closed by B6                                     | **Refuted**   | All four are the TLS block; B6-3/4/5 deferred (`prd.md:164-177`). BPR-014 already reads "Blocked on B6-3 (2026-09-11)" (`traceability:60`); BPR-015 (`:61`), BPR-016 (`:62`) and BG-06 (`register:300`) carry nothing. They get the same blocked sentence, dated, pointing at the HP-6 decision                                                  |
| BPR-011 and BPR-030 carry their landing evidence                                  | **Refuted**   | `traceability:57` (BPR-011) and `:79` (BPR-030) are the original acceptance text only, while BPR-013 (`:59`) shows the landed shape. BPR-011: B6-1 (#1580), B6-2 (#1583), the RC tag run; BPR-030: B6-9 (#1592) run ids, B6-10's operational rows                                                                                                |
| BPR-012 ("independently owner-hosted") is B6's to evidence                        | **Confirmed** | `traceability:58`; the HP-6 operator record (T1–T10 from docs alone, no OwnCord service) is the first acceptance evidence; the no-central-dependency capture is B4-8's `TestNoAutomaticTelemetry_Capture` (`traceability:107`, BPR-055). The row cites both                                                                                      |
| `docs/plans/README.md` describes B6 truthfully                                    | **Refuted**   | `:36` opens "**B6 NOT STARTED**" with a 2026-09-11 amendment about B6-1 only; `:22` says "**B5 is next**… B6–B10 not started". Seven B6 PRs are merged (#1580, #1581, #1583, #1585, #1588, #1590, #1592)                                                                                                                                         |
| The PRD is consistent about B6-1                                                  | **Refuted**   | `prd.md:138` `complete`; `:225-231` "stays `in-progress` until the first tag run proves the three unchecked acceptance rows"; the plan's rows `b6-1 plan:220-224` unchecked. Resolved by the RC tag run HP-6 cites; B6-16 rewrites `:225-231` to "proved by run <id>" or, if not, flips `:138` back                                              |
| `docs/quick-start.md`'s platform table is current                                 | **Refuted**   | `quick-start.md:13-18` "Linux ARM64 — Not published yet"; B6-1 added the asset to the release matrix (#1580). True until the RC tag publishes; false after. B6-12 Task 6 owns the row (it flips with the tag; B6-13's Files table does not list it) — B6-16 **flags** it in the inventory and edits it only if B6-12 has closed without doing so |
| Roadmap exit bullets and evidence bullets can all be marked met                   | **Refuted**   | E2, R2, the TLS half of R3 and the "certificate rotation" clause of E6 have no producer (HP-6 plan, Exit-gate map). They are amended in place as deferred, citing the HP-6 decision — never deleted                                                                                                                                              |
| The roadmap "Phase scorecard" is filled by B6-16                                  | **Refuted**   | `roadmap:1315-1336` says the values "belong in phase evidence, not as optimistic edits to this plan". The HP-6 scorecard carries them; B6-16 leaves the table and adds one line to "Current implementation slice" (`:1338`)                                                                                                                      |
| `npm run check:docs` catches a wrong status count                                 | **Confirmed** | `scripts/run.mjs:161` runs `check-doc-counts.mjs`, which reads `<n> <status>` enumerations (`check-doc-counts.mjs:20-30`). Any count B6-16 writes must match the ledger at the exit SHA                                                                                                                                                          |
| B5's exit is signed, so "server behaviour through B5 is feature-complete" holds   | **Unknown**   | `README.md:35` says B5-10 "is being finished" and the exit "remains open"; `prd.md:14-17` assumes B5 complete; the HP-5 scorecard has no "B5 exit" section (grep). B6's entry gate (`roadmap:769`) depends on it. **Out of B6-16's scope** — B5-12's final pass owns it — but the B6 README line must not claim a B5 exit that is not recorded   |

### What the corrections change

- **Two kinds of stale, two kinds of fix.** Rows the ledger already closed
  (twelve of the thirteen `OC-*` — every one except OC-0346, which already
  carries B3-9's `**Fixed**` prefix) get the B5-12 `**Fixed** —` prefix with ledger fields
  verbatim; rows the phase deferred (BG-06, BPR-015/016, workstreams 3 and 5,
  E2, R2) get a dated `_(deferred …)_` sentence pointing at the HP-6 decision.
  Nothing is deleted or re-tagged without the written reason rule 2 requires.
- **The order matters.** The `OC-*` and S-14 rows are stale today and can go
  in a first pass; the traceability landings, the README lines and the
  roadmap exit amendments wait for HP-6's signature, because the wording
  cites its decisions and the RC run id.

## Patterns to Mirror

| Category                      | Source                                                       | Pattern                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed-row prefix              | `register:150` (OC-0346), B5-12's five rows (`b5:2833-2845`) | `**Fixed <date>, <step> (#pr, `sha`):** <what the fix does>; pinned by <test>` — ledger fields verbatim, the PR found by `gh pr view --json commits` when `git log --grep` misses |
| Roadmap amendment             | `roadmap:706,710,730,734`                                    | `_(amended <date> by B6-16, <decision or PR>)_` inline, after the original text, never replacing it                                                                               |
| Traceability landing sentence | `traceability:59-60` (BPR-013 satisfied; BPR-014 blocked)    | `**Satisfied by <step> (<date>)** for <halves>: …` or `**Blocked on <step> (<date>).** …`; what did **not** close stays named                                                     |
| Register re-tag with reason   | `b5:2846-2858` (SEC-03, SEC-04, BG-18/19)                    | Phase cell changes only with the decision or PR that justifies it in the same cell                                                                                                |
| Status-line rewrite           | `README.md:34-35` (B4, B5 lines)                             | Bold verdict first, then dates, PRs and what remains open                                                                                                                         |
| Preserve signed evidence      | `b5:2806-2809`                                               | "Preserve historical evidence blocks and signed decisions; do not count a merged implementation as an accepted phase exit"                                                        |

## Files to Change

| File                                                         | Action | Why                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/repo-health-issue-register-2026-08-23.md`        | UPDATE | Twelve `OC-*` fixed prefixes (all but OC-0346); S-07, S-14 closure; S-17 unchanged unless B6-12 adds scanning; R-04, R-07, R-09 landing sentences from B6-12; BG-06 deferred; BG-15 landed; BG-20 partial (ARM64 shipped, in-place update tests per B6-8)                                                                                    |
| `docs/plans/repo-health-roadmap-2026-08-23.md`               | UPDATE | `## B6` amendments: workstreams 3, 5 (deferred), 13 (satisfied), 14 (closed by `lk load-test`, `prd.md:215-222`), 15 (rehearsed by B6-12), 18 (the sentence B6-15 Task 3 hands off, pasted verbatim); exit bullets E2, E6; evidence bullets R2, R3; one "Current implementation slice" line. B6-16 is the **only** plan that edits this file |
| `docs/plans/beta-requirements-traceability-2026-08-23.md`    | UPDATE | BPR-011, 012, 030 landings; BPR-015, 016 blocked; BPR-053 per B6-15; BPR-013/014 re-read against the HP-6 decision                                                                                                                                                                                                                           |
| `docs/plans/README.md`                                       | UPDATE | `:22` and `:36` rewritten to the post-HP-6 state, from the sentence HP-6 Task 5 hands off; B6-16 is the **only** plan that edits the B6 line                                                                                                                                                                                                 |
| `docs/plans/b6-server-deployment-operations-capacity.prd.md` | UPDATE | B6-16 row → `complete`; `:225-231` B6-1 wording resolved; a dated "Reconciled" note under Evidence                                                                                                                                                                                                                                           |
| `docs/quick-start.md`                                        | UPDATE | Only if B6-12 Task 6 closed without fixing `:13-18` (B6-12 owns the row: it changes with its tag); otherwise a line in the inventory naming it                                                                                                                                                                                               |

`.superpowers/findings-ledger.json` is **not** touched: the ledger is the
truth this step copies from.

## Tasks

### Task 0: Branch and the first-pass boundary

- **Action**: branch `docs/b6-16-register-roadmap` from `dev`. Decide the
  pass: if HP-6 is not yet signed, this is the **first pass** — only the
  "stale today" rows (Task 1's column) are edited, and the PR title says so
  (`docs(b6-16): first-pass register reconciliation for rows the ledger has
already closed`). The final pass is a second PR at the exit SHA.
- **Why**: B5-12's carryover: "initial reconciliation merged… a final pass is
  still owed at the B5 exit SHA" (`b5:2802-2804`). Doing it in two named
  passes is the honest version of that.
- **Validate**: PR title names the pass; PRD B6-16 row `in-progress` with
  this plan linked.

### Task 1: The inventory — every workstream and row, one verdict each

- **Action**: build the table below in the PR description (and as a
  "Reconciled" block under the PRD's Evidence section), one row per item,
  columns: item · verdict (shipped / deferred / refuted / partial / pending) ·
  PR(s) and `dev` SHA · stale today? · exact wording target.

  Workstreams (`roadmap:776-848`): 1 shipped B6-1 #1580 (+RC tag run) ·
  2 shipped B6-2 #1583 (+tag run for the manifest) · 3 **deferred** B6-3/4 ·
  4 shipped B6-6 #1588 (narrowed: reachability and honest limits, no
  public-IP HTTPS) · 5 **deferred** B6-5 · 6 shipped B5-3 #1542 + B6-7 #1585 ·
  7 shipped B6-8 #1590 (ARM64 upgrade not rehearsed, `deployment.md:668-675`) ·
  8 shipped B6-9 #1592 · 9 B6-10 (PR when merged) · 10 B6-11 (PR when merged;
  the byte-level carryover's outcome named) · 11 B6-12 (PR) · 12 B6-13 (PR) ·
  13 **refuted as open** — satisfied precondition, four ledger `fixed` ·
  14 **refuted** — "no harness exists" closed by `lk load-test`
  (`prd.md:215-222`, `Server/scripts/voice-load.sh`) · 15 B6-12's tag run ·
  16 shipped B6-7 #1585 · 17 B6-14 (PR) · 18 B6-15 (PR).

  Register rows: the thirteen `OC-*` (twelve need a `**Fixed**` prefix
  today — OC-0346 already has B3-9's; find each closing PR from the
  ledger's `fix.commit` via `git log --grep` then
  `gh pr view <n> --json commits`, as B5-12 did when `--grep` missed
  three); S-07, S-14 (stale today); S-17; R-04, R-07, R-09 (after B6-12);
  BG-06 (deferred); BG-15 (landed — PR from `git log -S'support-bundles'`);
  BG-20 (partial until the tag run; ARM64 half shipped).

  Traceability: BPR-011, 012, 013, 014, 015, 016, 030, 053 as in the Files
  table.

  Doc lines: `README.md:22,36`; `prd.md:138` vs `:225-231`;
  `quick-start.md:13-18`; `hp-4-scorecard:437-439` (stale support-bundle
  statement — **not edited**, it is a signed document; the register's BG-15
  row says where the endpoint landed instead).

- **Why**: rule 2 "can be checked by reading rather than re-derived"
  (`b5:2818-2820`). The inventory is the evidence the amendments cite.
- **Gotcha**: the ledger's `fix.test` can be a placeholder string; B5-12 hit
  this for three rows and cited the PR instead ("the ledger records no
  path", `b5:2843-2845`). Do the same, never invent a test name.
- **Validate**: the inventory has exactly 18 + 22 + 8 + 5 rows and no
  verdict cell is blank.

### Task 2: The amendments — exact wording per row

- **Action**: apply, in this order, each cell's text fixed before editing:

  **Register `OC-*`** (twelve rows — all but OC-0346): prefix
  `**Fixed <ledger fix.date>, <step> (#<pr>, `<sha>`):** <ledger fix.summary>; pinned by <fix.test or "the tests in #<pr>">.`
  OC-0353's closure clause "reverse-proxy voice join passes in the B6
  deployment rehearsal" is replaced by the fix's own test; phase stays
  `B6/B7` with "(client half B7)" if the ledger says the client side is
  separate.

  **S-14**: State → `resolved/superseded`; closure →
  `**Met by B6-9 (#1592, `26cd9675`), 2026-09-12:** 250/100/25 on 2 vCPU / 4 GB, runs 34701291805 and 34701991385, published in `docs/capacity.md`; operational scenarios B6-10 (#<pr>).`
  **S-07**: closure gains `Benchmarks: B3-6 (#1459); reference load baselines: B6-9 (#1592).`
  **R-09**: after B6-12, phase `B1/B6/B10`, closure gains
  `Rehearsed by B6-12 (#<pr>) against tag <tag>, run <id>, `gate-evidence` green.`
  **R-04, R-07**: the sentence B6-12's plan supplies (pinned digests, SBOM,
  provenance) — or, if B6-12 ships without SBOM/provenance, `**Partial:**`
  naming what is missing.
  **BG-06**: `**Deferred to the release (owner decision 2026-09-11; HP-6 decision 1, <date>):** B6-3 – B6-5 not built; `docs/port-forwarding.md` §"What this build does not do" states the limits. Phase unchanged.`
  **BG-15**: `**Server half landed** (#<pr>): `/admin/api/support-bundles/{preview,download}`, contract in `docs/architecture/diagnostics.md`; HP-6 record T10 is the operator evidence. Client/B9 half open.`
  **BG-20**: `**ARM64 assets and multi-arch images shipped** B6-1 (#1580), B6-2 (#1583); proved on tag <tag> run <id>. In-place alpha upgrade and rollback rehearsed by B6-8 (#1590); ARM64 upgrade not rehearsable until one release after (`docs/deployment.md`).`

  **Roadmap `## B6`**: workstream 3 and 5 gain
  `_(deferred 2026-09-11 by owner decision; recorded at HP-6 as an accepted limitation, <date>, by B6-16)_`;
  13 gains `_(amended <date> by B6-16: all four are `fixed` in the ledger — OC-0320 #<pr>, OC-0332 #<pr>, OC-0344 #<pr>, OC-0339 #<pr> — and were re-verified at the RC; a satisfied precondition, not a milestone)_`;
  14 gains `_(amended <date> by B6-16: closed by `Server/scripts/voice-load.sh`wrapping`lk load-test`, B6-9 #1592 — the gap was k6's, not the SFU's)_`;
  15 gains `_(amended <date> by B6-16: rehearsed by B6-12 #<pr>, tag <tag>)_`;
  18 gains B6-15's outcome sentence (whether the trust-model wording moved
  after B6-11's measurement). Exit bullet E2 and evidence bullets R2/R3's TLS
  half gain `_(deferred — HP-6 decision 1; carried to the release as B6-3/4/5's own exit evidence)_`;
  E6's "certificate rotation" clause the same. "Current implementation
  slice" (`:1338`) gains one dated line: B6 accepted at HP-6 on <date>
  (#<pr>), with the deferred TLS block named.

  **Traceability**: BPR-011 `**Satisfied by B6-1 (#1580), B6-2 (#1583) and tag <tag> run <id> (<date>):** four assets and two images from one commit, each through `cmd/smoke` (boot, migrate, health, drain, restart); restore by B6-8 (#1590).`
  BPR-012 `**First evidence at HP-6 (<date>):** the operator record — deployment, registration, login, messaging, backup, restore, update from docs alone with no OwnCord service; no-central-dependency capture is BPR-055's `TestNoAutomaticTelemetry_Capture`.`
  BPR-030 `**Satisfied by B6-9 (#1592, 2026-09-12)** for the profile and p95/p99 rows (runs 34701291805, 34701991385, `docs/capacity.md`); reconnect, DB waits, recovery and restart rows by B6-10 (#<pr>); <memory row per HP-6's not-claimed section>.`
  BPR-015, BPR-016: `**Blocked on B6-3 – B6-5 (deferred 2026-09-11; HP-6 decision 1).**` in BPR-014's shape.
  BPR-053: the sentence B6-15's PR wrote, copied — not paraphrased.

  **README**: `:36` → `**B6 ACCEPTED at HP-6 <date> (#<pr>), with the TLS block (B6-3 – B6-5) deferred to the release as an accepted limitation.** …` listing merged PRs and the two deferred rows; `:22` → B6 complete, B7 next, "B6-3 – B6-5 deferred".

  **PRD**: `:225-231` → "proved by tag <tag> run <id>"; B6-16 row `complete`.

- **Why**: the wording is the deliverable. Every sentence names a PR, a run
  id or a decision so the next reader checks rather than re-derives.
- **Gotcha**: `**Fixed**` rows must not change the `State` column's
  vocabulary (`register:55-64` has no `fixed` state; `OC-*` rows carry
  Severity, not State, `:120-122`). Do not touch a signed scorecard
  (`hp-4:437-439` stays; the register corrects the reader).
- **Validate**: `git diff --stat` touches only the six files in the Files
  table; every `#<pr>` in the diff resolves with `gh pr view`.

### Task 3: The checks and the hand-off

- **Action**: `npm run format`; `npm run check:docs` (every status count in
  an active document agrees with the ledger at this SHA — if B6-16 wrote
  none, it still runs); `node .superpowers/render-ledger.mjs --check`;
  `npm run check:hygiene`. PR to `dev`; after merge, the PRD row `complete`
  and this file linked. If B6-12 is closed and `quick-start.md:13-18` still
  says "Not published yet" after the RC tag, fix it here with the tag named.
- **Why**: the B6-6 plan's acceptance used the same trio (`b6-6 plan:532`).
- **Validate**: all four commands exit 0; `ci-check` skill on the branch.

## Validation

```bash
# the ledger says what the rows will say
node -e "const l=require('./.superpowers/findings-ledger.json');for(const id of ['OC-0320','OC-0331','OC-0332','OC-0339','OC-0344','OC-0350','OC-0353','OC-0355','OC-0361','OC-0364','OC-0367','OC-0373'])console.log(id,(l.findings||l).find(f=>f.id===id)?.status)"
git log --oneline dev | grep -E '\(B6-|#158[0-9]|#159[0-9]'          # the chain
git log -S'support-bundles' --oneline -- Server/admin/api.go          # BG-15's PR
gh pr view <n> --json commits --jq '.commits[].oid' | grep <fix.commit>  # when --grep misses
# docs
npm run format && npm run check:docs && npm run check:hygiene && node .superpowers/render-ledger.mjs --check
# → ci-check skill
```

## Risks

| Risk                                                                              | Likelihood | Impact | Mitigation                                                                                                                                  |
| --------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The final pass runs before HP-6 signs and cites a decision that is then reversed  | Medium     | High   | Two named passes (Task 0); the final pass's PR is opened after the scorecard's merge SHA exists                                             |
| A `**Fixed**` prefix cites a PR the ledger's `fix.commit` is not actually in      | Medium     | Medium | `gh pr view --json commits` per row, the B5-12 method; a row whose PR cannot be found says "ledger `fixed`, commit `<sha>`, PR not located" |
| The TLS deferral wording drifts across register, roadmap, traceability and README | High       | Medium | One sentence, written once in Task 2, pasted four times; `grep -c 'HP-6 decision 1'` equals the expected count                              |
| B6-12 ships without SBOM/provenance and R-07/E7 get marked met anyway             | Medium     | High   | R-07 and E7 read `**Partial:**` naming the missing artifacts; the HP-6 not-claimed section is the source                                    |
| A count written in prose trips `check-doc-counts.mjs`                             | Low        | Low    | No `<n> <status>` enumerations are written; the checker is run before the PR opens                                                          |
| Editing a signed scorecard to fix a stale claim                                   | Low        | High   | Never; the register row corrects the reader and names the scorecard line it supersedes                                                      |

## Out of scope

- **The B5 exit's own reconciliation** — B5-12's final pass; B6-16 only
  refuses to claim it in the README line.
- **Operator-doc edits** other than the one `quick-start.md` row, and only
  if B6-12 left it — B6-13 owns `docs/deployment.md` and
  `port-forwarding.md`; B6-12 Task 6 owns the `quick-start.md` platform row.
- **Ledger edits.** The ledger is copied from, never written to.
- **Re-planning satisfied preconditions** (`prd.md:272`) — workstream 13 is
  amended as satisfied, not reopened.
- **Any roadmap change for B7+.** The B7 entry gate reads HP-6's scorecard;
  B6-16 does not pre-empt it.

## Open questions for the owner

1. **Two passes or one?** This plan proposes a first pass now for the twelve
   `OC-*` rows, S-07 and S-14 (all stale today, all cheap), and the final pass
   after HP-6. One pass at the exit is simpler but leaves the register wrong
   for the weeks in between.
2. **Does B6-16 own the `quick-start.md` platform table?** Proposed: B6-12
   Task 6 does (the row flips with its tag); B6-16 fixes it only if B6-12
   closed without doing so.
3. **R-09's phase cell.** Proposed `B1/B6/B10` after B6-12 (matching
   workstream 15). The alternative is to leave `B1/B10` and let the
   workstream carry the rehearsal note alone.

## Acceptance

- [ ] Inventory table in the PR and under the PRD's Evidence: 18 workstreams,
      22 register rows, 8 traceability rows, 5 doc lines — every one with a
      verdict and a PR/SHA or a named deferral
- [ ] Twelve `OC-*` rows (all but OC-0346) carry
      `**Fixed <date>, <step> (#pr, `sha`)**` with ledger fields verbatim;
      OC-0353's rehearsal clause replaced
- [ ] S-14 `resolved/superseded` with the two run ids; S-07 names #1459 and
      #1592
- [ ] R-04, R-07, R-09 carry B6-12's landing (or `**Partial:**` naming what
      is missing); R-09's phase per question 3
- [ ] BG-06 deferred, BG-15 landed with its PR, BG-20 partial/shipped with
      the tag run id
- [ ] Roadmap workstreams 3, 5, 13, 14, 15, 18 and bullets E2, E6, R2, R3
      amended in place with dated `_(… by B6-16)_` text; nothing deleted
- [ ] BPR-011, 012, 030 landed; BPR-015, 016 blocked in BPR-014's shape;
      BPR-053 carries B6-15's sentence
- [ ] `README.md:22,36` and `prd.md:138/225-231` agree with each other and
      with the HP-6 scorecard
- [ ] `npm run format`, `npm run check:docs`, `npm run check:hygiene`,
      `node .superpowers/render-ledger.mjs --check` all green; `ci-check`
      green
- [ ] PRD B6-16 row `complete` with this plan linked; no ledger edit in the
      diff
