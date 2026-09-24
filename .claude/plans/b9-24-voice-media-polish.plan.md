# Plan: B9-24 — Polish voice and video controls and their accessibility

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-24 on branch `fm/b9-24-impl` from `dev` `35f0b246`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24).

> **Milestone:** B9-24 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-24-voice-media-polish`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8. **Requirements:** BPR-090, BPR-091, BPR-092.
> **Dependencies:** B9-20, B9-14. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish voice and video controls and their accessibility. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Join a call, change device, mute, view a stream, verify a peer, handle denied capture and leave without losing focus or stale media.

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

| #   | Verified current state                                                                                               | Evidence at planning commit                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Voice callbacks already route camera/screenshare through session functions and guard voice actions on a live socket. | `Client/src/pages/main-page/VoiceCallbacks.ts:112-135`; `Client/src/pages/main-page/VoiceCallbacks.ts:177-197` |
| 2   | The project has separate native voice interop and desktop voice-control test tiers.                                  | `Client/package.json:27-28`; `Client/CLAUDE.md:84-106`                                                         |
| 3   | Voice action outcomes are server-driven rather than optimistically applied by the callbacks.                         | `Client/src/pages/main-page/VoiceCallbacks.ts:143-173`                                                         |

The planning base also includes orphan-camera cleanup after reconnect/disable
(`Client/src-tauri/src/native_voice/session.rs:809-875`) and its regressions
(`Client/src-tauri/src/native_voice/session.rs:1049-1113`). Preserve these
when exercising media controls; no native-session rewrite belongs in this PR.

### Drift at the implementation base (2026-09-24)

Re-read at `35f0b246` (`dev`, B9-14/B9-20 merged). All three inventory rows
still hold; line numbers moved (B9-14 added the `can_moderate_voice` verdict
to the participant menu, B9-20 moved the voice/settings copy behind the `voice`
and `settings` catalogs). Facts the inventory did not name, found while
implementing — each is a Q1 gap the plan's Tasks 2/Task 4 ask to fix:

- **The transport-stats toggle was a `div` with a click handler.** The quality
  readout is the only control that expands `.vw-stats`, and a pointer-only div
  is unreachable by Tab/Enter (Q1 keyboard, "no hover-only action"). It is now
  a `<button>` with `aria-expanded`.
- **The voice header and ping used fill colours as text.** `.vw-connected`,
  `.vw-secured`, `.vw-timer` and the ping read `var(--green)`/`var(--yellow)`/
  `var(--red)`, which measure 4.34:1 / 7.30:1 / 3.66:1 on the widget's
  `--bg-secondary`; `--green` and `--red` miss the Q1 4.5:1 text bar. They now
  use the qualified `--text-positive`/`--text-warning`/`--text-danger`.
- **The active mute/deafen icon read 2.32:1 on its own 20 % red tint** (Q1
  1.4.11, 3:1 for UI components); it moves to `--text-danger` (4.32:1) while the
  tint stays and `aria-pressed` plus the icon swap carry the state.
- **A moderator-imposed mute/deafen was announced nowhere.** The disabled
  controls carry only a `title`, which a disabled button can never surface to a
  screen reader. A `.sr-only` `role="status"` region now carries the reason.
- **The video tile audio overlay was `opacity: 0` until hover**, so its volume
  slider and mute button could not be seen or focused by keyboard (same
  hover-only shape as B9-22's pinned-panel actions); it now also reveals on
  `:focus-within`, and the mute button gets a 24×24 target.
- **A tile rebuild or removal dropped keyboard focus to `<body>`.**
  `rebuildFocusLayout` detaches and re-appends every cell and `removeStream`
  removes one; the focused overlay control vanished with it. Focus is now
  captured by `data-user-id`/`data-tile-control` and restored to the replacement
  tile, else the first remaining tile's same control, else the grid itself.
- **The mic sensitivity threshold in Voice & Audio was pointer-only** (drag or
  click), so it had no keyboard path; it is now a `role="slider"` with
  arrow/Home/End support and `aria-valuenow`.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

B7 platform/native voice contracts and B5 effective voice moderation; never claim unavailable media succeeded or unverified E2EE is verified.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                | Purpose                                            |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/{VoiceWidget,VideoGrid}.ts; Client/src/pages/main-page/VoiceCallbacks.ts; voice settings UI` | Controls/feedback only                             |
| `Owned voice/video CSS from B9-1; Client/src/i18n/voice.ts`                                                         | Local layout and labels                            |
| `Client/tests/e2e/b9-voice-polish.spec.ts (new); native/voice-controls.spec.ts`                                     | Frontend plus actual desktop control evidence      |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                              | Dated implementation status and exact-SHA evidence |

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

### Task 1: Inventory controls on both native paths

Cover join/leave, mute/deafen, camera/screenshare, device choice, volume, stream watch, self-view and E2EE verification labels in the actual Windows and Linux application.

### Task 2: Fix interaction and feedback

Ensure all controls have names and keyboard access, focus stays predictable as participants join/leave, state changes are announced without speech storms and device/media failures have an actionable status.

### Task 3: Preserve ownership and identity

Keep Linux behavior behind the native adapter; do not rewrite LiveKit/E2EE state machines. Preserve supersession, verified/unverified distinctions and the existing self-view label fix.

### Task 4: Record degraded cases

