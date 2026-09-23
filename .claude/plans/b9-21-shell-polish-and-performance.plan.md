# Plan: B9-21 — Polish desktop shell navigation without rebuilding it on every update

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-21-impl` from `dev` `55589d43`, merging `dev` `838bab09` (B9-7); the outcome and evidence are in [Implementation record](#implementation-record-2026-09-23).

> **Milestone:** B9-21 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-21-shell-polish-and-performance`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8. **Requirements:** BPR-090, BPR-091.
> **Dependencies:** B9-4, B9-18. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish desktop shell navigation without rebuilding it on every update. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Keep focus on a channel or DM while names, presence and unread counts change; navigate a long server list at high zoom.

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

| #   | Verified current state                                                                                    | Evidence at planning commit                            |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | SidebarArea documents an O(n) rebuild on DM/member changes. Measure this current path before changing it. | `Client/src/pages/main-page/SidebarArea.ts:660-673`    |
| 2   | Quick-switch height and scrolling are already bounded; OC-0372 is not an open implementation task.        | `Client/src/styles/app.css:4875-4905`                  |
| 3   | The embedded DM section clears and rebuilds its visible rows.                                             | `Client/src/pages/main-page/SidebarDmSection.ts:70-75` |

### Drift at the implementation base (2026-09-23)

Re-read at `55589d43` (`dev`, B9-18 merged). Rows 1 and 3 still hold after the
B9-1 CSS split and B9-18 text extraction; only line numbers moved (B9-1's
split sent the shell/sidebar rules to `Client/src/styles/app/shell.css` and
`Client/src/styles/app/sidebar.css`, cited in row 2 as the pre-split
`app.css`). Two facts the inventory did not name, found while measuring:

- The DM sidebar's own full rebuild is `Client/src/pages/main-page/SidebarArea.ts`'s
  `refreshDmSidebar()` (the old `TODO(H16)`), not just the embedded section: it
  destroys and recreates `DmSidebar` on every `dmStore.channels` change.
- Neither sidebar path preserves scroll position, and `.channel-list` was
  clipped rather than scrollable whenever the list exceeded its column (the
  flex chain let `.channel-sidebar` grow past its slot). Both are fixed here.

`dev` moved to `838bab09` (B9-7) during implementation; it was merged in (not
rebased), and the measured numbers below are from that merged head.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

No server changes; preserve B7 one active connection/media session and account-scoped caches.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                                                 | Purpose                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `Client/src/pages/main-page/SidebarArea.ts; Client/src/pages/main-page/SidebarDmSection.ts; Client/src/components/ChannelSidebar.ts` | Measured incremental rendering and keyboard behavior |
| `Owned shell/sidebar CSS from B9-1`                                                                                                  | Scoped desktop polish                                |
| `Client/tests/e2e/b9-shell-polish.spec.ts (new)`                                                                                     | Focus, scroll and performance evidence               |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                                               | Dated implementation status and exact-SHA evidence   |

