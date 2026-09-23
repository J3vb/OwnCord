# Plan: B9-20 — Extract settings, account and desktop-owned text

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-20 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `refactor/b9-20-english-settings-and-native`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 6. **Requirements:** BPR-064, BPR-091.
> **Dependencies:** B9-3, B9-18. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Extract settings, account and desktop-owned text. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Read account deletion/recovery/retention, inspect sessions, export a support bundle and operate voice settings with expanded text.

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

| #   | Verified current state                                                             | Evidence at planning commit                                                                                                                           |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Account UI includes retention and permanent-deletion disclosure already.           | `Client/src/components/settings/AccountTab.ts:1094-1114`                                                                                              |
| 2   | Logs tab exposes local support export and explicitly warns that logs are verbatim. | `Client/src/components/settings/LogsTab.ts:348-376`                                                                                                   |
| 3   | Notification options have app-authored labels and descriptions.                    | `Client/src/components/settings/NotificationsTab.ts:14-39`                                                                                            |
| 4   | Account/session toasts on the main page are literal English.                       | `Client/src/pages/MainPage.ts:566`; `Client/src/pages/MainPage.ts:549`                                                                                |
| 5   | Visible server-error text is thrown from the API client without a catalog mapping. | `Client/src/lib/api.ts:721`; `Client/src/lib/api.ts:759`                                                                                              |
| 6   | Desktop update, incoming-call and native-voice surfaces hold app-authored copy.    | `Client/src/components/UpdateNotifier.ts:68`; `Client/src/components/IncomingCallBanner.ts:48`; `Client/src/features/voice/native/screenPicker.ts:25` |
| 7   | App-authored native error text lives in Rust and is shown to the user.             | `Client/src-tauri/src/lib.rs:225`; `Client/src-tauri/src/tofu.rs:404`                                                                                 |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Copy-only extraction preserves B7-15c disclosures and local-only export. Never claim text/files are E2EE or that exported logs are redacted.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                                                                                                                                                       | Purpose                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Client/src/components/settings/**; Client/src/components/{SettingsOverlay,VoiceWidget,VideoGrid}.ts`                                                                                                                                                      | Inventory-selected settings/desktop/media text only  |
| `Client/src/pages/MainPage.ts; Client/src/lib/{api,screenShare,livekitReconnect}.ts; Client/src/components/{UpdateNotifier,IncomingCallBanner}.ts; Client/src/components/channel-sidebar/volume-menu.ts; Client/src/features/voice/native/screenPicker.ts` | Account/session, error-mapping and voice/update copy |
| `Client/src/i18n/{settings,account,voice}.ts (new); native text owners identified in B9-3`                                                                                                                                                                 | Catalogs; Q7 native `text.rs` table                  |
| `Client/scripts/check-ui-strings.mjs; B9 text inventory`                                                                                                                                                                                                   | Final zero-unexplained-literal scan                  |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                                                                                                                                                                     | Dated implementation status and exact-SHA evidence   |

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

### Task 1: Bound the inventory

Cover settings tabs, account/session/recovery flows and their main-page toasts, visible API error text needing a catalog mapping, update/incoming-call banners, native desktop menu/notification/error copy identified by Q7, and voice-control text not owned by the messaging slice (volume menu, native screen picker). Exclude user content and OS-owned dialogs with explicit reasons, not silent omissions.

### Task 2: Extract without policy edits

Move complete English messages to catalogs, including ARIA/help/errors. Preserve one-time secret warnings, indefinite/default-retention distinction and the verbatim-log warning.

### Task 3: Handle the native boundary

For Rust-owned visible text use the Q7 `Client/src-tauri/src/text.rs` constant table with an extraction test; do not pull credentials, E2EE or media logic across the platform seam just to translate labels.

### Task 4: Close translation readiness

Merge the final inventory of every Client/src and native desktop text sink, justify retained server/user/OS data, and make unexplained hard-coded UI text fail the scan. Expansion tests use test-only text and ship no second locale.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/settings-tabs-extra.spec.ts; Client/tests/e2e/recovery-flow.spec.ts; Client/tests/e2e/sessions.spec.ts; Client/tests/e2e/updater.spec.ts; Client/tests/e2e/voice-channel.spec.ts; Client/tests/unit/update-notifier.test.ts; Client/tests/unit/notifications.test.ts; Client/tests/unit/screen-share-button.test.ts
- Proposed: i18n/settings.test.ts; b9-text-expansion.spec.ts settings/media cases; native text extraction check if applicable

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
lifecycle gates. Because this milestone may move app-authored text in
`Client/src-tauri` (Q7 native menus/notifications/errors), any PR that touches
`Client/src-tauri` **must also run `npm run check:rust`** and report its result;
a renderer-only PR that does not touch Rust remains on `npm run check:client`.
Rust/server changes beyond the Q7 text seam are not assumed: if an approved
prerequisite changes them, it must run its complete component gate separately.
Never run a local Tauri packaging build (CI-only per Client/CLAUDE.md).
Documentation-only B9-0/B9-27 use `npm run check:docs`, `npm run check:hygiene`
and evidence review. All PRs retain exact-integration-SHA CI evidence before
phase closure.

## Risks and rollback

An English-only beta still needs plural/error/native-string ownership; leaving these for translators creates a rewrite later.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q7 — Translation boundary beyond renderer text

**Decided 2026-09-23 by the owner:** option (a), bounded as follows. In scope: every app-authored string in `Client/src` (labels, accessible names, errors, toasts, banners, notification titles and bodies, date/number formatting) through the B9-3 catalog seam with typed parameters and plurals. Rust: only the user-visible native surfaces, moved into one `Client/src-tauri/src/text.rs` constant table with an extraction test; today that is the tray menu (`tray.rs`), the startup failure dialog (`lib.rs`) and the certificate/TOFU messages (`tofu.rs`, `ws_proxy.rs`). Rust strings returned to the renderer as errors are classified as codes: the renderer maps them to catalog text and shows the raw text only as a fallback detail. Server errors: the client maps the `error` code (`TIMED_OUT`, `NSFW_ACKNOWLEDGEMENT_REQUIRED`, `BANNED`, `RATE_LIMITED`, ...) to catalog text and shows the server `message` only when no mapping exists. Explicitly excluded with a written reason: OS-owned dialogs, user content, server-authored data (names, topics, reasons), and the separately served admin panel. Catalogs are feature-owned after B9-3.

**Options and consequences:** Cover all app-authored desktop text, including native menus/notifications/errors, while treating OS/user/server data as classified inputs; or limit extraction to TypeScript. TypeScript-only is smaller but leaves desktop-owned text outside BPR-064; including the server admin panel would further expand this client phase.

**Drafting recommendation (historical):** Cover renderer and app-authored native desktop text, inventory visible server errors with a client mapping where appropriate, explicitly exclude OS/user data and the separately served admin panel. Confirm catalog ownership and those exclusions.

## Implementation record (2026-09-23)

**Base:** `dev` `55589d43` (B9-18 merged). **Head:** `c233af68`.

### What moved

- **Catalogs.** `Client/src/i18n/account.ts` (`accountText`, new) owns the
  Account tab (profile, avatar, password, two-factor, status, devices,
  retention, deletion), the recovery-kit and recovery-code sections, the
  unseen-sign-in notice and the main page's account toasts.
  `Client/src/i18n/voice.ts` (`voiceText`, new) owns the voice widget and grid,
  the per-user volume menu, the update notifier, the incoming-call banner, the
  Linux screen picker, the push-to-talk key names and the voice/media error
  toasts. `settings.ts` grows the settings tabs, the connection-diagnostics
  panel, Voice & Audio and the support-bundle README. `connect.ts` (the startup
  chunk) takes the copy startup-reachable modules raise: the session
  shut-down/restarting/ban messages, the update banner, the DM fallbacks, the
  server-default retention notice, the block reasons, the voice-capacity
  refusals and the dispatcher's generic "Server error" fallback.
- **Chunk placement.** Every startup-resident file reads `connect.ts`, already
  in the startup closure; every lazy file reads its feature catalog. The
  connection-diagnostics engine moved behind a lazy `import()` in `main.ts` so
  its 30 strings could read the lazily loaded `settings.ts` instead of adding a
  startup catalog.
- **Exempt with a reason.** Internal `Error`s that never render: the E2EE
  protocol guards, the pending-message persistence guards, the rate-limiter and
  session-scope guards, the ws ping liveness errors, the WebGL/GLSL shader
  source, the native-room state guards, `localStorage` keys and the desktop-seam
  "Tauri APIs not available" guards. Each carries an `i18n-exempt:` comment.
- **Rust (Q7).** `Client/src-tauri/src/text.rs` is one constant table for the
  tray menu and tooltip, the startup failure dialog and the certificate/TOFU
  messages; `tray.rs`, `lib.rs`, `tofu.rs`, `ws_proxy.rs` and `http_proxy.rs`
  reference it. `text.rs`'s `user_visible_literals_live_only_in_this_table`
  fails if a user-visible literal reappears at a call site.

### Accessibility fixes found by the expansion run

- **Voice & Audio** (`VoiceAudioTab.ts`): the input/output/video device selects,
  the stream-quality and FPS selects, and the input/output volume sliders had no
  accessible name; each now has one from the catalog.
- **Logs** (`LogsTab.ts`): the filter and minimum-level selects had no
  accessible name; each now has one.
- Both faults predate B9-20.

### Bundle budget

| Chunk           | Base `55589d43` | This branch |   Budget |
| --------------- | --------------: | ----------: | -------: |
| startup closure |        93,944 B |    90,889 B | 94,000 B |
| MainPage        |        63,162 B |    63,140 B | 64,000 B |

Moving the diagnostics engine behind a lazy import and reading the lazy
settings catalog there took the startup closure 3,049 B below the base, so no
budget change was needed. `Client/bundle-budgets.json` is untouched.

### Evidence

Base `55589d43`; branch head `c233af68`; Node 26.9.0, Rust 1.98.1, clang 23,
Linux.

| Check                                                                                         | Result                                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `node scripts/check-ui-strings.mjs --update`, then the gate                                   | B9-20 literals 624 → 0; the baseline lists no B9-20 file (only B9-19's 416 remain); no new UI text                  |
| `npx vitest run --maxWorkers=4` (whole client, includes `ui-strings.test.ts`)                 | 297 files; 6,477 passed, 152 expected-fail; the one failure (`livekit-e2ee-enable-ack`) is pre-existing at the base |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint`, `knip`               | clean                                                                                                               |
| `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib` | clean; 235 passed, 2 ignored                                                                                        |
| Playwright `b9-text-expansion` (B9-3, B9-18 and the new B9-20 cases), 8 tests                 | 8 passed                                                                                                            |
| Playwright `settings-tabs-extra`, `settings-overlay`, `voice-channel`                         | 46 passed                                                                                                           |
| Playwright `account-security`, `recovery-flow`, `sessions`, `updater`                         | 18 passed                                                                                                           |
| `npm run build:budget && npm run check:budgets`                                               | all ok; startup 90,895 B of 94,000 B, MainPage 63,143 B of 64,000 B                                                 |
| `npm run check:docs`, `npm run check:hygiene` (prettier)                                      | passed                                                                                                              |

The expanded cases need the dev server's modules and skip under the
production-bundle config. They run on a private port because the default 1420
was held by another lane.

### Accessibility blocks (BPR-091) for this journey

| Block          | Status                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard       | Automated: the settings tabs, the voice controls and the account forms are reached and operated from the keyboard; the B9-20 expansion cases find no unnamed control |
| Screen reader  | Automated: accessible names come from the catalog in English and expanded. NVDA (Windows) and Orca (Linux) recordings **pending owner**                              |
| Focus          | No change: the tabs and dialogs keep B9-2's focus handling                                                                                                           |
| Contrast       | No change: no colour or token changed; B9-2's Q1/Q8 matrix applies                                                                                                   |
| Reduced motion | No change: no animation changed                                                                                                                                      |
| Zoom/reflow    | Automated at 940×500 with 20 px Large Font, English and expanded, for the settings tabs and the voice widget; OS zoom 200 % **pending owner**                        |
