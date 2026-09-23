# Plan: B9-14 — Finish narrow removal, kick, ban and effective voice controls

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-14 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-14-removal-kick-ban-controls`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 4, 5, 8. **Requirements:** BPR-072, BPR-091.
> **Dependencies:** B9-13. Q5-approved effective-capability prerequisite. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Finish narrow removal, kick, ban and effective voice controls. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Remove reported content, force-log out a user, ban a lower-ranked target and exercise voice controls under changing channel overrides.

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

| #   | Verified current state                                                                                                          | Evidence at planning commit                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Existing voice callbacks send channel-specific mute/deafen and move/kick frames without optimistic state mutation.              | `Client/src/pages/main-page/VoiceCallbacks.ts:143-173`                                   |
| 2   | The sidebar currently decides mute affordances from role-level permission. It is not a complete effective-channel projection.   | `Client/src/components/ChannelSidebar.ts:178-185`; `Client/src/lib/permissions.ts:49-52` |
| 3   | HP-5 assigns removal, force-logout kick and ban to separate permissions; operational controls remain owner-only.                | `docs/plans/hp-5-scorecard-2026-09-05.md:184-199`                                        |
| 4   | The server returns per-channel can_send, not a general effective moderation capability set, in this ready-channel construction. | `Server/ws/serve_ready.go:210-242`                                                       |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

MANAGE_MESSAGES, KICK_MEMBERS, BAN_MEMBERS and canonical effective voice authorization stay separate. SEC-02 public UI carryover is covered here; server policy is not relaxed.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                       | Purpose                                                  |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Client/src/features/moderation/ActionForms.ts; Client/src/lib/permissions.ts`                             | Removal/kick/ban and shared affordance helper            |
| `Client/src/components/ChannelSidebar.ts; Client/src/pages/main-page/VoiceCallbacks.ts`                    | Effective voice controls; no voice state-machine rewrite |
| `Client/tests/e2e/fullstack/b9-moderation-actions.spec.ts; Client/tests/e2e/emoji-voicemod.parity.spec.ts` | Action and override role evidence                        |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                     | Dated implementation status and exact-SHA evidence       |

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

### Task 1: Resolve the effective-capability handoff

Q5 must name how this client obtains authoritative per-channel voice affordances. A narrowly reviewed server projection, if chosen, is a separate prerequisite PR and must be planned before this client milestone starts. Do not copy an incomplete override algorithm or request broader admin data.

### Task 2: Wire removal, kick and ban

Use existing report-linked act and existing narrow direct actions where already supported. Distinguish removal from deleting a local view, and kick from a ban: kick means force logout. Confirm irreversible effects using the shared pattern.

### Task 3: Unify voice affordances

Use the accepted effective-permission signal for each current channel, invalidate on role/override/channel changes and retain server-authorized command responses. Unknown authority keeps controls unavailable with a reason.

### Task 4: Prove narrow authority

Record member, each single-bit role, denied/allowed channel override, hierarchy and role-change cases. Confirm no control opens TLS, backup or update operations. Preserve timeout voice ownership and media state through refusal.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/admin-moderation.spec.ts; Client/tests/e2e/emoji-voicemod.parity.spec.ts; Server/service/moderation_test.go
- Proposed: moderation/effective-controls.test.ts; expanded fullstack/b9-moderation-actions.spec.ts

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

Permission presentation needs data the client can lawfully read. Until Q5 and its prerequisite are complete this milestone is blocked, not satisfied by server rejection alone.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q5 — Effective voice moderation affordance contract

**Options and consequences:** Provide a narrow server-computed capability projection for the caller in each channel; or expose sufficient authorized overrides for a complete client derivation. The first keeps policy canonical and payload small; the second duplicates more permission logic and data. Role-only controls with eventual server refusal do not close SEC-02's effective-permission UI requirement.

**Recommendation (not approved):** Approve a minimal server-derived projection as a separately planned prerequisite PR; settle its payload, refresh semantics and owner before B9-14. Do not silently widen B9-14 into a server authorization rewrite.
