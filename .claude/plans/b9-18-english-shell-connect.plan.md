# Plan: B9-18 — Extract connect, shell and navigation text

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-18-impl` from `dev` `166d71e4`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-23).

> **Milestone:** B9-18 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `refactor/b9-18-english-shell-connect`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 6. **Requirements:** BPR-064, BPR-091.
> **Dependencies:** B9-4. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Extract connect, shell and navigation text. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Connect, inspect trust text, handle incompatible server, navigate channels and switch saved profiles with expanded labels.

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

| #   | Verified current state                                                                                      | Evidence at planning commit                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Server switch copy and accessible button behavior live in QuickSwitchOverlay.                               | `Client/src/components/QuickSwitchOverlay.ts:70-81`; `Client/src/components/QuickSwitchOverlay.ts:126-140`                                          |
| 2   | Sidebar labels/counts are literal and interpolated English.                                                 | `Client/src/pages/main-page/SidebarDmSection.ts:44-64`; `Client/src/pages/main-page/SidebarDmSection.ts:130-133`                                    |
| 3   | Connection/session replacement and incompatible state have existing global models to preserve.              | `Client/src/stores/ui.store.ts:8-40`                                                                                                                |
| 4   | Remaining shell/navigation/dialog components hold visible English that no plan's file table owned at draft. | `Client/src/components/UserBar.ts:252`; `Client/src/components/StatusPicker.ts:52`; `Client/src/components/MemberList.ts:101`                       |
| 5   | Channel-management, trust and call-banner copy is literal in components outside the original slice.         | `Client/src/components/CreateChannelModal.ts:53`; `Client/src/components/CertMismatchModal.ts:40`; `Client/src/components/IncomingCallBanner.ts:48` |
| 6   | Shell toasts, stream previews and channel-deletion notices carry user-visible English.                      | `Client/src/pages/main-page/OverlayManagers.ts:248`; `Client/src/lib/streamPreview.ts:215`; `Client/src/features/channels/wsHandlers.ts:144`        |

### Drift at the implementation base (2026-09-23)

Re-read at `166d71e44ce5dfde6455e3f108ce88a8def9c88f` (B9-4 merged). Since the
planning commit only B9-4 (`166d71e4`) touched these files: it added the
Message Requests badge to `SidebarDmSection.ts` (the view-all count moved from
lines 130-133 to 159) and the navigation state to `ui.store.ts`. Every other
cited line still holds, except the channel-deleted toast in
`features/channels/wsHandlers.ts`, now at line 148. Row 5's
`IncomingCallBanner.ts` is in neither this plan's file table nor the scanner's
B9-18 owner rule, so it stays with B9-20, the scanner's owner for it. B9-3's
scan attributed 388 literals in 31 files to B9-18; that is the slice.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Text-only change; preserve all B7 registration, trust, recovery and compatibility contracts.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                                                                                                                                                        | Purpose                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/pages/ConnectPage.ts; Client/src/pages/connect-page/**; Client/src/pages/main-page/Sidebar*.ts`                                                                                                                                                 | Inventory-selected text sinks only                 |
| `Client/src/components/{QuickSwitchOverlay,QuickSwitcher,CertMismatchModal,ServerBanner,ConnectedOverlay,UserBar,StatusPicker,MemberList,AdminActions,InviteManager,ChannelSidebar,CreateChannelModal,EditChannelModal,DeleteChannelModal,purge-prompt}.ts` | Remaining shell, member, trust and channel copy    |
| `Client/src/components/channel-sidebar/context-menu.ts; Client/src/lib/{streamPreview,safe-render,credentials}.ts; Client/src/pages/main-page/OverlayManagers.ts; Client/src/features/channels/wsHandlers.ts; Client/src/main.ts`                           | Shell navigation, overlays and session copy        |
| `Client/src/i18n/{connect,shell}.ts (new)`                                                                                                                                                                                                                  | Owned catalogs and call sites                      |
| `B9-3 text inventory/baseline; Client/tests/e2e/b9-text-expansion.spec.ts (new)`                                                                                                                                                                            | Coverage and expansion evidence                    |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                                                                                                                                                                      | Dated implementation status and exact-SHA evidence |

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

