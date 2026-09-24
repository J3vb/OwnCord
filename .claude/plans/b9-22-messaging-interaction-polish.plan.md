# Plan: B9-22 — Polish desktop message reading, composing and related overlays

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-24 on branch `fm/b9-22-impl` from `dev` `cd599319`, merging `dev` `cd599319` (startup budget 97,000 B); the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24).

> **Milestone:** B9-22 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-22-messaging-interaction-polish`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8. **Requirements:** BPR-090, BPR-091.
> **Dependencies:** B9-19, B9-7. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish desktop message reading, composing and related overlays. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Read old messages, jump to present, receive a new message, compose/reply/edit and use search/pins entirely by keyboard and screen reader.

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

| #   | Verified current state                                                                         | Evidence at planning commit                                                                    |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | MessageList virtualizes rows and uses ResizeObserver plus an anchor to preserve position.      | `Client/src/components/MessageList.ts:911-918`; `Client/src/components/MessageList.ts:953-967` |
| 2   | MessageInput supports selection-based formatting shortcuts; keep native text editing behavior. | `Client/src/components/MessageInput.ts:64-68`; `Client/src/components/MessageInput.ts:77-98`   |
| 3   | Existing focus helpers support roving navigation, including Enter/Space and Home/End.          | `Client/src/lib/a11y.ts:95-160`                                                                |

### Drift at the implementation base (2026-09-24)

Re-read at `cd599319` (`dev`, B9-19/B9-23 merged). All three rows still hold;
line numbers moved (B9-19 routed the message-list copy through the `messaging`
catalog, and MessageList grew the focus-restore helpers below). Facts the
inventory did not name, found while implementing:

- **A virtualized rebuild dropped keyboard focus to `<body>`.** `renderWindow`'s
  rebuild path aborts the row-scoped listeners and `clearChildren` detaches every
  row, so the focused action button vanished and focus fell to the document. The
  fix captures the focused control's `data-testid` (and its row's) before the
  rebuild and restores it on the replacement row.
- **The pinned panel's row actions were `display: none` until hover**, so the
  Jump/Unpin buttons could never be focused or reached by Tab — a hover-only
  action, not merely an invisible one. They now reveal on `:focus-within` with
  `opacity`/`pointer-events`, matching the message action bar.
- **The search overlay's input was not a combobox**: `role="listbox"` rows had no
  `aria-activedescendant` wiring and no live status, so a screen reader had no
  announced result set. It now matches the quick switcher's combobox pattern and
  its status carries `role="status"`.
- **Several icon-only controls had no accessible name**: the scroll-to-bottom
  button (a bare `↓`), the reply/edit cancel buttons, and the attachment-remove
  button (`title` alone is not an accessible name); the GifPicker's GIF play
  button and message-codeblock copy control were already named from B9-19.
- **The B9-16 appeals CSS used px literals** (`8px`/`12px`/`6px`/`border-strong`)
  from #1763; this lane moves it onto `--space-*`, `--radius-md` and
  `--border-control` per the firstmate spec.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Preserve B5 read/block/NSFW restrictions and B7 delivery/retry invariants. No new history or message protocol.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                      | Purpose                                            |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/{MessageList,MessageInput,SearchOverlay,PinnedMessages}.ts; Client/src/components/message-list/**` | Only measured interaction/semantics fixes          |
| `Owned messaging/overlay CSS from B9-1; feature catalogs`                                                                 | Scoped polish and accessible copy                  |
| `Client/tests/e2e/b9-messaging-polish.spec.ts (new)`                                                                      | Virtualized reading/composition journey            |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                                    | Dated implementation status and exact-SHA evidence |

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

### Task 1: Enumerate the reading workflow

Cover unread jump, history loading, live arrival, reply, edit/delete, reaction, autocomplete, search and pins. Add failing checks only for measured gaps, retaining the fixed timestamp/identity behavior from the ledger.

### Task 2: Fix semantic and focus behavior

Keep the active message/control reachable through virtualization, give icon controls usable names, preserve text selection and avoid announcing the entire history on every update. Ensure context actions work without hover.

### Task 3: Fix scoped layout/state inconsistencies

Apply owned messaging/overlay styles for long content, error/retry, empty search and large text; preserve scrolling and consent before media construction.

### Task 4: Record end-to-end accessibility

Test keyboard and screen reader through history pagination and new messages, the Q1 text scale (12–20 px with Large Font), OS zoom 200 % and 940×500 minimum-window reflow, reduced motion and contrast. Keep measured list performance within baseline.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/message-list.spec.ts; Client/tests/e2e/composer-advanced.spec.ts; Client/tests/e2e/message-actions.spec.ts
- Proposed: b9-messaging-polish.spec.ts; focused virtual-row retention unit tests

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

Virtualization can remove the focused row or create noisy announcements. Accessibility tests must exercise window changes, not a static five-message screen.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record — 2026-09-24

