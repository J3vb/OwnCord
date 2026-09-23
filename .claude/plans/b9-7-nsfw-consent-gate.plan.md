# Plan: B9-7 — Make NSFW consent an authoritative pre-load gate

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-7-impl` from `dev` `166d71e4`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-23).

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

### Drift at the implementation base (2026-09-23)

Re-read at `166d71e44ce5dfde6455e3f108ce88a8def9c88f` (B9-4 merged). All three
rows still hold at the cited ranges: the client helper and its label-only
comments (row 1), ChannelController mounting the list, typing indicator and
composer before the overlay section (row 2; the overlay block sat at
`:783-805`), and the server's `nsfw_acknowledged`/PUT/DELETE contract (row 3).
Drift found beyond the table: the pins and search loaders live in
`pages/main-page/OverlayManagers.ts`, not in `SearchOverlay.ts`/`PinnedMessages.ts`;
around-window jumps are fetched by `pages/main-page/MessageJump.ts`; a
full-ready resync refetches the active channel from
`features/messaging/wsHandlers.ts`; and `EditChannelModal.ts` told moderators
the label filters nothing. `types.ts`'s `ServerMessage` union had no
`nsfw_ack` member although the generated `protocolTypes.ts` names the type.

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

## Implementation record (2026-09-23)

### Implementation decisions and file-table amendments

- **One authority.** The account's acknowledgement is a field on the channel
  store row (`Channel.nsfwAcknowledged`), written only from `ready`, a 204 from
  `PUT`/`DELETE /api/v1/channels/{id}/nsfw-acknowledgement`, and the `nsfw_ack`
  frame (registered in `dispatcher.ts`, body in `features/channels/wsHandlers.ts`),
  or cleared by a server `403 NSFW_ACKNOWLEDGEMENT_REQUIRED` on a content read.
  Absent reads as not acknowledged. Clearing the label drops it (the server
  deletes the rows), so a relabel gates again; a re-sent `channel_create` keeps
  it. `lib/nsfw-gate.ts` and its sessionStorage keys are deleted, never migrated;
  logout clears consent with the channel store.
- **One admission point.** `features/content-consent/nsfw.ts` holds the
  predicate. `api.ts` wraps every channel content read — history, around,
  pins, reaction users and single-channel search — so a gated channel is
  refused locally with the server's own `403 NSFW_ACKNOWLEDGEMENT_REQUIRED`
  before any request, and a response that lands after consent was withdrawn is
  discarded. A server refusal of a read the store thought consented marks the
  channel not acknowledged, so the gate takes over (defence in depth: a resume
  that missed an `nsfw_ack` already gets a full `ready`). Whichever feature
  asks, nothing is fetched pre-consent. This is stale-result suppression, not
  network cancellation.
- **Gate before composition.** `ChannelController` mounts the header, then,
  for a gated channel, only the gate: no list, typing indicator, composer or
  history fetch, and the channel's delivered rows are dropped
  (`clearChannelContent`, a new `messages.store` mutator). A subscription on
  the channel's consent state remounts it whenever it crosses the gate —
  accepted, revoked here or on another device, relabelled, or restated by
  `ready`; labelling or unlabelling consented content only adds or removes the
  withdraw bar, so the composer keeps its draft. Revoking aborts the mount's
  signal. The gate waits for the 204 before opening and
  shows an error on failure. An acknowledged channel shows a withdraw bar.
- **Alternate entry points.** The pins panel does not open behind the gate,
  search behind it offers only server-wide search (the server already omits
  unacknowledged channels there), and a jump into a gated channel defers to the
  gate without a toast. When any channel falls behind the gate, a pins panel
  opened for it and the search overlay close (`ChatArea.ts`); when the mounted
  channel does, the image lightbox closes too. The global embed/media caches
  are URL-keyed and only read while rendering a consented row, so they are not
  cleared.
- **Files beyond the table:** `stores/messages.store.ts` and
  `features/messaging/historyWindows.ts` (the scoped scrub), the two loaders in
  `OverlayManagers.ts` and `MessageJump.ts`, the overlay closing in `ChatArea.ts`, `EditChannelModal.ts` (hint copy),
  `i18n/nsfwConsent.ts` (catalog), the `nsfw-gate.css` fragment, and the removed
  `setNsfwGateHost`/`clearNsfwAcknowledgements` calls in `MainPage.ts` and
  `auth.store.ts`. No navigation composition, token or import-order change.

### Evidence

Implementation `bca39fe4822052cc73094df74b6ed81e75c04e5d` on base `166d71e4`; Node 26.9.0, vitest 4.1.11, Playwright
1.63.0 Chromium, Linux.

| Check                                                                                                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Affected unit files at the base (`nsfw-gate`, `channel-controller`, `channels.store`, `dispatcher`, `auth.store`, `overlay-managers`, `message-jump`, `edit-channel-modal`, `historyWindows`)            | 597 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The same files plus `content-consent/nsfw.test.ts` after the change                                                                                                                                      | 608 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npm run test:coverage -- --maxWorkers=4` (whole client)                                                                                                                                                 | 292 files, 6,395 passed, 149 expected-fail; coverage floors met                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm run typecheck`, `npm run lint` (oxlint, cycles, eslint), `npm run knip`                                                                                                                             | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run build:budget && npm run check:budgets`                                                                                                                                                          | all ok at `166d71e4`: MainPage 59,322 B of 60,000 B, startup closure 87,699 B of 91,000 B. After merging `dev` `1d37c034` (B9-5): MainPage 60,905 B, startup 91,265 B, within the shared B9 budgets (64,000 B / 93,000 B, firstmate decision 2026-09-23); `dev` alone measured 60,073 B / 90,938 B. After merging `dev` `9f9e2b8e` (Refined Neon tokens): 61,018 B / 91,777 B. After merging `dev` `55589d43` (B9-18), with the gate and withdraw bar lazy-loaded from ChannelController (firstmate decision 2026-09-23): MainPage 63,343 B of 64,000 B, startup 94,362 B of 95,000 B (raised from 94,000 B for the single consent admission point in `lib/api.ts`); `dev` alone measured 63,132 B / 93,923 B |
| Playwright (dev server): `b9-nsfw-consent` (new), `gating-badges.parity`                                                                                                                                 | 23 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Playwright (dev server): `channel-management`, `channel-switch-messages`, `overlays`, `a11y-smoke`, `b9-text-expansion`, `b9-navigation`, `chat-header`, `logout-flow`, `profile-switch`, `reconnection` | 73 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `node scripts/check-doc-citations.mjs`, `node scripts/check-ui-strings.mjs`                                                                                                                              | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Zero pre-consent traffic** is recorded by `b9-nsfw-consent.spec.ts` from the
mock's `window.__invokeLog`: every first-party request naming the channel and
every `external_preview`/`external_image` broker invocation. Before
acknowledgement, after a failed one, after Escape, and with the pins button
pressed, the record is empty; after accepting, the first entry is the `PUT`
and history follows it; a second device's `nsfw_ack` opens the channel without
a request. Reconnect is unit-proved (`ready` restating consent remounts;
missing consent gates). The real-server fullstack spec and a native WebView2
network capture are **not run** here; the server side is B5-7's
`Server/api/nsfw_handler_test.go` and `Server/ws/nsfw_gate_test.go`, unchanged.

