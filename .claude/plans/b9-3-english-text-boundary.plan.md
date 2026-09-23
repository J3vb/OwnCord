# Plan: B9-3 — Introduce the English text and formatting boundary

**Status:** IMPLEMENTED — native AT recordings and OS-zoom check pending owner — 2026-09-23 on branch `fm/b9-3-impl` from `dev` `4830b23c`; inventory and evidence in `docs/plans/b9-text-inventory-2026-09-23.md`.

Validated at `d33224d7e8fa110bf68c93be2a030cf2f50da8d3`.

> **Milestone:** B9-3 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `refactor/b9-3-english-text-boundary`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 6. **Requirements:** BPR-064, BPR-091.
> **Dependencies:** B9-2. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Introduce the English text and formatting boundary. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Read Accessibility settings labels and help, including screen-reader names, with English and an expansion-only test catalog.

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

| #   | Verified current state                                                                                                          | Evidence at planning commit                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Accessibility labels and descriptions are literal English values in toggle definitions.                                         | `Client/src/components/settings/AccessibilityTab.ts:10-64`                                                |
| 2   | Counts and dynamic status text are assembled in UI code.                                                                        | `Client/src/pages/main-page/SidebarDmSection.ts:130-133`; `Client/src/components/UpdateNotifier.ts:20-26` |
| 3   | The UI toolkit has a dedicated setText call path, which extraction must preserve rather than replacing with HTML interpolation. | `Client/src/components/NsfwGate.ts:56-68`; `Client/src/components/message-list/embeds.ts:157-164`         |

### Drift at the implementation base (2026-09-23)

Re-read at `4830b23cd96c6ca3874054e214104b3869e3b359`. `git diff 0beee8e4 4830b23c`
over the three rows' files changes only `AccessibilityTab.ts`: B9-2 replaced
two `false` defaults with `SYNC_OS_MOTION_DEFAULT` (three lines, no copy). Every
cited line range still holds. The inventory itself is larger than three rows:
1,428 unextracted literals in 114 files, owned B9-18 (388), B9-19 (416) and
B9-20 (624); detail in the inventory document.

### Implementation decisions and file-table amendments

- **Baseline keyed by file and text, not line.** A line-keyed baseline breaks on
  every unrelated edit above a literal, in every lane. The scan reports the line
  of each failure; the per-file owner stands in for the reason, and
  `// i18n-exempt: <reason>` carries a per-literal reason. Same shape as B7-11's
  lifecycle allowlists.
- **Formatting locale `en-US`** (`TEXT_LOCALE`), the language of the catalogs.
  Today's call sites use the host locale, `en-US` and `en-GB`; the owning
  extraction records any visible change when it moves them.
- **The pilot catalog is `src/i18n/settings.ts`**, keyed `accessibility.*`; B9-20
  extends it rather than creating it.
- **Expansion is test-only.** `setTextTransformForTesting(expandText)` is called
  by unit tests and, in the e2e spec, through the dev server's module graph; the
  app ships no switch.

| File                                                                         | Why                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Client/scripts/ui-strings-baseline.json` (new)                              | The shrink-only baseline the scan compares against                   |
| `Client/scripts/check-ui-strings.d.mts` (new)                                | Types so the unit test can drive the scanner directly                |
| `Client/tests/e2e/b9-text-expansion.spec.ts` (new; B9-18 plans to extend it) | The journey's English and expanded checks at 940×500 with 20 px text |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Catalog strings are app copy. Message text, moderation evidence, server names and wire error codes are never translated or used as HTML.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                    | Purpose                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Client/src/i18n/** (new)`                                                              | English catalogs, typed formatting and colocated tests |
| `Client/src/components/settings/AccessibilityTab.ts`                                    | Pilot extraction only                                  |
| `Client/scripts/check-ui-strings.mjs (new); Client/tests/unit/ui-strings.test.ts (new)` | Inventory, shrinking baseline and falsifiable scan     |
| `docs/plans/b9-text-inventory-<date>.md (new)`                                          | Coverage and explicit exclusions                       |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan  | Dated implementation status and exact-SHA evidence     |

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

### Task 1: Inventory visible text

Scan Client/src and native desktop UI literals; classify labels, accessible names, errors, plurals, dates/numbers and intentionally untranslated user/provider data. Capture every file and an owner; Q7 settles native/backend scope.

### Task 2: Add the smallest typed seam

Create English feature catalogs and typed interpolation/plural/date/number helpers with stable keys. No locale picker, second shipping language or runtime download. Keep domain/wire identifiers untranslated and render through safe text APIs.

### Task 3: Prove the seam on one small component

Migrate AccessibilityTab as the pilot without changing copy. Test missing keys, placeholders, plural branches and representative expansion. Keep the catalog API stable before other extraction PRs start.

### Task 4: Add an honest scan

Add a source-aware string inventory/check with explicit allowlisted non-UI strings. During migration use a shrink-only baseline with file/line/reason; require zero unexplained literals at B9 exit. Do not claim a regex over double quotes finds every UI string.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/unit/accessibility-tab.test.ts; Client/tests/unit/AccessibilityTab.test.ts
- Proposed: Client/src/i18n/format.test.ts; Client/tests/unit/ui-strings.test.ts

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

A catalog can centralize strings while leaving plurals and ARIA text hard-coded; inventory all text sinks.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q7 — Translation boundary beyond renderer text

**Decided 2026-09-23 by the owner:** option (a), bounded as follows. In scope: every app-authored string in `Client/src` (labels, accessible names, errors, toasts, banners, notification titles and bodies, date/number formatting) through the B9-3 catalog seam with typed parameters and plurals. Rust: only the user-visible native surfaces, moved into one `Client/src-tauri/src/text.rs` constant table with an extraction test; today that is the tray menu (`tray.rs`), the startup failure dialog (`lib.rs`) and the certificate/TOFU messages (`tofu.rs`, `ws_proxy.rs`). Rust strings returned to the renderer as errors are classified as codes: the renderer maps them to catalog text and shows the raw text only as a fallback detail. Server errors: the client maps the `error` code (`TIMED_OUT`, `NSFW_ACKNOWLEDGEMENT_REQUIRED`, `BANNED`, `RATE_LIMITED`, ...) to catalog text and shows the server `message` only when no mapping exists. Explicitly excluded with a written reason: OS-owned dialogs, user content, server-authored data (names, topics, reasons), and the separately served admin panel. Catalogs are feature-owned after B9-3.

**Options and consequences:** Cover all app-authored desktop text, including native menus/notifications/errors, while treating OS/user/server data as classified inputs; or limit extraction to TypeScript. TypeScript-only is smaller but leaves desktop-owned text outside BPR-064; including the server admin panel would further expand this client phase.

**Drafting recommendation (historical):** Cover renderer and app-authored native desktop text, inventory visible server errors with a client mapping where appropriate, explicitly exclude OS/user data and the separately served admin panel. Confirm catalog ownership and those exclusions.
