# Plan: B9-23 — Polish account, privacy, recovery and settings journeys

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-24 on branch
`fm/b9-23-impl` from `dev` `1a3a7b1d`, merging `dev` `9c5f5d67` (#1774, the
moderation queue); the outcome and evidence are in
[Implementation record](#implementation-record-2026-09-24).

> **Milestone:** B9-23 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-23-account-settings-polish`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8, 10. **Requirements:** BPR-090, BPR-091; BPR-052..055, BPR-035.
> **Dependencies:** B9-20. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Polish account, privacy, recovery and settings journeys. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Recover an account, read retention, inspect/revoke sessions, review export warning and cancel/complete a throwaway account deletion.

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

| #   | Verified current state                                                                     | Evidence at planning commit                                                                      |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | The account tab already includes recovery, sessions and retention sections.                | `Client/src/components/settings/AccountTab.ts:1389-1396`                                         |
| 2   | Deletion discloses immediate erasure, prior backups and other devices' image caches.       | `Client/src/components/settings/AccountTab.ts:1110-1114`                                         |
| 3   | Large Font and high-contrast/reduced-motion preferences already have defined side effects. | `Client/src/components/settings/AccessibilityTab.ts:10-64`; `Client/src/lib/appearance.ts:63-81` |

### Drift at the implementation base (2026-09-24)

Re-read at `1a3a7b1d` (`dev`, B9-20 #1772 merged). All three inventory rows still
hold; B9-20 moved the whole tab's copy onto the `accountText` catalog seam
(`Client/src/i18n/account.ts`), so the cited line numbers shifted but the
sections the rows name are unchanged. Facts the inventory did not name, found
while auditing the journey and fixed here:

- **Unqualified status colours.** Every inline error/warning in `AccountTab.ts`
  and `RecoverySections.ts` painted text with the **fill** tokens `var(--red)`
  (3.35:1 on `--bg-primary`, 3.66:1 on `--bg-secondary`) and `var(--yellow)`
  (1.89:1 on white in light), below the Q1 4.5:1 bar. The TOTP/recovery status
  badges put white text on the `--green` fill (3.18:1). The B9-2 contract
  already names the qualified `--text-danger`/`--text-warning`/`--text-positive`
  replacements and the shared `.form-error`/`.form-status` classes.
- **No live roles on the form feedback.** Account/recovery errors were bare
  `<div>`s with no `role`, so a screen reader heard no error; only the connect
  banner had `role="alert"`, and its validation message was not tied to the
  field that caused it. The 2FA box's malformed-code feedback was a 500 ms
  `classList` toggle with no text and no announcement at all.
- **Placeholder-only labels.** The password-change, delete-confirm and
  recovery-kit password inputs had no `<label>`; the delete-confirm field's only
  accessible name was its placeholder.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

B4 erasure/retention/session authority and B7-15c desktop flows. Message retention is server-default only; attachments leave with messages; support bundle is user-initiated and local.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                  | Purpose                                            |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/settings/**; Client/src/components/SettingsOverlay.ts; affected connect forms` | Measured accessibility/state fixes only            |
| `Owned settings CSS from B9-1; account/settings catalogs`                                             | Scoped layout and approved copy                    |
| `Client/tests/e2e/b9-account-settings.spec.ts (new)`                                                  | Accessible privacy/recovery journey                |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                | Dated implementation status and exact-SHA evidence |

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

### Task 1: Audit the existing journey

Exercise registration modes, recovery, one-time codes, session review/revoke, deletion confirmation, retention and support export. Preserve B7 implementation and accepted disclosure text; do not rebuild these features.

### Task 2: Fix accessible feedback

Connect form errors to fields, announce async completion once, preserve focus across rebuilt account sections and keep one-time secrets out of live regions and diagnostic artifacts. Leave secret reveal/copy deliberate.

### Task 3: Apply scoped settings layout

Use owned settings styles for zoom, scroll, text expansion and consistent destructive controls. Preserve Large Font as a floor, OS/manual motion precedence, and each setting across restart.

### Task 4: Prove irreversible-action copy

Record successful and failed flows using throwaway accounts; no deletion result before server confirmation, no retention window presented as deletion delay, no support export represented as automatic upload.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/account-security.spec.ts; Client/tests/e2e/recovery-flow.spec.ts; Client/tests/e2e/sessions.spec.ts; Client/tests/unit/support-bundle.test.ts
- Proposed: b9-account-settings.spec.ts; expand settings-overlay.test.ts as needed

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

Polish must not rewrite privacy promises or expose secrets through screen recordings; use synthetic data and redact evidence.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q11 — BPR-051 comprehension-read method at HP-9

**Decided 2026-09-23 by the owner:** option (a). Readers: two desktop users who are not contributors to OwnCord, recruited by the owner (roles, not names, are recorded). Journey on the release candidate: install and sign up (retention summary at sign-up), open Settings > Account (retention and permanent-deletion text), Settings > Logs (local export note), and read the "short answer" section of `docs/trust-model.md`. Questions, answered unprompted in their own words: (1) Who can read your messages and files on this server? (2) What does the "End-to-end encrypted" badge on voice cover, and what does it not cover? (3) What happens to your messages when you delete your account, and can a backup bring them back? (4) What is in the support export and where does it go? Pass criterion: both readers answer all four correctly; one miss is a documentation defect to fix and re-read before HP-10. Results are recorded in the HP-9 scorecard against the RC SHA. This obligation stays in beta even though the longer documentation rows moved.

**Options and consequences:** Have one or more non-developer desktop users explain the operator trust, text/file access, deletion/backup and local-export disclosures after following the journey; or rely only on technical review. The first satisfies the stated comprehension purpose; technical review alone leaves that B10 item unproven.

**Drafting recommendation (historical):** Owner names the reader(s), questions and pass criterion at HP-9, records safe results against the RC and keeps this B10 obligation even if longer documentation moves later.

## Implementation record — 2026-09-24

Branch `fm/b9-23-impl`; base `dev` `1a3a7b1d`, `dev` `9c5f5d67` (#1774) merged in.
The owner's decisions applied are in
[b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md#q13--visual-direction)
(Q13: Refined Neon tokens; Aurora components adoptable per lane). No token file
was edited, and the shared PRD's status table was not touched — this record is
the lane's own.

### What changed

- **Feedback colour is the qualified status token, not the fill token
  (BPR-091, Q1 contrast).** `AccountTab.ts` and `RecoverySections.ts` painted
  error/warning/success text with `var(--red)`/`var(--yellow)`/`var(--green)`
  inline — measured at 3.35:1 / 1.89:1 / 3.18:1 on their surfaces, all below
  the Q1 4.5:1 bar. A small shared helper in `settings/helpers.ts`
  (`outcomeEl`/`showOutcome`) now builds every message from the B9-2 classes
  `.form-error`, `.form-status` and the new `.form-warning`, which resolve to
  `--text-danger`/`--text-positive`/`--text-warning`. The TOTP and recovery-kit status badges moved off white-on-
  `--green` onto `--text-positive`/`--text-muted` on `--bg-tertiary`; the badge's
  word carries the state, so colour is never the only signal.
- **Every form message is announced once.** Account/recovery errors and the
  recovery-kit status error gained `role="alert"`. `outcomeEl` fixes the live
  role at creation and `showOutcome` changes only the class and text, because
  swapping the role with the text rebuilds the region and drops the
  announcement; every account message is created as an error, so a later
  success or warning in the same element is also read as an alert. The
  one-time-secret reveal has a screen-reader-only `role="status"` region for
  copy success/failure, holding no secret.
- **A validation error is tied to its field.** `LoginForm`'s `validateForm`
  returns the offending field; the error is linked with `aria-invalid` +
  `aria-describedby` and focus moves to the control to fix. The banner is then
  not a live region, so the message is read once, as the field's description;
  it keeps `role="alert"` only when focus does not move — a server error that
  names no field, or Enter in a field that already has focus. The 2FA box's
  malformed code now shows real text (`connect.totp.invalidCode`) linked to its
  input the same way, instead of a 500 ms colour-only flash.
- **Real labels on the secret/password inputs.** The password-change fields, the
  delete-confirmation field and the recovery-overlay fields gained `<label>`s
  (and `aria-describedby` to their errors); the delete-confirm field's
  accessible name stays "Enter your password" so no e2e contract moved.
- **Focus survives a rebuilt section.** Rebuilding the TOTP section after an
  enroll/disable step, and hiding the password-confirm area after submit, now
  hand focus to the replacement control instead of dropping it to `<body>`.
  After "Sign out everywhere" the confirm button that was focused is hidden, so
  focus returns to the now-visible trigger; opening that confirm focuses
  Cancel. Chromium blurs a disabled focused button, so every async submit
  (profile, password, 2FA enrol/confirm/disable, sessions, deletion, recovery
  kit) returns focus to its control when the request fails. Each restore goes
  through `focusIsOurs` (`settings/helpers.ts`) and is skipped once the user
  has moved focus elsewhere.
- **Scoped reflow (BPR-091).** `.settings-content` gets `min-width: 0` (a flex
  child otherwise refuses to shrink below its min-content width, pushing the
  panel into horizontal overflow at the 940×500 minimum window with 20px text),
  and the user/server-provided row text (`.account-header-name`,
  `.account-field-value`, `.settings-sidebar-name`) wraps instead of clipping.

### Evidence

- **Unit:** the full client suite is green except one pre-existing,
  environment-only failure unrelated to this lane
  ( `tests/unit/livekit-e2ee-enable-ack.test.ts` — it needs the patched
  `livekit-client` that only `npm ci` applies locally; it fails identically at
  the base `1a3a7b1d` with this diff stashed). Two e2e cases also fail at the
  base and are not this lane's: the B9-20 "expanded voice controls" case in
  `b9-text-expansion.spec.ts` (the B9-21 sidebar's reflow overlays the voice row
  at 940×500 with expanded text, so Playwright's click is intercepted) and the
  pre-existing `livekit-client` patch gap. Both were re-run with the branch's
  diff stashed and fail the same way. The affected suites
  (`settings-overlay`, `account-tab-profile`, `account-tab-sessions`,
  `totp-settings`, `main-page`, `connect-page`, `login-form-recovery`,
  `recovery-secrets`, `ui-strings`, `i18n/settings`) pass (281 tests). Three
  tests that pinned the old inline `style.color` were updated to assert the
  B9-2 class and live role instead — the assertions were strengthened, not
  weakened. `tsc --noEmit`, `oxlint`, `eslint` and `lint:cycles` are clean.
- **E2E (mocked, Chromium, `--workers=1`):**
  `Client/tests/e2e/b9-account-settings.spec.ts` — 8 tests: the host and
  short-password errors mark and focus their field; Enter in an already-focused
  invalid field, or with a malformed 2FA code, announces the error once as an
  alert; a failed password change is
  announced on `.form-error` with its text measured ≥ 4.5:1; the deletion
  disclosure is verbatim, its password field is labelled and its error
  announced; the recovery overlay's error is tied to all three fields; and the
  account pane at 940×500 with 20px text keeps every control named, unclipped
  and on screen with a Q1 focus ring. The neighbour specs that touch these
  surfaces pass: `account-security` (its keyboard submits now also assert
  where focus lands), `sessions`, `recovery-flow`,
  `totp-flow`, `connect-page`, `register-flow`, `a11y-smoke` (56 tests).
- **Before/after screenshots** of the account pane, the password-change error
  and the deletion disclosure were captured on the same 1280×800 hardware at
  the base and the branch heads; attached to the PR.
- **Native AT (NVDA/Orca) recordings and OS-zoom checks are owner-run and remain
  pending**, consistent with the other B9 lanes.
- **Bundle budgets** (`npm run check:budgets` at the merged head): startup
  closure 94,405 B of the shared 95,500 B; MainPage 63,982 B of the unchanged
  64,000 B. This lane adds ~447 B of startup (the shared feedback helpers,
  catalog keys and the reflow CSS, which is not code-split) and ~5 B of
  MainPage; no budget was raised.

### Requirements and register

BPR-090 (coherent desktop navigation/state/feedback) and BPR-091 (keyboard,
focus, contrast, reflow, announcements/errors) get their automated evidence
here; the visual acceptance and native AT half remain owner-run.

### Drift from the plan

The plan's Task 1 asks to exercise registration modes, recovery, codes, session
review/revoke, deletion, retention and support export. Registration modes,
recovery, sessions and deletion are covered by the existing specs above plus the
new one; the support export was verified as already honest ("Nothing is
uploaded" in `settings.ts` and `supportBundle.ts`) and was **not** changed, so
it stays with its existing `tests/unit/support-bundle.test.ts` proof. No
behavioral gap was found in the accepted B7 disclosure text, so Task 4's
"prove irreversible-action copy" is satisfied by the existing
`account-security`/`b9-account-settings` assertions on the rendered copy rather
than new copy.
