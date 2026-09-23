# Plan: B9-2 — Apply the agreed shared accessibility and token rules

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-2 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-2-shared-accessibility-and-tokens`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8. **Requirements:** BPR-090, BPR-091.
> **Dependencies:** B9-1. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Apply the agreed shared accessibility and token rules. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Operate a shared modal and form with keyboard only; trigger pending, error and success states at large text and reduced motion.

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

| #   | Verified current state                                                                                                                        | Evidence at planning commit                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Tokens already define semantic colors, theme aliases and transition durations. Extend this vocabulary rather than replacing OwnCord identity. | `Client/src/styles/tokens.css:6-84`                                                              |
| 2   | Focus rings exist in base CSS; modalFactory composes dialog semantics and a focus trap with Disposable.                                       | `Client/src/styles/base.css:34-50`; `Client/src/lib/modalFactory.ts:71-99`                       |
| 3   | Large Font has a single writer and a minimum-size policy already; this is regression protection, not a new OC-0319 fix.                       | `Client/src/lib/appearance.ts:14-56`; `Client/src/components/settings/AccessibilityTab.ts:53-63` |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

No server contract changes. UI announcements never include hidden content or secrets.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                               | Purpose                                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Client/src/styles/tokens.css; Client/src/styles/base.css; CSS owners from B9-1`                   | Shared token and focus changes only                      |
| `Client/src/lib/a11y.ts; Client/src/lib/modalFactory.ts`                                           | Shared dialog helpers, if demonstrated by failing checks |
| `Client/tests/e2e/support/b9-accessibility.ts (new); Client/tests/e2e/b9-primitives.spec.ts (new)` | Reusable automated checks                                |
| `docs/architecture/b9-ui-contract.md (new)`                                                        | Approved shared patterns                                 |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan             | Dated implementation status and exact-SHA evidence       |

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

### Task 1: Pin the agreed examples

Add a small shared-controls fixture for normal, hover, focus, disabled, loading and error states. Record measured contrast and motion behavior, including high contrast and both font-size preferences.

### Task 2: Change only shared primitives

Apply the Q1/Q8-approved token adjustments, visible focus treatment, dialog focus restoration and common status/error semantics. Keep action-specific rules in their own milestone; do not restyle all feature screens here.

### Task 3: Make the checks reusable

Add a reusable automated accessibility helper and desktop screenshot fixture under existing test runners. Prove it fails with an intentionally unnamed control or removed focus behavior, then restore the fixture. Choose any new test dependency explicitly in the implementation PR.

### Task 4: Publish the usage contract

Document token/state names, keyboard patterns, polite versus assertive announcements and teardown ownership so parallel feature PRs use the same controls.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/a11y-smoke.spec.ts; Client/tests/unit/accessibility-tab.test.ts
- Proposed: b9-primitives.spec.ts; reusable accessibility helper with a failing control

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
- [ ] **Screen reader:** approved native AT reads names, roles, values, errors
      and relevant status once; no concealed/private/secret content in its tree.
- [ ] **Focus:** visible indicator, logical order, dialog containment/restore,
      stable location through async update/removal, and a safe fallback opener.
- [ ] **Contrast:** measure agreed text, controls, status and focus targets in
      built-in/high-contrast themes and the Q8-approved custom-accent policy;
      information never depends on color alone.
- [ ] **Reduced motion:** test both OS and app settings; no required animation,
      unwanted autoplay or motion-dependent feedback; preserve media controls.
- [ ] **Zoom/reflow:** test Q1-approved text scaling and desktop zoom/reflow,
      long English/expanded strings and smallest supported desktop window;
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

Global token changes have a wide visual effect; one shared-file writer, measured theme matrix, owner visual acceptance.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q1 — Accessibility acceptance contract

**Options and consequences:** Adopt a documented WCAG 2.2 AA-oriented checklist with Windows NVDA and Linux Orca native checks, text scaling and desktop reflow; or specify an equivalent native-task checklist covering every roadmap property with explicit thresholds and AT coverage. The first provides familiar criteria; the second needs more owner review to establish equivalent coverage. Structural smoke alone is insufficient under either option.

**Recommendation (not approved):** Adopt the broader checklist, name supported OS/AT versions and assign human reviewers before implementation. This is a proposed bar, not a claim of certification.

### Q8 — Theme and custom-accent accessibility policy

**Options and consequences:** Qualify every built-in theme and provide a contrast-safe fallback for arbitrary custom accents; or require/warn users to adjust custom themes themselves. Fallback preserves readable controls but can alter chosen colors; warnings preserve exact choices but cannot establish an all-settings contrast claim.

**Recommendation (not approved):** Qualify built-ins and high-contrast mode, retain identity, and approve a safe fallback for essential text/focus indicators. The owner must decide how custom accents are constrained or disclosed.
