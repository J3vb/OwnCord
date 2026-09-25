# HP-9 — Feature freeze and accessibility acceptance scorecard

**Hold point:** HP-9, defined in
[b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md)
§HP-9 and the roadmap
[repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md), B9.
**Prepared by:** B9-27 ([.claude/plans/b9-27-hp9-freeze-and-exit.plan.md](../../.claude/plans/b9-27-hp9-freeze-and-exit.plan.md)).
**Date:** 2026-09-25.
**Integration SHA:** `origin/dev` `84778e3d0ebbefb503029121379d30f154e92cce`
("feat(admin): apply Refined Neon tokens and accessibility floor to admin panel"),
the current `dev` head when this scorecard was written. Re-read it at the
release PR; `dev` moves with every merged docs lane.
**B9-26 manifest:** [b9-journey-evidence-2026-09-25.md](b9-journey-evidence-2026-09-25.md).
**Owner decisions applied:** Q1–Q13 (2026-09-23; Q1 amended 2026-09-24 and
2026-09-25), and the R0 decisions D-01..D-18 answered by the owner on
2026-09-25 ("approve the recommendations"). This scorecard records those
answers; it does not add a signature the owner has not given.

**Decision: B9 EXIT ACCEPTED 2026-09-25 by the owner** — "all ok" for the B9
lanes and "b9 all ok" for visual acceptance; the recommendations in the
private beta-readiness review (sections 1, 3 and 4) were approved the same day.
The freeze below takes effect from this date. This scorecard claims B9's exit,
not beta readiness: B6/HP-6, B7's `tauri-build` item and B10 remain open.

## What this hold freezes

From this date, the B9 candidate freezes **features, English strings,
protocol and migrations**, per the B9-27 plan Task 3 and the PRD's HP-9
section. The frozen surfaces are:

- the WebSocket message types in `protocol/schema.json` and the generated
  `Server/ws/message_types.go` / `Client/src/lib/protocolTypes.ts`;
- the SQLite schema under `Server/migrations/` (a new numbered migration is
  the only change path; a shipped migration is immutable);
- the English catalogs under `Client/src/i18n/` and the shrink-only
  `Client/scripts/ui-strings-baseline.json`.

A necessary beta-blocker fix that lands after the freeze takes a focused PR
with fresh exact-SHA evidence and the explicit freeze-impact note the plan
requires; a new feature does not enter. The first post-freeze change is the
owner-approved **admin-panel overhaul** (lanes AO-1..AO-8, "Refined Neon",
`Server/admin/static`, admin UI strings and styles only) — see the freeze-impact
note at the end.

## B9-26 manifest and native journey J

