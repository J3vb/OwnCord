# B9 — Unified feature experience, accessibility and polish

**Status:** DRAFT — 2026-09-23. Implementation is limited to the Q9 foundation lane (B9-0 → B9-3); B9-0 and B9-1 are done, and B9-2 and B9-3 are implemented.
**Entry gate: not fully met** (per-row status below). This document is not permission to bypass it.
**Owner decisions:** Q1–Q13 decided 2026-09-23 ([Open questions](#open-questions)); Q13 (visual direction) is a dated amendment. The Q9
amendment lets the serialized foundation lane B9-0 → B9-3 start now; B9-4 onward keeps the gate order.
**2026-09-23: Q9's upstream conditions for B9-4 onward are met** — HP-7 signed and the B5
moderation-evidence consent follow-up accepted by the owner, B7-10/B7-11 merged
([entry-gate status](#satisfied-preconditions-and-entry-gate-status)). B9-4 onward may now start in gate order.
**B9-0 complete 2026-09-23** at `dev` `f32149c47756b06f2400d484b3347fd782586ff3`:
[b9-entry-baseline-2026-09-23.md](b9-entry-baseline-2026-09-23.md) records the drift, verdicts and baselines.
**B9-1 complete — native AT recordings pending owner — 2026-09-23**:
[b9-css-split-evidence-2026-09-23.md](b9-css-split-evidence-2026-09-23.md) records the byte-identical emitted CSS (measured at `dev` `c80c8094`, re-run
unchanged at merge base `3c7dd486`) and before/after evidence.
**B9-2 implemented — native AT recordings and owner visual acceptance pending — 2026-09-23**:
[b9-shared-a11y-evidence-2026-09-23.md](b9-shared-a11y-evidence-2026-09-23.md) records the Q1/Q8 token matrix, the shared-controls
fixture and the keyboard, motion and reflow checks; [b9-ui-contract.md](../architecture/b9-ui-contract.md) is the usage contract.
**B9-3 implemented — native AT recordings and OS-zoom check pending owner — 2026-09-23**:
[b9-text-inventory-2026-09-23.md](b9-text-inventory-2026-09-23.md) records the text seam, the 1,428-literal inventory with owners, the
Q7 native/server boundary, the exclusions and the English and expansion checks; `Client/scripts/check-ui-strings.mjs` is the shrink-only gate.
**B9-4 implemented — native AT recordings pending owner — 2026-09-23**:
[the plan's implementation record](../../.claude/plans/b9-4-shared-navigation.plan.md#implementation-record-2026-09-23) records the Q2 destination map as
code (`Client/src/features/navigation/`), the plug-in and shared-file reservation rules, the inert-view transitions and the failing controls.
**B9-5 implemented — native AT recordings and OS-zoom check pending owner — 2026-09-23**:
[the plan's implementation record](../../.claude/plans/b9-5-message-requests-inbox.plan.md#implementation-record-2026-09-23) records the
Message Requests inbox (`Client/src/features/message-requests/`): snapshot/frame reconciliation, account scoping, the text-only
preview with zero automatic fetches, the Q2 count and the failing controls.
**B9-18 implemented — native AT recordings pending owner — 2026-09-23**:
[the plan's implementation record](../../.claude/plans/b9-18-english-shell-connect.plan.md#implementation-record-2026-09-23) records the
connect and shell catalogs, the 388-literal extraction, the sidebar-header reflow fix and the budget measurement.
English text is unchanged except the intended thousands grouping of numeric parameters of 1,000 or more ("1,234 online"), accepted by
the owner on 2026-09-23; the plan lists the affected keys.
Budget note (2026-09-23, firstmate decision 010): B9 feature lanes share one budget, startup 93,000 B (was 91,000 B) and MainPage
64,000 B (was 60,512 B), superseding the earlier MainPage 61,000 B decision; re-baseline at B9-26. B9-18's cost is catalog keys and
lookup calls from moving text behind the B9-3 seam, with no new copy; with dev ff349278 merged it measures startup 92,884 B and MainPage
62,443 B. With dev 9f9e2b8e (Refined Neon) merged the startup closure reached 93,384 B; moving copy that only lazy chunks show (recovery,
connection banner, identity-key prompt) out of the startup catalog brought it to 92,876 B, MainPage 63,026 B. With dev 20bcfdf8 merged the startup closure measures 93,923 B and MainPage 63,132 B; firstmate raised the shared startup budget to 94,000 B on 2026-09-23 (shared B9 lanes incl. Refined Neon and the B9-18 connect catalog; MainPage stays 64,000 B; re-baseline at B9-26). Firstmate raised it again to 95,000 B on 2026-09-23 for B9-7's consent admission point in `lib/api.ts` (94,362 B; the gate UI is lazy-loaded to hold MainPage at 63,343 B); `Client/bundle-budgets.json` owns the current figures.
**B9-7 implemented — native AT recordings pending owner — 2026-09-23**:
[the plan's implementation record](../../.claude/plans/b9-7-nsfw-consent-gate.plan.md#implementation-record-2026-09-23) records the server-backed
consent authority, the one pre-request admission point, the gate before composition, the alternate entry points and the zero pre-consent
traffic proof ([b9-nsfw-consent.spec.ts](../../Client/tests/e2e/b9-nsfw-consent.spec.ts)) at `bca39fe4822052cc73094df74b6ed81e75c04e5d` on base `166d71e4`.
**B9-10 implemented — native AT recordings pending owner — 2026-09-23**:
[the plan's implementation record](../../.claude/plans/b9-10-local-report-intake.plan.md#implementation-record-2026-09-23) records report
intake for messages, attachments and users, My reports in the Safety tab, the real-server role and refusal journey and the Q1 checks.
**B9-6 implemented — native AT recordings and OS-zoom check pending owner — 2026-09-23**:
[the plan's implementation record](../../.claude/plans/b9-6-message-request-decisions.plan.md#implementation-record-2026-09-23) records the
four decisions on the inbox, server-confirmed only, with 409/404 refetch, the accepted conversation opened only once the server opens it,
the real-server proof that Ignore and Delete stay silent to the sender, and the failing controls.

> **Drafted:** 2026-09-23. **Planning branch:** `docs/b9-unified-experience-plan`.
> **Exact base:** `0beee8e4c50ca18823750e381d3a1d6e327029b8`, checked-out `dev`.
> Source of phase scope: [roadmap B9](repo-health-roadmap-2026-08-23.md#b9--complete-unified-feature-ux-accessibility-and-polish).
> Product scope: [beta requirements](beta-product-requirements-2026-08-23.md).
> Evidence ownership: [traceability](beta-requirements-traceability-2026-08-23.md).
> [README.md](README.md) remains the plan-status authority. This follows the B7
> PRD plus per-PR milestone format; it does not supersede the roadmap or B5 decisions.

## Problem

B9 must turn the approved server contracts into complete desktop journeys,
with accessibility and privacy acceptance for each change. B5 already exposes
Message Requests, local reports and appeals (`Server/api/dm_request_handler.go:20-28`,
`Server/api/report_handler.go:54-59`, `Server/api/appeal_handler.go:69-89`).
The desktop broker also exists, with typed preview/image methods and refusal
results (`Client/src/platform/contracts/externalContent.ts:18-64`,
`Client/src/platform/desktop/externalContent.ts:55-67`). These are foundations
to consume and preserve, not new features to rebuild in B9.

At planning, the client NSFW helper (`Client/src/lib/nsfw-gate.ts`, since
removed by B9-7) recorded acknowledgement in sessionStorage and described the
server as label-only, while B5 has authenticated acknowledgement routes and a
caller-specific ready field (`Server/api/nsfw_handler.go:20-25`,
`Server/ws/serve_ready.go:228-237`). That code/document drift was B9-7's
contract integration. Likewise, literal English remains in settings and
dynamic sidebar labels (`Client/src/components/settings/AccessibilityTab.ts:10-64`,
`Client/src/pages/main-page/SidebarDmSection.ts:130-133`), and the sidebar
documents its O(n) rebuild (`Client/src/pages/main-page/SidebarArea.ts:660-673`).
Completeness cannot be inferred from an endpoint, a hidden overlay, a translated
label or a screenshot alone.

## Evidence and verification boundary

All current-state references in this PRD and its milestones were inspected at
the full base SHA above. They establish source behavior, not passing tests or
release acceptance. Implementation must re-read them at its own `dev` base,
record drift, and retain exact-integration-SHA evidence. Proposed files and tests
are labelled as proposed; no product tests were added or run for this planning PR.

| Area                        | Verified evidence                                                                                                                                                                                                                                                                                                                                                                                                             | Planning consequence                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop qualification       | B7-17 ([#1737](https://github.com/J3vb/OwnCord/pull/1737)) added the Windows ARM64 client and its `windows-aarch64-nsis` updater target (`Server/updater/assets.go`), and smoke-tests all four desktop artifacts before publish. HP-7 was signed by the owner 2026-09-23 ([B7 PRD](b7-shared-client-platform-desktop-parity.prd.md#hp-7-sign-off-2026-09-23)).                                                                | Four-target desktop acceptance met 2026-09-23, with B7-17's stated limits carried in the B7 PRD.                                                                                                                                                                              |
| B5 consent acceptance       | The public follow-up requires moderation-evidence consent verification before B9 interfaces ([B5 exit gate](b5-community-content-moderation-2026-09-04.md#exit-gate), "Conditions 3 and 4"). HP-5 accepted a design and narrowed server exits (`docs/plans/hp-5-scorecard-2026-09-05.md:18-28`, `:279-291`). The follow-up merged as [#1735](https://github.com/J3vb/OwnCord/pull/1735) and the owner accepted it 2026-09-23. | The consent prerequisite for B9 interfaces is accepted. The rest of the B5 exit is not accepted; the [2026-09-23 reconciliation](b5-community-content-moderation-2026-09-04.md#exit-gate-reconciliation-2026-09-23) names what remains. Security-review details stay private. |
| Broker ownership            | Typed metadata/image results and six refusal kinds exist; no AbortSignal is in the interface (`Client/src/platform/contracts/externalContent.ts:18-64`).                                                                                                                                                                                                                                                                      | Consent checks must precede admission. Discarding a late result is not cancelling its network request.                                                                                                                                                                        |
| Media path                  | YouTube metadata/thumbnail use the broker; click playback constructs a fixed-host sandboxed iframe (`Client/src/components/message-list/media.ts:178-239`).                                                                                                                                                                                                                                                                   | Playback remains a distinct explicit activation and privacy boundary. Do not claim broker limits apply to iframe traffic.                                                                                                                                                     |
| Shared state                | Dispatcher owns event subscriptions into stores (`Client/src/lib/dispatcher.ts:1-75`, `:98-107`; `Client/CLAUDE.md:46-56`).                                                                                                                                                                                                                                                                                                   | Add feature handlers through the dispatcher; serialize global-state integration.                                                                                                                                                                                              |
| Accessibility               | Modal helpers, focus styling and roving navigation exist (`Client/src/lib/modalFactory.ts:71-99`, `Client/src/styles/base.css:34-50`, `Client/src/lib/a11y.ts:95-160`). Existing smoke uses mocked Tauri (`Client/tests/e2e/a11y-smoke.spec.ts:1-24`).                                                                                                                                                                        | Reuse primitives; add measured and manual native acceptance. Existing smoke is not an OS screen-reader qualification.                                                                                                                                                         |
| Recipient actions           | Ready carries warnings; live moderation frames carry targeted action data (`Server/ws/serve_ready.go:416-465`, `Server/ws/moderation_actions.go:9-36`). The action-list service requires moderator authority (`Server/service/moderation.go:880-890`).                                                                                                                                                                        | Q6 must settle restart-safe recipient discovery before complete notices/appeals can close. Never use a moderator read as the member fallback.                                                                                                                                 |
| Effective voice authority   | Sidebar affordances use role-level permission (`Client/src/components/ChannelSidebar.ts:178-185`, `Client/src/lib/permissions.ts:49-52`); ready exposes `can_send` rather than a complete moderation capability projection (`Server/ws/serve_ready.go:210-242`).                                                                                                                                                              | Q5 is a contract prerequisite for the remaining SEC-02 UI work.                                                                                                                                                                                                               |
| Existing account experience | Recovery, sessions and retention already compose AccountTab (`Client/src/components/settings/AccountTab.ts:1389-1396`); deletion and local-log export already have disclosures (`:1110-1114`, `Client/src/components/settings/LogsTab.ts:348-376`).                                                                                                                                                                           | Polish and qualify those flows; do not re-plan them as absent or promise export redaction.                                                                                                                                                                                    |
| CSS ownership               | Main imports tokens/base/login/app/theme in order (`Client/src/main.ts:3-7`); shell, quick switch and NSFW rules still share app.css (`Client/src/styles/app.css:1-82`, `:4875-4905`, `:5073-5121`).                                                                                                                                                                                                                          | Mechanical source split first, with output equivalence; visual changes follow in separate PRs.                                                                                                                                                                                |

### Source-to-document drift

- B7's historical inventory and pending B7-16 row are not current code status
  (`docs/plans/b7-shared-client-platform-desktop-parity.prd.md:328`). The broker
  code cited above exists. Reuse it and verify acceptance separately.
- Client NSFW comments and local state do not describe the B5 server contract;
  B9-7 replaces that client integration, without weakening the server policy.
- Register entries for Large Font and quick-switch height should not be planned
  as unfixed (`docs/plans/repo-health-issue-register-2026-08-23.md:123`, `:176`).
  Current code has the font floor and bounded overlay
  (`Client/src/lib/appearance.ts:14-56`, `Client/src/styles/app.css:4875-4905`).
  B9 supplies regression acceptance and later reconciles the register.
  _Drift at `f32149c4` (B9-0):_ register rows cited in this PRD sit five
  lines lower (`:128`, `:181`, `:198`, `:215-221`, `:307-318`), and the
  `Client/CLAUDE.md:125` packaging rule is now `:136`. B9-0 reconciled the
  eight B9-tagged register rows that lacked their ledger fix.
- Original multi-surface requirement wording is narrowed by the dated B8
  amendments, not by an implicit B9 deferral. Browser/mobile rows stay visible
  as post-beta scope, never desktop-qualified by substitution.

## Users

Desktop members reading and sending messages; first-contact recipients;
reporters and moderated members; narrowly authorized local moderators; and
operators reviewing capability/disclosure accuracy. Keyboard, screen-reader,
large-text, high-contrast and reduced-motion users are part of every journey.
No new persona, centralized moderation role or provider is introduced.

## Hypothesis

Small feature PRs built on accepted B5/B7 contracts, a shared interaction/text
boundary and continuous accessibility review can close the approved desktop
experience while moving OwnCord's visual identity to the owner-approved direction (Q13) and without expanding the beta. This is
a delivery hypothesis to test with the evidence below, not an acceptance claim.

## Success metrics

| Outcome                  | Gate                                                                                                                                                                                                                                                                                                        | Evidence owner/milestone                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Requirement completeness | Every row below has an automated journey and applicable native/manual proof on the candidate; no unexplained missing state.                                                                                                                                                                                 | Feature author; B9-26 consolidation          |
| Consent                  | Zero NSFW content or consent-gated external fetch before the applicable acknowledgement, including native admission, alternate entry points and warm-cache cases. Message Requests use only their authorized text-preview DTO before acceptance. Revoke/teardown prevent new admission and stale rendering. | B9-5/7/8/11 and B9-26                        |
| Authorization            | Member/reporter/subject/moderator/owner and permission-change cases expose only the authorized DTO fields; no private accessibility-tree residue.                                                                                                                                                           | B9-10..17                                    |
| Accessibility            | No release-blocking defect in the six per-milestone check groups plus pointer, announcements, errors and media controls. Q1 fixes the measurable acceptance contract before product work.                                                                                                                   | Each author and named accessibility reviewer |
| English readiness        | Every app-authored text sink inventoried; no unexplained hard-coded UI strings; typed parameters/plurals/date/number formatting and expanded-text checks pass. English remains the only shipped language.                                                                                                   | B9-3/18/19/20                                |
| Identity and performance | Desktop visual review passes; existing B7 budgets are not weakened; before/after interaction and memory evidence uses the same fixture/hardware. Missing runtime baselines are measured in B9-0.                                                                                                            | B9-1/2/21..26                                |
| Phase closure            | Owner accepts HP-9 and exact-SHA evidence; every exit row below passes.                                                                                                                                                                                                                                     | B9-27; repository owner                      |

## Scope and dated amendments

Scope is the eleven B9 workstreams in
`docs/plans/repo-health-roadmap-2026-08-23.md:1183-1215`, read with all dated
owner amendments. B9 owns BPR-064 and BPR-090..092 and completes the client
halves of BPR-060..063 and BPR-070..073. It does not reassign server ownership.

| Governing decision                                                                                                                                                                  | Effect on this plan                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-28 execution pattern; 2026-08-31 integration-evidence amendment (`docs/plans/repo-health-roadmap-2026-08-23.md:208-228`, `:374-382`)                                        | One coherent invariant per PR, updated dev base before merge, pre-squash evidence for structural work, ledger/traceability/scorecard agreement. Any identical-tree evidence follows the documented rule; no unproved SHA equivalence.                                                                       |
| 2026-08-29 layout supplement (`docs/plans/developer-experience-layout-refactor-2026-08-29.md:381-407`)                                                                              | B9-1 preserves CSS selectors, cascade and built output. Token/visual changes ship later.                                                                                                                                                                                                                    |
| 2026-08-31 slim protocol decision (`docs/plans/repo-health-roadmap-2026-08-23.md:971-979`)                                                                                          | Preserve the current protocol-window and incompatible-client behavior; B9 does not invent cross-epoch support.                                                                                                                                                                                              |
| 2026-09-02 support-export scope and B7 follow-through (`docs/plans/repo-health-roadmap-2026-08-23.md:650-658`; `Client/src/components/settings/LogsTab.ts:348-376`)                 | Keep explicit user-initiated local export and truthful verbatim-log disclosure. No telemetry/upload or redaction promise.                                                                                                                                                                                   |
| B5 owner decisions 2026-09-04/05 and HP-5 accepted 2026-09-06 (`docs/plans/b5-community-content-moderation-2026-09-04.md:255-412`; `docs/plans/hp-5-scorecard-2026-09-05.md:18-28`) | Keep client preview broker/server GIF split, silent request rejection, narrow moderation, server-backed NSFW consent, erasure/retention and appeal rules. Server-only acceptance did not complete the client journeys.                                                                                      |
| 2026-09-18 B8 deferral (`docs/plans/repo-health-roadmap-2026-08-23.md:1042-1055`, `:1175-1259`)                                                                                     | Beta is Windows x64/ARM64 and Linux x64/ARM64 desktop only. Browser/PWA/phone/tablet, touch-device, responsive-device and unsupported-browser-API evidence move with B8. Desktop keyboard, screen reader, focus, contrast, reduced motion, text scaling, zoom/reflow and visual regression remain blocking. |
| 2026-09-18 B10 direction (`docs/plans/repo-health-roadmap-2026-08-23.md:1263-1285`)                                                                                                 | HP-9 must confirm/revise the cut list. Do not make thirty-run/14-day-soak work a new B9 milestone, silently waive retained RC gates, or settle the comprehension-read method for the owner.                                                                                                                 |
| 2026-09-23 owner decisions Q1–Q12, including the Q9 amendment ([Open questions](#open-questions))                                                                                   | B9-0, B9-1, B9-2 and B9-3 may start now in that serialized order; B9-4 onward keeps the gate order below. Q5/Q6 name upstream contract PRs that are decided but not implemented. Q11/Q12 are recorded again at HP-9.                                                                                        |
| 2026-09-23 owner decision Q13, visual direction ([Open questions](#q13--visual-direction))                                                                                          | The "identity preserved" exit row now means direction A (Refined Neon) now, with Aurora (C) component treatments adoptable per lane in B9-21..24. Tokens are single-writer: one token PR (a B9-2 follow-up) precedes B9-21.                                                                                 |
| B7 decisions and 2026-09-20 HP-6 exception (`docs/plans/b7-shared-client-platform-desktop-parity.prd.md:12-24`, `:386-395`)                                                         | Preserve B7 desktop target/qualification decisions. HP-6's B7 exception is not a B9 waiver; the rehearsed tag/HP-6 still precedes beta.                                                                                                                                                                     |

### Explicitly out of scope

No product/test/CI implementation in this planning PR. Later B9 PRs do not add
browser adapters, PWA hosting/push, phone/tablet layouts, touch qualification,
new providers, another shipping language, central moderation, unrelated server
policy, a dependency major, a release pipeline redesign or a rebrand. No
operational TLS/backup/update powers are added to moderation roles. No private
advisory details, exploit reproductions or embargoed patches belong in these
public documents. Public identifiers and affected properties suffice.

Q5/Q6 require narrowly scoped upstream contract PRs. Their payloads were
decided by the owner on 2026-09-23 (see Q5 and Q6); neither is implemented. Before
either is implemented, the owner must assign it and approve its own small plan
with code inventory and contract tests;
then link its exact accepted result in B9-14 or B9-15/16. These are explicit
blocking handoffs, not omitted work or implied authorization to widen those PRs.

## Satisfied preconditions and entry-gate status

**B9 product implementation was blocked at the planning commit** (see the 2026-09-23 update below the table). Source availability and planning
preparation are satisfied; phase acceptance is not. The required gate is in
`docs/plans/repo-health-roadmap-2026-08-23.md:1175-1181`.

| Entry item                                                                      | Verdict at planning commit                    | Required next evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current dev inspected, requirement/decision inputs read, small-PR plans present | Met for planning only                         | Re-verify each milestone at its actual implementation base.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B7 broker/platform foundation                                                   | Code present; qualification not inferred      | Preserve broker tests and native privacy evidence; reconcile historical pending rows with accepted results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Desktop platform matrix green                                                   | **MET 2026-09-23**                            | B7-17 four-target install/boot/connect/update/rollback/media smoke ([#1737](https://github.com/J3vb/OwnCord/pull/1737)); HP-7 signed by the owner 2026-09-23 ([sign-off and stated limits](b7-shared-client-platform-desktop-parity.prd.md#hp-7-sign-off-2026-09-23)). The owner-run real-desktop Linux device check is still outstanding.                                                                                                                                                                                                                                                                                                                                                                     |
| B5 contracts stable and security-reviewed                                       | **Evidence-consent part ACCEPTED 2026-09-23** | Consent follow-up ([#1735](https://github.com/J3vb/OwnCord/pull/1735)) accepted by the owner 2026-09-23 ([evidence](b5-community-content-moderation-2026-09-04.md#exit-gate), "Conditions 3 and 4"). The rest of the B5 exit is not accepted ([reconciliation 2026-09-23](b5-community-content-moderation-2026-09-04.md#exit-gate-reconciliation-2026-09-23)): Condition 6's push follow-up is proven ([#1742](https://github.com/J3vb/OwnCord/pull/1742)) and Condition 5's upload follow-up evidenced ([#1565](https://github.com/J3vb/OwnCord/pull/1565)), both awaiting owner acceptance; advisory disposition, the exit-SHA measurement and B5-12's final pass remain. Security-review status is private. |
| Agreed tokens, interaction patterns and accessibility test rules                | **Decisions recorded; NOT MET**               | Q1/Q2/Q8 decided 2026-09-23; the named reviewer is the repository owner (Q1). B9-0 recorded the baseline and rule set; owner acceptance is still needed. Existing tokens and helpers do not constitute this agreement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Recipient discovery and effective voice UI contracts                            | **Decided; contracts not implemented**        | Q5 (`can_moderate_voice`) PR accepted before B9-14; Q6 (`GET /api/v1/users/me/moderation`) PR accepted before complete B9-15/16. Keep these separate from a false claim that all B5 APIs are absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Common per-item entry contract                                                  | Prepared, not accepted for execution          | Assigned implementer, real base, reviewed code proof/failing control, contract/migration/privacy/rollback notes and green dependencies for each PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

_Rechecked 2026-09-23 by B9-0 at `f32149c4`:_ every verdict above is unchanged
([entry-gate verdicts](b9-entry-baseline-2026-09-23.md#entry-gate-verdicts-at-this-head);
[execution contract](b9-entry-baseline-2026-09-23.md#execution-contract-for-b9-1b9-3)).

B9-0 may prepare evidence and obtain decisions now. Under the Q9 amendment
(2026-09-23), B9-1, B9-2 and B9-3 may also start now, after B9-0 and in that
serialized order; B9-4 onward waits for the phase gates.

_Updated 2026-09-23 after the owner's sign-offs:_ the two rows above that Q9
names — the desktop platform matrix (HP-7 signed) and the B5 evidence-consent
follow-up (accepted) — are met, and B7-10/B7-11 are merged, so **B9-4 onward
may now start in gate order** (the dependency order in the milestone table).
The other rows keep their verdicts and are met per item, as each row states.
HP-6/tag obligations remain upstream release work; this plan neither claims
they passed nor creates a waiver.

## Delivery milestones

Every linked plan is one intended reviewable PR with its own branch, source
inventory, tasks, file boundary, tests/evidence, risks and owner questions.
Numbering is a stable reference, not a demand that independent work wait for
every smaller number. All product rows additionally depend on the entry gate.

| Milestone                                                                | One-PR outcome                                                          | Direct dependencies                                                                                                              | Roadmap workstreams | Status                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [B9-0](../../.claude/plans/b9-0-entry-evidence-and-decisions.plan.md)    | Verify entry evidence and settle the execution contract                 | Entry evidence preparation only                                                                                                  | entry; 8, 10        | Done                                                                                                                                                                                               |
| [B9-1](../../.claude/plans/b9-1-css-source-split.plan.md)                | Split app.css without changing its output                               | B9-0                                                                                                                             | 11                  | Complete — native AT recordings pending owner                                                                                                                                                      |
| [B9-2](../../.claude/plans/b9-2-shared-accessibility-and-tokens.plan.md) | Apply the agreed shared accessibility and token rules                   | B9-1                                                                                                                             | 7, 8                | Implemented — native AT and visual acceptance pending owner                                                                                                                                        |
| [B9-3](../../.claude/plans/b9-3-english-text-boundary.plan.md)           | Introduce the English text and formatting boundary                      | B9-2                                                                                                                             | 6                   | Implemented — native AT and OS zoom pending owner                                                                                                                                                  |
| [B9-4](../../.claude/plans/b9-4-shared-navigation.plan.md)               | Add the agreed shared navigation integration points                     | B9-3                                                                                                                             | 7, 8                | Implemented — native AT pending owner                                                                                                                                                              |
| [B9-5](../../.claude/plans/b9-5-message-requests-inbox.plan.md)          | Show the Message Requests inbox and safe text preview                   | B9-4                                                                                                                             | 1, 8                | Implemented — native AT and OS zoom pending owner                                                                                                                                                  |
| [B9-6](../../.claude/plans/b9-6-message-request-decisions.plan.md)       | Accept, ignore, delete or block a Message Request                       | B9-5                                                                                                                             | 1, 8                | Implemented — native AT and OS zoom pending owner                                                                                                                                                  |
| [B9-7](../../.claude/plans/b9-7-nsfw-consent-gate.plan.md)               | Make NSFW consent an authoritative pre-load gate                        | B9-4                                                                                                                             | 3, 8                | Implemented at `bca39fe4` on `166d71e4` — native AT pending owner; [evidence](../../.claude/plans/b9-7-nsfw-consent-gate.plan.md#evidence), [spec](../../Client/tests/e2e/b9-nsfw-consent.spec.ts) |
| [B9-8](../../.claude/plans/b9-8-external-content-consent.plan.md)        | Apply external-content consent before broker or provider work           | B9-7, B9-3                                                                                                                       | 2, 8                | Pending                                                                                                                                                                                            |
| [B9-9](../../.claude/plans/b9-9-rich-content-states.plan.md)             | Polish approved rich-content loading, failure and media controls        | B9-8                                                                                                                             | 2, 8                | Pending                                                                                                                                                                                            |
| [B9-10](../../.claude/plans/b9-10-local-report-intake.plan.md)           | Report local messages, users and attachments and show own report status | B9-4, B9-3                                                                                                                       | 4, 8                | Implemented — native AT pending owner                                                                                                                                                              |
| [B9-11](../../.claude/plans/b9-11-moderation-queue-evidence.plan.md)     | Show the permission-gated moderation queue and authorized evidence      | B9-4, B9-7, B9-10                                                                                                                | 4, 8                | Pending                                                                                                                                                                                            |
| [B9-12](../../.claude/plans/b9-12-moderation-workflow.plan.md)           | Assign, annotate and close reports with immutable history               | B9-11                                                                                                                            | 4, 8                | Pending                                                                                                                                                                                            |
| [B9-13](../../.claude/plans/b9-13-warning-timeout-actions.plan.md)       | Issue warnings and timeouts with accurate outcomes                      | B9-12                                                                                                                            | 4, 5, 8             | Pending                                                                                                                                                                                            |
| [B9-14](../../.claude/plans/b9-14-removal-kick-ban-controls.plan.md)     | Finish narrow removal, kick, ban and effective voice controls           | B9-13                                                                                                                            | 4, 5, 8             | Pending                                                                                                                                                                                            |
| [B9-15](../../.claude/plans/b9-15-moderation-notices.plan.md)            | Show authorized warnings, restrictions and action status to recipients  | B9-4, B9-3                                                                                                                       | 5, 8                | Implemented — native AT pending owner                                                                                                                                                              |
| [B9-16](../../.claude/plans/b9-16-personal-appeals.plan.md)              | Submit and track a local appeal                                         | B9-15                                                                                                                            | 5, 8                | Implemented — native AT pending owner ([evidence](../../.claude/plans/b9-16-personal-appeals.plan.md#evidence))                                                                                    |
| [B9-17](../../.claude/plans/b9-17-moderation-appeal-review.plan.md)      | Review and decide appeals without overexposing information              | B9-12, B9-13, B9-16                                                                                                              | 4, 5, 8             | Pending                                                                                                                                                                                            |
| [B9-18](../../.claude/plans/b9-18-english-shell-connect.plan.md)         | Extract connect, shell and navigation text                              | B9-4                                                                                                                             | 6                   | Implemented — native AT pending owner                                                                                                                                                              |
| [B9-19](../../.claude/plans/b9-19-english-messaging-content.plan.md)     | Extract messaging, rich-content and media text                          | B9-9, B9-6, B9-18                                                                                                                | 6                   | Pending                                                                                                                                                                                            |
| [B9-20](../../.claude/plans/b9-20-english-settings-and-native.plan.md)   | Extract settings, account and desktop-owned text                        | B9-3, B9-18                                                                                                                      | 6                   | Pending                                                                                                                                                                                            |
| [B9-21](../../.claude/plans/b9-21-shell-polish-and-performance.plan.md)  | Polish desktop shell navigation without rebuilding it on every update   | B9-4, B9-18                                                                                                                      | 7, 8                | Pending                                                                                                                                                                                            |
| [B9-22](../../.claude/plans/b9-22-messaging-interaction-polish.plan.md)  | Polish desktop message reading, composing and related overlays          | B9-19, B9-7                                                                                                                      | 7, 8                | Pending                                                                                                                                                                                            |
| [B9-23](../../.claude/plans/b9-23-account-settings-polish.plan.md)       | Polish account, privacy, recovery and settings journeys                 | B9-20                                                                                                                            | 7, 8, 10            | Pending                                                                                                                                                                                            |
| [B9-24](../../.claude/plans/b9-24-voice-media-polish.plan.md)            | Polish voice and video controls and their accessibility                 | B9-20, B9-14                                                                                                                     | 7, 8                | Pending                                                                                                                                                                                            |
| [B9-25](../../.claude/plans/b9-25-honest-desktop-capabilities.plan.md)   | Make desktop network, notification and update limitations actionable    | B9-9, B9-15, B9-23, B9-24                                                                                                        | 9, 8                | Pending                                                                                                                                                                                            |
| [B9-26](../../.claude/plans/b9-26-cross-feature-journeys.plan.md)        | Qualify complete desktop privacy, moderation and lifecycle journeys     | B9-6, B9-7, B9-9, B9-10, B9-11, B9-12, B9-13, B9-14, B9-15, B9-16, B9-17, B9-18, B9-19, B9-20, B9-21, B9-22, B9-23, B9-24, B9-25 | 10, 8               | Pending                                                                                                                                                                                            |
| [B9-27](../../.claude/plans/b9-27-hp9-freeze-and-exit.plan.md)           | Record HP-9 feature freeze and the B9 exit decision                     | B9-26                                                                                                                            | HP-9; exit          | Pending                                                                                                                                                                                            |

## Ordering, parallel work and shared ownership

1. B9-0 settles entry evidence and pre-implementation decisions. B9-1 mechanically
   splits styles. B9-2 then changes shared primitives/tokens, B9-3 fixes the text
   boundary, and B9-4 establishes navigation integration. This foundation is
   serialized; feature visual changes never ride the CSS source-move PR.
2. After B9-4, requests (5 → 6), consent/content (7 → 8 → 9), report/center
   (10 → 11 → 12 → 13 → 14), notices/appeals (15 → 16), and shell text (18)
   can prepare independently. B9-11 also waits for B9-7 and B5 evidence consent;
   B9-17 waits for 12/13/16. Q5/Q6 remain hard contract handoffs.
3. Text extraction 19 follows 9/6/18; 20 follows 3/18. Shell polish 21 follows
   4/18; message polish 22 follows 19/7; settings polish 23 follows 20;
   voice polish 24 follows 20/14. Separate owned files can proceed in parallel.
   Capability honesty 25 joins 9/15/23/24.
4. B9-26 joins every feature/text/polish lane and qualifies whole journeys.
   B9-27 records HP-9 and the exit verdict; neither is a bucket for unplanned
   feature fixes. A discovered blocker gets its own narrowly scoped fix PR
   and fresh evidence before the join passes.

**Single-writer lane:** shared navigation/MainPage composition, design tokens,
global stores, `api.ts`, `types.ts`, dispatcher registration, catalog API and
CSS import order are serialized even when their feature work is independent.
Reserve a file in the milestone PR, merge one shared change, rebase the next
from current dev, and rerun its affected checks. Keep catalogs feature-owned
after B9-3. Accessibility review runs continuously in every lane. Do not merge
competing global-state implementations and call conflict resolution testing.

Follow the roadmap's common execution contract (`:92-148`, `:188-228`): one
invariant per PR; reviewed proof or failing control first; smallest surface;
complete affected component checks; no threshold weakening; tracker and
requirement updates with evidence. The implementer is assigned at entry;
the owner retains product decisions and hold-point signatures.

## Requirement and register map

The requirement wording is in `docs/plans/beta-product-requirements-2026-08-23.md:90-103`,
`:118-120`; the inherited map is in
`docs/plans/beta-requirements-traceability-2026-08-23.md:113-126`, `:141-143`.
The rows below are **planned proof**, not release-qualified claims.

| Requirement | B9 milestones          | Required observable closure                                                                                                                                                            |
| ----------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-060     | 5, 6, 26               | First-contact text-only preview; accept/ignore/delete/block; sender silence; reconnect/block/erasure; no automatic media/embed/avatar fetch before trust.                              |
| BPR-061     | 8, 9, 19, 26           | Existing link/GIF/YouTube/media set works with consent, accessible controls, loading/refusal/error and LAN/offline distinctions.                                                       |
| BPR-062     | 8, 9, 26               | Preserve B5/B7 bounded retrieval, cache partitions, credential isolation and native network evidence; no new raw-fetch bypass.                                                         |
| BPR-063     | 7, 11, 26              | Server-backed per-user/channel acknowledgement before all protected entry points; second-device inheritance, failure/revoke/relabel/teardown; moderator consent.                       |
| BPR-064     | 3, 18, 19, 20, 26      | English catalogs, safe parameters/plurals/date/number seam, complete sink inventory and explained exclusions; no promised second beta language.                                        |
| BPR-070     | 10, 26                 | Report local message/user/attachment; cancel/submit/refusal; own status only; no central service or evidence over-disclosure.                                                          |
| BPR-071     | 11, 12, 13, 14, 17, 26 | Permission-gated queue/context/evidence, assignment/status/notes/actions/history/appeals; role-loss cleanup and confidential DTOs.                                                     |
| BPR-072     | 13, 14, 15, 26         | Narrow warning/timeout/removal/kick/ban controls and recipient outcomes; server hierarchy/effective voice authority; owner operations remain separate.                                 |
| BPR-073     | 15, 16, 17, 26         | Real action ids, one appeal per action/rate limit, status and audited decision; permitted reversal semantics and settled banned-user policy.                                           |
| BPR-090     | 1, 2, 4, 21..26        | Recognizable, owner-approved identity (Q13), coherent desktop navigation/state/feedback, preserved performance and visual acceptance.                                                  |
| BPR-091     | Every milestone        | Keyboard, pointer, screen reader, focus, contrast, reduced motion, text scale/zoom/reflow, announcements/errors/media controls; no release blocker. B8 device clauses remain deferred. |
| BPR-092     | 9, 24, 25, 26          | Honest desktop network/offline, media, notification and update behavior; unsupported-browser-API half remains with B8.                                                                 |

Register follow-through (`docs/plans/repo-health-issue-register-2026-08-23.md:193`,
`:210-216`, `:302-313`): BG-13 → 5/6; BG-14 → 10..17; BG-16 → 3/18..20;
BG-18 → 7/11; BG-19 → 8/9; C-13 measured sidebar remainder → 21;
SEC-02 effective-permission UI → 14. Existing account/session/recovery/retention
and local export flows receive regression evidence in 23/26. Historical C-07,
C-08 and C-12 descriptions are not instructions to repeat B7 extractions or
remove its guards; inspect current code and preserve accepted B7 budgets.

### Findings ledger disposition

The canonical ledger is `.superpowers/findings-ledger.json`, not a new B9
defect list. Reconciliation against the B9-tagged OC rows of the register at
the planning SHA finds **24 fixed, zero open**: OC-0314, OC-0319, OC-0325,
OC-0326, OC-0330, OC-0331, OC-0333, OC-0334, OC-0342, OC-0343, OC-0347,
OC-0348, OC-0350, OC-0355, OC-0356, OC-0361, OC-0364, OC-0367, OC-0368,
OC-0370, OC-0371, OC-0372, OC-0373 and OC-0375. Their existing status is
preserved. B9 adds applicable regression evidence, not duplicate fixes.

| B9-tagged finding | Canonical status | Ledger evidence                               |
| ----------------- | ---------------- | --------------------------------------------- |
| OC-0314           | Fixed            | `.superpowers/findings-ledger.json:7399-7407` |
| OC-0319           | Fixed            | `.superpowers/findings-ledger.json:7514-7522` |
| OC-0325           | Fixed            | `.superpowers/findings-ledger.json:7651-7659` |
| OC-0326           | Fixed            | `.superpowers/findings-ledger.json:7674-7682` |
| OC-0330           | Fixed            | `.superpowers/findings-ledger.json:7766-7774` |
| OC-0331           | Fixed            | `.superpowers/findings-ledger.json:7789-7797` |
| OC-0333           | Fixed            | `.superpowers/findings-ledger.json:7835-7843` |
| OC-0334           | Fixed            | `.superpowers/findings-ledger.json:7858-7866` |
| OC-0342           | Fixed            | `.superpowers/findings-ledger.json:8042-8050` |
| OC-0343           | Fixed            | `.superpowers/findings-ledger.json:8065-8073` |
| OC-0347           | Fixed            | `.superpowers/findings-ledger.json:8157-8165` |
| OC-0348           | Fixed            | `.superpowers/findings-ledger.json:8180-8188` |
| OC-0350           | Fixed            | `.superpowers/findings-ledger.json:8226-8234` |
| OC-0355           | Fixed            | `.superpowers/findings-ledger.json:8341-8349` |
| OC-0356           | Fixed            | `.superpowers/findings-ledger.json:8364-8372` |
| OC-0361           | Fixed            | `.superpowers/findings-ledger.json:8477-8485` |
| OC-0364           | Fixed            | `.superpowers/findings-ledger.json:8547-8555` |
| OC-0367           | Fixed            | `.superpowers/findings-ledger.json:8616-8624` |
| OC-0368           | Fixed            | `.superpowers/findings-ledger.json:8639-8647` |
| OC-0370           | Fixed            | `.superpowers/findings-ledger.json:8685-8693` |
| OC-0371           | Fixed            | `.superpowers/findings-ledger.json:8708-8716` |
| OC-0372           | Fixed            | `.superpowers/findings-ledger.json:8731-8739` |
| OC-0373           | Fixed            | `.superpowers/findings-ledger.json:8754-8762` |
| OC-0375           | Fixed            | `.superpowers/findings-ledger.json:8799-8807` |

The ledger's four open entries are OC-0445 (operational delivery budgets),
OC-0446 (restart measurement), OC-0447 (capacity measurement) and OC-0448
(release artifact verification property), at
`.superpowers/findings-ledger.json:10331-10390`. **No B9 workstream closes one
of these open findings.** They remain with their existing owners and release
gates. Newly verified B9 defects must enter the canonical ledger or a private
advisory before remediation. Phase exit requires no open B9-tagged finding
unless the owner explicitly retags it with a written reason in the scorecard;
a known exploitable beta blocker is not accepted risk.

_Drift at `f32149c4` (B9-0):_ OC-0446, OC-0447 and OC-0448 have since been
fixed and OC-0449..OC-0451 recorded and fixed; OC-0445 is the ledger's only open
entry (`.superpowers/findings-ledger.json:10331`). None is a B9 finding.

## HP-9 — Feature freeze and accessibility acceptance

B9-27 prepares `docs/plans/hp-9-scorecard-<date>.md` with the exact candidate
commit, B9-26 evidence manifest, every requirement journey, accessibility
defect disposition and gate verdict. The owner reviews and signs; this plan
does not supply that signature. Freeze features, English strings, protocol,
migrations and user-visible behavior after acceptance. Blocker fixes require
focused PRs, explicit freeze-impact review and new candidate evidence.

At HP-9 the owner confirms or revises the 2026-09-18 B10 table (Q12), including
the destination/owner of moved thirty-run and fourteen-day-soak work and moved
documentation. Retain the RC matrix, alpha upgrade/rollback, protocol check,
desktop/server/Docker evidence, one capacity comparison, zero unresolved
advisory/open P0/P1, packaging/provenance/signing/update checks, safe release
notes and HP-10 go/no-go unless a new explicit owner amendment changes them.
Q11 settles the retained BPR-051 non-developer comprehension read. B9 closure
does not itself tag, publish, merge, or satisfy B10.

## Exit gate and required evidence

Every row needs a dated PASS on the applicable candidate. FAIL, NOT RUN and
missing owner decisions block closure; do not replace them with prose promises.

| Exit condition                                                                                            | Required artifact/test evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved desktop journeys complete                                                                        | Requirement → milestone → test/recording matrix, including pending/empty/error/refusal/reconnect and permission-change states; four-target desktop qualification inherited and refreshed for affected native changes.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Consent and authorized disclosure preserved                                                               | Native broker and network capture plus first-party request counters; no pre-acknowledgement request; warm-cache, revoke/relabel/deletion, late-result and account-switch checks. Moderation member/reporter/subject/moderator/owner role matrix and audit walkthrough.                                                                                                                                                                                                                                                                                                                                                                                |
| No accessibility release blocker                                                                          | Per-milestone keyboard/pointer scripts; native screen-reader recordings with OS/AT versions; focus order/restore proof; measured contrast; OS/app reduced motion; approved text scaling and desktop zoom/reflow; accessible names/errors/status/media controls. Automated reports supplement manual checks.                                                                                                                                                                                                                                                                                                                                           |
| OwnCord visual identity updated to the owner-approved direction (Q13) without regressing desktop behavior | One token PR by a single writer lands the approved palette, typography, spacing and radius tokens before B9-21; B9-21..24 apply them per screen and may adopt Aurora treatments one lane at a time. Before/after desktop screenshots across every built-in theme, High Contrast, key states and window sizes; the B9-2 token matrix re-run at the Q1 thresholds (text 4.5:1, focus/UI 3:1, including `--border-control`); owner visual acceptance per lane. B9-1 additionally provides emitted-CSS equality or explained non-semantic build differences plus ordered-rule equality and owner review. No phone/tablet requirement is substituted here. |
| Translation-ready English                                                                                 | Source-aware sink inventory/scan with zero unexplained literals, typed interpolation/plural/date/number tests, exact-English and expanded-text comparisons, approved native/external-data exclusions.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Honest capabilities                                                                                       | LAN-without-internet, disconnected/reconnect, denied/cancelled device capture, notification limitations, manual/automatic update and failure demonstrations. No false success or unsupported offline/push/media claim.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Performance and engineering gates preserved                                                               | Existing bundle budget report; same-fixture startup/interaction/memory comparisons; complete affected client/server/Rust/generated checks where applicable; no added warnings, cycles, lifecycle violations or weakened thresholds.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Lifecycle/compatibility complete                                                                          | Real-server privacy, report/action/appeal, deletion/retention, block, session displacement, recovery and incompatibility journeys; synthetic data only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Status and owner acceptance agree                                                                         | HP-9 signed; PRD/README/traceability/register/ledger consistent; exact integration CI and pre-squash structural proof retained; B8 deferrals explicit; B10 decisions recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Evidence records command, tool/OS/AT versions, fixture, expected/actual result,
commit, PR/CI link and artifact location. Mocked Playwright cannot qualify
native traffic, Windows/Linux media or OS assistive technology. Test names and
proposed evidence files are in each milestone. Use the repository's ci-check
skill at execution time; full affected-component checks remain required. No
local Tauri packaging build (`Client/CLAUDE.md:125`); use the authorized CI
artifact path. Evidence uses throwaway accounts and synthetic content; secrets,
private reports and verbatim user logs do not enter public artifacts.

## Risks and mitigations

| Risk                                                                       | Impact                                                                 | Mitigation                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| An implemented API is mistaken for accepted service/desktop readiness      | Client ships on an unqualified boundary                                | Keep separate source, test and owner-acceptance verdicts; block entry and named contract handoffs.                                  |
| Consent applied only to the visible overlay                                | Hidden content work violates the approved gate                         | Guard admission before render/fetch, test alternate paths and native traffic; retain server authority.                              |
| Broader moderator DTO reused for recipient UX                              | Unauthorized information appears in DOM, state or assistive technology | Separate DTOs/stores, server-scoped reads, role matrix and teardown checks; Q6 prerequisite.                                        |
| Shared files change concurrently                                           | Conflicting state/lifecycle and cascade behavior                       | Single-writer integration, rebase, focused gates; owned feature modules/catalogs.                                                   |
| CSS split and visual fixes mix                                             | A cascade regression cannot be attributed                              | B9-1 mechanical-only output comparison and pre-squash head; subsequent visual PRs.                                                  |
| Accessibility or extraction becomes late cleanup                           | New screens ship inaccessible or hard-coded                            | Blocking checks/catalog usage in every feature PR; B9-26 verifies already-complete lanes.                                           |
| Revocation is described as cancelling requests without a cancellation seam | Privacy evidence overstates behavior                                   | Separate no-new-admission, stale-result suppression and actual cancellation; plan any required broker extension before claiming it. |
| Shortened B10 is treated as automatic release permission                   | Required retained gates are skipped                                    | Q11/Q12 and explicit HP-9/HP-10 owner decisions; no release action in B9.                                                           |

## Open questions

The owner decided all twelve on 2026-09-23, adopting the recommended answers,
and added Q13 (visual direction) the same day as a dated amendment.
Each question keeps its options and drafting recommendation for history; the
dated decision is the operative text. "Option (a)" in a decision is the first
option listed. Q11/Q12 are recorded again at HP-9.

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

Refresh carrier: the existing targeted channel_create / RefreshAllChannelVisibility paths (no separate channel_update frame)

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

**Clarified 2026-09-23 by the owner (B9-2):** Q8 accent-as-text threshold aligned to Q1's 4.5:1; 3:1 applies to focus/non-text. A custom accent is used as text only at 4.5:1 or better and as the focus indicator only at 3:1 or better, measured against the minimum over `--bg-primary`, `--bg-secondary`, `--bg-tertiary` and `--bg-input`; below either threshold that use falls back to the theme's tested colour, and fills are unchanged. B9-2's measurement found six preset swatches between 3:1 and 4.5:1 as text, so the literal 3:1 rule and the preset qualification above could not both hold. The fallback is the theme's tested `--accent-text`/`--focus-ring` token, which equals the default accent only where the default accent passes.

**Options and consequences:** Qualify every built-in theme and provide a contrast-safe fallback for arbitrary custom accents; or require/warn users to adjust custom themes themselves. Fallback preserves readable controls but can alter chosen colors; warnings preserve exact choices but cannot establish an all-settings contrast claim.

**Drafting recommendation (historical):** Qualify built-ins and high-contrast mode, retain identity, and approve a safe fallback for essential text/focus indicators. The owner must decide how custom accents are constrained or disclosed.

### Q9 — B9 start while upstream acceptance is open

**Decided 2026-09-23 by the owner:** written amendment, narrow. B9-0 (evidence and decisions), B9-1 (mechanical CSS split), B9-2 (shared accessibility/tokens) and B9-3 (English text seam) may start now, in that serialized order, because none touches a B5 contract, native code or desktop-qualification evidence. B9-4 onward keeps the gate order: B7-17/HP-7 accepted, the B5 moderation-evidence consent follow-up accepted, and B7-10/B7-11 merged before any B9 change to MainPage, dispatcher, stores or `api.ts`. Residual risks accepted with this amendment: (1) rebase cost if B7-5/B7-9/B7-10 touch the same style or shell files; (2) B9-1's output-equality evidence must be re-run at the actual merge base; (3) nothing here authorizes moderation-evidence UI (B9-11) before its contract is accepted, and nothing waives HP-6/HP-7. This is not inferred from B7's HP-6 exception; it is its own dated decision. **Conditions met 2026-09-23:** HP-7 signed and the consent follow-up accepted by the owner, B7-10/B7-11 merged — B9-4 onward may start in gate order ([entry-gate status](#satisfied-preconditions-and-entry-gate-status)).

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

### Q13 — Visual direction

**Decided 2026-09-23 by the owner (dated amendment):** A · Refined Neon now; Aurora (C) component treatments adoptable per lane in B9-21..24. The owner's words: "well I would not really say the style needs to be kept, if it can be improved than Im open to suggestions", then, choosing among the three directions a design scout proposed: "A now, then C pieces per screen (recommended). Refined Neon tokens first; B9-21..24 may adopt Aurora treatments one lane at a time."

Tokens are single-writer: one token PR (a B9-2 follow-up) lands the Refined Neon palette for all four built-in themes, Inter Variable bundled as the Linux fallback font, the `--space-1..8` and 4 / 8 / 12 / pill radius scales, `--border-control` and the role-colour clamp before B9-21. B9-21..24 then apply them per screen and may each propose individual Aurora treatments (Space Grotesk display, pill buttons, violet mentions, glass overlays with a solid fallback, the brand stripe) for the owner to accept per lane. The Q1/Q8 thresholds and the accent-role split are unchanged; `--border-control` (3:1 against `--bg-primary` and `--bg-secondary`, WCAG 1.4.11) and a role-colour text clamp (4.5:1, else `--text-normal`) are added to the shared contract ([b9-ui-contract.md](../architecture/b9-ui-contract.md)). The "OwnCord identity and desktop visual behavior preserved" exit row is amended accordingly ([Exit gate](#exit-gate-and-required-evidence)).

**Options and consequences:** A · Refined Neon keeps today's neon-glow look, fixes the scout's findings F1–F8 (light-theme white text, two brand accents, inputs without a 3:1 edge, the composer's double focus ring, unguarded role colours, font sizes off the scale, no designed Linux font, the crowded sidebar header) and is one token PR. B · Slate is a calm, neutral work-tool restyle that also moves the member list, colliding with MainPage/B9-4. C · Aurora is a bold, brand-led restyle (ink palette, violet second accent, Space Grotesk, glass overlays) that enlarges every polish lane's evidence.

**Scout recommendation (historical):** A now, then C pieces per screen.