Capture microphone/camera denied, device unplugged, screenshare cancellation/unavailable, server mute, network loss and recovery, with reduced motion and media controls at zoom. Re-run native media interoperability evidence for changed controls.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/voice-lifecycle.spec.ts; Client/tests/e2e/video-grid.spec.ts; Client/tests/e2e/native-voice/interop.spec.ts
- Proposed: b9-voice-polish.spec.ts; expanded native/voice-controls.spec.ts

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

Mocked Chromium voice tests do not qualify the Linux native media path. Native evidence stays required.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record — 2026-09-24

Branch `fm/b9-24-impl`; base `dev` `35f0b246` (B9-14/B9-20 merged). The owner's
decisions applied are in
[b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md#q13--visual-direction)
(Q13: Refined Neon tokens; Aurora components adoptable per lane; Q1/Q8
thresholds). No token file was edited, no Aurora treatment was adopted, and the
shared PRD's status table and per-lane status paragraphs were not touched —
this record is the lane's own.

### What changed

- **Keyboard path on the transport-stats readout (BPR-091).** The quality
  signal was a `div` toggling `.vw-stats`; it is now a `<button>` with
  `aria-expanded`, an Enter/Space keydown guard for the app's global keybinds,
  and `data-testid="vw-signal"`. It is local UI, never frozen by
  `updateFrozen`, so it stays reachable while the socket is down.
- **Qualified status text (BPR-091, Q1 contrast).** `VoiceWidget`'s header,
  secured badge, timer and `QUALITY_COLORS` map now use the `--text-*`
  status tokens; the ping text is the same element that carries the bar colour,
  so the token split (fill vs text) is what lets one map serve both.
  `.vw-controls button.active-ctrl` and `.disconnect` move their icon colour to
  `--text-danger`: the previous `--red` on its own 20 % tint read 2.32:1.
- **A moderator mute/deafen is announced once.** A `.sr-only` `role="status"`
  region (`.vw-mod-status`) carries "You were muted/deafened by a moderator"
  (and a combined line) and clears when the restriction lifts; text is only
  rewritten when it actually changes, so a render on an unrelated store update
  does not re-announce.
- **No hover-only action in the video grid (BPR-091).** `.video-cell:focus-within
.video-tile-overlay` reveals the tile's volume slider and mute button on
  focus, matching B9-22's pinned-panel fix; the mute button gains a 24×24
  minimum (`min-width`/`min-height`) and the two controls carry
  `data-tile-control` keys.
- **Focus survives a tile rebuild or removal (BPR-091 focus stability).**
  `captureFocusedControl` records the focused `(userId, control)` before
  `rebuildFocusLayout`/`removeStream` detaches cells and puts focus back on the
  replacement tile's same control, else the first remaining tile's, else the
  grid itself (`tabindex="-1"`), which is never `<body>`.
- **The mic sensitivity threshold is keyboard operable (BPR-091).** It is now
  a `role="slider"` with `aria-valuemin/max/now`, ArrowLeft/Down − 5,
  ArrowRight/Up + 5, Home 0 and End 100, sharing `applySensitivity` with the
  pointer path.

### Evidence

- **Unit (vitest, jsdom):** `tests/unit/b9-voice-polish.test.ts` (8) pins the
  button/aria-expanded toggle, the Enter/Space path, the moderator-status
  announcement and clearing, tile control keys, and the three focus-restore
  cases; `tests/unit/b9-voice-polish-css.test.ts` (10) parses `app.css` for the
  `:focus-within` reveal, the 24×24 tile-mute box and every status-token move.
  The full client unit suite is green: 255 files, 6125 passed | 152 expected
  fail. `tsc --noEmit`, `typecheck:e2e`, `oxlint --deny-warnings`,
  `lint:cycles`, `eslint`, prettier and `scripts/check-ui-strings.mjs` are
  clean; no new UI text escaped a catalog.
- **E2E (mocked Chromium, `--workers=1`, non-1420 port):**
  `tests/e2e/b9-voice-polish.spec.ts` — 7 tests: the stats toggle is a
  keyboard button with a Q1 focus ring; every voice control is named; a
  server mute announces once and clears; the header meets 4.5:1; the widget
  reflows at 940×500 with 20px text; the tile overlay reveals on focus (and
  hides again off-tile); the tile mute target is ≥ 24×24. The affected
  existing suites were re-run green: `voice-widget`, `video-grid`,
  `voice-lifecycle`, `voice-channel`, `voice-e2ee-verify` (41),
  `b9-text-expansion` (10, incl. the B9-20 expanded voice-controls case) and
  `settings-voice-audio` (10).
- **Budgets:** `npm run check:budgets` — startup 96,374 B (97,000), MainPage
  62,039 B (64,000), livekit 133,372 B, livekitSession 23,005 B. No budget was
  raised; CSS additions are small and the widget text tokens cost nothing.
- **Native (owner-run / CI):** `Client/tests/e2e/native/voice-controls.spec.ts`
  gains the stats-toggle keyboard check and the moderator-status role probe to
  the existing live journey (mute/deafen/disconnect over the real backend).
  NVDA (Windows) and Orca (Linux) recordings remain owner-run, tracked with
  B9-26; no automated proxy is claimed for them.

### Requirement map

BPR-090 (coherent desktop media controls/feedback, performance preserved),
BPR-091 (keyboard, focus, contrast, announcements, reflow) and BPR-092 (honest
media control state) get their automated evidence here. Voice transport,
LiveKit connection logic and media pipelines are unchanged: only the interaction
and visual layer moved. The B9-14 per-channel voice-moderation behaviour and the
B9-3 catalog seam (English byte-identical) are preserved.
