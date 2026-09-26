# Plan: B9-14 — Finish narrow removal, kick, ban and effective voice controls

**Status:** IMPLEMENTED — OS-zoom check pending owner; native AT recordings declined by owner 2026-09-24 — 2026-09-24 on branch `fm/b9-14-impl` from `dev` `c215cadeb4e16bff71f9ecac5261b50b27f0a453`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24).

> **Milestone:** B9-14 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-14-removal-kick-ban-controls`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 4, 5, 8. **Requirements:** BPR-072, BPR-091.
> **Dependencies:** B9-13. Q5 prerequisite: the separate server PR adding `can_moderate_voice` (decided 2026-09-23; not yet implemented). All product work also requires the PRD entry gate.
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

Per Q5 (decided 2026-09-23) this client obtains authoritative per-channel voice affordances from the server-computed `can_moderate_voice` channel boolean. That server projection is a separate prerequisite PR and must be planned before this client milestone starts. Do not copy an incomplete override algorithm or request broader admin data.

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

Permission presentation needs data the client can lawfully read. Until the Q5 `can_moderate_voice` prerequisite PR is accepted this milestone is blocked, not satisfied by server rejection alone.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q5 — Effective voice moderation affordance contract

**Decided 2026-09-23 by the owner:** option (a). A separate small server PR (protocol-change skill) adds one boolean, `can_moderate_voice`, to each channel object in `ready` and in the per-user `channel_create` refresh, beside `can_send`. It is computed by the existing `permissions.CanModerateVoice` for the caller in that channel (effective READ | MUTE_MEMBERS after both override layers). It is refreshed on the same events that refresh `can_send` today, plus a per-user `channel_update` push when a role or user override on that channel changes. The client shows the four voice-moderation actions only when `can_moderate_voice` is true; target rank, timeouts and destination capacity remain server-side refusals and are surfaced as such. No override data is exposed to members; no server authorization is rewritten.

**Options and consequences:** Provide a narrow server-computed capability projection for the caller in each channel; or expose sufficient authorized overrides for a complete client derivation. The first keeps policy canonical and payload small; the second duplicates more permission logic and data. Role-only controls with eventual server refusal do not close SEC-02's effective-permission UI requirement.

**Drafting recommendation (historical):** Approve a minimal server-derived projection as a separately planned prerequisite PR; settle its payload, refresh semantics and owner before B9-14. Do not silently widen B9-14 into a server authorization rewrite.

## Implementation record (2026-09-24)

### Drift at the implementation base

Re-read at `c215cade` (B9-13 #1784 merged); `dev` then moved to `646f2a43`
(B9-22 #1785, messaging accessibility, no moderation or sidebar file) and was
merged in.

- **Q5 is met.** The prerequisite server PR merged as
  [#1732](https://github.com/J3vb/OwnCord/pull/1732) (`22f2c884`): each
  channel in `ready` carries `can_moderate_voice`
  (`Server/ws/serve_ready.go:158-172`, `:245`, `channelCanModerateVoice`:
  base MUTE_MEMBERS, then effective READ|MUTE_MEMBERS after both override
  layers), and every targeted `channel_create` carries the caller's current
  verdict (`Server/ws/hub_visibility.go:299`, `:332`). It is refreshed on
  override edits (`RefreshChannelVisibility`), role-mask edits and a member's
  role change (`RefreshAllChannelVisibility`, `Server/admin/handlers_roles.go`,
  `handlers_users.go`), and a timeout (`RefreshUserChannels`,
  `Server/ws/moderation_actions.go:93-135`). The client type already declared
  it (`Client/src/lib/types.ts:161-168`, `:480-485`); the channels store did
  not keep it. The refresh uses `channel_create`, not the `channel_update`
  Q5's text names; the client treats both the same way (absent = unchanged).
- Row 1: `createVoiceModerationCallbacks` is now
  `Client/src/pages/main-page/VoiceCallbacks.ts:146-175`; unchanged in
  substance (fire-and-forget, no optimistic state; a refusal arrives as an
  `error` frame the dispatcher toasts).
- Row 2: `canModerateVoice` is `Client/src/components/ChannelSidebar.ts:185`
  and `roleHasPermission` `Client/src/lib/permissions.ts:49`; still
  role-level at the base.
- Row 3: unchanged (`docs/plans/hp-5-scorecard-2026-09-05.md:184-199`).
- Row 4: superseded by the Q5 bullet above: the ready channel now carries
  `can_moderate_voice` beside `can_send` (`Server/ws/serve_ready.go:242-245`).
- The report-linked act route already accepts `removal`, `kick` and `ban`
  (`Server/api/moderation_queue_handler.go:337-411`,
  `Server/service/moderation.go:604-647`): MODERATE_MEMBERS for the route,
  then MANAGE_MESSAGES in the message's channel (with READ) for removal
  (`message_crud.go:526-548`, no rank rule), KICK_MEMBERS plus rank for kick
  (`forceLogout`, `:798-848`, revokes every session and drops the socket),
  BAN_MEMBERS plus rank for ban; all refusals are 403 `FORBIDDEN` with no code
  telling a missing bit from rank. Removal of a message report needs no
  `message_id` (the server takes the report's target). Everything B9-14 needs
  is on `dev`: no server, protocol, schema or migration change.
- Observed, not changed (server, out of scope): removing a message that is
  already removed answers 500, because `writeServiceError` has no case for
  `ErrDeletedMessage` on this route; the client shows "Couldn't confirm this
  action. Check the history before trying again." and reads the report again.
  The client stops offering removal once the report's history has a removal,
  so this is left only for a message its author deleted after the report.

### What shipped

- **Removal, kick and ban** (`features/moderation/ActionForms.ts`), after
  warning, timeout and lift in the report's Actions section, to the moderator
  holding an open report (as B9-13): one reason field ("Reason for a removal,
  log-out or ban", optional, 500 characters, control characters sent as
  spaces) and one button per action the reader's role holds, each on its own
  bit (HP-5): "Remove reported message" (MANAGE_MESSAGES, and only on a
  report about a message), "Log out of every session" (KICK_MEMBERS: kick is
  a force logout, and the copy says they can sign in again), "Ban member"
  (BAN_MEMBERS). An unknown role (pre-`ready`, or not in the role list) holds
  none. The bit is read again when the confirmation is accepted, so an offer
  made before a demotion is not sent. Once the report's history has a
  removal, removal is no longer offered and the section says "The reported
  message was already removed." instead; kick and ban stay offered.
- **Confirmation** (the B9-6 `message-requests/decisions.ts` destructive
  confirm, built on `createModal`): a named modal dialog stating the effect
  (removal deletes for everyone on the server, not a local hide; kick signs
  them out everywhere and they can come back; ban keeps them out and is not
  undone from the Moderation Center), Cancel first and focused, Escape and
  the backdrop cancel, focus back on the opener (or, when a role change
  rebuilt the report meanwhile, the rebuilt button for the same action, else
  the report heading).
- **Committed outcome and refusals** (`Queue.ts`): each is one report-linked
  write (`POST /moderation/queue/{id}/act`, `{kind, reason}`) under B9-12's
  one-at-a-time guard, then the queue and report are read again. The status
  line speaks only after the server answers ("Message removed for everyone.",
  "Logged out of every session. They can sign in again.", "Member banned.
  They were disconnected and can't sign in again."). A 403 on removal is told
  apart by the server's message: an archived channel says so ("its channel is
  archived"), a permission refusal says the reader can't manage messages in
  its channel, and any other shows the server's own words; on kick or ban it
  says the role doesn't allow it or theirs isn't below the reader's (the server doesn't
  say which); no answer says the action could not be confirmed.
- **Live authority** (`Queue.ts`): a change to the reader's role or to the
  role list rebuilds the open report, so an action the role no longer holds
  stops being offered without a server round trip (focus stays on the same
  control, or the report heading if it went). While a read of the report is
  in flight the rebuild is skipped, so that read is not aborted; it renders
  with the current role itself.
- **History**: a kick row reads "Logged out of every session".
- **Effective voice controls** (`stores/channels.store.ts`,
  `components/ChannelSidebar.ts`, `channel-sidebar/volume-menu.ts`): the
  store keeps each channel's `can_moderate_voice` (ready sets it; a targeted
  `channel_create` replaces it, and one without the field leaves it). The
  participant menu reads the row's channel verdict when it opens: true offers
  Server Mute/Deafen, Move and Disconnect; false offers none, whatever the
  role; absent offers none and, only to a role holding MUTE_MEMBERS, says
  "Voice moderation unavailable: the server hasn't confirmed you can moderate
  this channel." (disabled text). Rank, timeouts and destination access stay
  server refusals, surfaced by the existing error toast. No override data is
  read or exposed; `VoiceCallbacks.ts` needed no change.

### Implementation decisions and file-table amendments

- **No `permissions.ts` helper.** The three bits are read with the existing
  `currentUserHasPermission` inside the lazy Moderation Center
  chunk (`mayEnforce`), so nothing new lands in the startup or MainPage
  chunks; the voice gate is the server's per-channel verdict, not a role
  helper. `VoiceCallbacks.ts` is unchanged (its sends were already
  server-authorized, with no optimistic state).
- **Files beyond the table**, each narrow wiring: `lib/api.ts` (the act
  request type gains `removal | kick | ban`; the shared single-writer file, as
  B9-11..13 did), `stores/channels.store.ts` (keep the server's
  `can_moderate_voice`, one optional field; the only way the sidebar can read
  it), `components/channel-sidebar/volume-menu.ts` (the disabled reason),
  `features/moderation/{Queue,History,api}.ts` (send and word the writes,
  rebuild on role change, the kick history label, the report's
  `target_type`), the `moderation` and `voice` catalogs, the colocated
  `features/moderation/effective-controls.test.ts` (the plan's proposed unit
  test), `tests/unit/channel-sidebar.test.ts`, and the mocked
  `tests/e2e/b9-moderation-actions.spec.ts` (the Q1 checks).
- **Not touched:** navigation, MainPage, dispatcher registration, tokens,
  styles (no CSS: the section and dialog reuse `mod-work-form`, `modal-*`,
  `btn-danger`), the catalog API, and the PRD (its shared status table and
  per-lane paragraphs are left alone; this record is the status).
- **Budget.** Before/after at the base (`build:budget`): startup closure
  96,130 → 96,151 B of 97,000 B, MainPage 61,325 → 61,418 B of 64,000 B; no
  budget change. The actions, dialog and copy load with the lazy Moderation
  Center chunk; the growth is the store field and the sidebar gate. After
  merging `646f2a43` (B9-22) the head measures startup 96,210 B and MainPage
  61,681 B, still within budget. After merging `dev` with B9-17 (#1786; the Moderation
  Center's Appeals tab, which hoisted `actionErrorText` to module level, where
  B9-14's refusal wording now lives) it measures startup 96,368 B and MainPage
  61,656 B. On that merge the whole unit suite (6,815 passed, 152
  expected-fail), the mocked `b9-moderation-actions`, `b9-appeal-review` and
  `emoji-voicemod.parity` (44 passed) and fullstack `b9-moderation-actions`
  and `b9-appeal-review` (3 passed) were re-run green. The PRD status table is
  left as `dev` has it; this record is B9-14's status.

### Evidence

Base `c215cade`, `dev` `646f2a43` merged; Node 26.9.0, vitest 4.1.11,
Playwright 1.63.0 Chromium, Go 1.26.7, Linux. Local Playwright ran on ports
1437 (dev server) and 4183 (preview, with
`OWNCORD_SERVER_ALLOWED_ORIGINS=http://localhost:4183` and a local-only
fixture base URL), never 1420 or 4173.