Branch `fm/b9-22-impl`; base `dev` `cd599319`. The owner's decisions applied are
in
[b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md#q13--visual-direction)
(Q13: Refined Neon tokens, Aurora components adoptable per lane; Q1/Q8
thresholds). No token files were edited and no Aurora treatment was adopted.

### What changed

- **Focus survives a virtualized rebuild (`MessageList.ts`).** `renderWindow`
  captures the focused control's `data-testid` (falling back to the row's first
  focusable control via the row's `data-testid`) before `clearChildren`, and
  restores it on the replacement row. A rebuild triggered by anything but the
  reader's own interaction keeps the keyboard user where they were instead of
  dumping focus on `<body>` (Q1: stable location through async update).
- **The scroll-to-bottom button is named** (`aria-label` from the new
  `scrollToBottom` catalog key) — it was a bare `↓` glyph.
- **Hover-only actions removed.** The pinned panel's `.pinned-msg__actions`
  switched from `display: none` (unfocusable) to `opacity`/`pointer-events`
  revealed on `:hover` **or** `:focus-within`; the message action bar's
  `:focus-within` reveal (present since earlier work) is now regression-pinned.
  The codeblock-copy and GIF play controls gained the same `:focus-within`
  reveal.
- **Search overlay is a real combobox** (`SearchOverlay.ts`): `role="combobox"`,
  `aria-controls`, `aria-activedescendant` re-pointed on every render (skipping
  an empty set), and a `role="status"` live region for searching/empty/failed.
- **Named composer controls** (`MessageInput.ts`): reply-cancel and edit-cancel
  get `aria-label`; the attachment-remove button names its file.
- **Q1 text contrast**: message timestamps, the edited marker, the grouped hover
  time and system-message time moved off the unqualified `--text-micro`
  (~2.5:1) onto `--text-muted` (5.1:1+); the add-reaction chip's dashed border
  moved from `--border` to `--border-control` and its colour onto `--text-muted`
  so the affordance is not a sub-3:1 decoration.
- **Target size**: the attachment-remove button 20→24px and the reaction chip a
  24px `min-height` floor (Q1, WCAG 2.5.8).
- **B9-16 appeal CSS onto tokens** (`overlays.css`): the #1763 px literals go to
  `--space-*` and `--radius-md`; the cancel button's edge uses `--border-control`
  (decorative `--border-strong` kept on the panel itself).

### Files changed

`Client/src/components/{MessageList,MessageInput,SearchOverlay}.ts`,
`Client/src/i18n/messaging.ts` (4 new keys; English byte-identical, kept behind
the B9-3 seam), `Client/src/styles/app/{messages,composer,pinned-messages,overlays}.css`,
`Client/tests/unit/message-list-focus-retention.test.ts (new)`,
`Client/tests/unit/b9-messaging-polish-css.test.ts (new)`, the extended
`message-input`/`search-overlay` unit tests, and
`Client/tests/e2e/b9-messaging-polish.spec.ts (new)`. No shared navigation,
`api.ts`, `types.ts`, dispatcher, global-store or token file was touched.

### Evidence

- **Unit:** full client suite 253 files / 6,096 passed (+152 expected failures),
  including the new focus-retention test (fails without the fix: the rebuilt row
  is a different node and focus is not restored), the new CSS parity test, and
  the extended composer/search suites. `tsc --noEmit`, `tsc -p tsconfig.e2e.json`,
  `eslint`, `oxlint`, `lint:cycles` and `knip` clean.
- **E2E (mocked, Chromium, `--workers=1`):**
  `Client/tests/e2e/b9-messaging-polish.spec.ts` — 9 tests: focus retained across
  a virtualized rebuild, the named scroll-to-bottom control, the action bar
  revealed on keyboard focus with a 3:1 ring, the composer's selection-preserving
  formatting and named controls, the named reply-cancel, the search combobox
  (aria-activedescendant + role="status"), the pinned panel's focus-revealed
  named actions, and 940×500 at 20px text with no overflow and 4.5:1 author text.
  The neighbour specs that touch these surfaces pass unchanged (110 tests across
  `message-list`, `message-actions`, `message-input`, `composer-advanced`,
  `search-overlay`, `overlays`, `message-edit-delete`, `reply-flow`,
  `chat-header`, `b9-navigation`, `b9-text-expansion`, `b9-shell-polish`).
- **Before/after screenshots** of the reading view, the focus-revealed action
  bar, the search overlay and the pinned panel (dark and light) plus the
  940×500/20px reflow were captured on the same 1280×800 (and 940×500) fixture
  at the base and the branch heads; the after-state shots are attached to the
  Playwright report (CI artifact) and the full before/after pair is in the PR.
- **Native AT (NVDA/Orca) recordings and OS-zoom checks are owner-run and remain
  pending**, consistent with the other B9 lanes.
- **Bundle budgets** (`npm run check:budgets` at the merged head): startup
  closure 96,149 B of the shared 97,000 B (raised by #1783 for B9-23); MainPage
  61,531 B of the unchanged 64,000 B. This lane adds ~800 B of startup (the
  focus-restore helpers, the search combobox wiring, four catalog keys and the
  CSS, which is not code-split) and ~220 B of MainPage; no budget was raised.

### Requirements and register

BPR-090 (coherent desktop reading/composing, preserved performance) and BPR-091
(keyboard, focus, contrast, reflow, announcements) get their automated evidence
here; the visual acceptance and native AT half remain owner-run. No new text was
added that is not behind the B9-3 seam, and English remains byte-identical
(`scripts/check-ui-strings.mjs` green against the shrink-only baseline).

### Drift from the plan

The plan's Task 1 asked to "enumerate the reading workflow ... add failing checks
only for measured gaps". The measured gaps are the four in
[Drift](#drift-at-the-implementation-base-2026-09-24) (focus loss on rebuild,
hover-only pin actions, non-combobox search, unnamed icon controls), each
covered by a failing-then-passing control. A wall-clock latency threshold is
intentionally not asserted, following B9-21's reasoning: a CI timing threshold
on a shared runner is flaky, and this lane's acceptance is focus/semantics, not
a stopwatch.
