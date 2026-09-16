# Plan: B6-15 — Privacy-claim reconciliation

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-15 — Privacy-claim reconciliation (roadmap workstream 18, the 2026-09-06 "B4-10" audit carryover)
**Satisfies**: the PRD row "BPR-053, requirement traceability and privacy acceptance evidence match the HP-4-approved retained audit-token design and `docs/trust-model.md`, with correlation and key-holder limits recorded consistently" (`prd.md:152`), and the carryover's rule that the agreed guarantee is not changed without an explicit owner decision (`repo-health-roadmap-2026-08-23.md:842-847`)
**Complexity**: Small (documentation and traceability; zero code unless the owner answers question 3 or 4 with "change the code")
**Drafted**: 2026-09-15 at `dev` `96258158`. Must land **after** B6-11 (`prd.md:271`: "B6-11 measures first; B6-15 aligns the wording to the measurement, never the reverse") and **before** HP-6 (`prd.md:158`). B6-10 and B6-11 are in flight. Files both this plan and B6-11 touch: `docs/trust-model.md` (B6-11 `:416-417` only if its drill 9 retains bytes; this plan `:429-434`), `docs/architecture/data-lifecycle.md` (B6-11: O4 A1 at `:238`, class 25 at `:418`, a new drills block; this plan: `:165`, `:414`, `:596-597`, the header), the PRD and `CHANGELOG.md`. Different lines in every case; this plan branches after B6-11 merges, so there is nothing to rebase (Task 0, Task 5's gotcha)

**Executor rule**: Where this plan proposes a default for an open question, apply
that default unless the owner has overridden it in this file. Where a step needs
hardware, a human, a network, or a merged PR that is not available to you, do not
guess and do not invent a value: mark the row `unverified`, state what was
missing in the PR description, and continue with the next step. Never leave a
`<placeholder>` in committed text.

## Summary

BPR-053 was written on 2026-08-23, before anything existed. B4-10 built the
retained audit-token design that HP-4 approved on 2026-09-03, and recorded a
**deviation** from the requirement's letter while doing it. The requirement,
its traceability row and the register were never rewritten to what was built.
The 2026-09-06 audit noticed and made it workstream 18.

Everything here is **wording moved to the measured truth**, in one direction:
the code and its tests say what the erasure leaves; `docs/trust-model.md`
already discloses it correctly; every other document is brought to that
disclosure. Nothing in this milestone redesigns the erasure (PRD out of scope,
`prd.md:118-120`). Where a document can only be made true by changing code,
the plan stops and asks (questions 3 and 4).

The sites where a privacy, erasure or audit-token claim is made, and the verdict
on each — the full matrix is in "Verify before you implement":

| #   | Claim site                                                                                | What it says today                                                                                        | Verdict                                                                      |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | BPR-053, `beta-product-requirements:82`                                                   | "unlinkable … after the subject mapping is cryptographically erased"                                      | **Disagrees** — no key is erased; rows about one subject share one token     |
| 2   | Traceability row, `beta-requirements-traceability:105`                                    | "mapping key is cryptographically erased; correlation attempts fail"; no acceptance evidence recorded     | **Disagrees**, and the evidence B4 said it recorded is absent                |
| 3   | Register BG-11, `repo-health-issue-register:305`                                          | "integrity logs are deidentified"                                                                         | **Disagrees in degree** — pseudonymised under a key the operator holds       |
| 4   | B4 plan bullet 1, `b4-…:1441-1448`                                                        | "per-subject key … erasure destroys the key … cannot be linked to each other"                             | Superseded by its own amendment (`:1462-1470`) and deviation (`:1632-1637`)  |
| 5   | HP-4 decision 4, `hp-4-scorecard:288-290`                                                 | "`subject_token` carries the marker"                                                                      | Agrees; predates `actor_token` (041), which the scorecard's PR table records |
| 6   | `docs/trust-model.md:410-437`                                                             | linkable to each other; to the identity only by whoever holds the key — the operator; two operator duties | **The reference wording.** Agrees with code                                  |
| 7   | `docs/security.md:247-255`                                                                | same as 6, one paragraph                                                                                  | Agrees; names `audit_log` only                                               |
| 8   | `docs/architecture/data-lifecycle.md:156-167,414`                                         | "the residue is the token, which names nobody without `erasure.key`"; class 21 names `subject_token` only | Agrees; class 21 omits `actor_token` that `:159-160` of the same file names  |
| 9   | `docs/schema.md:90,93-94,176-177`, `docs/api.md:3332-3336`                                | column-level description, "the file names nobody without the key"                                         | Agrees                                                                       |
| 10  | Code comments: `038:1-8`, `041:1-6`, `042:1-10`, `markers.go:17-24`, `erasure.go:356-363` | "'of whom' needs the erasure key"; "identifies nobody without the key"                                    | Agrees — this is what the docs are reconciled **to**                         |
| 11  | `trust-model.md:416-417`                                                                  | live file keeps no trace in freed pages or the WAL                                                        | B6-11's, not this plan's; read its result first (Task 0)                     |

**No claim is loosened to match a document.** Where two documents disagree,
the code and `trust-model.md` win; where the code is silent, the owner decides.

## Verify before you implement

Facts established from source at `96258158`. This is the claim matrix the PRD
row asks for. Rows marked **Refuted**, **Corrected** or **Unknown** contradict
the requirement's letter, an existing document, or each other, and every one
becomes a task.

| Claim                                                                       | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-053, verbatim                                                           | **Quoted**    | `beta-product-requirements-2026-08-23.md:82`: "Necessary integrity records retain no identifying or content data after deletion. Immutable moderation/audit history survives only as an unlinkable event category, time, action class, and integrity proof after the subject mapping is cryptographically erased. Durable deletion markers prevent a later backup restore from silently resurrecting erased data."                                                                                                                                                         |
| The subject mapping is cryptographically erased                             | **Refuted**   | Nothing is erased. The token is `HMAC-SHA256(erasure.key, user_id)` under **one server-wide key** that persists (`Server/db/markers.go:17-24`; `038_audit_unlinking.sql:3-5` "the erasure key kept beside totp.key"); the key is generated once and backed up as an operator duty (`docs/security.md:64-66`; `trust-model.md:434-437`). The B4 plan's design was a per-subject key destroyed at erasure (`b4-…:1443-1445`); HP-4 decision 3 replaced it with the one-key HMAC (`hp-4-scorecard:283-287`) and the plan's amendment says so (`b4-…:1462-1466`)               |
| Correlation attempts fail                                                   | **Refuted**   | `TestEraseAccount_UnlinksAuditHistory` (`Server/db/erasure_test.go:741,745,747`) asserts the **same** token on the subject's `user_login`, `user_ban` and `channel_create` rows — rows about one subject are linkable to each other by design; the plan records this as a deviation from its bullet 1 (`b4-…:1632-1637`: "keeps one token per subject on purpose — the token is what lets a restore recognise the subject"). The traceability row still says "correlation attempts fail" (`beta-requirements-traceability:105`)                                            |
| Who can correlate, and who can re-identify                                  | **Corrected** | Two different limits, today stated only in `trust-model.md:432-434`: (a) any holder of `VIEW_AUDIT_LOG` (`Server/admin/api.go:276-277`, `requirePerm(permissions.ViewAuditLog)`) can group an erased subject's rows by token **without the key** — the token is a stable pseudonym, not a secret; (b) whoever holds `erasure.key` can name the id by hashing candidates — the ids are small integers, and the server itself does exactly this to recover sequence floors (`docs/security.md:160-162`). BPR-053's "unlinkable" and BG-11's "deidentified" describe neither  |
| The token lives in more tables than `audit_log`                             | **Corrected** | `Server/db/erasure.go:340-354` unlinks `audit_log`, `reports`, `moderation_actions` and appeals in one group; `:431-435` `reports.subject_token`, `:451` `reports.reporter_token`, `:469` `report_events.actor_token`, `:491` `moderation_actions.actor_token`; `docs/schema.md:101,139,151,154`. One token per subject across every table and the marker file. BPR-053 says "moderation/audit history"; `trust-model.md:429-432` and `security.md:247-255` name `audit_log` only. `community-services.md:472` calls the outcome row "an unlinkable B4-10-style audit row" |
| A restored backup cannot resurrect erased data                              | **Confirmed** | `Server/db/markers.go:17-24`; `TestHP4_D2_RestoreResurrectsAndTheMarkersReapplyTheErasure`; `docs/trust-model.md:418-424`; `hp-4-scorecard:331` condition 4 "Met". Conditional on the operator keeping `erasure.key` and the marker file (`trust-model.md:434-436`; `deployment.md:526-528`). B6-11 drill 2 exercises the missing-file cases through the real endpoint; this plan cites, never re-proves                                                                                                                                                                   |
| The retained rows hold no content                                           | **Confirmed** | `erasure.go:371,375` `detail = ''`; `TestEraseAccount_UnlinksAuditHistory` asserts detail `""`; `audittest.AssertSafeDetails` forbids bodies in any audit detail (`trust-model.md:88-92`). `reports.detail` cleared on the reporter's erasure (`erasure.go:451`); evidence and notes deleted (`:420,428`)                                                                                                                                                                                                                                                                  |
| The retained rows hold no identifying data                                  | **Unknown**   | `erasure_jobs.user_id` is "a bare integer, not a foreign key … The row outlives the subject" (`037_erasure_jobs.sql:5-7`); no statement deletes or prunes `done` rows (`Server/db/queries/sqlite/erasure.sql:48` counts only `state <> 'done'`); disclosed in `data-lifecycle.md:165` ("the `erasure_jobs` row, which names the subject by id") but in no public-facing document. A raw id names nobody without a backup or the key — whether it satisfies BPR-053's "no identifying … data" is the owner's call (question 3)                                              |
| HP-4 approved the design that was built                                     | **Confirmed** | Decisions 3 and 4 (`hp-4-scorecard:283-290`), signed 2026-09-03 (`:17`); the `actor_token` column (041) and its backfill (042) arrived through the Codex reviews of #1520/#1522 (`041_audit_actor_token.sql:1-6`, `042_…:1-10`) and are recorded in the scorecard's PR table (`:56-57`). Decision 4's text names `subject_token` only. The approved design is decisions 3 + 4 **as amended by #1522/#1523**; the scorecard is signed and is not edited — the reconciled documents cite the chain                                                                           |
| B4 recorded BPR-053 as satisfied with acceptance evidence                   | **Refuted**   | `b4-…:1474` "`trust-model.md` backup caveat updated; BPR-053 row satisfied" and `:1476-1480` evidence block — but the traceability row (`beta-requirements-traceability:105`) carries **no** evidence, unlike BPR-055 one row down (`:107`, inline "_B4-8 (2026-09-02): …_"). The document's own rule: the primary phase "records the first acceptance evidence" (`:14-15`). That is the "privacy acceptance evidence" the PRD row names, and it does not exist                                                                                                            |
| `docs/trust-model.md` discloses the design correctly                        | **Confirmed** | `:410-437`: hard-deletes every attributable row; marker outside the restored file; token = HMAC under `erasure.key`; "the rows about one erased subject remain linkable to each other, and to the identity only by whoever holds the key — the operator" (`:432-434`); two duties (`:434-437`). This is the wording every other document is reconciled to. `security.md:247-255` matches it                                                                                                                                                                                |
| "Key holder" means one thing in the trust model                             | **Refuted**   | `trust-model.md:111,114,117,118` use **key holder** for the voice-E2EE room-key holder (lowest user id). The carryover's "key-holder limits" means the `erasure.key` holder. Reconciled wording must say "whoever holds `erasure.key`" / "the erasure-key holder", never bare "key holder", or the trust model contradicts itself in one term                                                                                                                                                                                                                              |
| `data-lifecycle.md` is internally consistent on the token columns           | **Corrected** | `:159-160` "in `subject_token` where the subject was the target, in `actor_token` where they acted" vs class 21 at `:414` "`subject_token` carries the marker's token" (no `actor_token`), and the appendix comment `:596-597` "the rows survive with subject_token = HMAC(erasure.key, :uid)". Both predate 041 and were never amended                                                                                                                                                                                                                                    |
| `api.md`'s audit-token paragraph is hand-written, not generated             | **Confirmed** | No `gendocs:` marker between `api.md:3000-3500`; `:3332-3336` is editable prose and already correct                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The B6-11 byte-level result may already have moved `trust-model.md:416-417` | **Unknown**   | B6-11 Task 5 (`b6-11-….plan.md:354-382`) corrects `:416-417` and `data-lifecycle.md` class 25 (`:418`) **only** if its drill 9 retains bytes, and says "B6-15 then reconciles BPR-053 and the register to the corrected wording". Task 0 reads what landed; this plan carries the sentence forward into the traceability evidence, never rewrites it                                                                                                                                                                                                                       |
| HP-4 decision 2 cites a trust-model heading that no longer exists           | **Confirmed** | `hp-4-scorecard:277` "(O1 A5, trust-model 'No secure deletion')" — no such heading remains (`grep` over `trust-model.md`, `data-lifecycle.md`, `security.md`: none); the paragraph was rewritten at B4-9 as decision 2 itself said (`:282`). Historical, signed, no edit                                                                                                                                                                                                                                                                                                   |
| The moderation-side "owed" note is stale                                    | **Confirmed** | `community-services.md:496` "Report-side **owed by B5-8**" — `erasure.go:431-451` does it. B5-12's final reconciliation owns that document (`b5-…:2802-2811`); noted here, not edited here                                                                                                                                                                                                                                                                                                                                                                                 |
| `.claude/plans/` is tracked and Prettier-gated                              | **Confirmed** | `.gitignore` whitelist; PRD decision 2026-09-08                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### What the corrections change

- **The requirement's letter is what moves, not the design.** BPR-053 says
  "cryptographically erased" and "unlinkable"; the built and approved design
  is a persistent server-wide key and one stable token per subject, linkable
  by anyone who can read the audit log and re-identifiable by whoever holds
  the key. The carryover forbids substituting a design silently — so the
  amendment to BPR-053 is dated, quotes the HP-4 decision it follows, and is
  presented to the owner as an explicit decision (question 1) before it is
  written, exactly as BPR-032 and BPR-045 were amended in place
  (`beta-product-requirements:58,72`).
- **Two limits, named separately everywhere.** "Correlation" (grouping rows
  by token, no key needed, `VIEW_AUDIT_LOG` suffices) and "re-identification"
  (naming the id, key needed, trivial for the key holder). Every document
  that touches the subject gets both, in those words, so the register, the
  traceability row and the trust model can be read side by side.
- **The acceptance evidence is written where the document says it lives.**
  The traceability row gains the inline evidence block B4 said it recorded
  and did not, naming the tests, the decision, the deviation, and B6-11's
  byte-level result as it landed.
- **`erasure_jobs.user_id` is surfaced, not hidden.** It is either an
  accepted, disclosed residue or a small code change; the owner picks
  (question 3). This plan does not decide it and does not bury it.

## Patterns to Mirror

| Category                             | Source                                                                   | Pattern                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Amending a requirement in place      | `docs/plans/beta-product-requirements-2026-08-23.md:72`                  | BPR-045: original text kept, then "_Amended 2026-09-02 (B4 owner decision 3): …_" in italics inside the same cell                         |
| Traceability evidence block          | `docs/plans/beta-requirements-traceability-2026-08-23.md:107`            | BPR-055: "_B4-8 (2026-09-02): `docs/architecture/diagnostics.md` — … `TestNoAutomaticTelemetry_Capture` …_" appended to the evidence cell |
| Recording a deviation, not hiding it | `docs/plans/b4-identity-recovery-data-lifecycle-2026-09-01.md:1632-1637` | "**Deviation recorded:** the plan's bullet 1 asked … HP-4 decision 4 … keeps one token per subject on purpose"                            |
| The reference disclosure             | `docs/trust-model.md:429-437`                                            | Mechanism, then the two limits, then the operator duties — one sentence each                                                              |
| Dated amendment in a doc header      | `docs/architecture/data-lifecycle.md:4-12`                               | "**Amended 2026-09-03 (B4-10):** …" — the header carries the date and the milestone, the body carries the change                          |
| Signed documents are not edited      | `docs/plans/hp-4-scorecard-2026-09-02.md:17`                             | "the owner merged this scorecard as #1515" — cite it, never rewrite it                                                                    |
| Register row amendment               | `docs/plans/repo-health-issue-register-2026-08-23.md:58`                 | status vocabulary (`confirmed` = observed at the audited head); B5-12 (#1546) amended rows in place with dated notes                      |
| Term hygiene                         | `docs/trust-model.md:111`                                                | "key holder" is already a defined term (E2EE); a second meaning gets a different name                                                     |

## Files to Change

| File                                                           | Action | Why                                                                                                                                            |
| -------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/beta-product-requirements-2026-08-23.md`           | UPDATE | `:82` BPR-053 — dated amendment inside the cell, after owner decision (question 1)                                                             |
| `docs/plans/beta-requirements-traceability-2026-08-23.md`      | UPDATE | `:105` — closure-evidence text corrected; the B4-10 / B6-11 acceptance evidence block appended                                                 |
| `docs/plans/repo-health-issue-register-2026-08-23.md`          | UPDATE | `:305` BG-11 — "deidentified" → "pseudonymised under `erasure.key`"; dated note                                                                |
| `docs/trust-model.md`                                          | UPDATE | `:429-432` one clause: the token also unlinks the moderation tables; "the erasure-key holder" wording; `:416-417` **untouched** (B6-11's)      |
| `docs/security.md`                                             | UPDATE | `:247-255` the same clause, so the two disclosures stay word-for-word aligned                                                                  |
| `docs/architecture/data-lifecycle.md`                          | UPDATE | `:414` class 21 gains `actor_token`; `:596-597` appendix comment likewise; header amendment line; `:165` `erasure_jobs` residue per question 3 |
| `docs/plans/repo-health-roadmap-2026-08-23.md`                 | —      | **Not edited here.** B6-16 owns every roadmap amendment; Task 3 hands it the workstream-18 sentence verbatim                                   |
| `docs/plans/b4-identity-recovery-data-lifecycle-2026-09-01.md` | UPDATE | `:1474` one dated note: the evidence B4 said it recorded is recorded by B6-15; nothing else in a completed plan moves                          |
| `docs/plans/b6-*.prd.md`, `CHANGELOG.md`                       | UPDATE | B6-15 row → `in-progress` now, `complete` + this link at the end; unreleased entry ("Docs" — not user-visible)                                 |
| `Server/db/erasure.go` or `Server/service/erasure.go`          | UPDATE | **Only if question 3 is answered "prune"** — and then via its own small PR with a test, not this one                                           |

No code, no migration, no new document. Seven existing documents say the same
thing in the same words when this lands; the eighth (the roadmap) says it once
B6-16 pastes the sentence.

## Tasks

### Task 0: Read what B6-11 left, and fence the branch

- **Action**: branch `feat/b6-15-privacy-claim-reconciliation` from `dev`
  **after** B6-11 merges. Read `docs/trust-model.md:410-437` and
  `docs/architecture/data-lifecycle.md` class 25 (`:418`) as they are on
  `dev` now: if B6-11's Task 5 third outcome happened, `:416-417` no longer
  says "keeps no trace" and class 25 carries a measured table — copy that
  sentence verbatim into Task 3's evidence block. If B6-11 changed nothing
  there, the evidence block cites its E1 test name and "measured, not
  assumed". Flip the PRD row to `in-progress` with this plan linked. Confirm
  with `git diff --stat dev...<b6-11 branch, found as follows>` that nothing else in "Files to
  Change" overlaps. Find B6-11's branch in the `plan:` cell of its PRD row
  (`docs/plans/b6-server-deployment-operations-capacity.prd.md`) or with
  `gh pr list --search 'B6-11' --json headRefName`. If none exists yet, skip
  this check and record "B6-11 not yet branched" in the PR description.
- **Why**: `prd.md:271` — wording follows measurement. Reconciling before the
  measurement lands would be the reverse.
- **Gotcha**: if B6-11 is still open at HP-6 planning time, this milestone
  is blocked, not started early; write `blocked on B6-11 (#<pr number, or
'not yet branched'>)` in the B6-15 row's Status cell rather than reconcile
  to a claim B6-11 may retract.
- **Validate**: `npm run format` clean; PRD row renders; `git log -1 -- docs/trust-model.md` is B6-11's commit or older.

### Task 1: Owner decision on BPR-053's letter, then the amendment

- **Action**: put question 1 to the owner with the two texts side by side.
  On "amend", append to the BPR-053 cell at
  `beta-product-requirements-2026-08-23.md:82`, in the BPR-045 shape (`:72`):

  > _Amended 2026-09-\_\_ (B6-15, after HP-4 decisions 3 and 4 and the B4-10
  > deviation recorded in the B4 plan): the subject mapping is not erased; it
  > is replaced by one stable token per subject, `HMAC-SHA256` of the user id
  > under the server-wide `data/erasure.key`. Retained audit and moderation
  > rows about one erased subject are therefore linkable to each other by
  > anyone who may read them, and to the identity only by whoever holds
  > `erasure.key` — the operator. "Unlinkable" in this requirement means
  > unlinkable to the identity without the key, not uncorrelatable._

  (Replace every `2026-09-__` with the merge date before committing; the grep
  gate in the Risks table catches leftovers.)

  Nothing before the italics changes: the original requirement stays
  readable as what was asked for on 2026-08-23.

- **Why**: the carryover, verbatim: "Do not silently substitute a different
  erasure design; changing the agreed guarantee requires an explicit owner
  decision" (`roadmap:845-847`). The guarantee was changed at HP-4 with the
  owner's signature; the requirement text was not. The amendment is the
  owner's signature reaching the requirement.
- **Gotcha**: do not soften the amendment to keep "unlinkable" unqualified.
  `TestEraseAccount_UnlinksAuditHistory:741-747` proves rows share a token;
  a requirement that says otherwise is a requirement the tests refute.
- **Mirror**: `beta-product-requirements:58,72`.
- **Validate**: the cell renders as one row; `npm run check:docs`.

### Task 2: The traceability row — closure wording and the missing evidence

- **Action**: `beta-requirements-traceability-2026-08-23.md:105`. Two edits
  in the last column:
  1. The closure text "subject/content mapping key is cryptographically
     erased; correlation attempts fail" becomes "the subject id is replaced
     by one `HMAC-SHA256` token under the server-wide `erasure.key` in every
     retained audit and moderation row and in the deletion marker; retained
     rows carry no content and no free-text detail; the id is recoverable
     only by whoever holds the key; restore of an older backup reapplies the
     durable deletion marker and cannot resurrect data". "Prerequisites"
     keeps "cryptographic mapping and backup design" — that is what was
     designed.
  2. Append the evidence block, in the BPR-055 shape (`:107`):

     > _B4-10 (2026-09-03, HP-4 decisions 3 and 4, #1520/#1522/#1523):
     > `docs/trust-model.md` "Erasure is not undone by a restore, but the
     > audit trail keeps a token"; migrations 038/041/042;
     > `TestEraseAccount_UnlinksAuditHistory`,
     > `TestEraseAccount_TwoErasedPrincipalsKeepBothTokens`,
     > `TestMarkerStore_TokenIsKeyedAndUnlinkable`,
     > `TestHP4_D2_RestoreResurrectsAndTheMarkersReapplyTheErasure`,
     > `TestErasureService_ReplayMarkersErasesAResurrectedAccount`. Deviation
     > from the B4 plan's per-subject-key design recorded in that plan
     > (§B4-10, "Deviation recorded"). Correlation limit: rows about one
     > subject share a token and are groupable by any `VIEW_AUDIT_LOG`
     > holder; re-identification limit: the id is recoverable by the
     > `erasure.key` holder by hashing candidates. Physical-erasure boundary:
     > <the sentence Task 0 copied from B6-11's result, with its test name>.
     > B7/B9 UI proof and B10 release evidence remain open._

- **Why**: `prd.md:152` "requirement traceability and privacy acceptance
  evidence match"; the document's own rule at `:14-15`; B4's unfulfilled
  "BPR-053 row satisfied" (`b4-…:1474`).
- **Gotcha**: the row stays **not release-qualified** (`:10` — none is). The
  evidence is B4's and B6-11's; B10 repeats it against the release candidate
  (`:18-19`). Do not tick anything the document does not have a tick for.
- **Mirror**: `:107`.
- **Validate**: `npm run format` leaves the table aligned; the row still
  parses as one row (Prettier will reflow the long cell — check the diff is
  one line).

### Task 3: The register, the roadmap, and the B4 plan's promise

- **Action**:
  - `repo-health-issue-register-2026-08-23.md:305` BG-11: "integrity logs
    are deidentified" → "integrity logs are pseudonymised under
    `erasure.key` (linkable per subject; re-identifiable by the key holder
    only)"; append "_(B6-15, 2026-09-\_\_: wording aligned to HP-4 decisions 3
    and 4; see BPR-053's amendment.)_". Status stays `confirmed` — it is the
    audit's observation at its head, not a workflow state (`:58`).
  - `repo-health-roadmap-2026-08-23.md:842-847` workstream 18 is **not
    edited here** — B6-16 owns the roadmap. This task writes the sentence
    B6-16 will paste, verbatim, into the PR description and the PRD row:
    "_(Reconciled 2026-09-\_\_ by B6-15 (#<pr>): BPR-053 amended,
    traceability evidence recorded, BG-11 reworded, the moderation tables
    named in the trust model; `erasure_jobs.user_id` decided as <question
    3's answer>.)_", the shape of `:406` and `:445`.
  - `b4-identity-recovery-data-lifecycle-2026-09-01.md:1474`: after "BPR-053
    row satisfied" add "_(the traceability evidence this line promised was
    recorded by B6-15, 2026-09-\_\_)_". Nothing else in a completed plan
    moves; `:1441-1448` stays as history because `:1632-1637` already
    disowns it.
- **Why**: three documents claim or imply BPR-053 is closed in a form it was
  not built in; the reader who checks one should find the same answer in
  the other two. The roadmap line is written by one plan (B6-16) so two
  branches never race on the same cell.
- **Gotcha**: the register says it is a planning view and the ledger is
  authoritative for `OC-*` (`:17-18`). BG-11 is not an `OC-*` row; no ledger
  entry is created for a wording change.
- **Validate**: `grep -n "deidentified" docs/plans/*.md` returns nothing;
  `npm run check:docs`.

### Task 4: The trust model and `security.md` — one clause, one term

- **Action**: `docs/trust-model.md:429-432`, inside the existing bullet,
  after "(`audit_log.subject_token` where they were the target,
  `actor_token` where they acted)": add "— and the same token in the
  report, report-event, moderation-action and appeal rows that name them
  (`Server/db/erasure.go`, `erasureUnlinkPrincipalRows`)". At `:433-434`
  "only by whoever holds the key — the operator" becomes "only by whoever
  holds `erasure.key` — the operator (the erasure-key holder, not the voice
  key holder of the E2EE section)". Then `docs/security.md:247-255` gets the
  identical clause and term, so the two paragraphs diff to nothing but their
  surrounding headings. `:416-417` is not touched by this task under any
  outcome.
- **Why**: BPR-053 says "moderation/audit history"; the code unlinks both
  (`erasure.go:340-354`); the disclosure names one. "Key holder" is a
  defined E2EE term five times in the same document (`:111-118`).
- **Gotcha**: the trust model's claims each trace to a test or line
  (`:545-547`). The new clause cites `erasureUnlinkPrincipalRows` and the
  tests already named in Task 2; it adds no claim the tests do not carry.
- **Mirror**: `trust-model.md:429-437`.
- **Validate**: `diff <(sed -n '247,255p' docs/security.md) <(sed -n '/Erasure is not undone/,/re-identifies an erased/p' docs/trust-model.md)` shows wording differences only in the lead-in; `npm run check:docs`.

### Task 5: `data-lifecycle.md` — class 21, the appendix, and the id residue

- **Action**:
  - `:414` class 21 "Today" cell: "`subject_token` carries the marker's
    token" → "`subject_token` (target) / `actor_token` (actor) carry the
    marker's token (migrations 038, 041, 042)"; the closing cell "the
    residue is the token, which names nobody without `erasure.key`" →
    "the residue is the token: rows about one subject are linkable to each
    other; the id is recoverable only by whoever holds `erasure.key`".
  - `:596-597` appendix comment: "the rows survive with subject_token =
    HMAC(erasure.key, :uid)" → "… with subject_token or actor_token =
    HMAC(erasure.key, :uid)".
  - `:165` "the `erasure_jobs` row, which names the subject by id": per
    question 3, either append "(a bare integer that outlives the subject,
    never pruned — accepted residue, owner decision B6-15/3)" or, if the
    owner chooses pruning, leave the line for the code PR to change.
  - Header `:4-12`: one more "**Amended 2026-09-\_\_ (B6-15):**" line naming
    the three edits.
- **Why**: the document's own rule (`:31-33`): "If a claim and the code
  disagree, the code is right and this document has a bug — file it like
  any other." Class 21 disagrees with `:159-160` of the same file.
- **Gotcha**: class 25 (`:418`) is B6-11's row; if Task 0 found it already
  rewritten, do not touch it; if not, do not touch it either.
- **Validate**: `npm run format && npm run check:docs`.

### Task 6: Close, hand off

- **Action**: PRD row → `complete` with this link, or `in-progress` naming
  the open owner question; `CHANGELOG.md` unreleased entry under a "Docs"
  line ("not user-visible: BPR-053 and the register now describe the
  retained audit-token design as built and approved at HP-4"); HP-6's row is
  told, in the PRD, that the privacy wording is reconciled and where the
  evidence block lives; B6-16 is handed Task 3's workstream-18 sentence. If
  question 3 or 4 produced a code decision, open the ledger row or the
  follow-up PR and name it in that sentence.
- **Validate**: `npm run format && npm run check:docs`;
  `node .superpowers/render-ledger.mjs --check` (unchanged ledger still
  validates); `ci-check` skill — docs-only, but the hygiene and Prettier
  gates are the ones that fail on tables.

## Validation

```bash
# every reconciled phrase is gone or present where it should be
grep -rn "cryptographically erased" docs/plans/beta-product-requirements-2026-08-23.md docs/plans/beta-requirements-traceability-2026-08-23.md   # only inside the original text, followed by the amendment
grep -rn "correlation attempts fail" docs/                                   # none outside the B4 plan's historical bullet
grep -rn "deidentified" docs/plans/                                          # none
grep -n "key holder" docs/trust-model.md                                     # E2EE section only; the erasure bullet says erasure-key holder
# the two disclosures agree
diff <(sed -n '247,255p' docs/security.md) <(sed -n '/Erasure is not undone/,/re-identifies an erased/p' docs/trust-model.md) || true
# B6-11's lines untouched by this branch
git diff dev -- docs/trust-model.md | grep -c "secure_delete\|WAL"          # 0
# docs gates
npm run format && npm run check:docs && node .superpowers/render-ledger.mjs --check
# → ci-check skill
```

## Risks

| Risk                                                                                                                          | Likelihood | Impact | Mitigation                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner reads the BPR-053 amendment as a weakening and wants the per-subject-key design instead                             | Low        | High   | Question 1 is asked before any edit; the answer "change the design" ends this milestone and opens a B7+ design item — the carryover's own rule                  |
| B6-11 has not merged when B6-15 is scheduled, and the physical-erasure sentence is reconciled to a claim B6-11 later retracts | Medium     | High   | Task 0 blocks on B6-11; the PRD row says "blocked on B6-11", never "in-progress" on a guess                                                                     |
| Prettier reflows the traceability table and the diff is unreadable                                                            | High       | Low    | One row edited per commit; the PR description quotes the cell before and after                                                                                  |
| "Key holder" is changed in the E2EE section by a global replace                                                               | Low        | Medium | Edits are line-addressed (`:429-434`); the validation grep asserts the E2EE uses survive                                                                        |
| The `erasure_jobs.user_id` question is read as a new finding and filed in the public ledger with detail                       | Medium     | Medium | It is an owner question here, not a finding; if the owner wants it tracked before deciding, it goes through `docs/security.md`'s advisory route, not the ledger |
| `security.md` and `trust-model.md` drift again after this lands                                                               | Medium     | Low    | Task 4's validation diff is written into the PR; HP-6's operator-doc review re-runs it                                                                          |
| The amendment date placeholders (`2026-09-__`) survive into the merge                                                         | Low        | Low    | Validation grep for `__` under `docs/` before the PR                                                                                                            |

## Out of scope

- **Redesigning the erasure model** — PRD `:118-120`. Per-subject keys,
  key destruction at erasure, token rotation, or removing the token from
  the audit rows are each a new guarantee and a new HP.
- **Re-proving anything.** Every test cited exists and is green on `dev`;
  the byte-level evidence is B6-11's; the missing-marker-file and
  missing-key restore cases are B6-11 drill 2.
- **`trust-model.md:416-417` and `data-lifecycle.md` class 25** — B6-11's,
  in either outcome.
- **`community-services.md:496`'s stale "owed by B5-8"** — B5-12's final
  reconciliation (`b5-…:2802-2811`); one line in this PR's description points
  B5-12 at it.
- **The HP-4 scorecard and the HP-5 scorecard** — signed; cited, not edited.
- **Client-side wording** (the deletion confirmation the B7/B9 UI shows) —
  the traceability row already defers it to B7/B9.
- **Pruning `erasure_jobs`** — a code change; its own PR if the owner asks
  (question 3).

## Open questions for the owner

1. **Amend BPR-053's text to the built design, or keep the text and record
   the design as a permanent deviation?** This plan proposes the amendment
   (Task 1), because a requirement whose tests refute its wording is not a
   requirement. Keeping the text means the traceability row must say
   "deviates from the requirement by HP-4 decision" in every later phase's
   evidence, B10 included.
2. **Is "linkable to each other by any `VIEW_AUDIT_LOG` holder" a limit to
   disclose in the trust model's bullet, or only in the traceability
   evidence?** The trust model already says "remain linkable to each other"
   (`:432-433`) without saying who can do the linking. This plan adds the
   permission name in the traceability evidence only (Task 2) and leaves the
   trust model's sentence as is — the owner may want it in both.
3. **`erasure_jobs.user_id` after `done`: accepted residue, or prune?** A
   bare integer that outlives the subject, never removed
   (`037_erasure_jobs.sql:5-7`; no delete statement). Disclosed in
   `data-lifecycle.md:165` only. Options: (a) accept and say so in the
   trust model's bullet beside "server logs (id only)"; (b) a small
   maintenance-tick prune of `done` rows older than N days, its own PR with
   a test. This plan writes (a)'s sentence and stops; (b) is a design change
   under the carryover's rule.
4. **Should the token be disclosed as brute-forceable by the key holder in
   public wording?** `security.md:160-162` already describes the server
   hashing candidate ids against tokens. The proposed wording says "the id
   is recoverable by the `erasure.key` holder by hashing candidates". The
   owner may prefer "re-identifiable by the key holder" without the how.
   Either is true; the plan uses the explicit form unless told otherwise.

## Acceptance

Ticked only where the edit landed and the validation greps pass; evidence is
the PR diff and the traceability row's evidence block.

- [ ] BPR-053 carries a dated amendment naming HP-4 decisions 3 and 4 and the
      B4-10 deviation, after an explicit owner decision recorded in the PR
      (question 1)
- [ ] The traceability row's closure text no longer says "cryptographically
      erased" or "correlation attempts fail" as achieved outcomes, and carries
      the B4-10 / B6-11 evidence block with every test name that exists on
      `dev`
- [ ] BG-11 no longer says "deidentified"; the B4 plan's `:1474` carries the
      dated reconciliation note; the workstream-18 sentence is handed to
      B6-16 verbatim (PR description and PRD row), not written here
- [ ] `trust-model.md` and `security.md` name the moderation tables and say
      "erasure-key holder"; their two paragraphs diff only in lead-in; the
      E2EE "key holder" uses are untouched; `:416-417` is untouched by this
      branch
- [ ] `data-lifecycle.md` class 21 and the appendix comment name both token
      columns; the header carries the amendment line; the `erasure_jobs`
      residue is worded per question 3
- [ ] The correlation limit and the re-identification limit appear as two
      separate statements in BPR-053's amendment, the traceability evidence,
      BG-11 and the trust model
- [ ] Physical-erasure wording in the evidence block is the sentence B6-11
      landed, copied, not paraphrased
- [ ] No code changed on this branch; any code decision from questions 3 or 4
      is its own PR and is referenced from the roadmap note
- [ ] PRD row, changelog, `check:docs`, `render-ledger --check` and `ci-check`
      green
