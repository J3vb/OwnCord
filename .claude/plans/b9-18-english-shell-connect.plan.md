# Plan: B9-18 — Extract connect, shell and navigation text

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

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
