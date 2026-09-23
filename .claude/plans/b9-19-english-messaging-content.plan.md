# Plan: B9-19 — Extract messaging, rich-content and media text

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-19 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `refactor/b9-19-english-messaging-content`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 6. **Requirements:** BPR-064, BPR-091.
> **Dependencies:** B9-9, B9-6, B9-18. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Extract messaging, rich-content and media text. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Send, retry, search, pin, preview a request and activate media with zero/one/many counts and expanded English labels.

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

| #   | Verified current state                                                  | Evidence at planning commit                                                                                                           |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | YouTube and media fallbacks contain literal loading and provider text.  | `Client/src/components/message-list/media.ts:168-192`                                                                                 |
| 2   | Message-list jump controls are constructed in the component.            | `Client/src/components/MessageList.ts:911-935`                                                                                        |
| 3   | GIF search names, attribution and status messages are literal English.  | `Client/src/components/GifPicker.ts:57-79`; `Client/src/components/GifPicker.ts:104-110`                                              |
| 4   | DM list/profile, member picker and emoji picker hold visible English.   | `Client/src/components/DmSidebar.ts:324`; `Client/src/components/DmProfileSidebar.ts:277`; `Client/src/components/EmojiPicker.ts:619` |
| 5   | Message/upload/pin status toasts are literal in the channel controller. | `Client/src/pages/main-page/ChannelController.ts:512`; `Client/src/pages/main-page/ChannelController.ts:560`                          |
| 6   | The NSFW gate and the user profile popup carry user-visible copy.       | `Client/src/components/NsfwGate.ts:60`; `Client/src/components/UserProfilePopup.ts:193`                                               |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

No message, provider or moderation policy changes; preserve plain-text safety and consent ordering.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                                                                                                                                                        | Purpose                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/message-list/**; Client/src/components/{MessageList,MessageInput,GifPicker,SearchOverlay,PinnedMessages}.ts`                                                                                                                         | Inventory-selected messaging text                  |
| `Client/src/components/{DmSidebar,DmProfileSidebar,EmojiPicker,UserProfilePopup,NsfwGate}.ts; Client/src/pages/main-page/{ChannelController,MessageJump,ChatHeader,MemberPickerModal}.ts; Client/src/components/{MentionAutocomplete,EmojiAutocomplete}.ts` | DM, picker, gate and message-status copy           |
| `Client/src/i18n/{messaging,content,requests}.ts (new or extend)`                                                                                                                                                                                           | Feature catalogs                                   |
| `B9-3 string scan baseline; Client/tests/e2e/b9-text-expansion.spec.ts`                                                                                                                                                                                     | Shrink baseline and messaging expansion cases      |
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

### Task 1: Extract the bounded feature families

Cover message list/input, actions, search, pins, emoji/GIF pickers, requests, previews, media UI, the DM list/profile, member picker and the NSFW gate from the inventory. New B9 feature copy should already use catalogs; verify it instead of migrating it twice.

### Task 2: Keep dynamic data distinct

Parameterize author/count/time safely. Preserve message bodies, filenames, URLs, provider-returned titles and protocol identifiers as data; do not tokenize user content or concatenate English plural fragments.

### Task 3: Protect names and announcements

Cover accessible media/control labels, message status, send errors, mentions and live announcements, not just visible buttons.

### Task 4: Close this scan slice

Run exact-English comparison and expanded layout cases for long filenames, counts 0/1/many and denied/error states. Keep renderer bundles within the current B7 budgets.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/message-actions.spec.ts; Client/tests/e2e/search-overlay.spec.ts; Client/tests/e2e/message-media.spec.ts; Client/tests/e2e/dm-system.spec.ts; Client/tests/e2e/emoji-insertion.spec.ts; Client/tests/e2e/user-profile.spec.ts; Client/tests/unit/dm-sidebar.test.ts; Client/tests/unit/dm-profile-sidebar.test.ts; Client/tests/unit/emoji-picker.test.ts; Client/tests/unit/message-jump.test.ts; Client/tests/unit/member-picker-modal.test.ts
- Proposed: i18n/messaging.test.ts; expanded b9-text-expansion.spec.ts

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

Extracting text from rich rendering can accidentally switch to HTML or start content loading. Keep negative-fetch and safe-render tests green.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q7 — Translation boundary beyond renderer text

**Decided 2026-09-23 by the owner:** option (a), bounded as follows. In scope: every app-authored string in `Client/src` (labels, accessible names, errors, toasts, banners, notification titles and bodies, date/number formatting) through the B9-3 catalog seam with typed parameters and plurals. Rust: only the user-visible native surfaces, moved into one `Client/src-tauri/src/text.rs` constant table with an extraction test; today that is the tray menu (`tray.rs`), the startup failure dialog (`lib.rs`) and the certificate/TOFU messages (`tofu.rs`, `ws_proxy.rs`). Rust strings returned to the renderer as errors are classified as codes: the renderer maps them to catalog text and shows the raw text only as a fallback detail. Server errors: the client maps the `error` code (`TIMED_OUT`, `NSFW_ACKNOWLEDGEMENT_REQUIRED`, `BANNED`, `RATE_LIMITED`, ...) to catalog text and shows the server `message` only when no mapping exists. Explicitly excluded with a written reason: OS-owned dialogs, user content, server-authored data (names, topics, reasons), and the separately served admin panel. Catalogs are feature-owned after B9-3.

**Options and consequences:** Cover all app-authored desktop text, including native menus/notifications/errors, while treating OS/user/server data as classified inputs; or limit extraction to TypeScript. TypeScript-only is smaller but leaves desktop-owned text outside BPR-064; including the server admin panel would further expand this client phase.

**Drafting recommendation (historical):** Cover renderer and app-authored native desktop text, inventory visible server errors with a client mapping where appropriate, explicitly exclude OS/user data and the separately served admin panel. Confirm catalog ownership and those exclusions.
