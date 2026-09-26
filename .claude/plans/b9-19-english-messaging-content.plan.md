# Plan: B9-19 — Extract messaging, rich-content and media text

**Status:** IMPLEMENTED — OS-zoom check pending owner; native AT recordings declined by owner 2026-09-24 — 2026-09-24 on branch `fm/b9-19-impl` from `dev` `782e010e`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24). This file carries the status and evidence for this lane; the shared PRD status table is updated by the single docs lane.

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

## Implementation record (2026-09-24)

**Base:** `dev` `782e010e` (B9-9, B9-6, B9-18 merged — the milestone's stated
dependencies). **Head:** recorded at PR time.

### Current-state inventory drift at the base

The plan's six inventory rows were re-read at `782e010e`. Line numbers had
drifted from the planning commit `0beee8e4`, as the plan warned; the
authoritative inventory is `Client/scripts/ui-strings-baseline.json`, which at
the base listed **408 literals across 21 B9-19-owned files** (the plan's prose
said 416 at planning time; B9-9 and B9-18 had moved some since). Every cited
file still held its copy; no row was refuted.

**Pre-existing bundle drift.** At the base, `origin/dev` itself measures
MainPage **64,022 B against its 64,000 B budget** on the reviewed toolchain
(Node 26.9.0, vite 8.3.0 from the lockfile); B9-9's merge added the copy/JS that
pushed it over, and CI at `c74f4786`/`782e010e` did not run the client leg
(`ci.yml`'s Change selection skips it for a server-only change; PR #1775's own
run measured 63,888 B before its final rebase onto `6671f228`). B9-19 moves the
messaging copy behind the seam and, as a side effect, takes MainPage back under
budget (below); no budget was raised.

### What moved

- **Catalogs.** Three new feature catalogs, split by where they load:
  - `Client/src/i18n/messaging.ts` (`messagingText`, new) — the message list
    welcome/loading/error states, the composer's labels and errors, the message
    renderers and their send-status reasons, the action bar and copy toasts,
    the search overlay, the pinned panel, the emoji and GIF pickers, the
    mention autocomplete and the message-jump toasts. Loads with the main page.
  - `Client/src/i18n/requests.ts` (`requestsText`, new) — the DM sidebar, the
    DM profile panel, the user profile popup and the member picker, plus the
    DM header's group subtitle.
  - `Client/src/i18n/messageStatus.ts` (`messageStatusText`, new) — the
    **startup-safe slice**: the date stamps (`formatting.ts`), the attachment
    download labels (`attachments.ts`) and the who-reacted tooltip
    (`reaction-tooltip.ts`), all statically reachable from the entry.
  - `i18n/content.ts` grew the YouTube embed's provider-title/loading/thumb-alt
    copy, which shares the lazy chunk with the preview and image states (B9-9).
- **Search-index data, not copy.** `EMOJI_NAMES` moved out of `EmojiPicker.ts`
  into a new `Client/src/components/emoji-keywords.ts` and is excluded from the
  UI-string scan with a reason, exactly like `message-list/syntax-highlight.ts`:
  it is a lookup table matched against typed queries, never rendered. The
  category labels it sits beside are copy and moved to the catalog.
- **Reused catalogs.** The DM/profile presence labels come from `shell.ts`'s
  existing `status.*` keys (no second copy); the composer's reconnect/not-
  connected/slow-mode strings reuse `shell.ts`'s `channel.reconnecting`,
  `channel.notConnected` and `shellText`'s status fallback.
- **Exempt with a reason.** The internal "external URLs are fetched only
  through the broker" guard, the `Bearer`/`data:`-URI wire fragments, the
  `Failed to read file` FileReader failure and the `KeyboardEvent.key` values
  (`Home`/`End`) each carry an `i18n-exempt:` comment.