B9-26 merged as [#1797](https://github.com/J3vb/OwnCord/pull/1797)
("test(client): qualify B9-26 cross-feature desktop journeys") at `dev`
`a685929c`. Its evidence manifest records nine fullstack journeys (A–I) on a
real Go server plus one native journey (J):

- The fullstack half passed 9/9 at journey head `66da915a`, then passed again
  in CI at the review head `e485deea` in run
  [36127046517](https://github.com/J3vb/OwnCord/actions/runs/36127046517):
  the `Client E2E (real server and media)` job reported success.
- Journey J (native Windows WebView2 external-content consent, broker and
  destination confinement) is selected by `playwright.config.native.ts`
  `native-core`, which the `client-native` job runs. On the same run
  [36127046517](https://github.com/J3vb/OwnCord/actions/runs/36127046517) the
  `Client E2E (Windows native)` job reported **success**, so journey J's
  native half is **PASS**, not NOT RUN.

No green `client-native` run of its own was needed beyond the B9-26 PR run:
the job exists inside `ci.yml` (job `client-native`, "Client E2E (Windows
native)") and ran on that PR. No CI run was triggered by B9-27.

## Exit condition verdicts

Verdicts are PASS / FAIL / NOT RUN on the evidence above. "NOT RUN" marks a
check this docs lane cannot run, not a defect.

| #   | Exit condition (B9 PRD)                           | Verdict  | Evidence                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Approved desktop journeys complete                | **PASS** | B9-26 journeys A–I (fullstack, real server) and J (native), run 36127046517; [manifest](b9-journey-evidence-2026-09-25.md).                                                                                                                                                                                                          |
| 2   | Consent and authorized disclosure preserved       | **PASS** | Journeys C, H, J plus per-lane `b9-nsfw-consent.spec.ts`, `b9-content-consent.spec.ts` (mock and native) and fullstack `nsfw-consent.spec.ts`.                                                                                                                                                                                       |
| 3   | No accessibility release blocker                  | **PASS** | Automated per-lane ARIA/keyboard/focus evidence; B9-26 journey I (940×500, 20 px, contrast, keyboard, reduced motion); automated 200 % zoom reflow in `Client/tests/e2e/b9-zoom.spec.ts`; `b9-responsive-nav.spec.ts` pins the drawer journey. Manual screen-reader check dropped and OS 200 % zoom automated (owner 2026-09-24/25). |
| 4   | Visual identity updated to Q13 without regression | **PASS** | Refined Neon token PR and per-lane application B9-2/B9-21..24; owner visual acceptance given 2026-09-25 ("b9 all ok").                                                                                                                                                                                                               |
| 5   | Translation-ready English                         | **PASS** | B9-3/B9-18/B9-19/B9-20 text seam and catalogs; `Client/scripts/check-ui-strings.mjs` and `Client/tests/unit/ui-strings.test.ts`; `b9-text-expansion.spec.ts`.                                                                                                                                                                        |
| 6   | Honest capabilities                               | **PASS** | B9-25 ([#1795](https://github.com/J3vb/OwnCord/pull/1795)); journey F (network loss and recovery) and J.                                                                                                                                                                                                                             |
| 7   | Performance and engineering gates preserved       | **PASS** | Bundle budgets re-baselined downward at B9-26 (MainPage 64,000→63,500 B; livekit 135,000→134,500 B; startup 97,000 and livekitSession 24,000 unchanged); `npm run check:client` green on the B9-26 PR.                                                                                                                               |
| 8   | Lifecycle/compatibility complete                  | **PASS** | Journeys B, D, E, F (retention/erasure, session displacement, recovery, reconnect) plus `long-session` CDP soak in the `client-fullstack` gate.                                                                                                                                                                                      |
| 9   | Status and owner acceptance agree                 | **PASS** | PRD/README/traceability/register updated by this lane; `node scripts/check-doc-counts.mjs` and `npm run check:docs` green; owner acceptance recorded 2026-09-25.                                                                                                                                                                     |

## Requirement verdicts

Per BPR-091's amended clauses and the B9 PRD's requirement map:

| Requirement                       | B9 half      | Verdict  | Evidence                                        |
| --------------------------------- | ------------ | -------- | ----------------------------------------------- |
| BPR-060 Message Requests          | client       | **PASS** | B9-5/B9-6; journey C.                           |
| BPR-061 rich content              | client       | **PASS** | B9-8/B9-9; journey J (native, run 36127046517). |
| BPR-062 bounded retrieval         | client       | **PASS** | B9-8; journey J; B7-16 desktop half.            |
| BPR-063 NSFW consent              | client       | **PASS** | B9-7/B9-11; journey H.                          |
| BPR-064 translation-ready English | client       | **PASS** | B9-3/18/19/20.                                  |
| BPR-070 local reports             | client       | **PASS** | B9-10; journeys A, B.                           |
| BPR-071 Moderation Center         | client       | **PASS** | B9-11..14, B9-17; journeys A, B, G, H.          |
| BPR-072 narrow actions            | client       | **PASS** | B9-13/B9-14; journey A.                         |
| BPR-073 appeals                   | client       | **PASS** | B9-16/B9-17; journeys A, B.                     |
| BPR-090 identity/performance      | client       | **PASS** | Refined Neon; budgets; owner visual acceptance. |
| BPR-091 accessibility             | client       | **PASS** | Automated evidence; see exit condition 3.       |
| BPR-092 honest capabilities       | desktop half | **PASS** | B9-25; journeys F, J.                           |

## Owner decisions recorded (R0)

The owner approved every recommended R0 answer (D-01..D-18) on **2026-09-25**.
Recorded where each source document lives:

| Id   | Decision recorded                                                                               | Where                                                            |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D-01 | TLS lifecycle is an accepted beta limitation; reverse proxy recommended; B6-3..B6-5 move to B11 | traceability BPR-014/015/016; roadmap B6/HP-6; PRD.md TLS bullet |
| D-02 | The first beta tag is the rehearsal; a failed run means a `beta.2`                              | roadmap B10 item 4; B11 block                                    |
| D-03 | Public-CA renewal pin-break accepted for beta; verifier change to B11                           | roadmap B11 block                                                |
| D-04 | Bundle-budget raises accepted; B9-26 re-baseline is the accepted baseline                       | scored card §Performance below; `Client/bundle-budgets.json`     |
| D-05 | SEC-01 (B4-4 admission control) needs no published advisory                                     | register SEC-01 row                                              |
| D-06 | GitHub Discussions re-enabled (owner action, B10)                                               | register BPR-100 row; B10                                        |
| D-07 | `tauri-build` on PRs into `dev` accepted as a deviation; the release PR runs it                 | B7 PRD; B10                                                      |
| D-08 | Windows code signing declined; timestamped-signature exception recorded                         | traceability BPR-005; scored card below                          |
| D-09 | OC-0454 declined as an accepted low with a `capacity.md` note                                   | register/B10 item 9                                              |
| D-10 | Q11 comprehension read runs against the release PR's artifacts before the tag                   | B9 PRD Q11                                                       |
| D-11 | Two-build compare added for the four server binaries                                            | B10/B6-12                                                        |
| D-12 | Synthetic upgrade fixture accepted; one manual alpha upgrade as HP-10 evidence                  | B10                                                              |
| D-13 | `dev`→`main` release PR uses a merge commit; squash stays for `dev` PRs                         | docs/contributing.md (B10)                                       |
| D-14 | Beta stays a full release (not pre-release)                                                     | release procedure (B10)                                          |
| D-15 | HP-6 Q1/Q4/Q5 answered; E6 N/A under D-01, E5 from the RC load run                              | HP-6 (B10)                                                       |
| D-16 | First-run defaults acknowledged, not changed; listed on the known-limitations page              | OP-18 (B10)                                                      |
| D-17 | Owner-lockout answer documented for beta; setup-time kit post-beta                              | B11 block                                                        |
| D-18 | Beta wording flip at the release commit; hobby disclaimer stays                                 | roadmap B10                                                      |

### D-04 — bundle-budget acceptance

The B9-26 re-baseline rule is
`new budget = min(current budget, measured + 1,000 B rounded up to the next 500 B)`,
applied to every budget and never raising one. At B9-26 the result was:

| Chunk                 | Measured  | Budget (was)        | Verdict                   |
| --------------------- | --------- | ------------------- | ------------------------- |
| startup               | 96,606 B  | 97,000 B (97,000)   | unchanged, 394 B headroom |
| MainPage              | 62,433 B  | 63,500 B (64,000)   | lowered                   |
| livekit (lazy)        | 133,372 B | 134,500 B (135,000) | lowered                   |
| livekitSession (lazy) | 23,008 B  | 24,000 B (24,000)   | unchanged                 |

The owner accepted these as the new baseline (D-04). The earlier B9-lane raises
(90,000→97,000 startup, 60,000→64,000 MainPage) predate the re-baseline and
were needed for the shared B9 catalog/consent cost; the re-baseline lowered two
budgets, so "the B7 budgets are not weakened" holds at the exit point.

### D-08 — Windows code signing deferral

Windows code signing stays declined for the beta (owner decision, 2026-09-25).
The user-facing half is the SmartScreen install note (RE-06); the release
procedure records the "timestamped-signature exception" line BPR-005 expects,
and the unsigned installers remain covered by checksums, SBOM and provenance.

## Q11 and Q12 as recorded

- **Q11** (BPR-051 comprehension read): two non-contributor desktop users read
  the four questions in the PRD against the **release PR's CI artifacts before
  the tag** (D-10). Status at HP-9: **NOT RUN** — the readers are recruited for
  B10, and a miss is a documentation fix before the tag. Method recorded in the
  B9 PRD Q11.
- **Q12** (B10 cut list): the 2026-09-18 table is confirmed row by row, the
  later gate is named **B11**, and the one-page moderation/Moderation-Center
  guide stays in beta (B10's DOC-09). Retained unchanged: RC matrix, alpha
  upgrade/rollback, protocol re-run, desktop/server/Docker matrix, one capacity
  comparison, zero open P0/P1 and advisories, packaging/provenance/signing,
  safe release notes, item 15 per Q11 and HP-10.

## Findings and open items at exit

- Ledger at 2026-09-25: **466 fixed / 6 open / 6 declined / 1 duplicate = 479**.
  The six open findings (OC-0454, OC-0473, OC-0474, OC-0476, OC-0478, OC-0479)
  are all low and **none is B9-tagged**. The B9 exit audit fixed thirteen,
  declined two as screen-reader-only work (owner 2026-09-25) and left five open
  for after the beta. No open B9-tagged finding blocks this exit.
- Owner questions: none open for B9. Q11's read and Q12's table are settled as
  above; the D-xx answers are recorded.

## Outstanding items that are not B9's to close

These are carried by later phases, not waived here:

- **HP-6** (operator/capacity) with an unfamiliar operator — deferred to run
  against B6-12's tag before beta (owner 2026-09-25).
- **B7 exit** — the `tauri-build`-on-`dev` item (D-07 accepted as a deviation);
  the release PR is the first full Tauri CI build of the B9 tree.
- **B10** — the shortened release checklist and HP-10 go/no-go.
- **B11** — the moved thirty-run/soak/documentation work and post-beta TLS.

## Freeze-impact note — admin panel overhaul (AO-1..AO-8)

The owner approved a pre-beta admin-panel overhaul: lanes **AO-1..AO-8**,
direction "Refined Neon", scoped to `Server/admin/static` and the admin panel's
UI strings and styles only (no server API, protocol or schema change). It lands
**after** this freeze and before the beta.

Freeze impact: **none to the frozen surfaces.** The B9 freeze covers the
protocol schema, migrations and the client English catalogs. The admin panel is
a separately served page with its own HTML/CSS and is explicitly outside the
B9 client catalog seam (B9 PRD Q7 excludes the separately served admin panel),
so AO work does not change `protocol/schema.json`, `Server/migrations/`,
`Client/src/i18n/` or `ui-strings-baseline.json`. The first AO lane
([#1805](https://github.com/J3vb/OwnCord/pull/1805), the token/accessibility
floor already merged) is the pattern: it touches `Server/admin/static/index.html`,
`CHANGELOG.md` and an admin-token contract test. The remaining AO lanes keep
that boundary; a change outside it needs its own freeze-impact review.

## Validation

- `node scripts/check-doc-counts.mjs` — green (10 claims across 5 watched
  documents agree with the ledger).
- `npm run check:docs` — green (doc counts, citations, migration immutability,
  ledger render).
- B9-27 is a documentation-only lane; no product, test, workflow or dependency
  change.

## Sources

- [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md),
  [b9-journey-evidence-2026-09-25.md](b9-journey-evidence-2026-09-25.md),
  [b9-27 plan](../../.claude/plans/b9-27-hp9-freeze-and-exit.plan.md)
- [repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md),
  [beta-requirements-traceability-2026-08-23.md](beta-requirements-traceability-2026-08-23.md),
  [repo-health-issue-register-2026-08-23.md](repo-health-issue-register-2026-08-23.md)
- `Client/bundle-budgets.json`, `Client/tests/e2e/b9-zoom.spec.ts`,
  `Client/tests/e2e/fullstack/b9-journeys.spec.ts`,
  `Client/tests/e2e/native/b9-journeys.spec.ts`, `.superpowers/findings-ledger.json`
