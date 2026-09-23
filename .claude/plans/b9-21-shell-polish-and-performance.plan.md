# Plan: B9-21 — Polish desktop shell navigation without rebuilding it on every update

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-21 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-21-shell-polish-and-performance`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8. **Requirements:** BPR-090, BPR-091.
> **Dependencies:** B9-4, B9-18. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish desktop shell navigation without rebuilding it on every update. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Keep focus on a channel or DM while names, presence and unread counts change; navigate a long server list at high zoom.

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

| #   | Verified current state                                                                                    | Evidence at planning commit                            |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | SidebarArea documents an O(n) rebuild on DM/member changes. Measure this current path before changing it. | `Client/src/pages/main-page/SidebarArea.ts:660-673`    |
| 2   | Quick-switch height and scrolling are already bounded; OC-0372 is not an open implementation task.        | `Client/src/styles/app.css:4875-4905`                  |
| 3   | The embedded DM section clears and rebuilds its visible rows.                                             | `Client/src/pages/main-page/SidebarDmSection.ts:70-75` |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

No server changes; preserve B7 one active connection/media session and account-scoped caches.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                                 | Purpose                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `Client/src/pages/main-page/SidebarArea.ts; Client/src/pages/main-page/SidebarDmSection.ts; Client/src/components/ChannelSidebar.ts` | Measured incremental rendering and keyboard behavior |
| `Owned shell/sidebar CSS from B9-1`                                                                                                  | Scoped desktop polish                                |
| `Client/tests/e2e/b9-shell-polish.spec.ts (new)`                                                                                     | Focus, scroll and performance evidence               |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                                               | Dated implementation status and exact-SHA evidence   |

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

### Task 1: Measure the exact interaction

Capture update latency, DOM replacements, focus and scroll behavior under the accepted representative member/channel/DM fixture. Preserve the accepted B7 startup and memory baseline.

### Task 2: Make bounded incremental updates

Replace unnecessary full rebuilds with keyed updates only where the measurement proves value. Preserve row identity, keyboard focus, current selection, unread/mention semantics and active call state.

### Task 3: Apply agreed shell consistency

Use existing identity and B9-2 tokens for spacing, empty/error/loading states and narrow desktop reflow. Do not remove navigation or rely on clipping when zoomed.

### Task 4: Compare evidence

Record before/after timing and screenshots on the same hardware/settings, including large profile lists and role/name/presence changes. Reject a faster implementation that changes announcements or focus.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/channel-sidebar.spec.ts; Client/tests/e2e/sidebar-header.spec.ts; Client/tests/e2e/server-profiles.spec.ts
- Proposed: b9-shell-polish.spec.ts; keyed-row identity/performance test

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

Keyed rendering can retain stale closures or subscriptions. Keep Disposable/session ownership and test deletion/reorder cases.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