### Task 1: Freeze the extraction slice

Use B9-3 inventory for ConnectPage/connect-page, MainPage shell, sidebar, quick switch, trust/connect dialogs, channel-management dialogs (create/edit/delete/invite), the member list and its admin/context menus, the user bar and status picker, call/server banners and common toasts; reserve shared files before editing.

### Task 2: Move complete messages

Extract visible, tooltip, placeholder and ARIA strings, preserving exact English copy and interpolations. Date/time/number formatting uses the stable seam; user/server names remain data.

### Task 3: Preserve safety semantics

Do not rewrite certificate trust, recovery or incompatibility claims during extraction. Strings that need a product change are flagged for their behavioral milestone.

### Task 4: Verify expansion and inventory

Run connection/navigation journeys with production English and expanded test strings. Reduce the scan baseline only for covered sinks, and capture zero text/behavior drift under English.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/connect-page.spec.ts; Client/tests/e2e/cert-tofu.spec.ts; Client/tests/e2e/incompatible-epoch.spec.ts; Client/tests/e2e/channel-management.spec.ts; Client/tests/e2e/member-list.spec.ts; Client/tests/e2e/user-bar.spec.ts; Client/tests/e2e/server-profiles.spec.ts; Client/tests/unit/create-channel-modal.test.ts; Client/tests/unit/edit-channel-modal.test.ts; Client/tests/unit/delete-channel-modal.test.ts; Client/tests/unit/cert-mismatch-modal.test.ts; Client/tests/unit/invite-manager.test.ts; Client/tests/unit/member-list.test.ts; Client/tests/unit/status-picker-userbar.test.ts; Client/tests/unit/server-banner.test.ts
- Proposed: b9-text-expansion.spec.ts shell/connect cases; ui-strings.test.ts

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

A string-only PR can still change control names used by keyboard users or alter safety copy. Compare exact English text and accessible names.

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

### What moved

- **Catalogs.** `Client/src/i18n/connect.ts` (`connectText`) holds the connect
  page, login, registration, 2FA and recovery forms, the server panel, the
  incompatible-server notice, the certificate and identity trust prompts, the
  post-login overlay, the connection banner and main.ts's session messages.
  `Client/src/i18n/shell.ts` (`shellText`) holds the sidebar, channel, member,
  invite, DM, purge, status, quick-switch and stream-preview copy.
- **Split by bundle.** connect.ts ships in the startup chunk; shell.ts loads
  with the main page. A startup-chunk module therefore reads connect.ts even
  for shell copy: the render fallback (`safe-render.ts`), the channel-deleted
  toast (`features/channels/wsHandlers.ts`) and the three DM-helper messages
  (`SidebarDmHelpers.ts`, which the dispatcher reaches). With them in shell.ts
  the whole shell catalog was pulled into the startup closure.
- **Exact English.** Every string keeps its copy and interpolation. Three
  concatenated plurals are now plural entries with the same English: the purge
  result, the channel mention title and slow-mode hours/minutes. Slow-mode
  seconds stay "{count} seconds" to avoid changing text for a stored 1-second
  value. The delete-channel warning is one message with the channel name as a
  parameter; the name renders in `<strong>` by splitting at a marker the
  parameter cannot contain. Numbers now go through `formatNumber`, so a count
  or latency of 1,000 or more is grouped ("1,234ms"). The slow-mode preset
  list is derived from `formatSlowMode` rather than a second table of labels,
  and channel-type labels (`channelTypeLabel`) replace capitalising the wire
  value.
- **Exempt with a reason.** The "OC" logo monogram and the "OwnCord" product
  name; the `example.com:8443` example address; `Missing #app element` (a
  developer error); and the two `errorLog` lines in `OverlayManagers.ts`
  (developer logs, never shown).
- **Not rewritten.** Certificate, identity, recovery and incompatibility claims
  are unchanged; no string needed a product change.
