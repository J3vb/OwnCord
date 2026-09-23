# B9-3 English text inventory

**Taken:** 2026-09-23
**Base commit:** `4830b23cd96c6ca3874054e214104b3869e3b359` (`dev`, after B9-2's PR #1736)
**Branch:** `fm/b9-3-impl`
**Plan:** `.claude/plans/b9-3-english-text-boundary.plan.md` (B9-3)
**PRD:** [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md), owner decision Q7
**Requirements:** BPR-064, BPR-091

This is the migration inventory B9-18, B9-19 and B9-20 extract from. The
machine-checked half is `Client/scripts/ui-strings-baseline.json`; this file
explains it, adds the sinks the scan cannot see, and records what is excluded
and why. Every number below came from the command next to it, run during this
session.

## The seam

`Client/src/i18n/format.ts` holds the API; each feature owns a catalog file
next to it (`settings.ts` today). `defineCatalog(namespace, entries)` returns
a reader whose key picks the entry and whose entry types its parameters:
`{name}` placeholders are required parameters, and a plural entry
(`{ one, other }`, English CLDR categories) requires `count`. Parameters are
inserted verbatim, so user and server data and wire identifiers pass through
untranslated; numbers go through `formatNumber`. `formatNumber` and
`formatDate` format in `TEXT_LOCALE` (`en-US`), the locale the catalogs are
written in. The result is plain text for `setText`, `textContent` or an
attribute, never HTML. A key a catalog lacks (reachable only through a cast)
renders as `namespace.key`. `setTextTransformForTesting(expandText)` is the
expansion-only test catalog: every template grows by about 40 % of its own
words between `⟦` and `⟧`, with placeholders kept and parameters unexpanded.
There is no locale picker, second language or runtime download.

B9-3 moved the Accessibility settings tab onto the seam without changing its
copy. Its text is now resolved when the tab is built, not at module load.

## How the inventory was taken

From `Client/`: `node scripts/check-ui-strings.mjs --update` wrote the baseline
(per file: owner, then each literal and its count), and
`node scripts/check-ui-strings.mjs --report` prints the per-file owner and
category table the totals below sum. The scanner parses
every `src/**/*.ts` file with the TypeScript compiler and reports a string or
template literal when either:

- its **position** is a text sink: `setText`, `showToast`, the text argument of
  `createElement`, `textContent`/`innerText`/`title`/`placeholder`/`alt`/`ariaLabel`
  assignments, a `setAttribute` of an ARIA or title/placeholder/alt attribute,
  or a `label`/`desc`/`description`/`tooltip`/ARIA property; or
- its **shape** is prose: words separated by spaces, a capitalised word, `…`
  or sentence punctuation, and not a class list, CSS value, path or selector.

It skips positions that never display text: imports and types, object keys,
comparisons and `case` labels, logger and `console` calls, DOM query,
listener, storage, class-list and style calls, and `class`/`id`/`role`/`data-*`
style properties. `// i18n-exempt: <reason>` exempts one literal; an empty
reason fails the scan. The comment counts on the literal's own line, or on the
line above only when that line holds nothing but the comment, so a trailing
exemption never carries over to the next line.

**What it cannot see**, so a green run is not "no English left": text built
from non-literal pieces; a single lowercase word outside a known sink (a
`placeholder` of "general" held in a variable); text passed through a variable
or helper into a sink; text in HTML or CSS. Its shape rule also catches some
non-UI prose, chiefly internal `Error` messages that never reach the UI; the
owner either extracts or exempts each with a reason. The sinks outside the
scan are listed by hand under [Not scanned](#not-scanned-listed-by-hand).

The gate is `Client/tests/unit/ui-strings.test.ts`, part of the unit suite. It
fails on a literal above its baseline count (new UI text) and on a baseline
entry the source no longer has (the baseline only shrinks; `--update` never
adds to an existing baseline). Entries are keyed by file and text, not line,
so an unrelated edit does not churn them. The same test proves each sink rule
on fixtures, pins the variable-indirection limit above, and checks that every
baseline file exists and carries the owner the scanner's rules assign.

## Totals at the base

1,409 unextracted literals in 114 files; 105 of them are templates with
interpolated values (shown with `{…}` in the baseline).

| Category        | Literals | Meaning                                                            |
| --------------- | -------: | ------------------------------------------------------------------ |
| text            |      565 | visible text through a known sink                                  |
| accessible-name |      125 | `aria-*`, `title` or `alt` text                                    |
| toast           |       40 | `showToast` / `showChangeOutcomeToast` message                     |
| error           |       54 | thrown or rejected `Error` text; some is shown, some internal-only |
| other           |      625 | prose by shape elsewhere: option labels, status maps, messages     |

| Owner | Files | Literals |
| ----- | ----: | -------: |
| B9-18 |    31 |      381 |
| B9-19 |    22 |      407 |
| B9-20 |    61 |      621 |

Owners come from the B9-18/19/20 plans' file tables. A file no table names
falls to B9-20, whose Task 4 merges the final inventory of every `Client/src`
text sink; B9-20 may reassign a file to the milestone whose journey owns it.

## Plurals, dates and numbers

English plural fragments assembled in code, each to become a plural entry:

| Site                                                         | Owner |
| ------------------------------------------------------------ | ----- |
| `src/pages/main-page/SidebarArea.ts` purge result            | B9-18 |
| `src/components/ChannelSidebar.ts` mention badge title       | B9-18 |
| `src/components/EditChannelModal.ts` slow-mode hours/minutes | B9-18 |
| `src/components/DmSidebar.ts` mention and unread titles      | B9-19 |
| `src/components/message-list/reaction-tooltip.ts` "others"   | B9-19 |
| `src/lib/types.ts` retention "day(s)"                        | B9-20 |
| `src/lib/session-notice.ts` "and N more"                     | B9-20 |

Counts rendered without a plural form ("View all messages (N)",
`SidebarDmSection.ts`) are in the baseline as templates (B9-18).

Date, time and list formatting today uses three conventions, which the owning
extraction moves onto `formatDate`/`formatNumber` and records any visible change:
the host locale (`toLocaleDateString(undefined, …)` in `SearchOverlay.ts` and
`PinnedMessages.ts`), `en-US` (`message-list/formatting.ts`) and `en-GB`
(`Intl.ListFormat` in `message-list/reaction-tooltip.ts`). All are B9-19's. The
seam has no list helper yet; adding one is additive and does not change the
catalog API.

## Q7 boundary: native, Rust-to-renderer and server text

The owner's Q7 decision puts these in scope for B9-20. B9-3 inventories them;
it moves none.

| Surface                              | Where                                                                                                                                                                                                     | Q7 treatment                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tray menu and tooltip                | `Client/src-tauri/src/tray.rs` ("Show/Hide", "Online", "Idle", "Do Not Disturb", "Offline", "Status", "Quit")                                                                                             | Constant table in `Client/src-tauri/src/text.rs` with an extraction test                                                                                                                |
| Startup failure dialog (not Linux)   | `Client/src-tauri/src/lib.rs` ("OwnCord failed to start" and its description)                                                                                                                             | Same table; the error detail stays raw                                                                                                                                                  |
| Certificate/TOFU mismatch text       | `Client/src-tauri/src/tofu.rs` `mismatch_message`; `ws_proxy.rs` connection errors                                                                                                                        | Same table for text a user reads; the renderer parses `Stored:` out of this message today, so the change keeps that contract or replaces it with a code                                 |
| Rust errors returned to the renderer | `Err(…)` returns in `commands.rs`, `credentials.rs`, `secret_store.rs`, `http_proxy.rs`, `ws_proxy.rs`, `external_content.rs`, `fallback_crypto.rs`, `native_voice/` (21 string `Err(…)` returns by grep) | Classified as codes: the renderer maps them to catalog text and shows the raw text only as a fallback detail                                                                            |
| Server error responses               | `ApiClientError` (`src/lib/api.ts`) carries the wire `code` and the server `message`                                                                                                                      | The client maps the `error` code (`TIMED_OUT`, `NSFW_ACKNOWLEDGEMENT_REQUIRED`, `BANNED`, `RATE_LIMITED`, …) to catalog text and shows the server `message` only when no mapping exists |

## Not scanned, listed by hand

| Sink                                        | Text      | Owner / treatment                                       |
| ------------------------------------------- | --------- | ------------------------------------------------------- |
| `Client/index.html` `<title>`               | "OwnCord" | Product name; not translated                            |
| `src/styles/app/messages.css` `content:`    | "GIF"     | Format name; B9-19 confirms it stays                    |
| Values passed through variables and helpers | —         | Each extraction milestone reviews its files' call paths |

## Explicit exclusions

| Excluded                                                                                                                       | Reason                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| OS-owned dialogs (file pickers, the Wayland screen-share portal, OS notification permission prompts)                           | The OS renders and localises them; the app supplies no copy                             |
| User content (message text, names, bios, attachments' filenames)                                                               | Data, not app copy; rendered verbatim as parameters                                     |
| Server-authored data (server, channel and role names, topics, moderation reasons, server `message` when a code has no mapping) | Authored by the server operator or a moderator, not the app                             |
| The separately served admin panel (`Server/admin/`)                                                                            | Not part of the desktop client; Q7 excludes it                                          |
| Wire identifiers (`src/lib/protocolTypes.ts`, error codes, event names)                                                        | Protocol, generated from `protocol/schema.json`; never shown as prose                   |
| Logger and `console` messages                                                                                                  | Developer diagnostics; the Logs tab and the support bundle show them verbatim by design |
| `src/lib/icons.ts`                                                                                                             | SVG path markup, no text                                                                |
| `src/components/message-list/syntax-highlight.ts`                                                                              | Programming-language keyword tables for code highlighting                               |
| `src/i18n/**`, `*.test.ts`, `*.d.ts`                                                                                           | The catalogs themselves; tests; type declarations                                       |

## Evidence

Environment: Ubuntu 24.04.5 LTS (headless agent host, no display or screen
reader), Node 26.9.0, vitest 4.1.11, Playwright 1.63.0 with bundled Chromium,
mocked Tauri (`tests/e2e/helpers.ts`).

Inventory drift at the base: the plan's three rows were re-read at `4830b23c`.
Only `AccessibilityTab.ts` changed since `0beee8e4` (B9-2's
`SYNC_OS_MOTION_DEFAULT`, three lines, no copy change). Every cited line range
still holds.

| Check                                                                                                | Command (from `Client/`)                                                                  | Result                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Accessibility tab suites, before and after the pilot                                        | `npx vitest run tests/unit/accessibility-tab.test.ts tests/unit/AccessibilityTab.test.ts` | 37 passed at the base file; 37 passed after. They find rows and switches by the English labels, so the copy is unchanged                                                                                         |
| Seam: keys, placeholders, plural 0/1/many, missing key, inherited key, expansion, number/date locale | `npx vitest run src/i18n/format.test.ts`                                                  | 9 passed; the `@ts-expect-error` lines fail `tsc --noEmit` if the types stop rejecting a missing key, a missing placeholder, a plural without `count` or parameters on a plain entry                             |
| Scan and ratchet                                                                                     | `npx vitest run tests/unit/ui-strings.test.ts`                                            | 12 passed                                                                                                                                                                                                        |
| Failing control: the pilot reverted to its base file                                                 | same, with `AccessibilityTab.ts` from `4830b23c`                                          | **Fail**, 1 test: ten "new UI text" entries (`Reduce Motion` …)                                                                                                                                                  |
| Failing control: one baselined literal reworded (`NsfwGate.ts`)                                      | `node scripts/check-ui-strings.mjs`                                                       | **Fail**: the new wording is new UI text, and the old wording is a stale baseline entry                                                                                                                          |
| English and expanded Accessibility tab at 940×500 with 20 px text and Large Font                     | `npx playwright test tests/e2e/b9-text-expansion.spec.ts`                                 | 2 passed: exact English labels and switch names; expanded labels whole (`⟦…⟧`), unclipped, in view, switches named by the expanded label, Space toggles, no horizontal scroll. Screenshot attached to the report |
| Failing control: descriptions forced to one clipped line                                             | same, with `.setting-desc { white-space: nowrap; overflow: hidden }` injected             | **Fail** (`toBeInViewport`)                                                                                                                                                                                      |

The expanded cases need the dev server's source modules and skip under the
production-bundle config (`test:e2e:prod`), which has no module to reach.

### Accessibility blocks (BPR-091) for this journey

| Block          | Status                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard       | Automated: Space toggles a switch after expansion. Tab order is unchanged from B9-2's fixture checks (no DOM change)                                                                           |
| Screen reader  | Automated: each switch's accessible name is its catalog label in English and expanded. NVDA (Windows) and Orca (Linux) recordings **pending owner**: this host has no display or screen reader |
| Focus          | No change: the tab's DOM and focus handling are unchanged; B9-2's focus-ring checks apply                                                                                                      |
| Contrast       | No change: no colour or token changed; B9-2's Q1/Q8 matrix applies                                                                                                                             |
| Reduced motion | No change: the toggles' behaviour is unchanged (37 existing tests)                                                                                                                             |
| Zoom/reflow    | Automated at 940×500 with 20 px text and Large Font, English and expanded. OS zoom 200 % on a native window **pending owner**                                                                  |
