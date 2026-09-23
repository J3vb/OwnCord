# Plan: B9-0 — Verify entry evidence and settle the execution contract

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

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
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                         | Dated implementation status and exact-SHA evidence              |

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
- [ ] **Screen reader:** approved native AT reads names, roles, values, errors
      and relevant status once; no concealed/private/secret content in its tree.
- [ ] **Focus:** visible indicator, logical order, dialog containment/restore,
      stable location through async update/removal, and a safe fallback opener.
- [ ] **Contrast:** measure agreed text, controls, status and focus targets in
      built-in/high-contrast themes and the Q8-approved custom-accent policy;
      information never depends on color alone.
- [ ] **Reduced motion:** test both OS and app settings; no required animation,
      unwanted autoplay or motion-dependent feedback; preserve media controls.
- [ ] **Zoom/reflow:** test Q1-approved text scaling and desktop zoom/reflow,
      long English/expanded strings and smallest supported desktop window;
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

**Options and consequences:** Adopt a documented WCAG 2.2 AA-oriented checklist with Windows NVDA and Linux Orca native checks, text scaling and desktop reflow; or specify an equivalent native-task checklist covering every roadmap property with explicit thresholds and AT coverage. The first provides familiar criteria; the second needs more owner review to establish equivalent coverage. Structural smoke alone is insufficient under either option.

**Recommendation (not approved):** Adopt the broader checklist, name supported OS/AT versions and assign human reviewers before implementation. This is a proposed bar, not a claim of certification.

### Q2 — Navigation and badge placement

**Options and consequences:** Place Requests beside DMs, Moderation Center behind a permission-gated server entry and personal notices/appeals in a safety view; or use a new top-level navigation rail. The first changes familiar workflows less; the rail is more visible but has a larger navigation and reflow cost. Badge semantics (pending requests versus unread) also need an explicit choice.

**Recommendation (not approved):** Use the existing shell and a pending-request count; approve destinations, back behavior and badge meaning together before B9-4.

### Q3 — External-content consent scope and persistence

**Options and consequences:** Require per-item activation without persistence; remember consent for this server/account session; or persist provider/server permission across restarts. Per-item is clearest but repetitive, session memory reduces prompts, persistent grants need a discoverable revocation/reset model and stronger lifecycle evidence. All options keep zero fetch before the applicable acknowledgement; NSFW and request trust remain separate.

**Recommendation (not approved):** Start with explicit per-item activation and no durable grants; offer broader grants only after the owner chooses their exact scope. Playback remains a separate deliberate action.

### Q4 — Warning and timeout presentation

**Options and consequences:** Use a persistent dismiss-resistant notice with an explicit Acknowledge action; or a blocking modal before other navigation. The former preserves access to recovery and help; the latter is harder to miss but interrupts the whole app and has stronger focus/escape obligations.

**Recommendation (not approved):** Use a persistent notice with explicit acknowledgement; keep timeout state adjacent to disabled actions. The server acknowledgement requirement does not itself settle whether the UI blocks navigation.

### Q5 — Effective voice moderation affordance contract

**Options and consequences:** Provide a narrow server-computed capability projection for the caller in each channel; or expose sufficient authorized overrides for a complete client derivation. The first keeps policy canonical and payload small; the second duplicates more permission logic and data. Role-only controls with eventual server refusal do not close SEC-02's effective-permission UI requirement.

**Recommendation (not approved):** Approve a minimal server-derived projection as a separately planned prerequisite PR; settle its payload, refresh semantics and owner before B9-14. Do not silently widen B9-14 into a server authorization rewrite.

### Q6 — Restart-safe recipient sanctions and appeal eligibility

**Options and consequences:** Add a member-safe own-action/restriction read with ids, reasons, expiry and eligibility; or use only existing live frames and ready warnings. The read needs a narrowly scoped server contract PR; live-only UX cannot recover removal/timeout action ids and all eligible history after restart and leaves BPR-072/073 incomplete. Currently banned users remain out-of-band under the existing B5 policy in either case.

**Recommendation (not approved):** Approve a separate B5 contract-completion PR for own-action/restriction discovery, with a DTO excluding reporter/evidence/internal notes. B9-15/16 remain blocked for complete closure until its exact contract is accepted.

### Q7 — Translation boundary beyond renderer text

**Options and consequences:** Cover all app-authored desktop text, including native menus/notifications/errors, while treating OS/user/server data as classified inputs; or limit extraction to TypeScript. TypeScript-only is smaller but leaves desktop-owned text outside BPR-064; including the server admin panel would further expand this client phase.

**Recommendation (not approved):** Cover renderer and app-authored native desktop text, inventory visible server errors with a client mapping where appropriate, explicitly exclude OS/user data and the separately served admin panel. Confirm catalog ownership and those exclusions.

### Q8 — Theme and custom-accent accessibility policy

**Options and consequences:** Qualify every built-in theme and provide a contrast-safe fallback for arbitrary custom accents; or require/warn users to adjust custom themes themselves. Fallback preserves readable controls but can alter chosen colors; warnings preserve exact choices but cannot establish an all-settings contrast claim.

**Recommendation (not approved):** Qualify built-ins and high-contrast mode, retain identity, and approve a safe fallback for essential text/focus indicators. The owner must decide how custom accents are constrained or disclosed.

### Q9 — B9 start while upstream acceptance is open

**Options and consequences:** Keep all product implementation behind the roadmap entry gates; or approve a written amendment allowing specific non-boundary work before B7/B5 closure. Strict ordering waits for evidence; a narrow exception could allow CSS/text work but must list residual risks and cannot authorize moderation evidence before its contract is accepted.

**Recommendation (not approved):** Keep current gate order. This planning PR and non-mutating evidence preparation are allowed now; do not infer a waiver from B7's HP-6 exception.

### Q10 — Timeout duration control

**Options and consequences:** Use a validated duration input within the existing one-minute to 28-day bounds; or add owner-chosen presets plus custom input. The former avoids inventing moderation policy; presets are faster but imply preferred sanction lengths.

**Recommendation (not approved):** Use a validated duration input initially; add presets only if the owner chooses their labels and values.

### Q11 — BPR-051 comprehension-read method at HP-9

**Options and consequences:** Have one or more non-developer desktop users explain the operator trust, text/file access, deletion/backup and local-export disclosures after following the journey; or rely only on technical review. The first satisfies the stated comprehension purpose; technical review alone leaves that B10 item unproven.

**Recommendation (not approved):** Owner names the reader(s), questions and pass criterion at HP-9, records safe results against the RC and keeps this B10 obligation even if longer documentation moves later.

### Q12 — Confirm or revise the shortened B10 cut list

**Options and consequences:** Confirm the 2026-09-18 keep/reduce/move table; or revise named rows at HP-9. Confirmation moves thirty-run and fourteen-day-soak evidence and the listed documentation to a later beta-to-stable gate; revision changes release work and needs an updated dated roadmap decision. Neither choice waives RC checks, upgrade/rollback, advisory closure or HP-10.

**Recommendation (not approved):** Review the table row by row at HP-9 and record the owner's decision and later-gate ownership; do not pre-approve it in B9 planning.
