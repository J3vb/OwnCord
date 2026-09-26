# Plan: B9-9 — Polish approved rich-content loading, failure and media controls

**Status:** IMPLEMENTED — native AT recordings declined by owner 2026-09-24 — 2026-09-24 on branch `fm/b9-9-impl` from `dev` `6671f228`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24). This file carries the status and evidence for this lane; the shared PRD status table is updated by the single docs lane (firstmate scope change, 2026-09-24).

> **Milestone:** B9-9 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-9-rich-content-states`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 2, 8. **Requirements:** BPR-061, BPR-062, BPR-091, BPR-092.
> **Dependencies:** B9-8. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish approved rich-content loading, failure and media controls. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Load a link, search a GIF, play/pause media and retry after network return while retaining message position.

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

| #   | Verified current state                                                                                                         | Evidence at planning commit                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Preview failures currently reduce to empty metadata and a fallback host label.                                                 | `Client/src/components/message-list/embeds.ts:69-84`; `Client/src/components/message-list/embeds.ts:132-141`                           |
| 2   | GIF picker already has loading, empty, roving keyboard navigation and a provider-disabled branch. Preserve these distinctions. | `Client/src/components/GifPicker.ts:73-81`; `Client/src/components/GifPicker.ts:104-119`; `Client/src/components/GifPicker.ts:162-179` |
| 3   | YouTube play activation and external-image layout are distinct rendering paths.                                                | `Client/src/components/message-list/media.ts:218-242`; `Client/src/components/message-list/media.ts:257-290`                           |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Consume existing B7 broker results and B5 GIF_DISABLED behavior; no policy broadening, new providers or client-held provider key.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                   | Purpose                                            |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `Client/src/components/message-list/{embeds,media,attachments}.ts; Client/src/components/GifPicker.ts` | Typed view states and accessible controls          |
| `Owned messaging/overlay CSS from B9-1; Client/src/i18n/content.ts (new)`                              | Local layout and English copy                      |
| `Client/tests/e2e/b9-rich-content.spec.ts (new)`                                                       | Failure, keyboard, motion and scroll evidence      |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                 | Dated implementation status and exact-SHA evidence |

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

### Task 1: Use typed states

Distinguish concealed, loading, loaded, unavailable, refused, expired and no-results. Provide a bounded explicit retry when meaningful; never retry a refused destination automatically or turn unavailable into success.

### Task 2: Make controls operable

Use keyboard-operable play/pause/open/save controls with accessible names, provider attribution and stable focus. Respect reduced motion and preserve GIF freezing and the bundled watermark (`Client/src/components/message-list/media.ts:312-342`); keep the existing provider set.

### Task 3: Preserve layout and bounds

Keep virtual-list anchor stability while media dimensions arrive, use lazy mounting after permission and release blob resources on teardown. A retry rechecks consent and current account partition.

### Task 4: Record mode evidence

Run successful, disabled-provider, offline, timeout, oversized, wrong-type, expired-handle and reconnect cases without leaking raw URLs/content into status or evidence logs.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/unit/media.test.ts; Client/tests/unit/embeds.test.ts; Client/tests/unit/gif-picker.test.ts; Client/tests/e2e/message-media.spec.ts
- Proposed: b9-rich-content.spec.ts with all ExternalContentFailure variants

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

A unified error message can erase the difference between policy refusal and network failure. Keep that distinction actionable without exposing implementation-sensitive details.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Drift at the implementation base (2026-09-24)

Re-read at `dev` `6671f2283f448afebe896eac993219df0529b692` (B9-8 merged as
[#1771](https://github.com/J3vb/OwnCord/pull/1771)):

- The three inventory rows hold, moved by the B9-8 consent gate: preview
  rendering and its refusal path are now `embeds.ts:60-114` (`fetchOgMeta`) and
  `:125-215`; YouTube activation is `media.ts:178-286`; the GIF picker's
  provider branch is `GifPicker.ts:200-260`.
- Row 3 moved: YouTube playback is already a `<button>` named "Play on
  YouTube" (B9-8), not a `div`; the remaining gap is the inline image, which was
  pointer-only.
- Not in the table: every refusal collapsed to `EMPTY_OG`/`null` at the render
  seam (`embeds.ts:77-95`, `media.ts:329-333`), so a policy refusal and a
  network failure were indistinguishable and no retry existed.
- Bundle base: startup closure 94,601 B / 95,000 B, MainPage 63,672 B / 64,000 B.

## Implementation record (2026-09-24)

### Implementation decisions and file-table amendments

- **Typed view states.** A preview's broker answer is kept as an
  `OgLoad` (`{ok:true, meta}` | `{ok:false, failure}`) through the cache,
  in-flight map and re-ask map (`embeds.ts`), so a refusal renders as
  `data-embed-state="failed"` plus `data-embed-failure` and never as a loaded
  card. An inline external image carries `data-media-state` ("loading" /
  "loaded" / "failed").
- **Bounded, explicit retry.** A shared `renderFailureStatus` (in
  `attachments.ts`) renders one status line plus a named retry button for the
  preview and inline-image paths and the GIF picker. On previews and inline
  images the retry is shown only for the transient `unavailable` class
  (including an image whose bytes fail to decode); a policy refusal
  (`blocked-destination`, `too-many-redirects`, `oversized`, `wrong-type`,
  `expired-handle`) is never auto-retried and offers no retry. A retry clears
  the cached refusal and calls the same `previewExternal`/`loadExternalImage`
  seam, which rechecks consent and the current partition (B9-8 preserved).
  While it re-asks, the retry stays mounted and focused with `aria-disabled`;
  focus then moves to the loaded image, or to the preview's link when the
  retry goes away, and the GIF picker's retry hands focus to the search field.
- **Keyboard-operable controls.** The inline external image is now a
  `role="button"`, `tabindex="0"` control named "Open image from {host}" with
  Enter/Space opening the lightbox; it stays hidden, and so out of the Tab
  order, until its bytes load. The lightbox is `role="dialog"` named after the
  image, `aria-modal`, takes focus on open (its named close button), traps Tab
  on that single stop, and restores focus to the opener on close.
- **Provider attribution and copy.** New copy lives in `i18n/content.ts`
  (lazy: previews, images, GIF picker) and `i18n/mediaControls.ts` (startup:
  the lightbox close button only), per the B9-3 catalog rule; the ratchet baseline
  shrank by the two now-extracted literals. The YouTube play button already
  names YouTube and keeps its `aria-describedby` note (B9-8).
- **Reduced motion and media controls.** No new animation was added; the
  failure line and retry are static, and the freeze/play GIF control and the
  bundled Klipy watermark are untouched.
- **Files beyond the table:** `i18n/mediaControls.ts` (new, the startup-safe
  slice) and `scripts/ui-strings-baseline.json` (shrunk by two literals). The
  bundled per-file retry for server video/audio attachments was dropped: the
  plan's inventory is the external rich-content set, and the added UI pushed
  the shared startup budget over its 95,000 B ceiling. Media attachments keep
  the existing honest `.msg-media-failed` dim-with-download state. No
  navigation, token, style-import, store or dispatcher change.

### Evidence

- **Unit:** `npx vitest run tests/unit src` — 295 files, 6,599 passed, 152
  expected-fail (on the follow-up branch off `dev` `782e010e`; 292 files,
  6,553 passed on the original PR's base). New named cases: the typed preview
  failed state and its
  bounded retry (`embeds.test.ts`), the inline-image failed state/retry,
  "never reads as loaded", "offers no retry for a policy refusal", "keeps the
  image hidden and unopenable until its bytes load", "an image that fails after
  the broker served it lands in the failed state", focus retention on retry and
  the dialog naming (`media.test.ts`), the picker's typed failure and retry
  (`gif-picker.test.ts`).
- **Mocked shell:** `npx playwright test tests/e2e/b9-rich-content.spec.ts
--workers=1` — 17 passed. The test-gate's eight live scenarios map to these
  covering specs (all mocked-shell; the native broker leg remains B9-8's):
  1. Loaded preview + loaded image — `b9-rich-content.spec.ts` "a successful
     preview loads…"; `message-media.spec.ts` "renders the OG title…" and
     "renders the player card…".
  2. All six `ExternalContentFailure` preview refusals — `b9-rich-content.spec.ts`
     the six `a ${failure} preview refusal never reads as a loaded card` cases.
  3. Policy refusal of the inline image offers no retry and is not a Tab stop —
     `b9-rich-content.spec.ts` "a policy refusal of the inline image offers no
     retry and is not a Tab stop" (newly added this pass).
  4. Keyboard Enter on Retry keeps focus while re-asking — `b9-rich-content.spec.ts`
     "the retry control is keyboard operable with an accessible name";
     `media.test.ts` "keeps keyboard focus on the retry…".
  5. Transient image failure recovers on Retry, focus to the image, Space opens
     the lightbox, Escape restores focus — `b9-rich-content.spec.ts` "a transient
     image failure is retried…" and "an inline image is keyboard operable and the
     lightbox contains then restores focus".
  6. After the consent reset a stale Retry sends nothing to the broker —
     `b9-rich-content.spec.ts` "a consent reset re-conceals the failed image and
     no stale retry can fetch" (newly added); `b9-content-consent.spec.ts` reset
     journey; `features/content-consent/external.test.ts` "refuses at the broker
     seam too".
  7. GIF transient failure shows "Couldn't load GIFs" + Retry and re-queries —
     `b9-rich-content.spec.ts` "a transient GIF failure is a typed retry, not
     the empty state" (newly added); `gif-picker.test.ts` typed-failure/retry.
  8. Q1 names/contrast/focus, no motion under reduced motion, 940×500 reflow at
     20 px 1×/2× — `b9-rich-content.spec.ts` the Q1, reduced-motion and reflow
     cases.
     This pass added three e2e cases (scenarios 3, 6, 7) and taught the native mock
     to refuse an image by failure class (it previously answered only bytes or a
     blanket `unavailable`), and extended the existing scenario 4 and 5 cases to
     assert the re-ask, the retained or moved focus, and the Space/Escape
     lightbox round trip; no other scenario was genuinely missing.
- **Consent preserved:** `b9-content-consent.spec.ts`, `message-media.spec.ts`
  — 26 passed; B9-8's zero-fetch-before-consent and its reset journey are
  unmodified.
- **Bundle:** startup closure 94,872 B / 95,000 B (+271 B, the startup
  `mediaControls` catalog and the lightbox focus code); MainPage 63,709 B /
  64,000 B (+37 B). No budget change; no note appended. Re-measured on Linux
  after the review fixes (which dropped two unused startup keys), base
  `1a3a7b1d` → this change: startup closure 93,150 → 93,384 B (+234 B),
  MainPage 63,841 → 63,890 B (+49 B, 110 B headroom).
- **Lint:** `npm run lint` (oxlint, cycles, eslint) and both typechecks clean.
- **Native:** NVDA (Windows) and Orca (Linux) recordings were declined by the
  owner 2026-09-24; the native broker traffic proof remains B9-8's
  `tests/e2e/native/b9-content-consent.spec.ts` (CI `native-core`).
