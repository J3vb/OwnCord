# Plan: B9-22 — Polish desktop message reading, composing and related overlays

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-22 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-22-messaging-interaction-polish`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8. **Requirements:** BPR-090, BPR-091.
> **Dependencies:** B9-19, B9-7. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish desktop message reading, composing and related overlays. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Read old messages, jump to present, receive a new message, compose/reply/edit and use search/pins entirely by keyboard and screen reader.

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

| #   | Verified current state                                                                         | Evidence at planning commit                                                                    |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | MessageList virtualizes rows and uses ResizeObserver plus an anchor to preserve position.      | `Client/src/components/MessageList.ts:911-918`; `Client/src/components/MessageList.ts:953-967` |
| 2   | MessageInput supports selection-based formatting shortcuts; keep native text editing behavior. | `Client/src/components/MessageInput.ts:64-68`; `Client/src/components/MessageInput.ts:77-98`   |
| 3   | Existing focus helpers support roving navigation, including Enter/Space and Home/End.          | `Client/src/lib/a11y.ts:95-160`                                                                |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Preserve B5 read/block/NSFW restrictions and B7 delivery/retry invariants. No new history or message protocol.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                      | Purpose                                            |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/{MessageList,MessageInput,SearchOverlay,PinnedMessages}.ts; Client/src/components/message-list/**` | Only measured interaction/semantics fixes          |
| `Owned messaging/overlay CSS from B9-1; feature catalogs`                                                                 | Scoped polish and accessible copy                  |
| `Client/tests/e2e/b9-messaging-polish.spec.ts (new)`                                                                      | Virtualized reading/composition journey            |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                                    | Dated implementation status and exact-SHA evidence |

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

### Task 1: Enumerate the reading workflow

Cover unread jump, history loading, live arrival, reply, edit/delete, reaction, autocomplete, search and pins. Add failing checks only for measured gaps, retaining the fixed timestamp/identity behavior from the ledger.

### Task 2: Fix semantic and focus behavior

Keep the active message/control reachable through virtualization, give icon controls usable names, preserve text selection and avoid announcing the entire history on every update. Ensure context actions work without hover.

### Task 3: Fix scoped layout/state inconsistencies

Apply owned messaging/overlay styles for long content, error/retry, empty search and large text; preserve scrolling and consent before media construction.

### Task 4: Record end-to-end accessibility

Test keyboard and screen reader through history pagination and new messages, the Q1-approved text scaling and desktop zoom/reflow (proposed: 200% text/400% zoom or equivalent reflow), reduced motion and contrast. Keep measured list performance within baseline.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/message-list.spec.ts; Client/tests/e2e/composer-advanced.spec.ts; Client/tests/e2e/message-actions.spec.ts
- Proposed: b9-messaging-polish.spec.ts; focused virtual-row retention unit tests

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

Virtualization can remove the focused row or create noisy announcements. Accessibility tests must exercise window changes, not a static five-message screen.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
