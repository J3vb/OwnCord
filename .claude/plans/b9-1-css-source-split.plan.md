# Plan: B9-1 — Split app.css without changing its output

**Status:** COMPLETE — native AT recordings declined by owner 2026-09-24 — 2026-09-23 at `dev` `c80c8094`, emitted CSS re-run unchanged at merge base `dev` `3c7dd486`; evidence in `docs/plans/b9-css-split-evidence-2026-09-23.md`.

> **Milestone:** B9-1 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `refactor/b9-1-css-source-split`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 11. **Requirements:** BPR-090, BPR-091.
> **Dependencies:** B9-0. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

A source move only: no visual or behavior changes.

**User journey:** Open shell, messages, settings, voice controls, quick switch and modal dialogs in every supported built-in theme.

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

| #   | Verified current state                                                                                                      | Evidence at planning commit                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The entry imports tokens, base, login, app and neon-theme CSS in that order. Preserve this cascade.                         | `Client/src/main.ts:3-7`                                                                                                                            |
| 2   | app.css owns shell/sidebar rules and later quick-switch and NSFW sections. Existing tokens/base files are already separate. | `Client/src/styles/app.css:1-82`; `Client/src/styles/app.css:4875-4905`; `Client/src/styles/app.css:5073-5121`; `Client/src/styles/tokens.css:1-29` |
| 3   | The supplement requires selector and built-output preservation, with visual changes separate.                               | `docs/plans/developer-experience-layout-refactor-2026-08-29.md:381-407`                                                                             |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

No protocol, persistence or server change; pure source relocation.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Client/src/styles/app.css; Client/src/styles/app/**/*.css (new)`                      | Ordered source sections and import manifest            |
| `Client/src/main.ts`                                                                   | Only if import composition requires it; preserve order |
| `docs/plans/b9-css-split-evidence-<date>.md (new)`                                     | Output equivalence and visual/accessibility baseline   |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan | Dated implementation status and exact-SHA evidence     |

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

### Task 1: Capture an equality oracle

Build desktop CSS at the start SHA with the locked toolchain; retain emitted CSS bytes and ordered rule/declaration inventory. Save desktop screenshots and computed-style samples for the six accessibility checks.

### Task 2: Move contiguous sections only

Use owned shell, messaging, sidebar, voice/video, settings, overlays and responsive/accessibility files. Keep tokens/base ownership already present. Use an import manifest or multiple ordered fragments where regrouping by domain would reorder a selector; do not deduplicate, rename, reformat declarations, introduce layers or change specificity.

### Task 3: Prove unchanged output

Compare emitted CSS bytes with build metadata/source-map references separately accounted for. If the bundler makes byte equality impossible, stop and explain the exact non-semantic difference; require ordered CSS AST/declaration equality plus owner review, not screenshots alone.

### Task 4: Record the mechanical diff

Store before/after hashes, comparison command, toolchain and pre-squash PR head. Update only style ownership guidance; any discovered visual defect gets a separate behavioral PR.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/unit/msg-actions-bar-focus-css.test.ts; Client/tests/e2e/main-layout.spec.ts; Client/tests/e2e/theme-persistence.spec.ts
- New evidence: emitted CSS hash/ordered AST comparison; keyboard/focus screenshots before and after

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

Grouping all rules for a feature together can change the cascade. Never mix a contrast or layout fix into this PR.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