| Check                                                                                               | Result                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npx vitest run --maxWorkers=4` (whole client, after merging `646f2a43`)                            | 312 files, 6,793 passed, 152 expected-fail             |
| `src/features/moderation/effective-controls.test.ts` + `tests/unit/channel-sidebar.test.ts`         | 23 + 118 passed                                        |
| Failing control: the same two files against the base source (production files reverted, tests kept) | 21 fail, as intended                                   |
| Playwright mocked: `emoji-voicemod.parity`, `sidebar-menus`, `b9-moderation-actions` (23)           | 17 and 23 passed; against the base 3 parity cases fail |
| Playwright fullstack (real Go server): `b9-moderation-actions` (B9-13's test and B9-14's)           | 2 passed; against the base B9-14's fails               |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint`                             | clean                                                  |
| `npm run build:budget && npm run check:budgets`                                                     | all ok                                                 |

**Permission matrix** (fullstack, synthetic accounts: alice owner; bob in the
client under single-bit roles, all MODERATE_MEMBERS plus one bit, positions
47-50 below Moderator; carol reporter and a plain member; dave the subject,
signed in on a second client):

| Case                                          | Offered in the client                         | Server answer / effect                                                 |
| --------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| Member (carol)                                | no Moderation Center                          | act `ban` 403                                                          |
| MODERATE_MEMBERS + MANAGE_MESSAGES            | Remove reported message only                  | API kick/ban 403; removal 204, gone on dave's client, ledger `removal` |
| MODERATE_MEMBERS + KICK_MEMBERS (live change) | Log out of every session only, with no reload | 204; dave's client leaves the app; ledger `kick`                       |
| MODERATE_MEMBERS + BAN_MEMBERS, dave superior | Ban member; shows the refusal                 | 403, ledger unchanged                                                  |
| Demoted with the confirm dialog open          | offer withdrawn; confirming sends nothing     | no request, ledger unchanged                                           |
| Demoted while his frames are lost             | stale offer; shows the refusal                | 403, ledger unchanged                                                  |
| BAN_MEMBERS, dave a member                    | Ban member                                    | 204; ledger `ban`; history "You issued: Ban"                           |
| TLS, backup, update                           | never offered by any of these controls        | owner-only, unchanged (HP-5)                                           |

