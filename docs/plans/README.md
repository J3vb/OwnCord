# Plan index

Closes G-04. Historical plans are kept at their existing paths — links from
audits and commit messages must keep resolving — so status is recorded **here**
rather than by moving or rewriting them.

A plan's own header can drift out of date after its table is updated in place.
Where that has happened it is called out below, and **this index is the
authority**.

## Active — these drive current work

| Plan                                                                                      | State                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [beta-product-requirements-2026-08-23](beta-product-requirements-2026-08-23.md)           | Approved beta scope, frozen. 57 `BPR-*` requirements.                                                                                                                                                                                                                                                                                                                            |
| [repo-health-roadmap-2026-08-23](repo-health-roadmap-2026-08-23.md)                       | Phase order and gates, B0–B10. **B0 and B1 complete** (HP-0 and HP-1 both accepted); **B2 in progress** — plan below. B3–B10 not started. **Amended 2026-08-28:** dated lines in B3–B10, a "Phase execution pattern" section, and a truthful status header. **Amended 2026-08-29:** B3/B7/B9 lines binding the layout-refactor supplement below; current slice updated for B2-2. |
| [repo-health-issue-register-2026-08-23](repo-health-issue-register-2026-08-23.md)         | 88 planning rows. Public-safe; not a replacement for the ledger.                                                                                                                                                                                                                                                                                                                 |
| [beta-requirements-traceability-2026-08-23](beta-requirements-traceability-2026-08-23.md) | Requirement → phase → evidence map. No row is release-qualified.                                                                                                                                                                                                                                                                                                                 |
| [b0-baseline-2026-08-25](b0-baseline-2026-08-25.md)                                       | **Supersedes the roadmap's "current evidence snapshot."** B0 measurements and dispositions.                                                                                                                                                                                                                                                                                      |
| [b1-repository-foundation-2026-08-25](b1-repository-foundation-2026-08-25.md)             | **B1-0 through B1-8 all done.** B1 execution plan. Re-verifies every RL-\* claim against HEAD; several are refuted.                                                                                                                                                                                                                                                              |
| [hp-0-scorecard-2026-08-25](hp-0-scorecard-2026-08-25.md)                                 | **HP-0 accepted 2026-08-25.** The single baseline-acceptance artifact. Part-closes `R-08`.                                                                                                                                                                                                                                                                                       |
| [hp-1-scorecard-2026-08-27](hp-1-scorecard-2026-08-27.md)                                 | **HP-1 accepted 2026-08-27.** Structural-diff proofs for the flatten and module rename, plus the B1 exit gate.                                                                                                                                                                                                                                                                   |
| [b2-protocol-trust-compat-2026-08-28](b2-protocol-trust-compat-2026-08-28.md)             | **B2 in progress from 2026-08-28.** B2-0, B2-1, B2-8 done 2026-08-28; B2-2 done 2026-08-29 (PR #1438, B2-3 and B2-4 folded in). **B2-5 is next**, serialized; B2-6/7/9 in parallel. Ends at HP-2.                                                                                                                                                                                |
| [audit-2026-08-19-remediation](audit-2026-08-19-remediation.md)                           | Phases 1–6 done 2026-08-20; **phase 7 pending**. Its header still reads "in progress 2026-08-19" — stale; the phase table is correct.                                                                                                                                                                                                                                            |

## Partially implemented

| Plan                                                        | State                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [bug-detection-improvements](bug-detection-improvements.md) | Tier 1a (`make fuzz`) and Tier 2 (five ESLint rules) shipped 2026-08-08. Remaining tiers open. |

## Design only — not implemented

| Plan                                                                                                  | State                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [developer-experience-layout-refactor-2026-08-29](developer-experience-layout-refactor-2026-08-29.md) | Draft, not started. Implementation supplement bound into the roadmap 2026-08-29: B3 workstream 17 (Phases 1–3, auth slice → HP-3), B7 workstream 16 (Phases 4–6), B9 workstream 11 (CSS split). Nothing starts before HP-2. |
| [slash-commands](slash-commands.md)                                                                   | Design only. No implementation; not in beta scope.                                                                                                                                                                          |

## Shipped — kept for history, do not use as current status

| Plan                                                                            | Shipped                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [audit-2026-07-19-decisions](audit-2026-07-19-decisions.md)                     | Decisions recorded; greenlit items implemented through 2026-07-23.                                   |
| [channel-visibility-unification](channel-visibility-unification.md)             | 2026-07-20 (D9), re-verified 2026-08-04.                                                             |
| [v2-dispatch-migration](v2-dispatch-migration.md)                               | 2026-07-20 (D10), re-verified 2026-08-04.                                                            |
| [tauri-capability-narrowing](tauri-capability-narrowing.md)                     | 2026-07-20, re-verified 2026-08-04.                                                                  |
| [http-tofu-proxy](http-tofu-proxy.md)                                           | 2026-07-19, re-verified 2026-08-04.                                                                  |
| [permission-middleware-consolidation](permission-middleware-consolidation.md)   | 2026-07-23 (D13), re-verified 2026-08-04.                                                            |
| [security-hardening-remediation](security-hardening-remediation.md)             | 2026-07-23, re-confirmed 2026-08-04.                                                                 |
| [security-scan-2026-07-22-remediation](security-scan-2026-07-22-remediation.md) | All 8 findings F1–F8 closed, verified 2026-08-04.                                                    |
| [sqlc-adoption](sqlc-adoption.md)                                               | Shipped, verified 2026-08-04.                                                                        |
| [discord-parity](discord-parity.md)                                             | Phases 1–6 complete, verified 2026-08-04. Phase 1's table reads as a gap list but every row shipped. |
| [infrastructure-roadmap](infrastructure-roadmap.md)                             | 2026-08-15, with two recorded leftovers (TOTP persister seam; published capacity numbers).           |

## Where status actually lives

Planning documents are not trackers. Do not read a defect count out of one.

| Concern                    | Source of truth                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| Defect status              | `.superpowers/findings-ledger.json` (`FINDINGS.md` is rendered from it)         |
| Security-sensitive defects | Private GitHub Security Advisories                                              |
| Product scope              | [beta-product-requirements-2026-08-23](beta-product-requirements-2026-08-23.md) |
| Phase order and gates      | [repo-health-roadmap-2026-08-23](repo-health-roadmap-2026-08-23.md)             |
| Current measured baseline  | [b0-baseline-2026-08-25](b0-baseline-2026-08-25.md)                             |

Ledger at 2026-08-29: **315 fixed / 56 open / 3 declined / 1 duplicate = 375**.
All 38 open records still resolved to a live `file:line` at
`5cc0888964e26276d1aca145e83270a2c1b9febd` when that sweep was run — it was a
manual pass, not something a command reproduces. What the tooling does check:

```
node .superpowers/render-ledger.mjs --check   # the ledger's schema is valid
node scripts/check-doc-counts.mjs             # documents agree with it, and
                                              # FINDINGS.md is not stale
```

## Adding a plan

1. Give it a `**Status:**` line with a date, and update that line — not only
   the phase table — when it changes.
2. Add a row here. A plan absent from this index has no recorded status.
3. Mark a superseded plan here; leave it at its path so existing links resolve.
