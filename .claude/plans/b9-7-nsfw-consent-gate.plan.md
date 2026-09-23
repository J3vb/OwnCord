# Plan: B9-7 — Make NSFW consent an authoritative pre-load gate

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-7 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-7-nsfw-consent-gate`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 3, 8. **Requirements:** BPR-063, BPR-091.
> **Dependencies:** B9-4. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Make NSFW consent an authoritative pre-load gate. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Enter a labelled channel, decline, fail acknowledgement, accept, revoke, reconnect and use a second device, including search/pins and cached media.

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

| #   | Verified current state                                                                                                                                        | Evidence at planning commit                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The client prompt calls a sessionStorage acknowledgement helper; its comments still describe label-only server behavior. This disagrees with the B5 contract. | `Client/src/components/NsfwGate.ts:87-94`; `Client/src/lib/nsfw-gate.ts:1-15`; `Client/src/lib/nsfw-gate.ts:50-65`                                                              |
| 2   | ChannelController mounts message UI before its current overlay section. Replace the composition order, not just the overlay styling.                          | `Client/src/pages/main-page/ChannelController.ts:457-458`; `Client/src/pages/main-page/ChannelController.ts:537-590`; `Client/src/pages/main-page/ChannelController.ts:783-805` |
| 3   | The server sends per-caller nsfw_acknowledged and exposes authenticated PUT/DELETE acknowledgement with 204 on success.                                       | `Server/ws/serve_ready.go:228-237`; `Server/api/nsfw_handler.go:20-25`; `Server/api/nsfw_handler.go:36-78`                                                                      |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

PUT/DELETE /api/v1/channels/{id}/nsfw-acknowledgement; ready.nsfw_acknowledged; nsfw_ack. B5 per-user/per-channel consent is independent of external-provider permission; moderators must acknowledge too. Moderation evidence remains blocked on B5 acceptance.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                          | Purpose                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Client/src/components/NsfwGate.ts; Client/src/lib/nsfw-gate.ts; Client/src/pages/main-page/ChannelController.ts`             | Replace the local overlay contract with pre-load composition  |
| `Client/src/features/content-consent/** (new); Client/src/lib/{api,types,dispatcher}.ts; Client/src/stores/channels.store.ts` | Authoritative consent and serialized global wiring            |
| `Client/src/components/{SearchOverlay,PinnedMessages}.ts; Client/src/components/message-list/{attachments,media,embeds}.ts`   | Gate alternate content entry points and revoke lifecycle only |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                                        | Dated implementation status and exact-SHA evidence            |

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

### Task 1: Consume server consent

Add nsfw_acknowledged and nsfw_ack payload types/state. Replace sessionStorage authority with server/account/channel state from ready and confirmed PUT/DELETE responses. Treat unknown state as gated; never silently migrate a local acknowledgement into server consent.

### Task 2: Gate before composition

Do not mount content, fetch history/search/pins/attachments, invoke broker methods or create provider frames until consent is authoritative. Gate the selected NSFW surface at its first content request and test alternate entry points, not only channel navigation.

### Task 3: Implement acknowledgement and revoke

Show clear scope and privacy copy; wait for successful PUT before opening. On revoke, relabel, permission loss, logout or account switch, unmount protected content, clear scoped caches and prevent in-flight results from repopulating it. Reconnect uses authoritative ready state; a new device inherits server consent.

### Task 4: Prove zero pre-consent traffic

Record native broker invocations, first-party content requests and provider traffic before acknowledgement, after failure, after revoke and after reconnect. Preserve B7 broker bounds. If cancellation of already-running native work needs a seam extension, record it as a dependency rather than claiming the current interface supports abort.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/unit/nsfw-gate.test.ts; Server/api/nsfw_handler_test.go; Server/ws/nsfw_gate_test.go
- Proposed: content-consent/nsfw.test.ts; Client/tests/e2e/fullstack/b9-nsfw-consent.spec.ts; native consent network capture

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

The current native broker interface has no AbortSignal. Prevent admission and discard stale results; prove or separately provide actual cancellation when required. Never describe stale-result suppression as network cancellation.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
