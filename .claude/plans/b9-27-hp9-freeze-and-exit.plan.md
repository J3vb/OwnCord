# Plan: B9-27 — Record HP-9 feature freeze and the B9 exit decision

**Status:** COMPLETE — 2026-09-25; the HP-9 exit was accepted by the owner and the
freeze recorded in [hp-9-scorecard-2026-09-25.md](../../docs/plans/hp-9-scorecard-2026-09-25.md). Documentation-only; no product, test, workflow or dependency change.

> **Milestone:** B9-27 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `docs/b9-27-hp9-freeze-and-exit`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** HP-9; exit. **Requirements:** BPR-064, BPR-090..092; inherited client halves.
> **Dependencies:** B9-26. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

This milestone produces evidence and decisions only; it does not implement feature code.

**User journey:** Owner reviews recordings and reproduces the critical desktop journeys, including refusals and accessibility states.

## What this milestone is not

No browser/PWA/phone/tablet product, touch-device qualification, new provider,
second shipping language, central moderation service or wholesale rebrand.
No permission-policy relaxation, unrelated feature, dependency major, CI redesign
or generated-file hand edit. The file table is the proposed implementation
boundary; work outside it needs an updated plan. This planning PR changes no
product code, tests or CI.

## Current-state inventory and verify before implementation

Every reference below was read at `0beee8e4c50ca18823750e381d3a1d6e327029b8`. These are source-inspection
facts, not claims that tests or platform acceptance passed. Proposed paths later
in this file are explicitly new work, not present behavior. Re-read this table
at the actual implementation base; record drift before coding.

| #   | Verified current state                                                                                                                                              | Evidence at planning commit                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | HP-9 freezes features, strings, protocol, migrations and behavior and asks the owner to confirm or revise the B10 cut list.                                         | `docs/plans/repo-health-roadmap-2026-08-23.md` (B9 §Hold point HP-9) |
| 2   | The shortened B10 direction retains RC matrix, upgrade/rollback, protocol, zero unresolved advisory and owner go/no-go; the comprehension read was settled at HP-9. | `docs/plans/repo-health-roadmap-2026-08-23.md` (B10 opening block)   |
| 3   | The current ledger has open low findings outside the B9 UI workstreams (six at 2026-09-25); none is closed by writing this plan.                                    | `.superpowers/findings-ledger.json`                                  |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

