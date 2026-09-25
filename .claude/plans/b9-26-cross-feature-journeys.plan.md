# Plan: B9-26 — Qualify complete desktop privacy, moderation and lifecycle journeys

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-26 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-26-cross-feature-journeys`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 10, 8. **Requirements:** BPR-060..064, BPR-070..073, BPR-090..092.
> **Dependencies:** B9-6, B9-7, B9-9, B9-10, B9-11, B9-12, B9-13, B9-14, B9-15, B9-16, B9-17, B9-18, B9-19, B9-20, B9-21, B9-22, B9-23, B9-24, B9-25. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Qualify complete desktop privacy, moderation and lifecycle journeys. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Run the connected end-to-end journeys with both allowed and refused roles, network loss, reconnect, erasure and retention.

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

| #   | Verified current state                                                                                                             | Evidence at planning commit                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | The client already has distinct unit, contract, frontend, native and fullstack commands. Use them for what they prove.             | `Client/package.json:20-45`                                          |
| 2   | Existing accessibility smoke uses mocked Tauri session setup; it cannot prove native privacy traffic or OS screen-reader behavior. | `Client/tests/e2e/a11y-smoke.spec.ts:1-24`                           |
| 3   | Server/client consent and moderation evidence obligations are named in the B5 exit follow-up.                                      | `docs/plans/b5-community-content-moderation-2026-09-04.md:2940-2968` |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

All B4/B5/B7 contracts; preserve server authority, consent before admission and separate recipient/moderator DTOs. B8 is explicitly not qualified here.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                           | Purpose                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `Client/tests/e2e/fullstack/b9-journeys.spec.ts (new); Client/tests/e2e/native/b9-journeys.spec.ts (new)`      | Integration of already-built journeys               |
| `docs/plans/b9-journey-evidence-<date>.md (new)`                                                               | Requirement/role/platform/network evidence manifest |
| `docs/plans/beta-requirements-traceability-2026-08-23.md; docs/plans/repo-health-issue-register-2026-08-23.md` | Truthful desktop closure and remaining blockers     |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                         | Dated implementation status and exact-SHA evidence  |

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

### Task 1: Complete the journey matrix

Tie every B9 requirement and inherited client half to the specific automated test, native/manual recording, role/mode, exact SHA and result. Include privacy, report/appeal, deletion/retention, block, session replacement and compatibility.

### Task 2: Run integrated lifecycle cases

Exercise first contact → safe preview → accept/block, labelled content → acknowledge/revoke → evidence, report → action → appeal → erasure/retention, and recovery/session switching through the real service contract. Use two accounts/devices without violating the one-live-socket rule.

### Task 3: Measure native privacy and accessibility

Collect first-party requests, native broker counters/capture and provider traffic; test warm-cache re-entry and logout. Run the approved keyboard, pointer, contrast, motion and zoom/reflow matrix on desktop targets; the screen-reader clause is met by the automated ARIA name/role and keyboard/focus evidence, with no manual screen-reader pass (owner decision 2026-09-24). Synthetic test data only.

### Task 4: Ratchet and reconcile

Compare bundle/startup/interaction/memory against accepted B7/B9 baselines, update traceability with desktop-qualified evidence and explicit B8 deferrals. New defects become canonical findings/private advisories and their own small fix PRs; this evidence PR does not hide broad product fixes.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Proposed: fullstack/b9-journeys.spec.ts; native/b9-journeys.spec.ts
- Required: every named feature test above, automated accessibility report, manual AT checklist, network capture, role matrix and bundle/runtime report

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

A collection of passing isolated tests is not end-to-end qualification. Preserve recordings and actual server/native traffic at one named integration SHA.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record — 2026-09-25

Branch `fm/b9-26-impl`; drafted at `0beee8e4`, an ancestor of the base with 84
commits between them (B9-1..B9-25 merged, the root agent guides #1796). `dev`
`0a3e7183` was merged into the lane (merge, not rebase). Q13 applied: no token
file was edited, no Aurora treatment adopted, and no existing English string
changed. No production code changed — this is a qualification lane and no
journey exposed a defect.

The pipeline's review gate returned nine findings; the owner decided F1–F4 are
required by this plan (fix, do not narrow the claims) and F5–F9 are also fixed.
The pipeline's own fix round hit its 30-minute wall-clock limit, so the fixes
were implemented as ordinary commits on this branch, per the 2026-09-25
instruction.

### Tasks

- **Task 0** verified the inventory at the real base (all three rows hold) and
  recorded the drift; the budgets hold at the base.
- **Task 1** is the journey matrix in
  [b9-journey-evidence-2026-09-25.md](../../docs/plans/b9-journey-evidence-2026-09-25.md):
  each requirement tied to a test, with allowed/refused roles, network, platform
  and result columns, and a per-requirement coverage map (BPR-060..064,
  070..073, 090..092).
- **Task 2** ships nine real-server journeys in
  `Client/tests/e2e/fullstack/b9-journeys.spec.ts`: report → warn → notice →
  appeal → decision (BPR-070..073); retention → reported+appealed self-erasure →
  observer cleanup with the report outcome surviving (BPR-052/BPR-054, BPR-070);
  first-contact → text-only preview (real network interception) → accept → block
  → composer gating (BPR-060); second-device displacement → "Use here"
  (BPR-090); recovery-kit → logout → recovery (BPR-090); network cut → B9-25
  notice → reconnect with state kept (BPR-090/BPR-092); refused roles (queue,
  list and decide all 403 with no UI entry) (BPR-071); consent → acknowledge →
  revoke → evidence (BPR-063/BPR-071); and the integrated 940×500/keyboard/
  reduced-motion matrix (BPR-091). The one-live-socket rule is respected.
- **Task 3** ships the native privacy journey in
  `Client/tests/e2e/native/b9-journeys.spec.ts` (registered in
  `playwright.config.native.ts`'s `native-core` project): consent gates the
  broker, "Ask each time" admits exactly the activated item (a length
  assertion), a warm-cache re-entry after consent does not refetch, every
  first-party HTTP destination is the configured server, and logout keeps that
  confinement. Runs in Windows CI; the manifest records it as **pending that
  run**, not desktop-qualified. Its automated ARIA/keyboard evidence stands in
  for the dropped manual screen-reader pass (owner 2026-09-24).
- **Task 4** re-baselined the budgets at this base: MainPage 64,000 → 63,500 B,
  livekit 135,000 → 134,500 B and livekitSession 24,000 → 23,500 B (each
  measured + a small documented headroom; startup stayed 97,000 B, already the
  tightest the ratchet rule allows). No budget was raised. The startup and
  memory baselines are the accepted B7 desktop figures, not measurable on this
  headless host; the automatable proxies (production bundle sizes and the
  keyed-reconciler interaction probe, `tests/unit/reconcile.test.ts`, 7 passed)
  are recorded. BPR-061/BPR-062 keep their B5/B7 status; B8 stays deferred.
- **Task 5** recorded the commands, exact head, results and limits in the
  evidence manifest, and updated the PRD status table (B9-25 was merged this
  cycle, so its row moves from Pending), this plan, the traceability header,
  the README summary and the register rows.

### Validation

From `Client/` at this head: `npx tsc -p tsconfig.e2e.json --noEmit` (clean);
`npx playwright test --config playwright.config.fullstack.ts
tests/e2e/fullstack/b9-journeys.spec.ts --workers=1` (9 passed);
`npx vitest run tests/unit/reconcile.test.ts` (7 passed); `npm run
build:budget && npm run check:budgets` (all budgets ok). The full component
gates run in CI on the PR; the native journey is CI-only (no Windows host here).
