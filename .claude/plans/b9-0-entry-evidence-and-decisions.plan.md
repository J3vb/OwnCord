# Plan: B9-0 — Verify entry evidence and settle the execution contract

**Status:** COMPLETE — 2026-09-23 at `dev` `f32149c4`; evidence in `docs/plans/b9-entry-baseline-2026-09-23.md`.

> **Milestone:** B9-0 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `docs/b9-0-entry-evidence-and-decisions`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** entry; 8, 10. **Requirements:** BPR-064, BPR-090..092; BPR-060..063, BPR-070..073.
> **Dependencies:** None; documentation-only entry preparation. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

This milestone produces evidence and decisions only; it does not implement feature code.

**User journey:** Connect, open Settings, switch a server, navigate a channel and review the current consent prompt without changing state.

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

| #   | Verified current state                                                                                                                                                              | Evidence at planning commit                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Desktop qualification is not complete: the updater target map has no Windows ARM64 entry. Do not infer a green four-target matrix from a server ARM64 job.                          | `Server/updater/assets.go:32-43`                                                                                      |
| 2   | The broker interface and native bindings exist despite the B7 PRD still labelling B7-16 pending.                                                                                    | `Client/src/platform/contracts/externalContent.ts:18-64`; `Client/src/platform/desktop/externalContent.ts:55-67`      |
| 3   | The current accessibility smoke checks dialog semantics, focus and live regions with mocked Tauri sessions; it is not a full native assistive-technology acceptance report.         | `Client/tests/e2e/a11y-smoke.spec.ts:1-24`; `Client/tests/e2e/a11y-smoke.spec.ts:26-105`                              |
| 4   | B5 explicitly leaves moderation-evidence consent verification as a prerequisite of the B9 interface. HP-5 accepted designs and narrowed server-only exits, not final B5 completion. | `docs/plans/b5-community-content-moderation-2026-09-04.md:2940-2956`; `docs/plans/hp-5-scorecard-2026-09-05.md:18-28` |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