**Voice override matrix** (unit and mocked Playwright; the server side is
#1732's own tests, and a live LiveKit session is not run locally): verdict
true offers the four actions and sends `voice_mod_mute {channel_id, user_id}`
and `voice_mod_kick {user_id}`; verdict false (an override denying a role
that holds every bit) offers none and no hint; a role without MUTE_MEMBERS
gets none; one channel's verdict never applies to another; a targeted
`channel_create` flips it both ways at the next open and one without the
field leaves it; no verdict offers none and gives the reason to a
MUTE_MEMBERS role only. Timeout voice ownership and media state are not
touched: the menu only decides what to offer, and a refusal is the existing
error toast.

**Accessibility** (mocked Playwright, `b9-moderation-actions.spec.ts`):
keyboard order Lift timeout → reason → Remove → Log out → Ban, each operable
with Enter/Space; the dialog is `role="dialog"` with `aria-modal`, named by
its heading, Cancel focused, Tab and Shift+Tab stay inside, Escape cancels
and returns focus to the opener; outcomes are announced in the
`role="status"` line only after the answer and refusals in `role="alert"`;
no unnamed control; dialog targets at least 24×24 px and no animation; text
and focus contrast of the new controls and the dialog at the Q1 thresholds
in dark, neon-glow, midnight and light, each with and without High Contrast
(per-theme ratios attached as `b9-14-contrast-*.json`); at 940×500 with
20 px Large Font the actions and the dialog stay in view with no sideways
scroll (screenshot attached). The voice menu's disabled reason is text with
`aria-disabled`; the menu's own keyboard access is B9-24's scope and is
unchanged here. Custom-accent fallback is inherited unchanged from B9-2 (no
new colour). **Owner-run pending:** the 200 % OS-zoom check. NVDA (Windows)
and Orca (Linux) recordings were declined by the owner 2026-09-24.