- **Shared files.** `SidebarArea.ts` and `SidebarDmSection.ts` (text sinks
  only, plus the header's info column taking a class instead of an inline
  style) are B9-4 single-writer files and are named in the PR. No edit to
  navigation, MainPage, tokens, stores, `api.ts`, `types.ts`, the dispatcher,
  the catalog API or CSS import order.

### Accessibility fixes found by the expansion run

- **Sidebar header reflow** (`styles/app/sidebar.css`). With Invite and Audit
  Log shown, the header squeezed the server icon and cut off the server name
  even in English at 940 px. With longer labels, the name went to zero width
  and Audit Log was cut off by the sidebar. The header now wraps its buttons
  onto a second, right-aligned row, the same pattern B9-4 uses when the
  Moderation entry is shown. A member without Audit Log keeps the one-row
  header.
- **Add Server close button** (`ServerPanel.ts`) had no accessible name; it
  is now "Close".

### Evidence

Base `166d71e44ce5dfde6455e3f108ce88a8def9c88f`; Node 26.9.0, Playwright
Chromium, Linux, dev server on a private port.

| Check                                                                                            | Result                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/check-ui-strings.mjs --update`, then the gate                                      | B9-18 literals 388 → 0; no new UI text; baseline lists no B9-18 file                                                                                                                                                                        |
| `npx vitest run --maxWorkers=2` (whole client, includes `ui-strings.test.ts`)                    | 291 files, 6,384 passed, 149 expected-fail                                                                                                                                                                                                  |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint` (oxlint, cycles, eslint) | clean                                                                                                                                                                                                                                       |
| Playwright `b9-text-expansion` (B9-3 cases plus the two B9-18 cases)                             | 4 passed                                                                                                                                                                                                                                    |
| Playwright full mocked suite, 4 workers                                                          | 456 passed, 7 skipped, 8 failed; the 8 failures (in `channel-gating`, `channel-management`, `dm-calls`) came from source edits and builds made against the live dev server mid-run, and those three files then passed 37 of 37 on their own |
| `npm run build:budget && npm run check:budgets`                                                  | see [Bundle budget](#bundle-budget)                                                                                                                                                                                                         |
| `npm run check:docs`                                                                             | passed                                                                                                                                                                                                                                      |

**Failing controls.** Each was applied in turn, the B9-18 expansion case was
run and it failed; each was restored before commit: the Add Server close
button without its label (`findUnnamedControls` reports it); the quick-switch
footer left as a literal (unexpanded text, and the scan reports new UI text);
the sidebar header CSS and info column reverted (the server-online line
overflows its box).

### Bundle budget

Measured against the same `build:budget` at the base, gzip level 9:

| Chunk           | Base `166d71e4` | This branch |   Budget |
| --------------- | --------------: | ----------: | -------: |
| startup closure |        87,349 B |    89,398 B | 91,000 B |
| MainPage        |        58,546 B |    60,721 B | 60,000 B |

The growth is the cost of reading text through catalog keys, not new copy:
the key strings and call sites do not minify. Replacing every shell key with a
one- or two-character id would save only about 870 B. Whether to raise the
MainPage budget is an owner decision, pending.

### Accessibility (Q1)

- **Keyboard:** the quick switcher opens with Enter from its user-bar button
  and closes with Escape, returning focus to the button. The Add Server dialog
  opens with Enter and closes with Escape. Both are covered at expanded text
  (e2e).
- **Screen reader:** accessible names come from the same catalog as the
  visible text. The B9-18 expansion case finds no unnamed control in the sidebar,
  user bar, quick switcher, login form or Add Server dialog. **NVDA and Orca
  recordings are owner-run and pending.**
- **Focus:** the quick switcher still restores focus to its opener.
- **Contrast, reduced motion:** no colours, tokens or animations changed.
- **Zoom/reflow:** at 940×500 with 20 px Large Font and expanded text, the
  checked sidebar, quick-switcher, connect-page and Add Server text is whole,
  on screen and not cut off by any clipping ancestor, with no horizontal page
  scroll; screenshots are attached to the Playwright report. OS zoom 200 %
  is owner-run and pending.
