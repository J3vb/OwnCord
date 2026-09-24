# Plan: B9-25 — Make desktop network, notification and update limitations actionable

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-25 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-25-honest-desktop-capabilities`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 9, 8. **Requirements:** BPR-092, BPR-091.
> **Dependencies:** B9-9, B9-15, B9-23, B9-24. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Make desktop network, notification and update limitations actionable. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Use a LAN server without internet, then lose the server; test denied notifications/capture and manual/failed update paths before restoring them.

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

| #   | Verified current state                                                                                                       | Evidence at planning commit                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Connection banners derive from one shared connection-status subscription and perform an initial sync.                        | `Client/src/pages/MainPage.ts:425-449`                                                             |
| 2   | UpdateNotifier already distinguishes manual-upgrade installs and renders download/restart/failure states.                    | `Client/src/components/UpdateNotifier.ts:38-68`; `Client/src/components/UpdateNotifier.ts:125-141` |
| 3   | Notification settings describe desktop notifications and taskbar flash; they are not a browser Web Push capability contract. | `Client/src/components/settings/NotificationsTab.ts:14-39`                                         |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Existing B6 network modes and B7 update/session/platform contracts. B8 browser API, PWA and closed-app Web Push UX is deferred.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                        | Purpose                                            |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/{UpdateNotifier,VoiceWidget}.ts; Client/src/components/settings/NotificationsTab.ts` | State-derived desktop labels                       |
| `Client/src/pages/MainPage.ts; connection UI composition`                                                   | Serialized shared-state consumption only           |
| `Client/tests/e2e/b9-desktop-capabilities.spec.ts (new)`                                                    | Mode and recovery matrix                           |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                      | Dated implementation status and exact-SHA evidence |

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

### Task 1: Build the desktop capability table

Record observed Windows/Linux supported behavior for notifications, capture, updater/package installs, native integrations, network and certificate trust. Include local-server reachability separately from internet-provider reachability.

### Task 2: Connect controls to actual state

Disable or explain unavailable actions using existing adapter results and transport state, not an assumed browser API or just an OS string. Keep one connection-state owner and do not add a new transport state machine.

### Task 3: Provide recovery actions

Distinguish permission denied, internet unavailable, server disconnected, update failed, manual package upgrade and displaced session. Show retry/settings/operator guidance appropriate to the state, preserving pending work where safe.

### Task 4: Prove honesty

Block internet while keeping the LAN server reachable; revoke notification/device permission; cancel capture; reject an update; restore capability and network. Verify no false-success text or retry storm. Browser/PWA/push support screens remain out of scope.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/reconnection.spec.ts; Client/tests/e2e/updater.spec.ts; Client/tests/e2e/incompatible-epoch.spec.ts
- Proposed: b9-desktop-capabilities.spec.ts; native captures per OS

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
- [ ] **Screen reader:** automated ARIA name/role/value/error/status evidence
      (accessible names on every control, live regions announcing a status once,
      no concealed/private/secret content in the accessibility tree). The manual
      NVDA (Windows) / Orca (Linux) check is dropped from beta acceptance by the
      owner on 2026-09-24 (BPR-091 amended in a parallel docs PR); automated
      evidence suffices.
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

Frontend automation supplies the accessibility evidence: mocked Playwright
alone cannot qualify native network behavior. The manual NVDA/Orca check is
dropped by the owner (2026-09-24); browser/mobile device qualification is
deferred with B8, and desktop zoom/reflow is not deferred.

## Validation

For a product PR run `npm run check:client` and the named focused/fullstack/native
checks selected by the changed paths; preserve existing bundle budgets and
lifecycle gates. Rust/server changes are not assumed: if an approved prerequisite
changes them, it must run its complete component gate separately. Never run a
local Tauri packaging build (CI-only per Client/CLAUDE.md). Documentation-only
B9-0/B9-27 use `npm run check:docs`, `npm run check:hygiene` and evidence review.
All PRs retain exact-integration-SHA CI evidence before phase closure.

## Risks and rollback

Online to the server and online to a provider are different facts. Do not disable LAN messaging because GIF search cannot reach the internet.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Drift at the implementation base (2026-09-24)

