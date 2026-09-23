# Plan: B9-23 — Polish account, privacy, recovery and settings journeys

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-23 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-23-account-settings-polish`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8, 10. **Requirements:** BPR-090, BPR-091; BPR-052..055, BPR-035.
> **Dependencies:** B9-20. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish account, privacy, recovery and settings journeys. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Recover an account, read retention, inspect/revoke sessions, review export warning and cancel/complete a throwaway account deletion.

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

| #   | Verified current state                                                                     | Evidence at planning commit                                                                      |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | The account tab already includes recovery, sessions and retention sections.                | `Client/src/components/settings/AccountTab.ts:1389-1396`                                         |
| 2   | Deletion discloses immediate erasure, prior backups and other devices' image caches.       | `Client/src/components/settings/AccountTab.ts:1110-1114`                                         |
| 3   | Large Font and high-contrast/reduced-motion preferences already have defined side effects. | `Client/src/components/settings/AccessibilityTab.ts:10-64`; `Client/src/lib/appearance.ts:63-81` |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

B4 erasure/retention/session authority and B7-15c desktop flows. Message retention is server-default only; attachments leave with messages; support bundle is user-initiated and local.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                  | Purpose                                            |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/settings/**; Client/src/components/SettingsOverlay.ts; affected connect forms` | Measured accessibility/state fixes only            |
| `Owned settings CSS from B9-1; account/settings catalogs`                                             | Scoped layout and approved copy                    |
| `Client/tests/e2e/b9-account-settings.spec.ts (new)`                                                  | Accessible privacy/recovery journey                |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                | Dated implementation status and exact-SHA evidence |

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

### Task 1: Audit the existing journey

Exercise registration modes, recovery, one-time codes, session review/revoke, deletion confirmation, retention and support export. Preserve B7 implementation and accepted disclosure text; do not rebuild these features.

### Task 2: Fix accessible feedback

Connect form errors to fields, announce async completion once, preserve focus across rebuilt account sections and keep one-time secrets out of live regions and diagnostic artifacts. Leave secret reveal/copy deliberate.

### Task 3: Apply scoped settings layout

Use owned settings styles for zoom, scroll, text expansion and consistent destructive controls. Preserve Large Font as a floor, OS/manual motion precedence, and each setting across restart.

### Task 4: Prove irreversible-action copy

Record successful and failed flows using throwaway accounts; no deletion result before server confirmation, no retention window presented as deletion delay, no support export represented as automatic upload.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/account-security.spec.ts; Client/tests/e2e/recovery-flow.spec.ts; Client/tests/e2e/sessions.spec.ts; Client/tests/unit/support-bundle.test.ts
- Proposed: b9-account-settings.spec.ts; expand settings-overlay.test.ts as needed

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
- [ ] **Screen reader:** NVDA (Windows) and Orca (Linux) read names, roles, values, errors
      and relevant status once; no concealed/private/secret content in its tree.
- [ ] **Focus:** visible indicator, logical order, dialog containment/restore,
      stable location through async update/removal, and a safe fallback opener.
- [ ] **Contrast:** measure text, controls, status and focus at the Q1 thresholds in
      built-in/high-contrast themes, preset accents and the Q8 custom-accent fallback
      (accent text/focus below 3:1 uses the theme default accent);
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

Polish must not rewrite privacy promises or expose secrets through screen recordings; use synthetic data and redact evidence.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q11 — BPR-051 comprehension-read method at HP-9

**Decided 2026-09-23 by the owner:** option (a). Readers: two desktop users who are not contributors to OwnCord, recruited by the owner (roles, not names, are recorded). Journey on the release candidate: install and sign up (retention summary at sign-up), open Settings > Account (retention and permanent-deletion text), Settings > Logs (local export note), and read the "short answer" section of `docs/trust-model.md`. Questions, answered unprompted in their own words: (1) Who can read your messages and files on this server? (2) What does the "End-to-end encrypted" badge on voice cover, and what does it not cover? (3) What happens to your messages when you delete your account, and can a backup bring them back? (4) What is in the support export and where does it go? Pass criterion: both readers answer all four correctly; one miss is a documentation defect to fix and re-read before HP-10. Results are recorded in the HP-9 scorecard against the RC SHA. This obligation stays in beta even though the longer documentation rows moved.

**Options and consequences:** Have one or more non-developer desktop users explain the operator trust, text/file access, deletion/backup and local-export disclosures after following the journey; or rely only on technical review. The first satisfies the stated comprehension purpose; technical review alone leaves that B10 item unproven.

**Drafting recommendation (historical):** Owner names the reader(s), questions and pass criterion at HP-9, records safe results against the RC and keeps this B10 obligation even if longer documentation moves later.