No runtime change. HP-9 cannot waive a known security blocker or grant access that B5 forbids.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                           | Purpose                                            |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `docs/plans/hp-9-scorecard-<date>.md (new)`                                                                    | Owner decision, freeze and evidence matrix         |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md; docs/plans/README.md`                           | Dated phase state                                  |
| `docs/plans/beta-requirements-traceability-2026-08-23.md; docs/plans/repo-health-issue-register-2026-08-23.md` | Exit reconciliation; no invented closure           |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                         | Dated implementation status and exact-SHA evidence |

Shared edits to navigation, `api.ts`, `types.ts`, `dispatcher.ts`, global stores,
tokens and style import composition take the PRD's single-writer lane. Parallel
work may prepare local modules; shared edits merge sequentially after rebase.

## Tasks

### Task 0: Verify the real base and acceptance preconditions

Create the named branch from `dev`; record its full SHA. Recheck the inventory,
dependency evidence and applicable owner answers. Capture the current affected
checks before changes. An unmet gate means **blocked**, not a speculative
implementation against a made-up endpoint. Retain the reviewed code proof above
and add a failing contract/measurement for the change; no threshold weakening.

### Task 1: Prepare the scorecard

Write docs/plans/hp-9-scorecard-<date>.md with the B9-26 manifest, exact integration SHA, every exit condition and its PASS/FAIL/NOT RUN verdict. List all unresolved owner questions and findings; never fill a signature on behalf of the owner.

### Task 2: Hold the owner review

Review recognizable identity, critical journeys and every accessibility defect. Confirm/revise B10 cut list under Q12 and settle the BPR-051 comprehension-read method under Q11. Keep HP-6/tag qualification obligations visible; B7's waiver was not cancellation.

### Task 3: Freeze and record change control

After owner acceptance, freeze features/English strings/protocol/migrations/user-visible behavior for the candidate. Necessary blocker fixes get focused PRs, new exact-SHA evidence and an explicit freeze-impact decision; no unreviewed feature additions.

### Task 4: Close only with evidence

Update the PRD status, README row, traceability and register consistently. Every tagged OC is fixed/refuted or explicitly retagged by owner with a reason. Keep B8 deferrals and B10 release obligations separate; do not tag, publish or merge as part of this milestone.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Evidence: B9-26 exact-SHA manifest, owner identity review and six-dimension accessibility checklist per milestone
- Validation: npm run check:docs; npm run check:hygiene; ledger validation; clean documentation-only diff

- [ ] Named behavior tests cover success, refusal, pending/error, reconnect and
      teardown where applicable, with an observed failing control before the fix.
- [ ] Evidence names the implementation SHA, platform/tool versions, fixture,
      command, expected result, actual result and recording/report location.
- [ ] No new warning, import cycle, native-import violation, unexplained test
      log, weakened assertion or reduced coverage/performance threshold.

### Accessibility blocks this milestone

Apply these checks to this milestone's user journey above, including loading,
empty, error, denied and completed states. A source-only/evidence milestone
records the applicable evidence and any missing checks; documentation alone
does not prove unchanged UI behavior. The CSS-only move supplies before/after
evidence. No milestone defers its accessibility acceptance to B9-26.

- [ ] **Keyboard:** Tab/Shift+Tab, Enter/Space, Escape and applicable arrow keys
      reach and operate every action; pointer parity; no hover-only action.
- [ ] **Screen reader:** automated ARIA name/role and keyboard/focus tests prove names, roles,
      values, errors and relevant status once; no concealed/private/secret content in the
      accessibility tree. No manual NVDA/Orca pass (owner decision 2026-09-24, Q1 amendment).
- [ ] **Focus:** visible indicator, logical order, dialog containment/restore,
      stable location through async update/removal, and a safe fallback opener.
- [ ] **Contrast:** measure text, controls, status and focus at the Q1 thresholds in
      built-in/high-contrast themes, preset accents and the Q8 custom-accent fallback
      (accent as text below 4.5:1, and accent as focus below 3:1, use the theme default accent);
      information never depends on color alone.
- [ ] **Reduced motion:** test both OS and app settings; no required animation,
      unwanted autoplay or motion-dependent feedback; preserve media controls.
- [ ] **Zoom/reflow:** test Q1 text scale 12–20 px with Large Font, OS zoom 200 %,
      long English/expanded strings and the 940×500 minimum desktop window;
      no clipped or unreachable controls, lost content or focus off screen.

Frontend automation plus manual native evidence is required: mocked Playwright
alone cannot qualify OS accessibility or native network behavior. Browser/mobile
device qualification is deferred with B8; desktop zoom/reflow is not deferred.

## Validation

For a product PR run `npm run check:client` and the named focused/fullstack/native
checks selected by the changed paths; preserve existing bundle budgets and
lifecycle gates. Rust/server changes are not assumed: if an approved prerequisite
changes them, it must run its complete component gate separately. Never run a
local Tauri packaging build (CI-only per Client/CLAUDE.md). Documentation-only
B9-0/B9-27 use `npm run check:docs`, `npm run check:hygiene` and evidence review.
All PRs retain exact-integration-SHA CI evidence before phase closure.

## Risks and rollback

A feature freeze is not B10 release approval. Missing native evidence, unresolved blockers or owner decisions keep the phase open.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q11 — BPR-051 comprehension-read method at HP-9

**Decided 2026-09-23 by the owner:** option (a). Readers: two desktop users who are not contributors to OwnCord, recruited by the owner (roles, not names, are recorded). Journey on the release candidate: install and sign up (retention summary at sign-up), open Settings > Account (retention and permanent-deletion text), Settings > Logs (local export note), and read the "short answer" section of `docs/trust-model.md`. Questions, answered unprompted in their own words: (1) Who can read your messages and files on this server? (2) What does the "End-to-end encrypted" badge on voice cover, and what does it not cover? (3) What happens to your messages when you delete your account, and can a backup bring them back? (4) What is in the support export and where does it go? Pass criterion: both readers answer all four correctly; one miss is a documentation defect to fix and re-read before HP-10. Results are recorded in the HP-9 scorecard against the RC SHA. This obligation stays in beta even though the longer documentation rows moved.

**Options and consequences:** Have one or more non-developer desktop users explain the operator trust, text/file access, deletion/backup and local-export disclosures after following the journey; or rely only on technical review. The first satisfies the stated comprehension purpose; technical review alone leaves that B10 item unproven.

**Drafting recommendation (historical):** Owner names the reader(s), questions and pass criterion at HP-9, records safe results against the RC and keeps this B10 obligation even if longer documentation moves later.

### Q12 — Confirm or revise the shortened B10 cut list

**Decided 2026-09-23 by the owner (to be recorded at HP-9):** confirm the 2026-09-18 table row by row, with two additions that do not change any verdict. First, give the "later beta-to-stable gate" a phase id now, proposed B11, so items 2, 3, 13, 14 and the moved half of item 11 have an owner row in the roadmap instead of "no phase id assigned yet". Second, at HP-9 re-examine only item 11's moderation half with the shipped B9 features in hand: if the Moderation Center, appeals and the out-of-band ban-appeal route ship in the beta, a one-page user guide for them stays in beta; accessibility, support, feedback and contribution documentation move as decided. Retained and unchanged: the RC matrix (1), alpha upgrade/rollback (4), protocol re-run (5), desktop/server/Docker matrix (6, 7), one capacity comparison (8), zero open P0/P1 and advisories (9), packaging/provenance/signing/update checks (10), safe release notes (12), item 15 per Q11, and HP-10.

**Options and consequences:** Confirm the 2026-09-18 keep/reduce/move table; or revise named rows at HP-9. Confirmation moves thirty-run and fourteen-day-soak evidence and the listed documentation to a later beta-to-stable gate; revision changes release work and needs an updated dated roadmap decision. Neither choice waives RC checks, upgrade/rollback, advisory closure or HP-10.

**Drafting recommendation (historical):** Review the table row by row at HP-9 and record the owner's decision and later-gate ownership; do not pre-approve it in B9 planning.