Re-read at `dev` `5e477f00` (B9-24 merged as
[#1789](https://github.com/J3vb/OwnCord/pull/1789)):

- Inventory row 1 holds: the connection banner still derives from the one
  `uiStore.connectionStatus` subscription with a synchronous initial sync
  (`MainPage.ts` `syncBanner`). `applyConnectionStatus` lives in
  `ServerBanner.ts`.
- Inventory row 2 holds: `UpdateNotifier` still distinguishes `manual_upgrade`
  and renders download/restart/failure states. B9-24 did not touch it.
- Inventory row 3 holds: `NotificationsTab` still describes the desktop
  notification/flash/sound preferences; it had no OS-permission state.
- Not in the table, added by this lane: `Notifier.permissionGranted()` /
  `requestPermission()` are `Promise<boolean>` with no denied/unavailable
  distinction, and the voice widget's listen-only state carried only a bare
  "Grant Microphone" button. Both gaps are the ones Tasks 2-4 name.
- Bundle base at `5e477f00`: startup closure 96,374 B / 97,000 B, MainPage
  62,039 B / 64,000 B (B9-24's recorded numbers).

## Desktop capability table (Task 1)

Observed from source at `5e477f00`; desktop behavior is what the client can
actually observe, not a browser-API assumption.

| Capability           | Windows / Linux supported behavior                                                                                                   | Limitation the UI now makes actionable                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Network / server     | WS over the native proxy; reconnect loop keeps the store in `reconnecting` for the whole outage and a failed dial is `disconnected`. | Device-offline (`navigator.onLine === false`) is told apart from server-unreachable once a dial has failed; a Retry re-dials. |
| Internet provider    | None required for LAN messaging; link previews/GIFs go through the native broker and fail closed without internet.                   | Not gated on server reachability — the banner never claims the internet is required for a LAN server.                         |
| Notifications        | Tauri notification plugin; OS permission is a real gate on the popup, not the taskbar flash (a passive hint).                        | The desktop plugin cannot read the OS setting, so the row says so and points at the system settings; no false grant.          |
| Device capture (mic) | LiveKit join falls back to listen-only on `NotAllowedError`, `NotFoundError` or any other capture failure.                           | A persistent notice gives the next step; after a failed retry it stops implying a permission grant is all that is missing.    |
| Updater / packages   | A `.deb`/`.rpm` install reports `manual_upgrade` and cannot self-update; other installs download then relaunch.                      | The manual-install limitation and each install phase are announced once; no false "up to date" claim.                         |
| Certificate trust    | TOFU mismatch latches the socket to `disconnected` until the user accepts the rotated fingerprint.                                   | Retry re-dials through `connect()`, which re-validates and re-latches on a mismatch — it cannot bypass the TOFU gate.         |

## Implementation record — 2026-09-24

Branch `fm/b9-25-impl`; base `dev` `5e477f00`. Q13 applied: no token file was
edited and no Aurora treatment adopted; the shared PRD status table and per-lane
status paragraphs were not touched. The updater contract (#1766/#1767) and the
network/notification transport contracts are unchanged. The B9-3 catalog seam
keeps every other existing English string byte-identical; the connection
notice deliberately changes two: `shell` `banner.disconnected` ("Disconnected")
is removed, replaced by `banner.serverUnreachable` / `banner.deviceOffline`, and
a `reconnecting` status whose dial has failed now shows those instead of
`banner.reconnecting` (whose text is unchanged). All other catalog changes are
new keys.

### What changed

- **The connection notice answers the real state (BPR-092).** `ServerBanner`
  gains `ConnectionBannerOptions` (`offline`, `dialFailed`, `onRetry`).
  `wireConnectionStatus` records `uiStore.connectionDialFailed`: set when a
  dial (`connecting`/`authenticating`) ends without connecting, held for the
  rest of the outage across the backoff's later dials, and cleared only on a
  connection or a fresh connect from a stopped socket (sign-in, server switch,
  "Use here"). A `reconnecting` status keeps "Reconnecting..." until a dial has
  failed (a drop, an announced restart, "Use here"); after that, or on
  `disconnected`, it renders "Can't reach this server right now…"
  with a Retry button, and "Your device reports no network connection…", also
  with Retry, when `navigator.onLine` is false. `onLine` is only the device's
  report (WebKitGTK reads false on a LAN with no default route while its
  server is reachable), so the offline wording does not assert there is no
  network, never claims the internet is required, and keeps the Retry.
- **Retry is safe against TOFU and the backoff.** `MainPage`'s `retryConnection`
  calls `ws.connect()`, which re-validates the certificate (a mismatch
  re-latches) and cancels any pending backoff attempt via `cancelReconnect()`,
  so a manual retry cannot race the loop. `online`/`offline` window listeners
  (owned by a `Disposable`) only re-render the notice; the reconnect loop and
  Retry own recovery, and a displaced session is never redialed (B7-14
  preserved).
- **Notices are announced once (BPR-091).** `ServerBanner` owns a `.sr-only`
  `role="status"` live region appended beside the visible banner; the visible
  countdown rewrites only the banner, so the screen reader hears the initial
  notice once, not every second.
- **The OS notification permission is reported, not assumed (BPR-092).**
  `tauri-plugin-notification`'s desktop backend answers "granted" without
  asking the OS, so the `Notifier` contract gains `readsOsPermission` (false
  for the desktop notifier). Where it is false the row says OwnCord can't read
  the system notification setting and to check the system settings, with no
  Allow action (the opener's default scope has no `ms-settings:`, and no
  permission was widened). A notifier that does observe the OS keeps granted /
  denied wording, with "Allow notifications" calling `requestPermission()` on a
  denial; unavailable (no native notifier) is named as a different limitation.
- **Update phases are announced once.** `UpdateNotifier` owns a `.sr-only`
  `role="status"` region carrying the coarse phase (available / downloading /
  installed / failed); the per-percent progress tick updates only the visible
  text, and identical text is never re-set.
- **Listen-only is explained.** `VoiceWidget` adds a persistent mic notice: a
  hint under the Grant Microphone button, replaced after a failed retry by
  wording that points at the system setting and the device, without claiming a
  permission denial the app cannot actually observe.

### Evidence

- **Unit (vitest, jsdom):** new `tests/unit/notification-permission.test.ts`
  pins granted / denied+Allow / denied-again / unavailable / no-notifier-on-ask
  and the cannot-read-the-OS wording; `dispatcher.test.ts` pins when a dial
  counts as failed; `server-banner.test.ts` adds the offline vs server wording,
  "Reconnecting..." until a dial fails, a Retry that stays usable across
  repeated clicks, the
  Retry-still-offered-when-offline case, the live-region announcement, and the
  countdown-not-re-announced property; `update-notifier.test.ts` adds the
  once-per-phase announcement and the available-update announcement;
  `voice-widget.test.ts` adds the mic notice fill/empty (the live region stays
  rendered so a listen-only join is announced) and the failed-retry
  wording; `main-page.test.ts` adds the Retry redial, "Reconnecting..." until a
  dial fails, one unreachable notice (announced once) with Retry held across
  repeated failed dials, and the network events re-rendering without a redial.
- **E2E (mocked Chromium, `--workers=1`, non-1420 port):**
  `tests/e2e/b9-desktop-capabilities.spec.ts`: a drop says "Reconnecting..."
  until a dial fails, then names the unreachable server with a working Retry;
  device-offline names that instead, still with Retry; network return re-renders the notice; the
  notice is announced once through the live region; the restart countdown does
  not re-announce; the desktop build says it cannot read the OS notification
  setting; reflow at 940×500; the update banner is announced once; a manual
  install states its limitation with no false update claim.
- **Budgets:** `npm run check:budgets` — startup closure 96,511 B (97,000),
  MainPage 62,394 B (64,000), livekit 133,372 B, livekitSession 23,003 B. No
  budget raised.
- **Static:** `tsc --noEmit`, `typecheck:e2e`, `oxlint --deny-warnings`,
  `lint:cycles`, `eslint`, prettier and `scripts/check-ui-strings.mjs` clean;
  every new string lives in a catalog.
- **Native / AT:** the manual NVDA (Windows) and Orca (Linux) screen-reader
  check is dropped from beta acceptance by the owner (2026-09-24), not pending;
  automated evidence only, as the owner directed. Native network/capture
  behaviour stays with the desktop suites; no live-Tauri behavior is claimed
  from the mocked run.

### Requirement map

BPR-092 (honest desktop network/offline, notification and update behavior),
BPR-091 (announcements, keyboard reach, reflow) and BPR-090 (coherent desktop
state/feedback, budgets preserved) get their automated evidence here. Transport
contracts, the updater internals and the notification policy are unchanged; only
the interaction and status layer moved. The B9-3 catalog seam is preserved
apart from the connection-notice keys named above, and B7-14 displaced-session
behaviour is preserved.
