# Plan: B9-2 — Apply the agreed shared accessibility and token rules

**Status:** IMPLEMENTED — native AT recordings and owner visual acceptance pending — 2026-09-23 on branch `fm/b9-2-impl` from `dev` `3c55f811`; evidence in `docs/plans/b9-shared-a11y-evidence-2026-09-23.md`, contract in `docs/architecture/b9-ui-contract.md`.

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

### Drift at the implementation base (2026-09-23)

`git diff 0beee8e4 3c55f811` over the three inventory rows' files
(`tokens.css`, `base.css`, `modalFactory.ts`, `appearance.ts`,
`AccessibilityTab.ts`, `a11y.ts`): **no change**. All three rows hold as
written. B9-1 moved app.css into `Client/src/styles/app/*.css`, so "CSS owners
from B9-1" means those fragments plus `login.css` and `theme-neon-glow.css`.
Measuring at the base found more than the inventory lists. The dark default
accent reads 2.74:1 as text or focus ring. The neon-glow default accent carried
white text at 1.96:1. The light theme's link, status and warning text reads
1.5–3.8:1, and High Contrast in the light theme drew white text on white.
Settings switches had no accessible name. The OS reduced-motion setting was
ignored unless the user turned on "Sync with OS", which defaulted to off.

### File-table amendments (implementation)

Q8's derivation happens at apply time, and Q1 requires the OS motion setting to
be honoured. Neither fits inside the table below, so the implementation also
touches these files:

| File                                                                                                                  | Why                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Client/src/lib/color-contrast.ts` (new), `Client/src/lib/themes.ts`                                                  | WCAG math and `applyAccent()`, the single writer of the Q8 derived tokens             |
| `Client/src/components/settings/AppearanceTab.ts`, `helpers.ts`                                                       | use `applyAccent`, the Q8 disclosure, the light theme's tested tokens, named switches |
| `Client/src/components/settings/AdvancedTab.ts`, `VoiceAudioTab.ts`                                                   | pass the now-required switch label                                                    |
| `Client/src/lib/os-motion.ts`, `Client/src/lib/appearance.ts`, `AccessibilityTab.ts`                                  | Q1: reduced motion from the OS or the toggle; Sync with OS on by default              |
| `Client/tests/unit/*` (affected suites, `color-contrast.test.ts` new), `Client/tests/e2e/settings-tabs-extra.spec.ts` | coverage; preconditions updated where Q1 changed the intended motion default          |
| `docs/plans/b9-shared-a11y-evidence-2026-09-23.md` (new), `docs/architecture/README.md`                               | evidence record; index row for the contract                                           |

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

Apply the Q1/Q8 token adjustments (Q8: derived `--on-accent`, `--accent-hover` and `--accent-active`; accent-as-text or focus below 3:1 falls back to the theme default accent), visible focus treatment, dialog focus restoration and common status/error semantics. Keep action-specific rules in their own milestone; do not restyle all feature screens here.

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

Global token changes have a wide visual effect; one shared-file writer, measured theme matrix, owner visual acceptance.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q1 — Accessibility acceptance contract

**Decided 2026-09-23 by the owner:** adopt a WCAG 2.2 AA-oriented checklist as the B9 acceptance bar. Named assistive technologies: NVDA (current stable) on Windows 11 and Orca (current GNOME release) on Linux; one native recording per milestone journey on each. Thresholds: text contrast 4.5:1, large text / UI components / focus indicators 3:1 (WCAG 1.4.3, 1.4.11); visible, unobscured focus (2.4.7, 2.4.11); pointer targets at least 24×24 CSS px (2.5.8); text spacing (1.4.12); no content or function lost at the app text scale of 12–20 px with Large Font on, at OS zoom 200 %, and at the 940×500 minimum window (1.4.10 as applied to desktop); reduced motion honoured from both the OS setting and the in-app toggle. The repository owner is the named human reviewer; automated reports supplement, never replace, the manual checks. This is a bar for B9 acceptance, not a certification claim.

**Options and consequences:** Adopt a documented WCAG 2.2 AA-oriented checklist with Windows NVDA and Linux Orca native checks, text scaling and desktop reflow; or specify an equivalent native-task checklist covering every roadmap property with explicit thresholds and AT coverage. The first provides familiar criteria; the second needs more owner review to establish equivalent coverage. Structural smoke alone is insufficient under either option.

**Drafting recommendation (historical):** Adopt the broader checklist, name supported OS/AT versions and assign human reviewers before implementation. This is a proposed bar, not a claim of certification.

### Q8 — Theme and custom-accent accessibility policy

**Decided 2026-09-23 by the owner:** option (a), scoped. Qualify the four built-in themes (dark, neon-glow, midnight, light) and the High Contrast toggle at the Q1 thresholds, and the ten preset accent swatches with them. A custom accent is honoured for fills and decoration. Three tokens are derived from it at apply time: `--on-accent` (white or near-black by WCAG relative luminance, used for all text on accent surfaces), `--accent-hover` and `--accent-active`. Where the accent itself is the text or the focus indicator and its contrast against the theme background is below 3:1, those uses fall back to the theme's default accent; fills keep the user's colour. One line under the accent input discloses this: "Custom colours may reduce readability; text and focus indicators fall back to a readable colour when needed, and High Contrast restores tested colours."

**Options and consequences:** Qualify every built-in theme and provide a contrast-safe fallback for arbitrary custom accents; or require/warn users to adjust custom themes themselves. Fallback preserves readable controls but can alter chosen colors; warnings preserve exact choices but cannot establish an all-settings contrast claim.

**Drafting recommendation (historical):** Qualify built-ins and high-contrast mode, retain identity, and approve a safe fallback for essential text/focus indicators. The owner must decide how custom accents are constrained or disclosed.

**Clarified 2026-09-23 by the owner (during B9-2):** Q8 accent-as-text threshold aligned to Q1's 4.5:1; 3:1 applies to focus/non-text. The accent is used as text only at 4.5:1 or better and as the focus indicator only at 3:1 or better, against the minimum over the four `--bg-*` surfaces. Below either, that use falls back to the theme's tested colour, and fills are unchanged. Recorded in the PRD's Q8 block.