- **Numbers stay ungrouped where the literal was.** Character and attachment
  caps pass `String(...)` (`error.tooLong`, `error.tooManyAttachments`,
  `composer.slowMode`, `search.minChars`, `picker.groupHint`) so "4000",
  "5s" and "9" keep their exact English. The counted titles `mention.count`,
  `unread.count` and `reaction.others` become plural entries: `count` picks the
  branch and the displayed number is a separate `{n}` passed as `String(count)`,
  so a count of 1234 still renders "1234", not "1,234" (and `reaction.others`
  carries the reactor names, so the whole sentence is one entry).
  `members.count` and `requests.dm.groupSubtitle` keep the literals'
  always-plural "{count} members" wording, so "1 members" is unchanged.

### Bundle budget

| Chunk           | Base `782e010e` | This branch |   Budget |
| --------------- | --------------: | ----------: | -------: |
| startup closure |        94,179 B |    95,249 B | 95,500 B |
| MainPage        |        64,022 B |    61,347 B | 64,000 B |

Moving the messaging copy out of the renderers' inline literals into
`messaging.ts` shrinks the MainPage chunk by 2,675 B even after the catalog is
added. The startup closure grows 1,070 B (three new catalog modules and their
lookup calls, no new copy) — headroom is 251 B. `Client/bundle-budgets.json` is
untouched; no budget raise was requested.

### Evidence

Base `782e010e`; Node 26.9.0, vite 8.3.0, Playwright 1.63.0 (bundled Chromium),
Linux, dev server on a private port (1420/1431 were free locally).

| Check                                                                                          | Result                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/check-ui-strings.mjs --update`, then the gate                                    | B9-19 literals 408 → 0; the baseline is now `{}`; scan exit 0                                                                                                   |
| Failing control: `formatting.ts` date stamp reverted to its literal                            | **Fail**: `src/components/message-list/formatting.ts:87: new UI text "Today at {…}"`, exit 1                                                                    |
| `npx vitest run --maxWorkers=4` (whole client)                                                 | 306 files; 6,658 passed, 152 expected-fail                                                                                                                      |
| `npx tsc --noEmit`, `npx tsc -p tsconfig.e2e.json --noEmit`                                    | clean                                                                                                                                                           |
| `npx oxlint --deny-warnings src/`, `npm run lint:cycles`, `npx eslint src/`                    | clean                                                                                                                                                           |
| `npx knip`                                                                                     | clean                                                                                                                                                           |
| `npm run build:budget && node scripts/bundle-budget.mjs`                                       | all budgets ok (see table)                                                                                                                                      |
| Playwright `b9-text-expansion.spec.ts` (B9-3, B9-18, **new B9-19**, B9-20)                     | 9 passed; the 1 failure (`B9-20 ... expanded voice controls`) reproduces on unmodified `782e010e` at 940×500 with 20px text (sidebar overlap another lane owns) |
| Playwright `message-actions`, `search-overlay`, `dm-system`, `emoji-insertion`, `user-profile` | 44 passed, 1 skipped                                                                                                                                            |
| Playwright `message-media`                                                                     | 11 passed                                                                                                                                                       |
| New unit: `src/i18n/messaging.test.ts`                                                         | 7 passed (exact English, parameterised values, plural branches)                                                                                                 |

The expanded cases need the dev server's modules and skip under the
production-bundle config.

### Accessibility blocks (BPR-091) for this journey

| Block          | Status                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard       | Automated (existing suites): the message action bar, search overlay, pinned panel, DM sidebar and member picker are reached and operated with Enter/Space/Escape and arrows; the new B9-19 case asserts the expanded action names are visible |
| Screen reader  | Automated: action, panel, picker and search accessible names resolve from the catalog in English and expanded. NVDA (Windows) and Orca (Linux) recordings **declined by the owner 2026-09-24**                                                |
| Focus          | No change: no focus handling was touched; the B9-9 lightbox/popup focus behaviour is untouched                                                                                                                                                |
| Contrast       | No change: no colour or token changed; B9-2's Q1/Q8 matrix applies                                                                                                                                                                            |
| Reduced motion | No change: no animation changed                                                                                                                                                                                                               |
| Zoom/reflow    | Automated at 940×500 with 20 px Large Font, English and expanded, for the message rows, pinned panel and search overlay; OS zoom 200 % on a native window **pending owner**. The B9-20 voice-widget overlap in that run predates B9-19        |