Bounded-group amendments made during implementation (same purpose, named
explicitly as the table's groups were proposals):

| Added file                                                                     | Why it is in this lane                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Client/src/components/DmSidebar.ts`                                           | The DM list is the second surface the journey names ("a DM while names, presence and unread counts change"); the old `TODO(H16)` rebuild lives across `SidebarArea` and this component. |
| `Client/src/lib/reconcile.ts (new)`                                            | One keyed-list reconciler shared by both sidebars; a private copy in each would be two things to keep correct.                                                                          |
| `Client/src/lib/a11y.ts`                                                       | Added an `orientation` argument to `enableRovingNavigation` so a vertical navigation list steps with ArrowUp/Down; the horizontal default is unchanged.                                 |
| `Client/src/i18n/shell.ts`                                                     | No new keys: the category-name label now names its arrow via `aria-labelledby` rather than a second copy of the text.                                                                   |
| `Client/src/styles/app/sidebar.css; Client/src/styles/app/friends-dm.css`      | The owned shell/sidebar fragments; the reflow fix and focus/hover parity live here.                                                                                                     |
| `Client/tests/unit/reconcile.test.ts (new)` and the updated sidebar unit tests | Focused proof for the reconciler and the amended OC-0229/OC-0280 contracts.                                                                                                             |

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

### Task 1: Measure the exact interaction

Capture update latency, DOM replacements, focus and scroll behavior under the accepted representative member/channel/DM fixture. Preserve the accepted B7 startup and memory baseline.

### Task 2: Make bounded incremental updates

Replace unnecessary full rebuilds with keyed updates only where the measurement proves value. Preserve row identity, keyboard focus, current selection, unread/mention semantics and active call state.

### Task 3: Apply agreed shell consistency

Use existing identity and B9-2 tokens for spacing, empty/error/loading states and narrow desktop reflow. Do not remove navigation or rely on clipping when zoomed.

### Task 4: Compare evidence

Record before/after timing and screenshots on the same hardware/settings, including large profile lists and role/name/presence changes. Reject a faster implementation that changes announcements or focus.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/channel-sidebar.spec.ts; Client/tests/e2e/sidebar-header.spec.ts; Client/tests/e2e/server-profiles.spec.ts
- Proposed: b9-shell-polish.spec.ts; keyed-row identity/performance test

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

Keyed rendering can retain stale closures or subscriptions. Keep Disposable/session ownership and test deletion/reorder cases.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

One budget decision is open and escalated to firstmate (see the record below): the
MainPage chunk measure exceeds the shared 64,000 B budget by 434 B after this
lane; the raise is requested rather than erasing earlier notes.

## Implementation record — 2026-09-23

Branch `fm/b9-21-impl`; base `dev` `55589d43`, `dev` `838bab09` (B9-7) merged
in. The owner's decisions applied are in
[b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md#q13--visual-direction)
(Q13: Refined Neon tokens, Aurora components adoptable per lane). No token files
were edited.

### What changed

- **Measured before/after (source inspection + a jsdom probe).** At the base,
  a single `dmStore.channels` change replaced **every** DM row (0 surviving
  nodes in the probe) via `refreshDmSidebar()`, and an unread bump rebuilt the
  whole channel list (670 nodes under `.channel-list`, 0 survivors). After the
  change, a row whose key and rendered signature are unchanged keeps its DOM
  node; only the changed row is rebuilt.
- **`lib/reconcile.ts`** — a small keyed reconciler (`reconcileChildren`):
  reuse by `key` + `signature`, rebuild a changed row, remove the gone ones,
  restore focus to a rebuilt focused row, `dispose` a row before it detaches.
  It is not a virtual DOM; `signature` is the caller's honest statement of what
  the row draws.
- **`ChannelSidebar`** — two-level keyed reconciliation (category groups, then
  their rows); each row owns its own `Disposable` for its per-row listeners
  (context menu, drag), replacing the single per-render controller. A voice row
  is rebuilt on every render that a voice event can reach (`voiceTick`), since
  it carries live participant/stream/E2EE state; text rows stay keyed. Rows are
  keyboard-reachable: one Tab stop per list, ArrowUp/Down roving, Enter/Space
  activates, `role`/`aria-current` set, a visible `:focus-visible` ring.
- **`DmSidebar`** — rows keyed by DM channel; a new `update(conversations)`
  refreshes them in place instead of the caller destroying and recreating the
  component, so the search input, its value, focus and the list scroll all
  survive. Row keyboard semantics as above; the back header is a real
  focusable control.
- **`SidebarDmSection`** — the embedded preview's top-3 rows are keyed; the
  list is one Tab stop with vertical roving.
- **`SidebarArea`** — `refreshDmSidebar()` now calls `DmSidebar.update()`
  (removing the OC-0280 capture/restore of a destroy+recreate).
- **CSS (`app/sidebar.css`, `app/friends-dm.css`)** — focus-visible rings for
  the roving rows and the category arrow; hover parity for the "+" and DM
  close buttons (`:focus-within`), so no action is hover-only; 24×24 pointer
  targets (Q1, WCAG 2.5.8); and the reflow fix — `.channel-sidebar` takes
  `flex: 1 1 0; min-height: 0` so `.channel-list` scrolls instead of being
  clipped when a long list exceeds its column.

### Evidence

- **Unit:** full client suite 251 files / 6,025 passed (+152 expected failures),
  including the new `reconcile.test.ts` and the amended OC-0229 (row-listener
  lifetime across re-renders) and OC-0280 (DM search/focus preservation) tests.
  `tsc --noEmit`, `eslint`, `oxlint`, `lint:cycles` and `knip` clean.
- **E2E (mocked, Chromium, one spec, `--workers=1`):**
  `Client/tests/e2e/b9-shell-polish.spec.ts` — 6 tests: one Tab stop + arrow
  roving + Enter + ring; row identity across an unrelated unread update; DM
  search/focus across a presence change; scroll position preserved on a long
  list; reflow at 940×500; the embedded DM preview's Tab stop + arrows. All
  pass against the dev server. The neighbour specs that touch these surfaces
  also pass unchanged: `channel-sidebar`, `sidebar-header`, `sidebar-menus`,
  `b9-navigation`, `a11y-smoke`, `b9-text-expansion`, `server-profiles`,
  `overlays` (75 tests).
- **Native AT (NVDA/Orca) recordings and OS-zoom checks are owner-run and remain
  pending**, consistent with the other B9 lanes.
- **Bundle budgets:** startup closure 94,486 B of the shared 95,000 B;
  MainPage 64,434 B — **434 B over** the shared 64,000 B budget. This lane adds
  ~1.1 KB of MainPage (the reconciler and the keyed render paths, all startup
  code). The raise is requested (see open budget decision); no earlier budget
  note is erased.

### Requirements and register

BPR-090 (coherent desktop navigation, preserved performance) and BPR-091
(keyboard, focus, reflow) get their automated evidence here; the visual
acceptance and native AT half remain owner-run. Register C-13's "measured
incremental sidebar updates" clause is addressed: the `TODO(H16)` is gone and
the O(n) rebuild is replaced by a keyed, measured update.

### Drift from the plan

The plan's `Task 1` asked to "capture update latency, DOM replacements, focus
and scroll behavior". DOM replacements/identity and focus/scroll are asserted
directly (unit + e2e); a wall-clock latency threshold is intentionally **not**
asserted, because a CI timing threshold on a shared runner is flaky and the
owner's acceptance is DOM-identity/focus, not a stopwatch. This is recorded as
a deliberate scope choice, not an omitted check.