**Failing control.** With the consent predicate forced to `false` (the
pre-B9-7 behaviour of loading under the overlay), 15 unit tests
(`content-consent/nsfw.test.ts`, `channel-controller.test.ts`) and all 16
`b9-nsfw-consent.spec.ts` tests failed; restored before commit.

### Accessibility (Q1)

- **Keyboard:** the gate's actions are buttons in decline-then-accept order;
  Enter/Space operate them and Escape declines. The withdraw control is a
  button. Proven in unit and e2e (keyboard-only accept).
- **Screen reader:** the gate is a `section` named by its heading and described
  by its body and scope/privacy text; saving sets `aria-busy`; a failure is a
  `role="alert"`. Nothing from the channel is in the tree before consent,
  because nothing is mounted. **NVDA and Orca recordings are owner-run and
  pending.**
- **Focus:** the heading takes focus on mount, so a stray Enter is never
  consent; accept keeps focus through saving (`aria-disabled`, not
  `disabled`) and after a failure; revoking lands focus on the gate heading.
  A regate caused elsewhere (another device, a moderator, `ready`, a server
  refusal) takes focus only from the channel content it replaces (list,
  typing indicator or composer) or from `<body>`, never from an open dialog.
  When the gate that held focus is removed, focus moves to the composer after
  accepting, or to the sidebar after declining or Escape, never `<body>`.
  Focus rings measured at Q1 in every theme and High Contrast.
- **Contrast:** heading, body, scope text and both buttons ≥ 4.5:1 in dark,
  neon-glow, midnight and light, with and without High Contrast; the bar's text
  and control likewise (JSON attached per run). The scope text moved from
  `--text-faint` to `--text-muted` to qualify. Custom-accent fallback is not
  exercised: the gate uses no accent colour.
- **Reduced motion:** the gate runs no animation with or without reduced
  motion.
- **Zoom/reflow:** at 940×500 with 20 px Large Font, at 1× and 2× device
  scale, every control and the heading are reachable and unclipped with no
  horizontal page scroll (the card now scrolls from its top instead of
  centring out of view). Targets are ≥ 24×24 px.
