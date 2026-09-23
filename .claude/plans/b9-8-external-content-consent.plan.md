# Plan: B9-8 — Apply external-content consent before broker or provider work

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-8 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-8-external-content-consent`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 2, 8. **Requirements:** BPR-061, BPR-062, BPR-063, BPR-091.
> **Dependencies:** B9-7, B9-3. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Apply external-content consent before broker or provider work. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Tab to a concealed external item without loading it; acknowledge, play, revoke, revisit a warm cache and switch server.

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

| #   | Verified current state                                                                                                                      | Evidence at planning commit                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The broker returns typed preview metadata and images with six refusal classes; calls accept a partition but no cancellation signal.         | `Client/src/platform/contracts/externalContent.ts:18-64`                                                                                                             |
| 2   | Generic preview rendering starts a broker preview and can recover an expired image handle.                                                  | `Client/src/components/message-list/embeds.ts:60-84`; `Client/src/components/message-list/embeds.ts:132-141`; `Client/src/components/message-list/embeds.ts:183-199` |
| 3   | YouTube title and thumbnail load through the broker; playback creates a fixed-host sandboxed iframe on click. The frame is a distinct path. | `Client/src/components/message-list/media.ts:178-239`                                                                                                                |
| 4   | External caches are cleared during MainPage teardown.                                                                                       | `Client/src/pages/MainPage.ts:1020-1026`                                                                                                                             |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

B7-16 ExternalContentBroker.preview/image, B5 GIF proxy and NSFW consent. Preserve bounded retrieval, cache partitions, TOFU for server files and no credentials on external fetches. No server unfurl proxy.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                   | Purpose                                            |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `Client/src/features/content-consent/**`                                                               | External consent model and placeholder control     |
| `Client/src/components/message-list/{embeds,media,attachments}.ts; Client/src/components/GifPicker.ts` | Admission gates and cache/retry lifecycle          |
| `Client/tests/e2e/native/b9-content-consent.spec.ts (new)`                                             | Native invocation and provider traffic evidence    |
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

### Task 1: Implement only the approved consent lifetime

Apply Q3 to a small feature-owned permission model; keep provider consent distinct from NSFW and Message Request trust. No ordinary render, hover, focus or observer may grant permission. State the viewer-IP disclosure before acknowledgement.

### Task 2: Guard every admission path

Guard OG/oEmbed, thumbnails, inline external images, sent GIFs, picker/provider queries and retry/expired-handle recovery before invoking the B7 broker or first-party GIF proxy. Request preview and unacknowledged NSFW content remain suppressed even if external consent was previously granted.

### Task 3: Separate playback consent

Require deliberate activation before the YouTube iframe is created, name the provider and explain playback leaves the broker byte-fetch boundary. Keep fixed host/sandbox/CSP unchanged. Revoke removes frames, revokes object URLs and invalidates pending UI/cache results.

### Task 4: Verify across sessions and modes

Test cold and warm caches, lazy rows, repeated activation, revoke, account/server switch, LAN-only server with internet blocked, network return and unavailable native host. Native traffic capture must prove zero work before permission; a mock alone is insufficient.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/unit/embeds.test.ts; Client/tests/unit/media.test.ts; Client/tests/unit/gif-picker.test.ts; Client/tests/unit/platform/externalContent.suite.ts
- Proposed: content-consent/external.test.ts; native/b9-content-consent.spec.ts

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

Playback is not brokered bytes; promising that every iframe subrequest is covered by broker limits would be false. Consent on one gate must never implicitly satisfy another.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q3 — External-content consent scope and persistence

**Decided 2026-09-23 by the owner:** one consent choice per server profile, persisted across restarts. The first time a message would load external content on a given server, nothing is fetched; a dialog states in one sentence that previews and images are fetched from the viewer's machine to hosts chosen by message authors, and offers "Load automatically on this server" or "Ask each time". "Ask each time" is per-item click-to-load. The grant is keyed by server profile (not global), stored with the other client preferences, and is revoked by turning off the existing Text & Images toggles or by a "Reset external content consent" action in that tab. Message Request previews and NSFW channels stay separately gated and never inherit this grant. YouTube playback remains a separate explicit click, as today.

**Options and consequences:** Require per-item activation without persistence; remember consent for this server/account session; or persist provider/server permission across restarts. Per-item is clearest but repetitive, session memory reduces prompts, persistent grants need a discoverable revocation/reset model and stronger lifecycle evidence. All options keep zero fetch before the applicable acknowledgement; NSFW and request trust remain separate.

**Drafting recommendation (historical):** Start with explicit per-item activation and no durable grants; offer broader grants only after the owner chooses their exact scope. Playback remains a separate deliberate action.