No new server contract. B5 consent acceptance and B7 desktop qualification are prerequisites, not waived by this document.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                           | Purpose                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `docs/plans/b9-entry-baseline-<date>.md (new)`                                                                 | Measured baseline, entry decision and journey/evidence manifest |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md; docs/plans/README.md`                           | Dated status and accepted owner decisions                       |
| `docs/plans/repo-health-issue-register-2026-08-23.md; docs/plans/beta-requirements-traceability-2026-08-23.md` | Evidence-backed status reconciliation only                      |

Shared edits to navigation, `api.ts`, `types.ts`, `dispatcher.ts`, global stores,
tokens and style import composition take the PRD's single-writer lane. Parallel
work may prepare local modules; shared edits merge sequentially after rebase.

## Tasks

### Task 0: Verify the real base and acceptance preconditions

For this documentation-only preparation, unmet product gates are findings to record, not permission to implement. Create the named branch from `dev`; record its full SHA. Recheck the inventory,
dependency evidence and applicable owner answers. Capture the current affected
checks before changes. An unmet gate means **blocked**, not a speculative
implementation against a made-up endpoint. Retain the reviewed code proof above
and record missing controls for future implementation; no threshold weakening.

### Task 1: Recount at the implementation head

Record git SHA, branch, tool versions, code-versus-document verdicts, and evidence links for every PRD entry gate. Obtain B7-17/HP-7 and B5 follow-up acceptance; an absent run or signature remains NOT MET. Preparation may proceed without pretending this authorizes implementation.

### Task 2: Obtain the owner decisions

Record pre-implementation answers to Q1–Q10 in the PRD, with date and reason; schedule Q11/Q12 explicitly for HP-9. Agree the token inventory, interaction rules, accessibility checks, evidence matrix and file ownership before the first product PR. A recommendation is not a decision.

### Task 3: Record baselines and claims

Produce the B9 baseline and requirement-journey matrix. Use accepted B7 bundle/runtime evidence or measure the missing runtime baseline on the named desktop machine; no invented latency target. Record screen reader/OS versions and fresh screenshots of current themes.

### Task 4: Reconcile the register safely

Compare every B9-tagged OC row with the ledger. All 24 are fixed at this planning commit (see the PRD ledger references); preserve that history and assign regression evidence instead of reopening them. None of the four open ledger findings is a B9 UI fix. Record upstream release blockers without changing their status.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/a11y-smoke.spec.ts; Client/tests/unit/platform/externalContent.desktop.test.ts
- Evidence: b9-entry-baseline-<date>.md, exact-SHA B7 desktop artifact matrix and HP-7 acceptance; B5 consent follow-up acceptance

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

Stale status rows can look like either missing code or completed acceptance. Separate source presence, passing tests, and owner acceptance.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q1 — Accessibility acceptance contract

**Decided 2026-09-23 by the owner:** adopt a WCAG 2.2 AA-oriented checklist as the B9 acceptance bar. Named assistive technologies: NVDA (current stable) on Windows 11 and Orca (current GNOME release) on Linux; one native recording per milestone journey on each. Thresholds: text contrast 4.5:1, large text / UI components / focus indicators 3:1 (WCAG 1.4.3, 1.4.11); visible, unobscured focus (2.4.7, 2.4.11); pointer targets at least 24×24 CSS px (2.5.8); text spacing (1.4.12); no content or function lost at the app text scale of 12–20 px with Large Font on, at OS zoom 200 %, and at the 940×500 minimum window (1.4.10 as applied to desktop); reduced motion honoured from both the OS setting and the in-app toggle. The repository owner is the named human reviewer; automated reports supplement, never replace, the manual checks. This is a bar for B9 acceptance, not a certification claim.

**Options and consequences:** Adopt a documented WCAG 2.2 AA-oriented checklist with Windows NVDA and Linux Orca native checks, text scaling and desktop reflow; or specify an equivalent native-task checklist covering every roadmap property with explicit thresholds and AT coverage. The first provides familiar criteria; the second needs more owner review to establish equivalent coverage. Structural smoke alone is insufficient under either option.

**Drafting recommendation (historical):** Adopt the broader checklist, name supported OS/AT versions and assign human reviewers before implementation. This is a proposed bar, not a claim of certification.

### Q2 — Navigation and badge placement

**Decided 2026-09-23 by the owner:** keep the existing shell; no new rail. Message Requests: a "Message Requests (N)" section at the top of DM mode, N = pending requests from `GET /api/v1/dm-requests`, kept live by the `dm_request` frame. Badge meaning: the DM header badge shows pending-request count separately from unread; request messages never add to unread or mention counts, never flash the taskbar and never raise a desktop notification before acceptance. Moderation Center: a "Moderation" button in the server header beside "Audit Log", shown only with `MODERATE_MEMBERS`, opening a content-area view (not the browser); no badge in beta, the open-report count is shown inside the view. Personal notices, restrictions, own reports and appeals: a "Safety" tab in Settings, linked from the Q4 notice banner. Back: the Moderation Center and Requests views reuse the existing `channelBeforeDm` return path (close or Escape returns to the channel the user came from).

**Options and consequences:** Place Requests beside DMs, Moderation Center behind a permission-gated server entry and personal notices/appeals in a safety view; or use a new top-level navigation rail. The first changes familiar workflows less; the rail is more visible but has a larger navigation and reflow cost. Badge semantics (pending requests versus unread) also need an explicit choice.

**Drafting recommendation (historical):** Use the existing shell and a pending-request count; approve destinations, back behavior and badge meaning together before B9-4.

### Q3 — External-content consent scope and persistence

**Decided 2026-09-23 by the owner:** one consent choice per server profile, persisted across restarts. The first time a message would load external content on a given server, nothing is fetched; a dialog states in one sentence that previews and images are fetched from the viewer's machine to hosts chosen by message authors, and offers "Load automatically on this server" or "Ask each time". "Ask each time" is per-item click-to-load. The grant is keyed by server profile (not global), stored with the other client preferences, and is revoked by turning off the existing Text & Images toggles or by a "Reset external content consent" action in that tab. Message Request previews and NSFW channels stay separately gated and never inherit this grant. YouTube playback remains a separate explicit click, as today.

**Options and consequences:** Require per-item activation without persistence; remember consent for this server/account session; or persist provider/server permission across restarts. Per-item is clearest but repetitive, session memory reduces prompts, persistent grants need a discoverable revocation/reset model and stronger lifecycle evidence. All options keep zero fetch before the applicable acknowledgement; NSFW and request trust remain separate.

**Drafting recommendation (historical):** Start with explicit per-item activation and no durable grants; offer broader grants only after the owner chooses their exact scope. Playback remains a separate deliberate action.

### Q4 — Warning and timeout presentation

**Decided 2026-09-23 by the owner:** persistent notice, never a blocking modal. Unacknowledged warnings render as a top-of-app banner (the existing banner slot pattern) with the reason, the date, and one "Acknowledge" button that calls `POST /api/v1/users/me/notices/{id}/ack`; the banner has no other dismiss and survives navigation until the server confirms the acknowledgement. Multiple warnings stack oldest first. Timeouts are not banners: the composer, reaction controls and voice join show the disabled state inline with the server-supplied expiry ("You can't send messages until 14:05"); a local countdown is advisory and re-validates on the server's refusal codes. A one-time toast announces a newly received warning or timeout for screen readers.

**Options and consequences:** Use a persistent dismiss-resistant notice with an explicit Acknowledge action; or a blocking modal before other navigation. The former preserves access to recovery and help; the latter is harder to miss but interrupts the whole app and has stronger focus/escape obligations.

**Drafting recommendation (historical):** Use a persistent notice with explicit acknowledgement; keep timeout state adjacent to disabled actions. The server acknowledgement requirement does not itself settle whether the UI blocks navigation.

### Q5 — Effective voice moderation affordance contract

**Decided 2026-09-23 by the owner:** option (a). A separate small server PR (protocol-change skill) adds one boolean, `can_moderate_voice`, to each channel object in `ready` and in the per-user `channel_create` refresh, beside `can_send`. It is computed by the existing `permissions.CanModerateVoice` for the caller in that channel (effective READ | MUTE_MEMBERS after both override layers). It is refreshed on the same events that refresh `can_send` today, plus a per-user `channel_update` push when a role or user override on that channel changes. The client shows the four voice-moderation actions only when `can_moderate_voice` is true; target rank, timeouts and destination capacity remain server-side refusals and are surfaced as such. No override data is exposed to members; no server authorization is rewritten.

**Options and consequences:** Provide a narrow server-computed capability projection for the caller in each channel; or expose sufficient authorized overrides for a complete client derivation. The first keeps policy canonical and payload small; the second duplicates more permission logic and data. Role-only controls with eventual server refusal do not close SEC-02's effective-permission UI requirement.

**Drafting recommendation (historical):** Approve a minimal server-derived projection as a separately planned prerequisite PR; settle its payload, refresh semantics and owner before B9-14. Do not silently widen B9-14 into a server authorization rewrite.

### Q6 — Restart-safe recipient sanctions and appeal eligibility

**Decided 2026-09-23 by the owner:** option (a), as a separate B5 contract-completion PR. Add `GET /api/v1/users/me/moderation` (session auth) returning the caller's own ledger rows of kind warning, timeout, removal, and ban where the ban has lapsed or been reversed, newest first, bounded by the existing retention sweep. Each row: `id` (the ledger id appeals use), `kind`, `reason`, `created_at`, `expires_at`, `lifted_at`, `acknowledged_at`, `appealable` (computed by the same rules `Submit` applies: kind eligible, not already appealed), and `appeal` (`{id, state}` or null). Excluded by construction: actor, reporter, report link, evidence, internal notes. Keep `ready.notices` as the fast path for unacknowledged warnings. Currently banned users remain out of band under B5 policy. B9-15/16 stay blocked for complete closure until this contract is accepted.

**Options and consequences:** Add a member-safe own-action/restriction read with ids, reasons, expiry and eligibility; or use only existing live frames and ready warnings. The read needs a narrowly scoped server contract PR; live-only UX cannot recover removal/timeout action ids and all eligible history after restart and leaves BPR-072/073 incomplete. Currently banned users remain out-of-band under the existing B5 policy in either case.

**Drafting recommendation (historical):** Approve a separate B5 contract-completion PR for own-action/restriction discovery, with a DTO excluding reporter/evidence/internal notes. B9-15/16 remain blocked for complete closure until its exact contract is accepted.

### Q7 — Translation boundary beyond renderer text

**Decided 2026-09-23 by the owner:** option (a), bounded as follows. In scope: every app-authored string in `Client/src` (labels, accessible names, errors, toasts, banners, notification titles and bodies, date/number formatting) through the B9-3 catalog seam with typed parameters and plurals. Rust: only the user-visible native surfaces, moved into one `Client/src-tauri/src/text.rs` constant table with an extraction test; today that is the tray menu (`tray.rs`), the startup failure dialog (`lib.rs`) and the certificate/TOFU messages (`tofu.rs`, `ws_proxy.rs`). Rust strings returned to the renderer as errors are classified as codes: the renderer maps them to catalog text and shows the raw text only as a fallback detail. Server errors: the client maps the `error` code (`TIMED_OUT`, `NSFW_ACKNOWLEDGEMENT_REQUIRED`, `BANNED`, `RATE_LIMITED`, ...) to catalog text and shows the server `message` only when no mapping exists. Explicitly excluded with a written reason: OS-owned dialogs, user content, server-authored data (names, topics, reasons), and the separately served admin panel. Catalogs are feature-owned after B9-3.

**Options and consequences:** Cover all app-authored desktop text, including native menus/notifications/errors, while treating OS/user/server data as classified inputs; or limit extraction to TypeScript. TypeScript-only is smaller but leaves desktop-owned text outside BPR-064; including the server admin panel would further expand this client phase.

**Drafting recommendation (historical):** Cover renderer and app-authored native desktop text, inventory visible server errors with a client mapping where appropriate, explicitly exclude OS/user data and the separately served admin panel. Confirm catalog ownership and those exclusions.

### Q8 — Theme and custom-accent accessibility policy

**Decided 2026-09-23 by the owner:** option (a), scoped. Qualify the four built-in themes (dark, neon-glow, midnight, light) and the High Contrast toggle at the Q1 thresholds, and the ten preset accent swatches with them. A custom accent is honoured for fills and decoration. Three tokens are derived from it at apply time: `--on-accent` (white or near-black by WCAG relative luminance, used for all text on accent surfaces), `--accent-hover` and `--accent-active`. Where the accent itself is the text or the focus indicator and its contrast against the theme background is below 3:1, those uses fall back to the theme's default accent; fills keep the user's colour. One line under the accent input discloses this: "Custom colours may reduce readability; text and focus indicators fall back to a readable colour when needed, and High Contrast restores tested colours."

**Options and consequences:** Qualify every built-in theme and provide a contrast-safe fallback for arbitrary custom accents; or require/warn users to adjust custom themes themselves. Fallback preserves readable controls but can alter chosen colors; warnings preserve exact choices but cannot establish an all-settings contrast claim.

**Drafting recommendation (historical):** Qualify built-ins and high-contrast mode, retain identity, and approve a safe fallback for essential text/focus indicators. The owner must decide how custom accents are constrained or disclosed.

### Q9 — B9 start while upstream acceptance is open

**Decided 2026-09-23 by the owner:** written amendment, narrow. B9-0 (evidence and decisions), B9-1 (mechanical CSS split), B9-2 (shared accessibility/tokens) and B9-3 (English text seam) may start now, in that serialized order, because none touches a B5 contract, native code or desktop-qualification evidence. B9-4 onward keeps the gate order: B7-17/HP-7 accepted, the B5 moderation-evidence consent follow-up accepted, and B7-10/B7-11 merged before any B9 change to MainPage, dispatcher, stores or `api.ts`. Residual risks accepted with this amendment: (1) rebase cost if B7-5/B7-9/B7-10 touch the same style or shell files; (2) B9-1's output-equality evidence must be re-run at the actual merge base; (3) nothing here authorizes moderation-evidence UI (B9-11) before its contract is accepted, and nothing waives HP-6/HP-7. This is not inferred from B7's HP-6 exception; it is its own dated decision.

**Options and consequences:** Keep all product implementation behind the roadmap entry gates; or approve a written amendment allowing specific non-boundary work before B7/B5 closure. Strict ordering waits for evidence; a narrow exception could allow CSS/text work but must list residual risks and cannot authorize moderation evidence before its contract is accepted.

**Drafting recommendation (historical):** Keep current gate order. This planning PR and non-mutating evidence preparation are allowed now; do not infer a waiver from B7's HP-6 exception.

### Q10 — Timeout duration control

**Decided 2026-09-23 by the owner:** option (a). One duration input (a number with a minutes/hours/days unit selector), validated client-side to the server's 1 minute–28 days and sent as `duration_seconds`; server validation remains authoritative and its `BAD_REQUEST` message is shown on refusal. A "Lift timeout" action calls the existing untimeout route. No presets in beta.

**Options and consequences:** Use a validated duration input within the existing one-minute to 28-day bounds; or add owner-chosen presets plus custom input. The former avoids inventing moderation policy; presets are faster but imply preferred sanction lengths.

**Drafting recommendation (historical):** Use a validated duration input initially; add presets only if the owner chooses their labels and values.

### Q11 — BPR-051 comprehension-read method at HP-9

**Decided 2026-09-23 by the owner:** option (a). Readers: two desktop users who are not contributors to OwnCord, recruited by the owner (roles, not names, are recorded). Journey on the release candidate: install and sign up (retention summary at sign-up), open Settings > Account (retention and permanent-deletion text), Settings > Logs (local export note), and read the "short answer" section of `docs/trust-model.md`. Questions, answered unprompted in their own words: (1) Who can read your messages and files on this server? (2) What does the "End-to-end encrypted" badge on voice cover, and what does it not cover? (3) What happens to your messages when you delete your account, and can a backup bring them back? (4) What is in the support export and where does it go? Pass criterion: both readers answer all four correctly; one miss is a documentation defect to fix and re-read before HP-10. Results are recorded in the HP-9 scorecard against the RC SHA. This obligation stays in beta even though the longer documentation rows moved.

**Options and consequences:** Have one or more non-developer desktop users explain the operator trust, text/file access, deletion/backup and local-export disclosures after following the journey; or rely only on technical review. The first satisfies the stated comprehension purpose; technical review alone leaves that B10 item unproven.

**Drafting recommendation (historical):** Owner names the reader(s), questions and pass criterion at HP-9, records safe results against the RC and keeps this B10 obligation even if longer documentation moves later.

### Q12 — Confirm or revise the shortened B10 cut list

**Decided 2026-09-23 by the owner (to be recorded at HP-9):** confirm the 2026-09-18 table row by row, with two additions that do not change any verdict. First, give the "later beta-to-stable gate" a phase id now, proposed B11, so items 2, 3, 13, 14 and the moved half of item 11 have an owner row in the roadmap instead of "no phase id assigned yet". Second, at HP-9 re-examine only item 11's moderation half with the shipped B9 features in hand: if the Moderation Center, appeals and the out-of-band ban-appeal route ship in the beta, a one-page user guide for them stays in beta; accessibility, support, feedback and contribution documentation move as decided. Retained and unchanged: the RC matrix (1), alpha upgrade/rollback (4), protocol re-run (5), desktop/server/Docker matrix (6, 7), one capacity comparison (8), zero open P0/P1 and advisories (9), packaging/provenance/signing/update checks (10), safe release notes (12), item 15 per Q11, and HP-10.

**Options and consequences:** Confirm the 2026-09-18 keep/reduce/move table; or revise named rows at HP-9. Confirmation moves thirty-run and fourteen-day-soak evidence and the listed documentation to a later beta-to-stable gate; revision changes release work and needs an updated dated roadmap decision. Neither choice waives RC checks, upgrade/rollback, advisory closure or HP-10.

**Drafting recommendation (historical):** Review the table row by row at HP-9 and record the owner's decision and later-gate ownership; do not pre-approve it in B9 planning.
