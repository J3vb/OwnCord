# B4 — Complete identity, recovery, privacy, and data lifecycle

**Drafted:** 2026-09-01  
**Base commit:** `39019e7f` (`dev`, the B3 exit commit; exit signed 2026-09-01
by the owner — the dated "B3 exit" section of
[hp-3-scorecard-2026-08-29.md](hp-3-scorecard-2026-08-29.md)) — claims below
verified at `39019e7f`  
**Status:** IN PROGRESS — plan merged 2026-09-01 (PR #1496 = `aabac60`);
**B4-0 merged 2026-09-02** (PR #1497 = `d8653ea`; entry-gate item 3's
public half is its document, the private half stays counted-not-described);
**B4-3 merged 2026-09-02** (PR #1499 = `9587c9e`; OC-0321 closed fail-closed,
S-13 persisted through the limiter's persister shape, emergency recovery codes
built — B4-3 ran ahead of the decision-blocked B4-1, whose "after B4-1"
ordering was hot-file avoidance);
**B4-12 batch (a) merged 2026-09-02** (PR #1502 = `12dbc88`; OC-0313 and
OC-0329 closed — the legacy per-user volume and DM-note keys are consumed
on migration, so a pre-scoping value reaches the first host only);
**B4-2 merged 2026-09-02** (PR #1498 = `920b034`; the BPR-042 route-posture
and dead-credential proofs and the BPR-043 absence proofs, all with negative
controls — test files only, no gap found);
**B4-12 batch (b), client half, merged 2026-09-02** (PR #1503 = `366f199`;
OC-0314 closed — the partial-success warning on password/2FA changes reaches
the user; OC-0354 waits on owner question 8);
**B4-7 (sign-out-everywhere half) merged 2026-09-02** (PR #1500 = `21080e2`;
`DELETE /api/v1/users/me/sessions` with its explicit response, the
`session_revoke_all` audit row and the two-account proof; the new-login
signal half waits on owner question 8);
**B4-4 merged 2026-09-02** (PR #1504 = `eecf99b`; one atomic admission budget
at every bcrypt site with race and bounded-work proofs; SEC-01's register row
records the control and closes on the owner's advisory ID);
**B4-12 batch (d) merged 2026-09-02** (PR #1501 = `9515174`; OC-0340 and
OC-0341 closed — a negative token lifetime is refused at the service seam both
callers share, and a numeric label can be revoked). **Owner decisions 1–5 and
8–10 recorded 2026-09-02** (amendments under the questions);
**B4-7 new-login half merged 2026-09-02** (PR #1507 = `dc69fbb`; the
REST-only `unseen` session flag, and OC-0354 closed with it — BG-08's server
half complete); **B4-1 merged 2026-09-02** (PR #1508 = `8bd4212`; the four
registration modes with the upgrade mapping, the audited transition and
the approval queue — BG-10's server half); **B4-8 merged 2026-09-02** (PR #1510 = `b5e9d4a`; the
diagnostics inventory, the egress-sites invariant, the no-telemetry
capture and the support-bundle contract — BPR-055's server half); **B4-12 batch (c) merged 2026-09-02** (PR #1509 = `fc4c562`; OC-0324
closed — the login lockout key folds like the account lookup); **B4-5 merged 2026-09-02** (PR #1512 = `52f3df7`; the argon2id-verified recovery kit, one-transaction redemption without the second factor, lockouts and the hygiene proof — BG-09's server half); **B4-6 merged 2026-09-02** (PR #1513 = `33f82a8`; owner-issued
15-minute single-use credentials with fixed-wording verification, redeemed
through the recovery route — BPR-045); **HP-4 scorecard opened 2026-09-02** (branch `docs/hp-4-scorecard`; the five baseline drills green on snapshot copies, the schema drafts with rollbacks, the failure-model map and six recorded decisions); **HP-4 accepted 2026-09-03** — the owner merged the scorecard as #1515 (`9598c51`) with all six decisions standing; **B4-9 merged 2026-09-03** (PR #1516 = `c9f06da`, branch `feat/b4-9-account-erasure` from `dev` `9598c51`; the Codex review fix — the replay-pipeline purge and the persisted-envelope predicate — merged separately as #1517; complete account erasure — every inventory class hard-deleted in one `secure_delete` transaction, the file half journaled and resumed, the reconciliation pass, the admin route; lineage checklist green on the alpha copy). **B4-10 merged 2026-09-03** (PR #1520 = `87ad997`, its Codex review fixes following as #1522; branch `feat/b4-10-deletion-markers`, stacked on #1517; deletion markers in `data/erasure/markers.sqlite` under `erasure.key`, replayed on every open before anything serves; audit rows unlinked to the marker token; the post-restore proof green on the alpha copy). **B4-11 opened 2026-09-03** (PR #1521, branch `feat/b4-11-retention`, stacked on #1520; indefinite by default, server and per-channel windows, pinned exempt, no DMs, no holds, a bounded restart-safe sweep with a file journal and a `messages` marker per channel replayed on open, the effect preview and the audited policy). B4 chain complete pending merges; next HP-5 / B4 exit. _Update this line — not only the step table — as steps
land; the [README.md](README.md) row is the status authority._

Primary inputs:

- [beta roadmap](repo-health-roadmap-2026-08-23.md), B4 section (15
  workstreams, three of them dated scope notes) and HP-4
- [beta product requirements](beta-product-requirements-2026-08-23.md):
  BPR-041 through BPR-046 and BPR-052 through BPR-055
- [traceability](beta-requirements-traceability-2026-08-23.md) rows for those
  ten requirements — each step's evidence list is drawn from its row
- [issue register](repo-health-issue-register-2026-08-23.md) — every row
  tagged `B4` first: OC-0313, OC-0314, OC-0321, OC-0324, OC-0329, OC-0340,
  OC-0341, OC-0354; SEC-01; S-13; the B4/B9 halves of BG-08, BG-09, BG-10,
  BG-11, BG-12 (S-10 and OC-0345 closed in B3; OC-0329 and OC-0313 carry
  `B4/B7`, OC-0314 and OC-0354 `B4/B9` or `B4/B7` — the B2-8 precedent is
  that the first tag's phase fixes a contained defect even client-side)
- [docs/trust-model.md](../trust-model.md) — the public disclosure the B4
  work must keep true (its "No secure deletion" limitation is what B4-9 and
  B4-10 remove)
- `Server/testdata/snapshots/README.md` — the B3-7 alpha dataset whose first
  named consumer is "B4 — HP-4 drills"
- [docs/security.md](../security.md) "What stays private" — the rule B4-0 and
  HP-4 follow for destructive-operation threat content

B4's primary product requirements are BPR-041–046 and BPR-052–055. The phase
makes local accounts and stored data recoverable, revocable, retained, and
erasable without central services or misleading privacy claims — on the
service/boundary structure B3 built and guarded.

## Steps at a glance

| Step      | What                                                                                                                                                        | Size     | Parallel with                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| **B4-0**  | Destructive-operation failure/threat models + data-class inventory — closes entry-gate item 3                                                               | 1–2 days | everything before HP-4 (docs + private advisories)     |
| **B4-1**  | Registration modes: `closed / invite-only (default) / approval / open`, audited transitions, upgrade mapping (BPR-041, BG-10)                               | 2–3 days | B4-0, B4-2, B4-7, B4-8, B4-12 client batches           |
| **B4-2**  | Authenticated-only and no-external-dependency absence proofs (BPR-042, BPR-043)                                                                             | 1 day    | B4-0, B4-1 (new test files only), B4-7, B4-8           |
| **B4-3**  | TOTP key-file fail-closed (**OC-0321, must-close**), durable second-factor state (S-13), emergency recovery codes (BPR-046)                                 | 2–3 days | B4-0, B4-7, B4-8, B4-12 client batches — not B4-1      |
| **B4-4**  | Atomic admission budgets for expensive authentication work (SEC-01)                                                                                         | 1–2 days | after B4-3 (shares `service/auth.go`)                  |
| **B4-5**  | Locally generated recovery kit with protected non-reversible verification material and one-time rotation (BPR-044)                                          | 2–3 days | after B4-4                                             |
| **B4-6**  | Short-lived administrator-assisted recovery after recorded local verification (BPR-045)                                                                     | 2 days   | after B4-5                                             |
| **B4-7**  | Session contracts: new-login signal + sign-out-everywhere; listing/individual revocation already exist (BG-08 server half)                                  | 1–2 days | B4-1..B4-6, B4-8                                       |
| **B4-8**  | Local diagnostics inventory, support-bundle data contract, no-automatic-telemetry proof (BPR-055 server half)                                               | 1–2 days | everything                                             |
| **HP-4**  | Irreversible-data review: models, data contracts, migration/rollback design, legal/operator wording, baseline drills on the alpha dataset — **owner signs** | —        | —                                                      |
| **B4-9**  | Complete account erasure: profile, credentials, sessions, messages, reactions, uploads (BPR-052, BG-11)                                                     | 3–4 days | after HP-4                                             |
| **B4-10** | Unlinkable integrity history and anti-resurrection deletion markers (BPR-053)                                                                               | 2–3 days | after B4-9                                             |
| **B4-11** | Retention: indefinite default, server/channel policies, attachment cleanup (BPR-054, BG-12 server half)                                                     | 2–3 days | after B4-10 (HP-4 may relax to parallel with B4-10)    |
| **B4-12** | The B4-tagged findings in batches: OC-0313+OC-0329, OC-0314+OC-0354, OC-0324, OC-0340+OC-0341 (OC-0321 rides B4-3)                                          | spread   | client batches: any; OC-0324 after B4-1; CLI pair: any |

Order: **B4-0 first** (it is entry-gate work and HP-4's input), with B4-1,
B4-2, B4-7, B4-8 and B4-12's client batches beside it. The identity chain
**B4-3 → B4-4 → B4-5 → B4-6 is serial** — all four touch `service/auth.go`
and `auth/`, and `dev` is `strict: true`, so one PR in flight per hot file —
and starts after B4-1 merges (B4-1 owns `api/auth_handler.go` and
`service/auth.go` while open). Then **HP-4**, then the irreversible-data
chain **B4-9 → B4-10 → B4-11**, serial because the three share schema, audit
and backup-interplay contracts; HP-4 may explicitly authorise B4-10 ∥ B4-11
once the contracts are fixed. The roadmap's parallelism rule is preserved:
registration/session work (B4-1, B4-7) and local diagnostics (B4-8) proceed
in parallel; recovery, deletion, and retention serialize until HP-4 fixes
their data contracts.

Every step: branch from `dev`, one PR per step (B4-12 per batch), squash
merge with a conventional subject, verify with the `ci-check` skill before
push, migrations only through the `db-change` skill, any WebSocket message
change only through the `protocol-change` skill, and append a dated evidence
block to this plan in the step's PR. Steps that HP-4 or the exit reviews
record pre-squash `refs/pull/<n>/head` SHAs at merge time.

## Entry gate

| Condition                                                            | State 2026-09-01                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B3 domain, database, audit, and lifecycle boundaries are established | **Met.** Evidence block below: the B3-0 inventory is live and green at `39019e7f` with zero `move` rows; lifecycle owns start/stop/drain in `Server/internal/app/`; the settings/audit, auth, session, token, upload, user and voice families sit behind `Server/service/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Backup/restore fixtures and representative alpha data are captured   | **Met.** Evidence block below: admin backup create/list/delete/restore handlers with a restore round-trip test; scheduled backup + retention pruning in the maintenance loop; the B3-7 anonymised snapshot `Server/testdata/snapshots/v1.2.0-alpha.4.sqlite` with its standing migration canary, whose README names "B4 — HP-4 drills" as its first consumer.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Destructive operations have private threat and failure models        | **Not evidenced.** Nothing in the repository is or points at such a model: HP-2's threat work covered protocol, trust, E2EE and predicates; `docs/trust-model.md` discloses operator powers and today's deletion limits but is a disclosure, not a failure model; B3 produced none. Whether private owner-side material exists cannot be verified from the repository — owner question 6. **B4-0 closes this item** (the B3-0 precedent: B3's entry-gate item 3 did not exist either and became the phase's first step). _2026-09-01: B4-0 opened — the public half is [docs/architecture/data-lifecycle.md](../architecture/data-lifecycle.md); the private half needed no new advisory (that document's last section); owner question 6 stays open for owner-side material._ |
| _(context)_ B3 exit signed; `dev` at or past `39019e7f`              | **Met.** `git merge-base --is-ancestor 39019e7f HEAD` exits 0 on `dev`; `39019e7` is "docs(b3): exit signed" (PR #1495).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Entry evidence, 2026-09-01, measured at `39019e7f`:**

- **Boundaries (item 1).** `cd Server && go run ./cmd/dbinventory` prints the
  full table and exits 0: `53 files import db outside db/ and service/ (. 1,
admin 11, api 9, auth 2, cmd/gendocs 1, cmd/seed 2, internal/app 6,
plugin 1, ws 20); 34 are type-only; 0 unlisted. Dispositions: adapter 35,
boundary 18. Move targets: .` — zero `move` rows, matching the B3 exit.
  The allowlist lives in `Server/invariants/db_import_boundary.go`
  (`DBImportAllow`) and only shrinks. Lifecycle: `Server/internal/app/`
  owns bootstrap, http, hub, persistence, maintenance, restart and the
  composite close (`lifecycle.go`, `lifecycle_failure_test.go`). Domain
  families: `Server/service/` carries `auth.go`, `session.go`, `settings.go`,
  `setup.go`, `token.go`, `upload.go`, `user.go`, `voice.go` beside the B2-era
  services; audit writes go through `db.WriteAudit` with the B2-6 coverage
  tests (`service/audit_coverage_test.go`).
- **Fixtures and alpha data (item 2).** Backup/restore:
  `Server/admin/handlers_backup.go` (create, list, delete, restore, with a
  detached safety backup before restore) and
  `Server/admin/backup_maintenance.go` (schedule + retention pruning, driven
  by the `backup_schedule` / `backup_retention` settings seeded in
  `migrations/001_initial_schema.sql:182-183`), tested by
  `Server/admin/handlers_backup_test.go` — `TestHandleRestoreBackup_Success`
  restores and re-opens the database — and
  `backup_maintenance_test.go`. The maintenance loop that runs them is
  `Server/internal/app/maintenance.go` (also home of the orphaned-attachment
  sweep — B4-11's natural seam). Alpha data:
  `Server/testdata/snapshots/v1.2.0-alpha.4.sqlite` + `scrub.sql` +
  `README.md` (shape: 100 users, 12 channels, 20,000 messages, 300
  attachment rows, 500 reactions, 30 invites); `Server/db/alpha_snapshot_test.go`
  is the standing canary (opens a copy, applies HEAD migrations, checks row
  counts) and `TestAlphaProfileByteIdentical` pins reproducibility.
- **Threat/failure models (item 3).** `grep -rni "threat" docs/ --include="*.md" -l`
  returns the plans that cite HP-2 and `docs/trust-model.md`; none models
  failure or abuse of account erasure, retention cleanup, backup restore, or
  recovery rotation. `docs/plans/hp-2-scorecard-2026-08-29.md` has no
  destructive-operation section (its seven questions are protocol/trust/E2EE/
  predicates/deferred-systems/strict). Not met; B4-0 is the closure.

## Verify before you implement

Every claim the roadmap's B4 section rests on, re-tested against `39019e7f`.
Verdicts a step depends on are repeated in that step's spec.

| Claim                                                                           | Verdict                     | What it means for the work                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session listing and individual revocation already exist (workstream 15)         | **Confirmed**               | `GET /api/v1/users/me/sessions` and `DELETE /api/v1/users/me/sessions/{id}` (`api/profile_handler.go:134-135`); `sessions` rows carry `device`, `ip_address`, `created_at`, `last_used` (`migrations/001:37-46`); `DeleteOtherSessions` backs the credential-change revocations. B4-7 adds only the new-login signal and sign-out-everywhere, exactly as the workstream says.                                                                                                               |
| A new-login event and sign-out-everywhere do not exist                          | **Confirmed**               | Zero hits for a new-login event, `logout_all`, or an all-sessions revoke route in `Server/` production code. B4-7 builds both.                                                                                                                                                                                                                                                                                                                                                              |
| Registration is invite-only by default (BPR-041 premise)                        | **Confirmed, by accident**  | Registration is a boolean: `registration_open` (default **true** — `service/auth.go:873`) gates `POST /auth/register` (403 when off, checked before the body is read), and the open path **always** consumes an invite (`Register` → `CreateUserWithInvite`, transactional per OC-0376). So the effective modes today are `closed` and `invite-only`; no open (invite-less) mode and no approval mode exist. B4-1 replaces the boolean with the four-mode enum and maps 1→invite, 0→closed. |
| Emergency recovery codes exist and must be preserved (workstream 6, BPR-046)    | **Refuted — stub only**     | `api/totp_handler.go:91` hard-codes `BackupCodes: []string{}`; no generation, storage, or verification path exists anywhere, and the client renders codes only when the array is non-empty (`AccountTab.ts:543`). Workstream 6 is **build**, not preserve: B4-3 creates the codes end to end.                                                                                                                                                                                               |
| OC-0321 is open at HEAD (workstream 14, must-close)                             | **Confirmed**               | `auth/totp_encrypt.go:45` — only `err == nil` is handled; every read error (EACCES, EIO, dangling symlink…) falls through to key generation and an `os.WriteFile` truncate, orphaning every stored TOTP secret. The corrupt-content branches already fail closed and are test-pinned; the read-error branch is the gap. Rides B4-3.                                                                                                                                                         |
| Durable TOTP used-code and partial-auth persistence is incomplete (S-13)        | **Confirmed**               | All three stores are in-memory: `auth.NewPartialAuthStore(10m)`, `NewPendingTOTPStore(10m)`, `NewUsedTOTPCodeStore()` with `usedTOTPCodeTTL = 90s` (`service/auth.go:260-262`, `auth/constants.go:27-29`). A restart forgets used codes (replay window) and drops in-flight 2FA challenges. B4-3 persists hash-only with expiry; sliding rate-limit windows stay in memory per S-13's closure line.                                                                                         |
| Password-confirmation admission is unbounded (workstream 8, SEC-01)             | **Confirmed**               | Password-confirm paths carry per-user lockouts (`pw_confirm_lock`, BUG-111) but no bounded concurrent admission — no semaphore/singleflight anywhere in `api/`, `service/`, `auth/`. SEC-01's public closure line stands: one server-owned admission decision, bounded concurrent attempts, race/load coverage. Detail stays in the private advisory.                                                                                                                                       |
| Account deletion exists but is not erasure (workstream 9, BPR-052 premise)      | **Confirmed**               | `db.DeleteAccount` (db/account.go) deletes sessions/reactions/read-states/DM rows, revokes API tokens, reverses mention counts, **soft-deletes** messages (`deleted=1, content=''`) and **anonymises** the user row. Left behind: upload files and attachment rows outside emptied DMs, invites/emoji authored (FK, no cascade), audit rows naming the subject (`account self-deleted from <ip>`), FTS/freed pages, and backups. `trust-model.md:345-348` discloses exactly this.           |
| Audit history is linkable after deletion (workstream 10, BPR-053 premise)       | **Confirmed**               | Audit rows keep `user_id` and free-text detail; no cryptographic subject-mapping erasure, no durable deletion markers, and a backup restore resurrects the account wholesale. B4-10 is greenfield on the B2-6 audit foundation (detail denylist, id-not-name rows).                                                                                                                                                                                                                         |
| Message/attachment retention does not exist (workstream 11)                     | **Confirmed**               | The only retention today is `backup_retention` (pruning backup files). No message/channel retention policy, no retention clock, no policy-driven attachment cleanup. The maintenance loop (`internal/app/maintenance.go`) and the orphaned-attachment sweep are the seams B4-11 extends. `service/message_purge.go` is moderation bulk-delete, not retention — reusable mechanics.                                                                                                          |
| Email and SMTP are absent entirely (workstream 3, BPR-043 premise)              | **Confirmed — vacuous**     | Zero `smtp` hits in `Server/`; no email column in any migration. "Email optional / SMTP nonessential" holds by absence. B4 adds **no** email field or SMTP path (owner question 7); B4-2 pins the constraint with absence tests so it cannot regress silently.                                                                                                                                                                                                                              |
| Auth is required for messages, files, calls, moderation (workstream 2)          | **Believed true, unproven** | Uploads, GIF proxy and the ws handshake mount `AuthMiddleware`; no guest path is visible. What is missing is the **proof**: a route inventory asserting every data-bearing route's auth posture, and uniform revoked/expired/partial-session failure tests. B4-2 produces it.                                                                                                                                                                                                               |
| Admin-assisted recovery does not exist (workstream 5)                           | **Confirmed**               | `admin/handlers_users.go` has no credential-reset path at all (by design — a lockout comment at `:123` shows the sensitivity). B4-6 is greenfield.                                                                                                                                                                                                                                                                                                                                          |
| Local diagnostics exist; telemetry is opt-in; no support bundle (workstream 12) | **Confirmed**               | `GET /api/v1/diagnostics/connectivity` returns local server/voice/client diagnostics; OTel is compiled only under `-tags otel` and exports only where configured; the self-updater's manifest check is the one routine outbound call. No support-bundle export exists (BG-15 is tagged B6/B9). B4-8 scope: absence proof + inventory + bundle **data contract**; owner question 10 confirms the split.                                                                                      |
| Register rows OC-0313/0314/0324/0329/0340/0341/0354 are open                    | **Confirmed**               | All seven `open` in `.superpowers/findings-ledger.json` (plus OC-0321 above). Roadmap rule 2: B4 cannot exit while any is open unless re-tagged with a written reason in the HP-4/exit scorecard. Four are client-side fixes; the B2-8 precedent (six client-side B2-tagged findings fixed in-phase) applies — these are contained defect fixes, not B7 platform work.                                                                                                                      |

Net effect: workstream 15 is exactly as re-scoped; workstream 6 is larger
than written (recovery codes must be built, not preserved); workstream 1 is
smaller in mechanism (one enum replaces a boolean, and invite-only conduct
already exists) but carries the approval queue as real new surface;
workstreams 4, 5, 9, 10, 11 are greenfield on seams B3 prepared; workstream
3 is vacuous today and needs only guarding; and entry-gate item 3 is honest
new work, not paperwork.

## Owner decisions required before implementation

Explicit open questions — **ask, don't assume**. Each blocks the step that
names it; none blocks the plan itself, B4-0, or B4-2. Answers land as dated
amendments here (and to BPR wording where the owner changes scope, as with
BPR-032).

1. **Registration modes and defaults (blocks B4-1).** Confirm the mode set
   `closed / invite-only / approval / open`, invite-only as the fresh-install
   default, and the upgrade mapping `registration_open` 1 → invite-only,
   0 → closed (never → open — the roadmap's "upgrade preserves the owner's
   chosen mode without silently opening registration"). Approval mode: the
   review surface is the admin panel only (no email exists); does an
   approved applicant complete registration via a one-time link/code, or is
   the account created pending and unlocked? Per-mode abuse limits for
   `approval` and `open`.
2. **Recovery-kit shape and 2FA interplay (blocks B4-5).** The server stores
   only protected, non-reversible verification material either way; the
   product choices are: kit presentation for B9 (file, phrase, QR — affects
   only the client format of the secret the server hands out once); whether
   recovery with the kit **bypasses TOTP** (it is "I lost my devices" — the
   likely intent) or still requires the second factor; one active kit per
   account with regeneration invalidating the old (recommended); lockout
   policy for failed kit attempts.
3. **Admin-assisted recovery policy (blocks B4-6).** Who may issue — owner
   only, or any admin-class role? Credential TTL (BPR-045 says short-lived —
   propose 15 minutes, single-use). What the "recorded local identity
   verification" audit row says — it must be content-free (category, actor,
   subject id, decision), so the wording is fixed here, not improvised.
4. **Retention defaults and precedence (blocks B4-11).** Indefinite default
   is fixed by BPR-054. Open: the minimum configurable window (propose ≥ 1
   day), channel-policy-overrides-server precedence (propose yes, either
   direction), whether **pinned messages are exempt** from retention
   deletion, and whether retention applies to DMs (propose: server/channel
   scope only, DMs untouched, per BPR-054's wording).
5. **Legal/operator holds (blocks B4-11's hold surface; reviewed at HP-4).**
   The exit gate binds holds only "if such a mechanism is explicitly
   introduced". Decide: introduce an operator hold in beta (a per-channel/
   per-user "retention does not delete this" flag with audit), or explicitly
   record that no hold mechanism exists in beta and retention is absolute.
   If introduced, the operator-facing wording is the owner's (HP-4 reviews
   "legal/operator wording").
6. **Do private destructive-operation threat/failure models already exist
   (shrinks B4-0)?** Entry-gate item 3 is unverifiable from the repository.
   If owner-side material exists, B4-0 reduces to referencing it and filling
   gaps; if not, B4-0 writes it as specified below.
7. **Email/SMTP stay out of B4 (confirms B4-2/B4-5 scope).** No email field
   or SMTP path exists; BPR-043/046 make them optional and nonessential.
   Proposal: B4 adds neither; optional SMTP recovery is a post-B4 decision
   revisited at B9 (its UX phase). Confirm, or name the wanted scope now.
8. **New-login signal transport (blocks half of B4-7).** Two candidate
   contracts: (a) a new server→client WebSocket event to the account's other
   live sessions — an additive protocol change inside epoch 1, through the
   `protocol-change` workflow, with the B2 fixtures extended; or (b)
   REST-only — sessions gain an `unseen` flag the client surfaces on next
   fetch, no protocol change. (b) is smaller and epoch-quiet but cannot
   notify in real time. The same appetite governs where OC-0354's
   `totp_enabled` lands: the `GET /users/me` profile response (no protocol
   change, proposed) versus the `auth_ok` payload. Sign-out-everywhere is
   REST either way and proceeds regardless.
9. **Erasure semantics for message history (blocks B4-9).** BPR-052 forbids
   leaving "attributed or anonymized content" behind. Choose: erased users'
   messages are hard-deleted rows (channel history shows nothing), or
   content-free unattributed tombstones remain ("erased message" with no
   author id) so conversation shape survives. Affects clients, replay, FTS
   and the lineage checklist; both satisfy BPR-052's letter, only one is
   wanted.
10. **Support-bundle split (confirms B4-8 scope).** BG-15 (privacy-safe
    support bundle + verified zero telemetry) is register-tagged B6/B9,
    while the B4 exit gate mentions user-initiated, secret-reviewed bundles.
    Proposal: B4-8 delivers the no-telemetry proof, the local-diagnostics
    inventory, and the bundle **data contract** (what a bundle may contain,
    redaction rules, user-initiation requirement); the export endpoint and
    operator/client UX land in B6/B9 under BG-15. Confirm, or pull the
    endpoint into B4-8.

**Decisions recorded 2026-09-02** (owner answers — each the option the plan
proposed; the steps they name are unblocked from this date):

1. Registration (B4-1): the mode set, the invite-only default and the
   upgrade mapping stand. Approval mode creates the account up front with
   the applicant's credentials and holds it locked until an admin approves
   it in the admin panel — nothing is sent to the applicant; a denied
   application removes the locked account, audited. `approval` and `open`
   get a per-IP creation limit and a queue-size cap.
2. Recovery kit (B4-5): using the kit bypasses TOTP (it means "I lost my
   devices") and forces a password reset; one active kit per account,
   regeneration invalidates the old; the client presents a word phrase and
   a downloadable file (B9 formats the same secret); five failed kit
   attempts lock recovery for 15 minutes, audited.
3. Admin-assisted recovery (B4-6): owner only; the credential lives 15
   minutes and is single-use; the audit row is `recovery_assist_issued`
   with category, actor id, subject id and the recorded verification
   decision — nothing else.
4. Retention (B4-11): minimum window one day; a channel policy overrides
   the server policy in either direction; pinned messages are exempt;
   server and channel scope only, DMs untouched.
5. Holds: no hold mechanism in beta — retention is absolute, and the exit
   gate's hold rule does not apply. A hold, if ever wanted, is its own
   later step.
6. Answered by B4-0 (PR #1497): no owner-side material existed; the
   document was written as specified.
7. Confirmed: no email or SMTP path in B4; optional SMTP recovery is a
   post-B4 decision revisited at B9.
8. New-login signal (B4-7's second half): REST-only — sessions gain an
   `unseen` flag the client surfaces on its next fetch; no protocol change.
   OC-0354's `totp_enabled` goes on the `GET /users/me` profile response.
9. Erasure (B4-9): erased users' messages are hard-deleted rows; channel
   history shows nothing where they were.
10. Support bundle (B4-8): the data contract, the local-diagnostics
    inventory and the no-telemetry proof only; the export endpoint and the
    UX land in B6/B9 under BG-15.

Build order from here: B4-7's new-login half with OC-0354, then B4-1 with
the OC-0324 batch behind it, then B4-5 → B4-6 (serial on `service/auth.go`)
with B4-8 beside them, then HP-4 and B4-9 → B4-10 → B4-11.

## B4-0 — Destructive-operation failure/threat models and data-class inventory

Closes entry-gate item 3 and is HP-4's primary input. Roadmap workstream 13's
binding (drills run on the B3-7 dataset) is designed here.

1. **Failure models, public.** A new `docs/architecture/data-lifecycle.md`
   (linked from `docs/architecture/README.md`): for each destructive or
   irreversible operation — account erasure (current anonymise path and the
   B4-9 target), retention cleanup, backup restore, recovery-secret rotation,
   TOTP key lifecycle — the failure model: interrupted mid-operation,
   disk-full, crash between transaction and filesystem effects, concurrent
   writers, restore-over-newer-data, and the declared recovery behaviour for
   each. Engineering failure models are public-safe; this file discusses how
   operations fail, never how to abuse them.
2. **Threat content, private.** Abuse cases that discuss exploitable gaps
   (who can trigger someone else's deletion, recovery-flow takeover shapes,
   admission-budget exhaustion) go to private GitHub Security Advisories per
   [docs/security.md](../security.md), each with its opaque public owner
   (SEC-01 already has one; new ones get register rows only as opaque
   families). The public doc references that they exist, nothing more.
3. **Data-class inventory.** The same document tables every user-attributable
   data class at `39019e7f` — profile fields, credentials and second-factor
   material, sessions and tokens, messages (+FTS), reactions, read states,
   mentions, uploads and attachment files on disk, invites, emoji, audit
   rows, voice states, plugin rows, backups — with, per class: where it
   lives, today's deletion behaviour (from the verify table: what
   `db.DeleteAccount` covers and what it leaves), and the B4-9/B4-10/B4-11
   target. This is the seed of BPR-052's "deletion data-lineage checklist"
   evidence.
4. **Drill protocol.** How HP-4 and the B4-9..11 tests consume the alpha
   snapshot: always a copy (`cp` into a temp dir, per its README), never the
   tracked file; the canary (`alpha_snapshot_test.go`) and
   `TestAlphaProfileByteIdentical` stay green untouched; each drill records
   before/after row-count and file-count inventories.
5. No code beyond, at most, a test helper that copies the snapshot. One PR.

Exit: the document exists with all five parts; entry-gate item 3 flips to
met with this PR's SHA as evidence; any private advisories filed are counted
(not described) in the evidence block. If owner question 6 surfaces existing
private material, the evidence block records that instead of new advisories.

**Evidence, 2026-09-01** — branch `feat/b4-0-data-lifecycle` from `dev`
`aabac60`; PR #1497 to `dev` (the squash SHA is recorded by the next step's
PR, as B3 did). Closes entry-gate item 3's public half.

- **Document:** [docs/architecture/data-lifecycle.md](../architecture/data-lifecycle.md),
  linked from `docs/architecture/README.md`. Eight operations (O1 account
  deletion, O2 message deletion/purge, O3 orphan sweep, O4 backup/restore,
  O5 replay-event retention, O6 session sweeps, O7 TOTP key lifecycle, O8
  recovery-secret rotation as a requirement) each modelled on the same five
  axes — interrupted, disk-full, transaction-vs-file, concurrent writer,
  restore-over-newer; a 26-row data-class inventory with today's behaviour
  under O1, the hard-delete cascade rule per class (from `Server/migrations/`)
  and the B4 step that changes it; the drill protocol with five HP-4
  baseline drills (D1–D5); an appendix of subject-inventory queries — the
  seed of B4-9's generated lineage checklist. Every claim names its function
  or file.
- **Corrections to this plan's verify table, found writing it:** (a) upload
  files are not simply "left behind" by today's deletion — rows linked to the
  soft-deleted messages and the old avatar become sweep-eligible and the
  orphan sweep reclaims them on a later tick, best-effort, only when storage
  is configured, and a failed unlink strands the file with no row naming it
  (O3 A1); the B4-9 requirement (synchronous, journaled removal plus a
  reconciliation pass) is unchanged, the baseline is now accurate. (b)
  `login_attempts` has no writer at HEAD — nothing to erase, and no B4 work
  should be planned for it. (c) FTS: account deletion empties the message's
  index entry (the content change fires `messages_au`); an ordinary soft
  delete keeps the terms until the content changes. (d) `audit_log` has had
  no foreign key to `users` since migration 003; the unlinkability work
  (B4-10) is not constrained by one.
- **Helper:** `Server/internal/alphasnap` — `Path()` resolves the tracked
  snapshot from the package's own location with a `go.mod` walk-up fallback,
  `Copy(dir)` writes a private byte copy (`os.CreateTemp`, no SQLite
  connection on the source). Tests: `TestPathPointsAtTrackedSnapshot`,
  `TestCopyIsByteIdenticalAndLeavesSourceAlone` (size, mtime and no
  `-wal`/`-shm`/`-journal` sidecar on the source), `TestCopyMakesDistinctFiles`,
  `TestCopyRefusesMissingDir`. `gofmt -l` clean; `go vet` clean; `go test
-race ./internal/alphasnap/` green; all four build-tag variants build;
  `cmd/dbinventory` unchanged at 53 importers / 0 unlisted (the package
  imports no `db`). `golangci-lint` could not run locally — the installed
  binary is built with Go 1.25 and refuses the module's 1.26.7 target, the
  mismatch the register's health table already records — so CI's pinned
  lint is the evidence.
- **Private half:** no new advisory needed — every gap the document records
  is already public (OC-0321; the deletion limits `docs/trust-model.md`
  discloses), a requirement on an operation B4 has not built, or an
  operator-facing failure mode nobody can trigger without owning the host
  (reasoning in the document's last section). SEC-01 remains the one
  pre-existing private item touching these operations. Owner question 6 is
  still open: owner-side models, if they exist, merge into the operation
  catalogue rather than replacing it.
- **Gates before push:** `npx prettier --check .` on the pinned 3.9.6 under
  Node 24; `npm run check:docs` (count claims and the ledger schema); the
  Go checks above.

## B4-1 — Registration modes

BPR-041, BG-10 server half; roadmap workstream 1. Today: a boolean
`registration_open` (default true, `service/auth.go:873`) where "open" still
requires an invite — effective modes `closed` and `invite-only` only.

1. **Mode setting.** Replace the boolean with `registration_mode` ∈
   `closed | invite | approval | open`, invite-only default for fresh
   installs; migration maps existing `registration_open` 1 → `invite`,
   0 → `closed` (never → `open`), through the `db-change` skill. The settings
   service validates the enum; the setup wizard writes the new key; the
   admin settings surface follows.
2. **Enforcement at the policy gate.** `RegistrationPolicy` (already checked
   before the request body is read) becomes mode-aware: `closed` 403s;
   `invite` requires a valid invite exactly as today (`CreateUserWithInvite`
   transactionality preserved — OC-0376's proof stays green); `open` admits
   without an invite; `approval` creates a pending application, not an
   account (or a locked account — per owner question 1), and pending
   applicants cannot authenticate.
3. **Approval queue.** Schema + service + admin-panel endpoints: list,
   approve, deny; approve/deny are audited (id-based rows, B2-6 shape);
   per-mode abuse limits (application rate per IP, queue size cap) per
   owner question 1's answer.
4. **Audited transitions.** Changing `registration_mode` writes an audit row
   naming old and new mode; the register's BPR-041 closure line ("explicit
   transitions … are audited") is the RED test written first.
5. **State tests** (the roadmap's "registration-mode state tests"): a
   per-mode table test — register attempt × mode × (invite valid/expired/
   revoked/absent/concurrent-reuse) — plus upgrade tests proving both legacy
   values map without opening registration, and a fresh-install test proving
   the invite-only default.
6. One PR (schema + service + api + admin + tests). The client's
   registration UX is B9 (BG-10's other half); nothing here touches
   `Client/`.

Exit: all modes enforce their documented behaviour with the state-test
matrix green; upgrade mapping proven; transitions audited; evidence block
records the matrix and the migration pair.

**Evidence, 2026-09-02** — branch `feat/b4-1-registration-modes` from `dev`
`a595786` (stacked on B4-7's second half, #1507); PR to `dev` #1508 (draft,
opened 2026-09-02). Fix commit `eb583bf`. Owner decision 1 chose the locked
account for approval mode.

- **Mode setting:** `registration_mode` ∈ `closed | invite | approval | open`
  replaces the boolean; migration 034 derives it — a fresh install (no users
  when the migrations run) is `invite`; an upgrade maps `registration_open`
  1/true → `invite` and anything else → `closed`, never `open` — and removes
  the old row. `SettingsService` validates the enum (lower-cased, trimmed),
  writes a `registration_mode_change` audit row naming old and new mode, and
  allows `require_2fa` only while the mode is `closed`; the mode cannot leave
  `closed` while `require_2fa` is on, and an unrelated patch is never gated.
  The setup wizard and its status carry `registration_mode` (default
  `invite`); the admin panel's Settings page and the wizard's step 4 use a
  mode select.
- **Policy gate:** `RegistrationPolicy` refuses `closed` (403, before the
  body is read) and, as before, a `require_2fa` server; an unparseable value
  fails closed and is logged. `Register` then admits per mode
  (`admitRegistration`): invite mode needs a code (an empty one gets the
  uniform 400 before any bcrypt work) and spends it exactly as before
  (`CreateUserWithInvite`, OC-0376's transaction); open mode creates the
  account and its first session in one transaction
  (`CreateUserWithSession`); approval mode records a locked application
  (`users.registration_status = pending`, no session,
  `202 {"status":"pending_approval"}`) that `Login` refuses with
  `403 account is awaiting approval`.
- **Approval queue:** `GET /admin/api/registrations`, `POST …/{id}/approve`,
  `POST …/{id}/deny` (`MANAGE_SERVER`), audited `registration_approve` /
  `registration_deny`; the Users page shows the pending card with both
  buttons. Denial anonymises and locks the row for good (`denied`, the
  username released) instead of deleting it — audit rows reference the id,
  the convention `DeleteAccount` already follows. Applications are absent
  from the member roster, the admin user list and the `require_2fa`
  enrolment count.
- **Abuse limits (decision 1):** open and approval registration are budgeted
  at 5 per client address per 24 h and the queue is capped at 100
  applications, both `429 RATE_LIMITED`; invite mode is budgeted by its
  invites.
- **State tests:** `TestRegister_ModeMatrix` — every mode × valid / expired /
  revoked / absent / used-up invite, with the account, lock and
  invite-consumption consequences (concurrent reuse stays OC-0376's proof);
  `TestMigration034_MapsRegistrationOpenWithoutOpening` (seven upgrade and
  fresh-install cases); `TestRegister_ApprovalMode_LockedUntilApproved`;
  `TestPendingUsers_HeldOutsideTheRosterUntilDecided`;
  `TestCreateUserWithSession_CommitsBothOrNeither`;
  `TestRegister_InviteFreeModesAreBudgetedPerAddress`,
  `TestRegister_ApprovalQueueIsCapped`,
  `TestRegister_InviteModeRefusesAnEmptyCodeBeforeHashing`; the
  `TestSettings_*` mode and require_2fa preconditions;
  `TestAdminAPI_Registrations_ListApproveDeny` and
  `…_RequireManageServer`; the audit-coverage rows for the three new
  actions. The boolean-era tests moved to the mode.
- **Client:** nothing structural (BG-10's UX is B9); the connect page shows a
  notice on the 202 instead of wiring a missing token.
- **Docs:** `api.md` (register modes and 202, the registration-queue
  section, settings and wizard fields), `security.md` (audit list,
  require_2fa rule, checklist), `schema.md` regenerated, traceability row
  BPR-041.
- **Gates:** four build-tag builds, `go vet`, `go test -race ./...`,
  `-tags deadlock ./ws/`, pinned `golangci-lint` 0 issues on the changed
  packages, `sqlc generate` no diff, `gendocs` regenerated; client full unit
  suite, `tsc`, `oxlint` and `eslint`; `check:docs` and the ledger check.
- **Review fixes (Codex, 2026-09-02, `205b86a`):** (P1) a taken
  `[denied-<id>]` name made a denial fail and left the application pending —
  the namespace is reserved at registration like `[deleted-…]`, and
  `DenyPendingUser` falls back to suffixed variants the way `anonymiseUser`
  does (`TestDenyPendingUser_FallsBackWhenTheDeniedNameIsTaken`); (P2) the
  queue cap was a count followed by an insert — the insert now carries the
  cap in one serialized statement, `db.ErrPendingQueueFull` → 429
  (`TestCreatePendingUser_CapIsEnforcedByTheInsert`,
  `TestRegister_ApprovalQueueCapHoldsUnderConcurrency` under `-race`); (P2)
  two concurrent mode patches could audit the same previous value —
  `SettingsService.Patch` runs one at a time
  (`TestSettings_RegistrationModeTransitionsChainUnderConcurrency`); and,
  raised on the stacked #1509 against B4-7's client change, a profile
  refresh landing after a local 2FA change no longer overwrites it (an
  epoch bumped by every local change guards the answer).

## B4-2 — Authenticated-only and no-external-dependency absence proofs

BPR-042, BPR-043; roadmap workstreams 2 and 3. Both believed true at HEAD;
this step turns belief into pinned proof. New test files only — it does not
edit `api/auth_handler.go` and may run beside B4-1.

1. **Route-posture inventory test.** A test walks the chi route tree and
   asserts every data-bearing route (messages, files, calls/voice,
   moderation, profile, admin) mounts `AuthMiddleware` (or the admin/owner
   middlewares), with an explicit allowlist for the deliberately public
   surface (register, login, health, connectivity diagnostics, update
   manifest) — the allowlist can only shrink, `DBImportAllow` style.
2. **Anonymous-absence tests.** Unauthenticated REST requests and WebSocket
   handshakes against representative routes of each class answer their
   uniform 401/handshake-reject; revoked, expired, and partial-auth (2FA
   pending) sessions fail uniformly (the B2 absence-contract shape).
3. **No-external-dependency proof.** An absence test pins that `Server/`
   production code imports no SMTP/mail package and no email column exists
   in the schema (guards owner question 7's "B4 adds neither" until decided
   otherwise); registration, login, session listing and revocation pass in
   the existing offline test harness (no network beyond the loopback
   server), which is BPR-043's "SMTP unset and internet blocked" evidence at
   the unit tier — the full network capture is B4-8's.
4. One PR. RED first: each absence test is proven able to fail (mount probe
   route without auth / add a fake mail import in a scratch commit, observe
   the failure, revert — the B2-7 probe pattern).

Exit: inventory + absence tests green and RED-proven; BPR-042's traceability
row cites them; no production code changed (or any gap found is filed and
fixed in its own right — a gap here is a security finding and follows
docs/security.md, not this plan).

**Evidence, 2026-09-01** — branch `feat/b4-2-absence-proofs` from `dev`
`aabac60`; PR #1498 to `dev` (the squash SHA is recorded by the next step's
PR). Test files only, plus a two-line refactor of
`api/absence_contract_test.go` (`fullRouter` now delegates to a new
`fullRouterWithDB`) so the new tests can mint principals behind the
production router. No production code changed; **no gap was found** — every
route off the public surface already answered the uniform 401.

- **Route-posture inventory** (`api/auth_posture_test.go`):
  `TestAuthPosture_EveryRouteOffThePublicSurfaceAnswers401` walks the
  production router (`chi.Walk`, admin and plugin subrouters included; the
  B2 guard of ≥ 100 routes kept) and sends an anonymous request to every
  route not in `publicSurface`, requiring `401` with error `UNAUTHORIZED` —
  never a 200, a resource-revealing 404, or a body parser's 400 ahead of
  authentication. `publicSurface` is the declared public surface with a
  reason per entry, shrink-only (a stale entry fails the test): the two
  health probes, `/api/v1/info`, the three credential entry points
  (`login`, `register`, `verify-totp`), the updater manifest, the WebSocket
  handshake (in-band auth, `TestEpoch1Fixtures/auth-failure`), the admin
  panel's static files and first-run setup pair (perimeter-gated; the
  `/admin/api` routes beneath are `RequireAdminAuth`-gated and walked),
  `/api/v1/metrics`, the two LiveKit perimeter routes and the LiveKit
  signalling proxy. `optionalPublicSurface` carries `/metrics/*` for the
  `-tags otel` run CI performs on this package (`ci.yml`). Negative
  control: `TestAuthPosture_NegativeControl` mounts an unauthenticated probe
  route beside the production tree and requires exactly it to be reported.
  A finding worth recording: the walk passed on its first run — at
  `aabac60` every non-public route, `/admin/api` and `/api/v1/admin/plugins`
  included, already answered the uniform 401.
- **Dead-credential uniformity** (`api/dead_session_test.go`):
  `TestAuthPosture_DeadCredentialsFailUniformly` mints a member behind the
  production router, proves a live session and a live API token are
  accepted (controls), then presents six dead classes — missing, revoked
  session, expired session (row kept, `expires_at` in the past), unknown
  token, **partial-auth token** (minted through a real 2FA login challenge,
  the `TestLogin_RequiresTOTPChallenge` shape) and revoked API token — to
  both the API gate (`/api/v1/auth/me`) and the admin gate
  (`/admin/api/me`), requiring the identical `401 UNAUTHORIZED` from every
  pair; a banned account with a valid session is pinned as the documented
  `403 FORBIDDEN` exception.
- **No external dependency** (`api/external_dependency_absence_test.go`,
  the B2 absence-contract shape — vocabulary pins, honestly labelled):
  `TestAbsenceContract_NoMailTransportImport` parses every production `.go`
  file under `Server/` (237 at `aabac60`; tests and `dbgen` excluded) and
  fails on an import matching a mail-transport or e-mail pattern;
  `_NoMailModuleRequirement` scans `go.mod`; `_NoMailConfigKeyOrRoute` walks
  the koanf keys and the route tree; `_NoEmailColumn` opens a fresh migrated
  schema and inspects every table's columns via `pragma_table_info`.
  Negative controls: `_ImportScannerNegativeControl` plants a `net/smtp`
  import in a temp tree, `_ColumnScannerNegativeControl` plants a
  `contacts.email` column in a temp database; each scanner must report
  exactly the plant. Registration, login, session listing and revocation
  already pass in the offline unit harness (`TestRegister_*`, `TestLogin_*`,
  the sessions tests) — BPR-043's evidence at the unit tier; the
  internet-blocked network capture is B4-8's.
- **Traceability:** BPR-042 and BPR-043 rows now cite the tests (the UI /
  public-docs clauses stay B9's; recovery clauses land with B4-5/B4-6).
- **Gates before push:** `gofmt -l` clean; `go vet ./api/` and
  `go vet -tags otel,wazero ./api/`; `go test -race ./api/` (whole package,
  green, ~113 s); `go test -tags otel -race -run 'TestAuthPosture|TestAbsenceContract' ./api/`
  green; `npx prettier --check .` and `npm run check:docs` green.
- **Review fixes (2026-09-02, Codex on #1498, both valid):** `mailPattern`
  had no rule for the bare word `mail`, so `go-mail`, `mail_address` or
  `/mail/recovery` would have passed every scanner — it now matches `mail`
  at a name boundary (pinned by `TestAbsenceContract_MailPatternBoundaries`,
  with the non-matches that keep it honest); and only the import and column
  scanners had negative controls, so the go.mod, config-key and route scans
  were extracted into functions and each got one (a planted `go-mail`
  requirement, a planted `mail_address` key, a planted `/mail/recovery`
  route), making the traceability row's "each with a negative control"
  true. Tests green under the default and `otel` tags; lint 0 issues.

## B4-3 — TOTP key-file fail-closed, durable second-factor state, emergency recovery codes

Roadmap workstreams 6 and 14; **OC-0321 (must-close)**, S-13, BPR-046. First
step of the serial identity chain — owns `auth/` and `service/auth.go`.

1. **OC-0321.** `LoadOrGenerateTOTPKey` generates only on confirmed
   non-existence (`errors.Is(err, fs.ErrNotExist)` on the direct read — a
   dangling-symlink ENOENT resolved via `Lstat` is still generation-eligible
   only when nothing exists at the path); every other read error fails
   closed without touching the file, matching the invalid-hex/wrong-length
   branches its own tests pin. RED first: a write-only key file (and an EIO
   simulation via a directory at the path) must refuse startup and leave the
   file byte-identical; then GREEN. The ledger record closes in this PR.
2. **Durable used-code and partial-auth state (S-13).** New tables (via
   `db-change`): used TOTP codes (hash of user id + code window, expiry =
   the 90s TTL) and partial-auth challenges + pending enrollments (token
   hash only, 10-minute expiry) — hash-only persistence, expiry sweeps in
   the maintenance loop, restart tests proving a used code stays used and an
   in-flight challenge survives, failure-mode tests (store write fails →
   verification fails closed). Sliding rate-limit windows explicitly stay in
   memory (S-13's closure line). The infrastructure-roadmap's recorded
   "TOTP persister seam" leftover closes here.
3. **Emergency recovery codes (BPR-046 — build, not preserve).** Generation
   (10 codes, one-time, alphabet chosen for transcription), storage as
   individual hashes, verification as a login second factor when TOTP is
   unavailable, consumption-on-use, regeneration invalidating the old set,
   exhaustion behaviour, and enrollment wiring: `totp/enable` returns real
   codes instead of the `[]string{}` stub at `api/totp_handler.go:91`
   (confirm returns them if enrollment UX expects them there — match the
   existing response contract), disable clears them. Tests: enrollment,
   verify, replay (a used code fails), exhaustion, restart, revocation.
4. **No security questions.** An absence line in the same tests: no such
   field exists in schema, config or API (BPR-046's prohibition, pinned).
5. Client changes: none (B9 owns recovery-code UX beyond what
   `AccountTab.ts` already renders for a non-empty array).
6. One PR. Coverage floors for `auth` and `service` ratchet with the new
   tests in the same PR.

Exit: OC-0321 closed in the ledger with the regression test named; restart
tests green under `-race`; recovery codes work end to end at the API tier;
the stub is gone.

**Evidence, 2026-09-01** — branch `feat/b4-3-second-factor` from `dev`
`aabac60`; PR #1499 to `dev` (the squash SHA is recorded by the next step's
PR). Code commit `39cecf3`; tests, floors and this block in follow-ups on
the same branch. Started ahead of B4-1 (decision-blocked, no branch open),
so no hot-file overlap occurred.

- **OC-0321 (must-close):** `LoadOrGenerateTOTPKey` generates only on a
  confirmed absence (`fs.ErrNotExist` **and** nothing at the path by
  `Lstat` — a dangling symlink is presence), refuses every other read error
  with the file untouched, and writes through `writeKeyFileAtomic` (temp
  file, fsync, rename; a stale temp file is cleared). RED-first:
  `TestLoadOrGenerateTOTPKey_ReadErrorFailsClosed` (directory at the path,
  dangling symlink, unreadable file — skipped as root, so the EACCES case
  runs on the unprivileged CI runner) and `_AtomicWrite`. **Revert-proof
  pass:** with the original loader restored the test failed ("generated a
  key … through a dangling symlink"); with the fix it passes. Ledger:
  `fixed` 2026-09-01, `fix.commit = 39cecf3`, `revertProof = pass`.
- **S-13 (durable second-factor state):** `auth.SecondFactorPersister` —
  the `LockoutPersister` shape, stdlib types only (auth imports db, so db
  cannot name auth types) — implemented by `db` over migration 032
  (`partial_auth_challenges`, `pending_totp_enrollments`, `totp_used_codes`;
  RFC3339 UTC text timestamps). `PartialAuthStore`, `PendingTOTPStore` and
  `UsedTOTPCodeStore` take `WithPersister`; with one set the database is
  the store (every read goes to it — the first draft cached in memory, and
  `TestSecondFactor_ChallengeAndReplayWindowSurviveRestart` caught a stale
  cache trusting a challenge another process had consumed). Rows carry
  `HashToken` digests of the token and of `userID:code`, and AES-GCM
  ciphertext for the pending secret (encrypted under the TOTP key like
  `users.totp_secret` — the one row that cannot be hash-only, since the
  secret must be recovered to confirm). Faults fail closed: no challenge is
  issued, no enrolment staged, no code accepted on trust; the log-only
  branches (restore, delete, unmark) are covered by a persister that reads
  but cannot write. Sliding rate-limit windows stay in memory. The
  maintenance tick sweeps the tables; `db.DeleteAccount` purges them
  (`TestDeleteAccount_PurgesSecondFactorState`). Tests:
  `TestPartialAuthStore_SurvivesRestart`, `_RestoreAndExhaustionPersist`,
  `TestPendingTOTPStore_SurvivesRestartSealed`,
  `TestUsedTOTPCodeStore_ReplayRejectedAcrossRestart`,
  `TestCleanupExpiredSecondFactorState`,
  `TestSecondFactorStores_FailClosedWhenPersisterFails` (auth); the db
  round-trips in `db/secondfactor_queries_test.go`; at the service tier a
  challenge issued by one `AuthService` completes in another, a spent
  code is refused by both, and a pending enrolment confirms after a
  restart (`TestSecondFactor_*`). Register S-13 → resolved/superseded.
- **BPR-046 (emergency recovery codes — build, not preserve):** ten
  `XXXXX-XXXXX` codes from a 32-symbol unambiguous alphabet (50 bits),
  bcrypt-hashed at `min(10, bcryptCost)`; issued by `EnableTOTP` (the
  `backup_codes` field the enable response always had) and by the new
  `POST /api/v1/users/me/totp/recovery-codes` (password-confirmed, 2FA
  required, `409 CONFLICT` otherwise, audit `recovery_codes_regenerated`
  with no code in the row — `TestAuditCoverage_APIMutations` gained the
  row); `VerifyTOTP` routes on the input's shape, spends a code by the
  conditional update (single use under concurrency) and reports
  `recovery_codes_remaining`; disable and erasure delete the set. A spent
  recovery code stays spent on a lost claim (the TOTP path's unmark does
  not apply — documented in `VerifyTOTP`). Tests:
  `TestRecoveryCodes_EndToEnd`, `_RegenerateRequiresTOTP`,
  `_StoredHashedOnly` (api), `TestRecoveryCodes_GenerateNormalizeMatch`,
  `TestNormalizeRecoveryCode_RejectsOtherShapes` (auth), the service
  restart test above. No security questions exist (pinned in
  `docs/security.md`; the vocabulary absence test is B4-2's file family
  and lands when the branches meet). Client untouched: it already renders a
  non-empty `backup_codes` list; UX is B9's.
- **Docs:** `api.md` (route index regenerated to 122 routes; prose for the
  new endpoint, the `backup_codes` semantics and `recovery_codes_remaining`),
  `schema.md` (table index regenerated; migration 032 in the history),
  `security.md` (2FA section, audit list, the key-file operator rule). The
  data-lifecycle inventory's class 4 row names the four tables once B4-0
  (#1497) lands — the document lives on that branch.
- **Gates (local mirror, Linux):** `go test -race ./...` 20 packages ok;
  `go test -tags deadlock` on `auth`, `service`, `api`, `db`, `ws` ok; all
  four build-tag variants build; `-tags otel` (`telemetry`, `api`) and
  `-tags wazero` (`plugin`) suites ok; the pinned `golangci-lint` v2.11.3,
  built locally with the module toolchain, reports 0 issues on the module
  (it first caught a `gocritic` byte-compare in a new test, fixed);
  `sqlc generate` reproducible; `gendocs` drift-free; prettier and
  `check:docs` green. **Windows CI** on `eabbc72` then failed one subtest:
  the mode-bit "unreadable key file" case cannot exist there (Windows keeps
  only a read-only bit, so `0o200` still reads back), so it is
  platform-guarded exactly like the root case; the directory-at-the-key-path
  subtest pins the same read-error branch on every platform. **Coverage:** the first run tripped the floors for
  `auth` (89.6% vs 90.8%) and `db` (76.2% vs 79.3%) — the new query
  wrappers were exercised only by other packages' tests, which do not
  count toward `db`'s own figure — so both gained in-package tests; final
  figures aggregate 81.2%, `auth` 91.4%, `db` 79.4%, `service` 74.4%,
  `ws` 88.0%. Ratchet: `auth` 90.8 → 91.4, `service` 71.3 → 74.3 (74.4
  measured, minus 0.1 for the 0.1 run-to-run variance CI has shown on this
  package), aggregate 79.8 → 80.9 (81.2 measured locally and floored at
  81.1; once the dev merge added B4-0's `internal/alphasnap`, 47% covered,
  to the denominator, CI measured 81.0 — the lowest Linux figure observed,
  minus 0.1 for variance, per the ratchet rule); `db` stays 79.3 —
  this branch measures 79.4 against `dev`'s 79.7, a 0.3-point dip from the
  wrappers' fault branches, above the floor and disclosed; `ws` untouched.
- **Private half:** nothing new to file — the controls added are described
  above; the gap OC-0321 closed was already public in the ledger.
- **After B4-0 merged (2026-09-02):** `docs/architecture/data-lifecycle.md`
  class 4 now names the four migration-032 tables, their `ON DELETE CASCADE`
  and their purge in `DeleteAccount`, replacing the "in memory today" note
  B4-0 wrote before this branch existed.

## B4-4 — Atomic admission budgets for expensive authentication work

Roadmap workstream 8; SEC-01 (P1). Public-safe scope only — the detailed
analysis lives in the private advisory; this plan states the control, not
the gap.

1. One server-owned admission decision bounds concurrent
   password-confirmation (and other deliberately expensive) authentication
   work: an atomic budget acquired before the expensive computation starts,
   released after, refusing over-budget attempts with the existing
   rate-limit error shape. All password-confirm sites route through it —
   login, delete-account, TOTP enable/confirm/disable, password change, and
   the B4-5/B4-6 recovery verifications land on it afterwards (a reason this
   step precedes them in the chain).
2. Race and load regression coverage per SEC-01's closure line: a
   concurrency test proving the budget's atomicity under `-race`, and a
   bounded-work proof (N concurrent attempts admit at most the budget).
3. Coordinate closure with the owner: the finding closes through its private
   advisory; the public register row flips with the advisory's ID recorded
   by the owner (the HP-2 follow-up shape for SEC-01/SEC-04 IDs).
4. One PR, after B4-3 merges (shares `service/auth.go`).

Exit: every expensive-auth site is budgeted; race/load tests green; SEC-01's
public closure evidence satisfied and the advisory updated by the owner.

**Evidence — 2026-09-02 (branch `feat/b4-4-admission-budget`, PR #1504):**

- **Control.** `auth.AdmissionBudget` (`Server/auth/admission.go`) is one
  counting semaphore: `TryAcquire` takes a slot without waiting or refuses,
  the returned release is idempotent, and `Peak`/`InFlight` expose the
  high-water mark the proofs read. The shared `auth.RateLimiter` owns the
  single instance (`Admission()`), sized once at startup from
  `security.expensive_auth_concurrency` (`SetAdmissionBudget` in
  `internal/app.StartRuntime`; 0 = twice the core count, never below 4;
  clamped to 1–4096), so the auth routes, the profile handler and the hub
  take one server-owned decision.
- **Sites.** Every bcrypt computation on an authentication path holds the
  slot for exactly the expensive step: login (acquired before the failure
  reservation, so a refusal charges neither the per-IP nor the per-username
  budget), registration's hash, account deletion, TOTP enable/confirm/
  disable and recovery-code regeneration (through
  `requirePasswordConfirmation`, now a method on the service), the ten-hash
  recovery-code issue, the up-to-ten-compare recovery-code match at
  `verify-totp` (acquired before that attempt is reserved), and the
  change-password route's old-password compare and new-password hash in
  `api/profile_handler.go`. The refusal is `service.ErrAuthBusy` — 429
  `RATE_LIMITED`, "too many authentication attempts in progress, try again
  later" — and `confirmPassword` passes it through without counting a
  failure.
- **Proofs.** `TestAdmissionBudget_AdmitsAtMostSizeAtOnce` (40 goroutines
  against a budget of 3 under `-race`: exactly 3 admitted, 37 refused, peak
  3, drained after release), `TestAdmissionBudget_ReleaseIsIdempotent`,
  `TestAdmissionBudget_RefusedWorkRunsNoBcrypt`;
  `TestExpensiveAuth_RefusedWhenBudgetExhausted` (all eight service sites
  answer `ErrAuthBusy` with the budget held, and the held slot stays the
  peak), `TestExpensiveAuth_BusyRefusalsChargeNoAttempt` (ten refused
  logins, three refused deletions and three refused confirmations leave
  every lockout untripped for the real attempts that follow),
  `TestExpensiveAuth_ConcurrentAttemptsAdmitAtMostTheBudget` (24 concurrent
  logins against a budget of 2: peak at most 2, every outcome admitted or
  refused, none lost); `TestLogin_RefusedWhenAuthBudgetExhausted` and
  `TestChangePassword_RefusedWhenAuthBudgetExhausted` pin the 429 shape at
  the transport and the recovery once the slot is back. Revert-proof: with
  the budget calls removed from the sites the service and api tests fail —
  no `ErrAuthBusy` is ever returned.
- **Register.** SEC-01's row records the control and stays `confirmed`: the
  flip carries the advisory ID the owner records (step 3, the HP-2
  follow-up shape) — the one exit item this branch cannot do.
- **Docs.** `docs/server-configuration.md` gains the key (the hand-written
  Security table and the regenerated index); `docs/security.md` states the
  contract in one line under two-factor authentication.
- **Gates:** recorded at push in the PR's test plan.

## B4-5 — Locally generated recovery kit

BPR-044, BG-09 server half; roadmap workstream 4. Greenfield. Blocked on
owner question 2.

1. **Contract.** The client generates the kit locally; the server receives
   and stores only protected, non-reversible verification material (argon2id
   verifier of the kit secret — never the secret), via an authenticated
   enrolment endpoint; recovery presents the kit secret, is verified
   server-side, and on success: password reset is permitted, **all**
   sessions of the account are revoked, the kit is consumed and must be
   rotated (one-time use), and a content-free audit row is written.
   TOTP interplay per owner question 2.
2. **Schema** via `db-change`: one active kit verifier per account, created/
   used timestamps, no plaintext anywhere; the data-lifecycle inventory
   (B4-0) gains the class.
3. **Abuse controls:** rate limits + lockout on failed kit attempts (keys in
   the existing limiter), admission budget from B4-4 on the verification,
   and replay/concurrency tests: two concurrent uses of one kit admit at
   most one; a used kit fails thereafter; restart mid-recovery leaves no
   half-state (the roadmap's "recovery abuse, replay, concurrency, and
   restart tests").
4. **Secret hygiene proof:** logs, audit rows and (per B4-8's contract) any
   future support bundle contain no usable recovery material — a test greps
   captured log output from a full recovery round.
5. Recovery works with SMTP unset and no outbound network (it is loopback
   REST only) — BPR-043/044 evidence.
6. Client UX is B9's (BG-09 other half); B4 may land a minimal API-tier
   consumer in tests only. One PR, after B4-4.

Exit: enrolment/recovery/rotation green with the abuse suite; audit rows
content-free; `trust-model.md` gains the kit's honest description (what the
server stores, what it cannot recover).

**Evidence, 2026-09-02** — branch `feat/b4-5-recovery-kit` from B4-1's
branch (its `service/auth.go` owner; stacked on #1508); PR to `dev` (draft,
opened 2026-09-02). Owner decision 2 (bypasses TOTP, one active kit, phrase +
file, five failures lock for 15 minutes) and decision 7 (no email path).

- **Contract:** `POST /api/v1/users/me/recovery-kit` (password-confirmed,
  the `pw_confirm` lockout family) issues the kit: with a client-generated
  secret in the body the server stores its verifier and echoes nothing; with
  none it generates 20 random bytes, shown as eight base32 groups, and
  returns them once. Either way `recovery_kits` (migration 035) holds one
  argon2id verifier per account (PHC string, parameters recorded, `m=19456,
t=2, p=1`), replaced and un-spent on re-enrolment. `GET
/api/v1/users/me/recovery-kit` is the account's own "enrolled or spent"
  (O8 axis A3). `POST /api/v1/auth/recover` redeems: `DB.RedeemRecoveryKit`
  spends the kit (conditional on `used_at IS NULL` — axis A4), replaces the
  password, deletes every session and writes the `recovery_kit_used` row in
  one transaction (axis A1), then a fresh session is issued without the
  second factor. `DeleteAccount` purges the row (data-lifecycle class 5).
- **Abuse controls:** the argon2id compare and the new-password hash each
  take an admission slot (B4-4); every failure — unknown account, no kit,
  spent kit, wrong secret — is the same 401 and runs the same compare
  (against a verifier nobody holds when there is none); five failures per
  account or per address lock recovery for 15 minutes, the per-account
  lockout audited as `recovery_kit_locked`; the public route is limited like
  login.
- **Tests:** `auth`: `TestRecoveryKitSecret_ShapeAndNormalization`,
  `TestRecoveryKitVerifier_RoundTrip` (the verifier never contains the
  secret, salts differ), `TestRecoveryKitVerifier_ParametersComeFromTheVerifier`
  (a verifier made under other parameters still verifies; malformed ones
  never). `db`: `TestRecoveryKit_UpsertReplacesAndUnspends`,
  `TestRedeemRecoveryKit_IsOneTransaction`,
  `TestRedeemRecoveryKit_RollsBackAsAWhole` (an injected failure inside the
  redeem leaves kit, password and sessions untouched — the restart case),
  `TestDeleteAccount_PurgesTheRecoveryKit`. `service`:
  `TestRecoveryKit_EnrolRecoverRotate` (a 2FA-enrolled account recovers
  without a challenge, every session revoked, the old password refused, the
  spent kit refused, re-enrolment rotates; the captured log and the audit
  rows contain neither secret nor verifier — the secret-hygiene proof),
  `TestRecoveryKit_ClientGeneratedSecret`,
  `TestRecoveryKit_UniformRefusalsAndLockout`,
  `TestRecoveryKit_ConcurrentRedemptionAdmitsOne` (`-race`),
  `TestRecoveryKit_AdmissionBudgetRefusesWithoutWork`; the audit-coverage
  rows `recovery_kit_issued` and `recovery_kit_locked` (the `used` row is
  written inside the transaction and checked in the round-trip test).
  `api`: `TestRecoveryKitRoutes_EnrolStatusRecover` (anonymous enrolment
  401, wrong password 400, weak new password 400, wrong secret 401, the old
  session dead after recovery, the new password signs in, the spent kit
  refused); `POST /api/v1/auth/recover` joins the posture walk's declared
  public surface with its reason (B4-2's `publicSurface`), so the walk still
  proves every other route answers the uniform 401. Recovery is loopback REST
  only — no mail, no outbound network (BPR-043/044).
- **Docs:** `api.md` (three routes), `security.md` ("Account Recovery",
  audit list), `trust-model.md` ("Account recovery": what the server stores
  and what it cannot recover), `data-lifecycle.md` (class 5, O8 satisfied),
  traceability row BPR-044, `schema.md` regenerated.
- **Client:** none (BG-09's UX is B9; the API-tier consumer is the test).
- **Gates:** four build-tag builds, `go vet ./...`, `go test -race` on
  `auth`, `db`, `service`, `api`, pinned `golangci-lint` 0 issues on them;
  `sqlc generate` no diff; `gendocs` regenerated; `check:docs` and the
  ledger check.

## B4-6 — Administrator-assisted recovery

BPR-045; roadmap workstream 5. Greenfield (`admin/handlers_users.go` has no
credential-reset path today, deliberately). Blocked on owner question 3.

1. An authorized admin (per owner question 3) issues a **short-lived,
   single-use** recovery credential for a target account after recording the
   local-verification decision; the API requires that recorded decision
   (category + free-of-content note per the fixed wording), refuses
   otherwise, and rate-limits issuance per admin and per target.
2. Redemption: the user presents the credential, sets a new password;
   success revokes the affected account's sessions **and** the credential;
   expiry and single-use are enforced server-side; concurrent redemption
   admits one.
3. Audit: issuance and redemption write content-free rows (actor id, subject
   id, action class) — the "safe audit record" of BPR-045; the
   audit-redaction test proves no verification note or credential material
   lands in detail fields.
4. Tests: unauthorized issuance, replay, concurrent, restart-mid-flow,
   expiry, audit-redaction — the traceability row's list, verbatim.
5. One PR, after B4-5 (shares the recovery service surface).

Exit: the full BPR-045 test list green; admin panel exposes issuance behind
the authorized role; docs updated (`trust-model.md` "who can reset
credentials" gains the honest answer).

**Evidence, 2026-09-02** — branch `feat/b4-6-assisted-recovery` from B4-5's
branch (shares the recovery service; stacked on #1512); PR #1513 to `dev`. Owner decision 3 (owner-only,
15 minutes, single use).

- **Contract:** `POST /admin/api/users/{id}/recovery-credential`, owner-only
  by role position (`ownerOnlyMiddleware`, like tokens and backups) with the
  service checking the role again. The body records how the owner verified
  the person as one of four fixed wordings (`in_person`, `voice_call`,
  `video_call`, `trusted_contact`) and nothing else: the plan's "content-free
  note per the fixed wording" is the wording itself, so no free text exists
  that could reach the audit log. Refused for the issuer's own account, a
  banned or pending account and an anonymised row; budgeted at 5 per owner
  and 3 per account per hour. The response is the credential once (15 random
  bytes, six base32 groups), its expiry and the target's username. Stored:
  `recovery_assists` (migration 036) — argon2id verifier, issuer, wording,
  created/expires; a new issuance replaces the outstanding one.
- **Redemption:** the public recovery route, in `credential` (or the kit
  field): the secret's shape selects the verifier, so every attempt still
  costs exactly one argon2id compare and the kit and the credential never
  interfere. `DB.RedeemRecoveryAssist` deletes the live credential
  (conditional on `expires_at > now`), replaces the password, revokes every
  session and writes `recovery_assist_used` in one transaction (axis A1),
  then the session is issued without the second factor. A recovery by kit
  withdraws an outstanding credential; an assisted recovery leaves the kit
  enrolled. Lockouts, budgets and the uniform 401 are B4-5's.
- **Safe audit record:** `recovery_assist_issued` (actor the owner, target
  the account, detail the wording and "expires in 15 minutes") and
  `recovery_assist_used`; both audit-coverage tables carry the issued row
  with the credential and the verifier as forbidden strings.
- **Tests, the traceability row's list:** unauthorized —
  `TestAdminAPI_RecoveryCredential_OwnerOnlyIssueAndRedeem` (anonymous 401,
  member 403, Administrator 403, then the owner's 201 and the redemption
  through the service) and `TestRecoveryAssist_IssueIsOwnerOnlyWithFixedWording`
  (member, no actor, free text, unknown target, self, banned target — none
  stores a credential or writes a row); replay —
  `TestRecoveryAssist_RedeemsOnceWithoutSecondFactor` (a 2FA account signs in
  without the challenge, every session revoked, the old password refused, the
  row consumed, the replay refused),
  `TestRecoveryAssist_IssueReplacesAndRedeemConsumes` and
  `TestRecoverRoute_AcceptsAnOwnerIssuedCredential` (the route, the
  `credential` field, the old session dead); concurrent —
  `TestRecoveryAssist_ConcurrentRedemptionAdmitsOne` (`-race`); restart —
  `TestRecoveryAssist_SurvivesARestart` (a fresh service on the same database
  honours the credential once) and `TestRedeemRecoveryAssist_RollsBackAsAWhole`
  (an injected failure leaves credential, password and sessions untouched);
  expiry — `TestRecoveryAssist_ExpiryAndReplacement` and
  `TestRedeemRecoveryAssist_RefusesAnExpiredCredential`; audit-redaction —
  the audit rows in the round-trip test and the captured log in
  `TestRecoveryAssist_LogCarriesNoRecoveryMaterial`; also
  `TestRecoveryAssist_IssuanceIsBudgeted`,
  `TestRecoveryAssist_KitAndCredentialDoNotInterfere`,
  `TestRedeemRecoveryKit_WithdrawsTheOutstandingCredential`,
  `TestDeleteAccount_PurgesTheRecoveryCredential`.
- **Admin panel:** the Users page gains an owner-only "Issue recovery
  credential" action; its modal records the verification wording and shows
  the credential once with its expiry.
- **Docs:** `api.md` (the admin route, the authorization table, the recover
  section), `security.md` ("Account Recovery", audit lists),
  `trust-model.md` ("who can reset credentials" — the owner, this way, and
  nobody else), `data-lifecycle.md` (class 5), traceability BPR-045,
  `schema.md` regenerated.
- **Review and CI fixes (2026-09-02):** Codex's three findings on the shared
  recovery path (#1512) apply here too and are fixed the same way — the
  admission slot is taken before an attempt is charged and covers compare
  and hash, a malformed secret still runs the compare, the route bounds the
  username; the admin handler no longer imports the database package (the
  service resolves the issuing owner by id — the db-import-boundary
  invariant); `TestAdmissionBudget_AdmitsAtMostSizeAtOnce` counts a decision
  before signalling it. Codex on #1513 (`70a6e98`): the redeem consumes
  only the credential whose verifier it compared, so a re-issue between the
  compare and the transaction cannot be spent by the replaced one
  (`TestRedeemRecoveryAssist_OnlyConsumesTheCredentialItVerified`); the two
  issuance budgets are peeked and spent under one lock
  (`TestRecoveryAssist_IssuanceBudgetHoldsUnderConcurrency`, `-race`); the
  admission slot is taken before the budgets are charged
  (`TestRecoveryAssist_AdmissionRefusalChargesNoIssuance`).
- **Gates:** four build-tag builds, `go vet ./...`, `go test -race` on `db`,
  `service`, `admin`, `api`, `auth`; pinned `golangci-lint` 0 issues on them;
  `sqlc generate` no diff; `gendocs` regenerated; `check:docs` and the ledger
  check.

## B4-7 — Session contracts: new-login signal and sign-out-everywhere

Roadmap workstreams 7 and 15 (re-scoped: listing and individual revocation
exist — verify table); BG-08 server half; feeds OC-0314's fix in B4-12.
Blocked on owner question 8 for the signal's transport only.

1. **Sign-out-everywhere.** `DELETE /api/v1/users/me/sessions` revokes every
   session of the caller (current one included — the response says so, the
   client re-authenticates), reusing `DeleteOtherSessions` mechanics plus
   the current session; audited; integration test proves only the caller's
   account is affected (the exit gate's "only the correct account's
   devices") — a two-account test with interleaved revocations.
2. **New-login signal**, per owner question 8: (a) ws event via the
   `protocol-change` skill (schema + generated Go/TS + epoch-1 fixture
   extension + absence contract), or (b) REST `unseen` flag on the sessions
   list, marked seen on fetch. Either way the contract is server-complete
   for B9's UI (BG-08's notices) without client work now.
3. **Metadata correctness.** The session list already carries device/ip/
   created/last-used; add what the chosen contract needs (nothing more), via
   `db-change` if a column is required.
4. Tests: multi-device inventory/revocation integration tests (the roadmap's
   required evidence), wrong-account 404/403 paths, revoked-session
   uniform-failure joins B4-2's suite.
5. One PR. If (a): `-tags deadlock -count=10 -timeout 60m ./ws/` after the
   hub change, per the B3 trap list.

Exit: sign-out-everywhere green with the two-account proof; the new-login
contract live and fixture-covered in its chosen transport; BG-08's server
half done (UI remains B9).

**Evidence, 2026-09-01 — sign-out-everywhere half** — branch
`feat/b4-7-sessions` from `dev` `aabac60`; PR to `dev` #1500 (draft,
opened 2026-09-01). The new-login signal half waits on owner question 8
and lands as a second PR under this step; BG-08's server half completes
then.

- **Contract:** `DELETE /api/v1/users/me/sessions` revokes every session
  of the calling account, the current one included, and answers `200`
  `{"sessions_revoked": n, "current_session_revoked": true}` (false only
  for an API-token principal, which holds no session) — the explicit note
  the plan asked for, so the client re-authenticates instead of treating
  the next 401 as an error. Backed by a dedicated `DeleteUserSessions`
  query (sessions.sql, sqlc regenerated) and `UserService.RevokeAllSessions`,
  which writes the `session_revoke_all` audit row naming the account and
  the count, never a token or device (`TestAuditCoverage_ServiceMutations`
  gained the row and the detail denylist covers it).
- **Two-account proof:** `TestRevokeAllSessions_OnlyTheCallersAccount`
  interleaves two accounts' sessions in creation order, signs one out
  everywhere, and requires exactly that account's sessions gone (both,
  the current one included), the other account's two untouched, and the
  caller's token refused afterwards; `TestRevokeAllSessions_Unauthorized`
  pins the anonymous 401 (the B4-2 posture walk will see the route as
  session-gated when the branches meet).
- **Docs:** `api.md` (route index regenerated to 122 routes; endpoint
  prose), `security.md` (audit list), `trust-model.md` ("Multi-device
  sessions" gains the bullet).
- **Gates:** `gofmt`, `go vet`, `go test -race` on `api`, `service`, `db`
  green; the pinned `golangci-lint` v2.11.3 (local build) 0 issues; `gendocs`
  regenerated; prettier and `check:docs` green.
- **Review fixes (Codex, 2026-09-02):** (P1) the route now drops the
  account's live WebSockets in the same request — `ws.Hub.DisconnectRevokedUser`
  behind the `api.SessionDisconnector` seam the profile mount's broadcaster
  satisfies — instead of leaving a connected device to the revoked-session
  sweep's next tick; `TestRevokeAllSessions_DisconnectsTheAccountsLiveSockets`.
  (P2) a call that revokes nothing (an API-token principal keeps its
  session-less credential) writes no audit row, and the route is capped at
  five calls per account per minute (`429 RATE_LIMITED`);
  `TestRevokeAllSessions_NothingToRevokeWritesNoAuditRow`,
  `TestRevokeAllSessions_IsRateLimitedPerAccount`. The Linux coverage floor
  for `db` (79.3) was 0.1 under after the dev merge because the new
  `DeleteUserSessions` wrapper had no db-package test; it has one now
  (`TestDeleteUserSessions_RemovesEveryOneOfTheUsersOnly`) rather than a
  lowered floor.

**Evidence, 2026-09-02 — new-login signal half** — branch
`feat/b4-7-new-login` from `dev` `a595786`; PR to `dev` #1507 (draft, opened
2026-09-02). Fix commit `1c7c5b2`; ledger record OC-0354 flipped on the same
branch (`fix.commit = 1c7c5b2`, `revertProof = pass`). Owner decision 8 chose
the REST-only contract, so there is no protocol change and no B2 fixture work.
BG-08's server half is complete; the UI that surfaces both signals is B9.

- **Contract:** `sessions.unseen` (migration 033, `INTEGER NOT NULL DEFAULT
0`, so rows from before the upgrade read as seen). A session created by a
  login (`db.CreateSession`) starts unseen; a registration's first session
  does not (`CreateUserWithInvite` — no other device exists to tell).
  `GET /api/v1/users/me/sessions` carries `unseen` per row and is the
  acknowledgement: `UserService.MarkSessionsSeen` clears every row but the
  caller's own once the response is built, so the device that just signed in
  never acknowledges itself and the response shows the flags as they were;
  an API-token principal (no session) acknowledges every row. No audit row —
  nothing security-sensitive changes.
- **Tests:** `TestMarkSessionsSeen_AcknowledgesEveryLoginButTheCallers` (db:
  flags per login, the caller's own row kept, another account untouched, id 0
  acknowledges all, the token lookup carries the flag);
  `TestCreateUserWithInvite_Success` (registration's first session not
  flagged); `TestListSessions_NewLoginIsUnseenUntilAnotherDeviceLists` (api:
  the phone lists first and acknowledges only the laptop; the laptop sees the
  phone as new exactly once). Revert-proof: with the acknowledgement made a
  no-op, both flag tests fail.
- **OC-0354 (B4-12 batch (b), the server-side half of the round trip):** the
  profile response already stated `totp_enabled`; the client never read it,
  and every `auth_ok` (whose user object omits the field) wiped it. The
  Account tab's 2FA section now calls `onRefreshTotpStatus` (`GET /users/me`
  → `updateUser`) when it opens, rebuilding only if the answer differs from
  what it shows, and `setAuth` keeps the known value when the same account
  re-authenticates without it — never across accounts, and the payload wins
  when present. Tests: `auth.store.test.ts`, `totp-settings.test.ts`;
  revert-proof: two cases fail with the two changes undone.
- **Docs:** `api.md` (the contract on the sessions route), `trust-model.md`
  (multi-device bullet), `schema.md` regenerated; the hand-written `sessions`
  fixtures in the admin, api, db and ws test packages gained the column.
- **Gates:** four build-tag builds, `go vet`, `go test -race ./...`,
  `-tags deadlock ./ws/`, pinned `golangci-lint` v2.11.3 0 issues, `sqlc
generate` and `genprotocol` no diff; client full unit suite, `tsc`, `oxlint`
  and `eslint`; `check:docs` (336 fixed / 43 open) and the ledger check.

## B4-8 — Local diagnostics, support-bundle contract, no-telemetry proof

BPR-055; roadmap workstream 12; the B4 half of BG-15 per owner question 10.
Parallel-safe with everything.

1. **Diagnostics inventory.** Document (in `docs/architecture/`
   data-lifecycle or operations page) every diagnostic surface —
   `GET /api/v1/diagnostics/connectivity`, logs, metrics endpoint, OTel
   under `-tags otel` — and its locality: what leaves the machine (answer
   today: nothing except the self-updater's manifest check, and OTel only
   where an operator configures an exporter).
2. **No-automatic-telemetry proof.** A CI-runnable network capture: start
   the default-build server against a loopback-only allowlist, drive
   startup, registration, messaging, upload, idle, shutdown; assert zero
   non-loopback egress attempts (updater check disabled by config in the
   harness, or its one allowed destination pinned). Recorded as the
   "network capture demonstrating no automatic telemetry" evidence; rerun
   at B10 per BG-15.
3. **Support-bundle data contract.** The rules a future bundle must obey —
   user-initiated only, contents enumerated against the B4-0 data-class
   inventory, redaction requirements (no tokens, no key material, no message
   content without explicit inclusion), review step before write — written
   as the contract BG-15's B6/B9 implementation must satisfy. No endpoint in
   B4 unless owner question 10 says otherwise.
4. One PR (docs + capture harness + any config flag the harness needs).

Exit: capture green in CI; inventory published; contract written; BPR-055's
traceability row cites the capture (its "crash/update/support workflows"
breadth completes at B6/B10 with BG-15).

**Evidence, 2026-09-02** — branch `feat/b4-8-diagnostics` from `dev`
`a595786`; PR to `dev` #1510 (draft, opened 2026-09-02). Commit `c4de066`.
Owner decision 10: the data contract, the inventory and the proof; the
export endpoint and UX stay with BG-15 in B6/B9.

- **Diagnostics inventory:**
  [docs/architecture/diagnostics.md](../architecture/diagnostics.md) — the
  health probe, connectivity diagnostics, JSON metrics, the Prometheus
  exporter, OTLP, logs and the admin log stream, the audit log, backups and
  the healthcheck CLI, each with who reads it and that it stays local (OTLP
  only where an operator builds with the tag and configures an endpoint).
- **Egress inventory, enforced:** the `egress-sites` invariant
  (`Server/invariants/egress_sites.go`, in `Rules`) lists every production
  file that can open an outbound connection — the updater's three files
  (manual), the LiveKit download (configuration), the LiveKit process probes
  and signalling proxy (loopback), the plugin `host_http` capability and the
  GIF proxy (configuration, both empty by default), the healthcheck CLI
  (loopback) and the OTLP exporter (tagged build + configuration) — with
  trigger, destination and gate. An unlisted `http`/`net`/`tls`/`websocket`/
  `grpc` request or dial constructor, `http.Client` / `http.Transport` /
  `net.Dialer` literal, or OTLP import fails CI; a row whose file no longer
  reaches out fails `TestEgressAllowIsLive`; `TestEgressSites_Rule` is the
  negative control. The rule's first run found the startup banner learning
  the machine's address by `net.Dial("udp", "8.8.8.8:80")` at every start
  (no packet, but a capture shows the connect) — it now reads the interface
  table — and two undocumented sites (the LiveKit proxy, `updater/assets.go`),
  now rows.
- **No-automatic-telemetry capture:** `TestNoAutomaticTelemetry_Capture`
  (`Server/internal/app`) boots the real server as `main` does with the
  compiled defaults (TLS off, no LiveKit auto-download, no telemetry, no GIF
  key, no plugin allowlist), records every connection the default transport
  opens and every name the resolver looks up, drives first-run setup,
  invite registration, sign-in, a WebSocket session with the ready payload
  and a sent message, a channel read, an upload, an idle period and a
  graceful shutdown, and asserts nothing beyond loopback was dialled and no
  name was resolved; a positive control proves the recorder sees a loopback
  dial. The coverage boundary (a client on its own transport, or a bare
  `net.Dial`) is stated on the page and closed by the static rule; B10's
  packet-level rerun and the crash/offline flows are BG-15's.
- **Support-bundle data contract:** on the same page — user-initiated only
  with an audit row; nothing leaves by itself and any crash reporting is a
  separate opt-in that records consent; the items a bundle may contain,
  each with its data-lifecycle classes and redaction; the forbidden
  classes; the preview-before-write step with a manifest and redaction
  report; the tests the implementation must ship.
- **Docs:** the page and its index row; `security.md` "Diagnostics and
  Telemetry"; traceability row BPR-055 cites both tests.
- **Gates:** four build-tag builds, `go vet ./...`, `go test -race` on
  `internal/app` and `invariants`, pinned `golangci-lint` 0 issues on both;
  `check:docs` and the ledger check.

- **Review fixes (Codex on #1510, 2026-09-02, follow-up PR):** the inventory
  is per site — each row names the functions that may reach out, the rule
  flags a dial anywhere else in a listed file and `TestEgressAllowIsLive`
  checks every site both ways; the two LiveKit rows are `config`, not
  `loopback`, because `voice.livekit_url` may name a remote LiveKit and then
  the probes and each session's signalling leave the machine; the startup
  banner brackets an IPv6 address (`TestWSURL_BracketsIPv6`).

## HP-4 — Irreversible-data review

`docs/plans/hp-4-scorecard-<date>.md`, in the HP-2/HP-3 shape. Sits after
the identity chain (B4-0..B4-8) and **before any of B4-9/B4-10/B4-11
merges** — the roadmap's "before enabling deletion or retention cleanup".
Roadmap workstream 13 binds the drills to the B3-7 dataset.

Questions the scorecard answers with commands:

1. Are the failure models (B4-0) complete against the shipped identity
   chain — does every destructive operation B4-9..11 will build have its
   interrupted/disk-full/crash/restore row, and does private threat
   coverage exist for each (counted, not described)?
2. Are the data contracts for erasure, unlinkable audit, deletion markers
   and retention fixed — schema drafts reviewed, migration **and rollback**
   written for each, and the alpha snapshot's declared boundary (its README)
   respected?
3. **Baseline drills, on copies of `v1.2.0-alpha.4.sqlite`:** today's
   destructive operations exercised before the new ones exist — the current
   anonymise-deletion, a backup + restore round trip, and a
   restore-over-newer-data rehearsal — with before/after inventories
   recorded (B4-0's drill protocol). The tracked snapshot stays
   byte-identical (canary green).
4. Is the legal/operator wording decided (owner questions 4, 5, 9 answered)
   and reflected in the specs below as dated amendments?
5. Are the B4-tagged findings on track (B4-12 state; roadmap rule 2 needs
   zero open at exit)?

Owner signs. Acceptance authorises B4-9, B4-10, B4-11 (and may relax
B4-10 ∥ B4-11). Pre-squash SHAs of the chain's PRs are recorded here.

**Evidence, 2026-09-02** — branch `docs/hp-4-scorecard` from `dev` `b5e9d4a`;
PR to `dev` (draft). [hp-4-scorecard-2026-09-02.md](hp-4-scorecard-2026-09-02.md)
answers the five questions with commands and their output:

- **Drills D1–D5** as `TestHP4_*` in `Server/db/hp4_drills_test.go`, each on
  its own `alphasnap.Copy`, with the before/after subject inventories pasted
  (D1: exactly the predicted leftovers; D2: a restore resurrects the account
  and nothing records the deletion; D3: newer data gone, schema HEAD's; D4:
  the replay window survives O1 until pruned; D5: the sweep strands a file on
  demand). The tracked snapshot stayed byte-identical.
- **Drafts with rollbacks** in `docs/plans/hp-4-drafts/`: `erasure_jobs`,
  `deletion_markers`, `audit_unlinking`, `retention`.
- **Decisions recorded** (open to reversal at signature): erasure purges the
  subject's replay events; `secure_delete` + WAL truncate for freed-page
  honesty; markers live outside the database file and are replayed on every
  open and restore; audit rows keep integrity through a marker token; no
  holds, no DM retention, pinned exempt; B4-10 → B4-11 stays serial.
- **Signature pending:** the owner signs the scorecard; acceptance authorises
  B4-9 → B4-10 → B4-11.

## B4-9 — Complete account erasure

BPR-052, BG-11; roadmap workstream 9. Replaces today's anonymise-and-ban
(verify table) with erasure of every required class. After HP-4; blocked on
owner question 9 for message semantics.

1. **Scope, from the B4-0 inventory:** profile fields, credentials and
   second-factor material (TOTP secret, recovery codes, recovery-kit
   verifier), sessions and API tokens, messages per owner question 9 (+FTS
   rows), reactions, read states, mentions, **uploads: attachment rows and
   the files on disk** (the class today's path leaves behind outside
   emptied DMs), invites created, emoji authored (ownership reassigned or
   removed per inventory disposition), voice states, DM rows as today.
   The admin-initiated deletion path joins the same implementation (the
   register's "admin-logout row is B4's" note).
2. **Transactional and resumable.** The database half stays one
   transaction; filesystem effects (upload files) are journaled so an
   interruption resumes — a durable erasure job row that survives restart
   and completes idempotently (BPR-052's "interruption resumes safely";
   BG-11's "transactional/resumable"). Disk-full and crash paths per the
   B4-0 model.
3. **Data-lineage checklist**, generated not hand-written: a test walks the
   inventory and asserts, post-erasure on an alpha-snapshot copy, zero rows/
   files attributable to the subject in every class — the pre/post
   "database and storage inventory is empty for the subject" evidence.
   Last-admin guard and the OC-0294/OC-0293 mention-count reversal survive
   as today.
4. FTS rebuild/delete for the subject's content; SQLite freed-page honesty:
   the trust-model's page-scrub caveat is either closed (incremental vacuum
   after erasure) or explicitly retained and disclosed — decided at HP-4
   with the failure model.
5. One PR (service + db via `db-change` + the job runner in the maintenance
   loop + tests). Client confirmation UX stays B9 (BG-11 wording).

_Amendment 2026-09-02 (owner decision 9; HP-4 decisions 1 and 2):_ erased
users' messages are **hard-deleted rows** (channel history shows nothing
where they were), the subject's `events` rows go in the same transaction,
the erasure connection runs with `secure_delete` on and truncates the WAL
after commit; the job row and its file journal follow the `erasure_jobs`
draft in `hp-4-drafts/`.

Exit: lineage checklist green on the alpha copy; interruption/restart tests
green; `trust-model.md:345`'s "No secure deletion" paragraph rewritten to
the new truth (backup caveat remains until B4-10).

**Evidence, 2026-09-03** — branch `feat/b4-9-account-erasure` from `dev`
`9598c51` (HP-4 accepted); PR #1516 to `dev`, merged as `c9f06da`; the Codex review fix followed as #1517, merged as `7907c16`. Owner decision 9 and HP-4
decisions 1–2.

- **Erasure (`db.EraseAccount`, `Server/db/erasure.go`):** one transaction
  on the writer connection with `PRAGMA secure_delete = ON` for its duration
  (restored after) and `PRAGMA wal_checkpoint(TRUNCATE)` after commit; the
  last-admin guard and the OC-0294/OC-0293 mention-count reversal kept from
  the anonymising deletion it replaces. Children before parents, so the
  `users` DELETE passes with `foreign_keys=ON`: mentions naming the subject,
  attachment rows (uploaded by the subject or on the subject's messages, the
  avatar included), messages (the FTS trigger drops the index entries),
  reactions, read states, sessions, API-token **rows**, the four
  second-factor tables, recovery kit and assists (`issued_by → 0` on
  credentials the subject issued), voice state, blocks both directions,
  per-user overrides, DM membership and open state, the subject's invites
  (deleted — `created_by` is `NOT NULL REFERENCES users`, no user 0 exists),
  `redeemed_by → NULL`, the subject's `rate_lockouts` keys (exact-suffix
  match on id and case-folded name), the subject's replay `events`
  (`db.EventNamesUserPredicate` over the persisted envelope's `payload`:
  `user_id`, `user.id`, `from_user_id`, `mentions`); emoji reassigned to the oldest remaining
  admin-class account (else any account, else deleted with their files);
  survivor DM closing as before; then the `users` row, then the
  `erasure_jobs` row (migration 037, the `erasure_jobs` draft verbatim) with
  the captured `stored_as` list. `db.SubjectInventory` /
  `DB.TakeInventory` (`Server/db/inventory.go`) is the data-lifecycle
  appendix as code.
- **The file half (`service.ErasureService`, `Server/service/erasure.go`):**
  removes the journaled files after commit (a missing file counts as
  removed), completes or records the attempt; `Resume` runs every
  unfinished job at maintenance start-up and each tick; `Reconcile` lists
  the upload directory (`storage.Storage.List`), asks
  `DB.ReferencedStoredFiles` which names a row still references and removes
  the rest, older than the one-hour upload grace, at most 500 per tick — the
  HP-4 drill D5 stranded-file class reclaimed. One runner is shared by the
  self-service route (`AuthService.DeleteAccount`), the admin route
  (`ModerationService.EraseUser`, `DELETE /admin/api/users/{id}`,
  `ADMINISTRATOR` + hierarchy, never self, audited with the actor) and the
  maintenance loop; the router installs the upload storage, the loop's own
  storage is the fallback.
- **O1 A4 and O5 closed:** a message on an already-authenticated socket is
  either deleted by the transaction or refused by the foreign key once the
  row is gone, then the `member_ban` broadcast cuts the socket
  (`TestErasure_MessageOnAuthenticatedSocketDoesNotSurvive`). With the hub
  installed on the runner (`ErasureService.SetHub`) the erasure broadcasts
  the `member_ban` itself and purges the replay pipeline behind it
  (`Hub.PurgeUserFromReplay`: `EventPersister.Flush` as a barrier,
  `EventRingBuffer.RemoveWhere`, `DB.DeleteEventsForUser`), so a frame
  queued before the erasure or the notification itself cannot resurface on
  a reconnect or be written back by a later flush
  (`TestErasure_PurgesTheReplayPipeline`, `TestEventPersister_FlushIsABarrier`,
  `TestEventRingBuffer_RemoveWhere`, `TestErasureService_HubBroadcastsThenPurges`,
  `TestDeleteEventsForUser_MatchesEveryEnvelopeShape`) — Codex's two
  findings on #1516, both confirmed and fixed. Its review of #1517 added
  four more, also fixed there (`2f48505`): the purge is a journaled job step
  (`erasure_jobs.replay_purged`, migration 040) retried until it succeeds;
  a producer that reaches the hub after the purge with a frame naming the
  erased user is dropped (the hub's tombstone set); and a client resuming
  from before the purge takes the full ready (a replay-purge watermark in
  `mustFullResync`, and a ring replay crossing a cleared slot returns nil); and migration 037 is again byte for byte what `dev` shipped, the
  reply index moving to 040 beside `replay_purged` —
  `TestErasure_PurgeForcesFullResyncAndDropsLateFrames`,
  `TestErasureService_ReplayPurgeIsRetriedFromTheJournal`; the
  `idx_messages_reply_to` index moved to migration 040 so upgraded
  installations get it.
- **Tests:** lineage — `TestHP4_D1_ErasureLeavesNoClass` (alpha copy, every
  class zero, one journaled file per attachment row),
  `TestErasureService_LineageChecklistOnAlphaSnapshot` (files materialised
  per the drill protocol, zero on disk after),
  `TestEraseAccount_EveryInventoryClassIsZero` (a fixture with a row in
  every class, what must survive checked); interruption/restart —
  `TestErasureService_RestartResumesTheFileHalf` (commit, close, reopen,
  `Resume` finishes), `TestErasureService_FailedRemovalIsRetriedAndMissingFilesCount`,
  `TestErasureService_NoStorageLeavesTheJobPending`; disk-full —
  `TestEraseAccount_FailingStatementRollsBackEverything` (a failing
  statement late in the transaction leaves every class as before, no job
  row, `secure_delete` restored, the retry succeeds); reconciliation —
  `TestErasureService_ReconcileRemovesOnlyStrandedFiles` (a live attachment,
  an emoji file and a fresh upload survive; the stranded files go, bounded);
  the routes — `TestAuthService_DeleteAccountErasesAndBroadcasts`,
  `TestAuthService_DeleteAccountLastAdminIsRefused`,
  `TestModerationService_EraseUser`, `TestAdminAPI_DeleteUser_*`,
  `TestDeleteAccount_*` (api); D2 and D4 rewritten for the erasure (D2 keeps
  its resurrection expectation for B4-10 to invert); the earlier
  `TestDeleteAccount_*` db rows carried over as `TestEraseAccount_*`.
- **Docs:** `trust-model.md` ("No secure deletion" → "Deletion does not reach
  backups yet"), `data-lifecycle.md` (O1 rewritten, O3 A1/A3/A5, the
  inventory's Today column, the drill protocol, the appendix), `api.md` (both
  routes, the authorization table), `schema.md` (regenerated; the
  `ADMINISTRATOR` row), `hp-4-drafts/README.md`, the HP-4 scorecard's chain
  table and acceptance record, this block and the README row. Client
  confirmation UX stays B9.

## B4-10 — Unlinkable integrity history and anti-resurrection markers

BPR-053; roadmap workstream 10. After B4-9 — it is erasure's audit and
backup half.

1. **Unlinkable audit.** Audit/moderation rows referencing an erased subject
   retain only event category, time, action class, and an integrity proof;
   the subject mapping is **cryptographically erased**: subject references
   in retained rows are keyed (per-subject key, HMAC'd ids), and erasure
   destroys the key — correlation attempts across retained rows fail
   (test: two retained rows about one erased subject cannot be linked to
   each other or to the id). Detail fields for the subject are purged
   (extends the B2-6 denylist mechanics).
2. **Durable deletion markers.** A marker table (subject-key digest, erasure
   time, classes erased — no identifying data) that **backup restore
   honors**: restoring a pre-erasure backup detects markers recorded after
   that backup's creation and re-applies the erasure before the server
   serves data. Markers must therefore survive restore — stored outside the
   single restored database file (beside `totp.key` in the data dir, in the
   backup-safety design HP-4 reviewed) — this is the mechanism decision
   HP-4 fixes; the requirement ("restore … reapplies the durable deletion
   marker and cannot resurrect data") is BPR-053's, verbatim.
3. **Post-restore proof** (the roadmap's required evidence): drill on an
   alpha copy — erase a subject, take/restore an older backup, assert the
   lineage checklist still finds zero subject data after startup.
4. One PR, `db-change` for the schema; restore-path changes reviewed against
   the B4-0 restore failure model.

_Amendment 2026-09-02 (HP-4 decisions 3 and 4):_ markers live in
`data/erasure/markers.sqlite`, outside the file a restore overwrites, keyed
by an HMAC of the user id under a key generated beside the TOTP key, and are
replayed against the main database on every open and after every restore;
audit rows about an erased subject keep action, time and order with
`actor_id`/`target_id` zeroed, detail rewritten and the marker token in
`audit_log.subject_token` — the `deletion_markers` and `audit_unlinking`
drafts.

Exit: unlinkability and non-resurrection tests green on alpha copies;
`trust-model.md` backup caveat updated; BPR-053 row satisfied.

**Evidence, 2026-09-03** — branch `feat/b4-10-deletion-markers`, stacked on
#1517 (B4-9's review fix) until that merged as `7907c16` and was cascaded in;
PR #1520 to `dev`, merged as `87ad997` (at `a9aa6da`, before the review fixes
landed on the branch); those follow as #1522 (`fix/b4-10-review`). HP-4
decisions 3 and 4.

- **The key and the file:** `auth.LoadOrGenerateErasureKey`
  (`Server/auth/erasure_key.go`) — `OWNCORD_ERASURE_KEY`, else
  `data/erasure.key`, generated only on a confirmed absence, atomic write,
  every other read error fails closed (the OC-0321 rule, shared with the
  TOTP key). `db.MarkerStore` (`Server/db/markers.go`) is
  `data/erasure/markers.sqlite`: its own SQLite file, schema applied on
  open — the `deletion_markers` draft plus a `state` column. A marker names
  its subject as `SubjectToken` = HMAC-SHA256(key, `account:<id>`); the
  file names nobody without the key.
- **Two-phase write around the erasure:** `ErasureService.Erase` checks
  the refusals first (`db.EraseAccountPreflight`: the user exists, the
  last-admin guard), records the marker `pending` together with the users
  id counter (`sequence_floors`), runs `db.EraseAccount` with the token
  behind the audit writer's barrier, then confirms it `recorded`; a refused
  erasure discards the pending marker it created, a replay leaves an
  existing one alone. A pending marker left by a crash is applied on the
  next open like a recorded one when its account is present — the restore
  is what the markers defend against, and it reverts the very commit the
  marker was waiting on, so the main database cannot say whether it
  happened; the request behind the marker was authorised before it was
  written — and confirmed when the account is gone
  (`TestErasureService_PendingMarkerSurvivesACrashAndARestore`).
- **Replay on every open:** the `erasure-markers` start-up stage
  (`Server/internal/app/erasure.go`, between `migrate` and `telemetry`,
  before the hub, the router and any listener) loads the key, opens the
  file and runs `MarkerStore.ReplayAccounts`: every account whose id hashes
  to a marker is erased again through the full runner — rows, audit
  unlinking, files — with an `account_erasure_replayed` audit row carrying
  the token; `replays`/`last_replay` count it. The replay runs
  `db.ReplayEraseAccount`, the transaction without the last-admin guard: a
  live-operation rule the erasure passed when it ran, and a backup from
  before the handover to another administrator would otherwise keep the
  subject for good — the replay erases them and logs that no admin-class
  account remains (`TestErasureService_ReplayErasesTheLastAdminOfAnOlderBackup`).
  Before the replay the id counters are raised to the floors the marker
  file keeps (`MarkerStore.SequenceFloors`, `db.RaiseSequences`): a restore
  rolls `sqlite_sequence` back, and the next account would otherwise
  inherit an erased id and the marker's token
  (`TestErasureService_ReplayMarkersRaisesTheSequenceFloors`, with the
  negative control). A restore restarts the process
  (`handleRestoreBackup`), so "after every restore" is this stage. The
  routes' runner gets the same store (`SetMarkers`) so their erasures
  record into it.
- **The audit writer's barrier:** the production audit path is
  asynchronous (`db.AuditWriter`), so an entry about the subject queued
  just before the transaction would land raw after its `UPDATE`. The
  erasure installs the writer's unlinking rule for the subject and takes
  its flush barrier before the transaction (`db.UnlinkQueuedAudits`:
  `AuditWriter.Unlink`, `Flush`); the rule outlives the barrier, so an
  entry a producer enqueues after the erasure is written unlinked too, and
  a refused erasure withdraws it (`RelinkAudits`) —
  `TestAuditWriter_FlushBarrierWritesQueuedEntriesUnlinked`,
  `TestErasureService_QueuedAuditEntriesAreUnlinked`.
- **Codex's review** (on #1521, whose diff carried this code, and on
  #1520; five findings, all confirmed): the audit writer's queue, the
  last-admin guard at replay, the discarded pending marker, the id reuse
  across restored timelines, and the one token column a second erasure
  overwrote — the bullets above are the fixes.
- **Unlinkable audit history (migration 038, the `audit_unlinking` draft
  verbatim):** inside the erasure transaction every audit row the subject
  appears in — as actor, or as a `user` target — keeps its action, time and
  position, gets `actor_id`/`target_id` = 0 and `detail = ''`, and carries
  the token — in `subject_token` where the subject was the target, in
  `actor_token` where they acted (migration 041, after Codex's review: the
  draft's one column kept only the last erasure's token on a row naming two
  erased subjects; `TestEraseAccount_TwoErasedPrincipalsKeepBothTokens`).
  The erasure's own `account_deleted` row is written
  unlinked from the start (`db.WriteAuditEntry`: actor 0 for self-service,
  the administrator for the admin route, the target the token, no IP); the
  async audit writer carries the token. `GET /admin/api/audit-log` returns
  `subject_token` on those rows. Inventory class 21 (rows naming the id) is
  zero after an erasure, so `InventoryKeptByErasure` is empty.
- **Deviation recorded:** the plan's bullet 1 asked that two retained rows
  about one erased subject "cannot be linked to each other"; HP-4 decision
  4, which amended it, keeps one token per subject on purpose — the token
  is what lets a restore recognise the subject — so rows about one subject
  are linkable to each other and to the identity only by whoever holds
  `erasure.key`. `trust-model.md` says so.
- **Tests:** post-restore proof —
  `TestHP4_D2_RestoreResurrectsAndTheMarkersReapplyTheErasure` (alpha copy:
  erase with a marker, restore the older backup, the account is back in
  full, replay, zero in every class, the audit rows unlinked by token) and
  `TestErasureService_ReplayMarkersErasesAResurrectedAccount` (file-backed
  database, files restored too, erased again with the audit row);
  markers — `TestMarkerStore_TokenIsKeyedAndUnlinkable`,
  `TestMarkerStore_PendingConfirmDiscard`, `TestMarkerStore_ReplayAccounts`
  (recorded + present erased, pending + gone confirmed, pending + present
  discarded, a second replay idle), `TestMarkerStore_FileLivesOutsideTheDatabase`,
  `TestErasureService_RecordsAndConfirmsTheMarker` (a refused erasure leaves
  no marker); audit — `TestEraseAccount_UnlinksAuditHistory`; the key —
  `TestLoadOrGenerateErasureKey_*`; the stage —
  `TestOpenMarkers_ReplaysAgainstTheOpenedDatabase`.
- **Docs:** `trust-model.md` (the backup caveat closed, the token and the
  operator's two duties stated), `security.md` (the key, the unlinked rows,
  `account_erasure_replayed`), `data-lifecycle.md` (O1 A5, O4 A3/A5,
  classes 21, 24 and the new 27, drill D2, the appendix), `api.md`,
  `schema.md` (038 regenerated; the marker file's schema), the drafts README,
  this block, the README row, the scorecard.

## B4-11 — Retention policies and attachment cleanup

BPR-054, BG-12 server half; roadmap workstream 11. After B4-10 (HP-4 may
allow ∥). Blocked on owner questions 4 and 5.

1. **Policy model.** Indefinite by default — a fresh and an upgraded server
   delete nothing (RED-first test). Server-scope and channel-scope retention
   windows per owner question 4 (precedence, minimum window, pinned-message
   exemption, DM exclusion), stored as settings/columns via `db-change`.
2. **Clock and sweep.** The maintenance loop gains a retention tick: batch
   deletes past-window messages (reusing `message_purge` mechanics — mention
   reversal, FTS, read-state effects) and cleans their attachments (rows +
   files, riding the orphan-sweep seam), restart-safe and bounded per tick.
   Boundary tests: exactly-at-window, clock skew/DST (UTC contract), restart
   mid-sweep, disk pressure (cleanup still frees space when writes fail —
   B4-0 model).
3. **Holds**, exactly per owner question 5's answer: either the hold flag
   exists (retention skips held content; holds audited; exit-gate wording
   applies) or the scorecard records that no hold mechanism exists in beta
   and the exit condition is vacuously met — never an undocumented middle.
4. **Audit + preview.** Policy changes audited (old→new window, scope);
   the owner-facing effect preview ("would delete N messages") is a server
   endpoint; UI is B9 (BG-12's other half).
5. One PR. Deletion markers (B4-10) are not written for retention deletions
   — retention is policy, not subject erasure — the distinction is recorded
   in the data-lifecycle doc.

_Amendment 2026-09-02 (owner decisions 4 and 5; HP-4 decisions 5 and 6):_
minimum window one day; a channel policy overrides the server policy in
either direction; pinned messages exempt; server and channel scope only, DMs
untouched; **no hold mechanism** — retention is absolute; each sweep writes
a `messages`-scoped marker so a restore cannot resurrect what the policy
removed, which keeps B4-11 after B4-10. The `retention` draft in
`hp-4-drafts/` is the shape.

Exit: retention clock/attachment cleanup tests green (roadmap evidence);
default-indefinite proven for fresh + upgraded (alpha copy) servers; holds
per decision; backup/restore interplay tested (a restore does not
resurrect messages the policy already deleted — same marker question
resolved at HP-4, or window-based re-sweep on restore).

**Evidence, 2026-09-03** — branch `feat/b4-11-retention`, stacked on #1520
(B4-10) until it merged as `87ad997`, then carrying #1522 (B4-10's review
fixes) until that merges; PR #1521 to `dev`, marked ready 2026-09-03. Owner decisions 4 and 5; HP-4 decisions 5
and 6.

- **Policy model (migration 039, the `retention` draft with its comment
  semicolons turned into commas):** `settings.retention_days` (`0` = keep
  forever, seeded by the migration, so a fresh and an upgraded server
  delete nothing — `TestRetention_IndefiniteByDefault`, in-memory and on the
  alpha copy), `channel_retention` (a per-channel override in either
  direction, `0` keeps the channel forever), `RetentionMinDays` = 1,
  `RetentionMaxDays` = 3650, pinned exempt, DMs never listed
  (`DB.RetentionWindows`, `TestRetentionWindows_ServerAndChannelPrecedence`).
  The settings patch validates the window and audits
  `retention_policy_change` old → new
  (`TestSettings_RetentionDaysValidatedAndAudited`); the channel routes
  audit `channel_retention_change`.
- **Clock and sweep (`RetentionService.Tick`, `DB.SweepRetention`):** the
  maintenance tick sweeps every channel with an effective window in batches
  of 500 under a 5,000-message budget, each batch one transaction with the
  purge mechanics — mention-count reversal (OC-0294), attachment rows
  deleted and their files returned, the FTS trigger, `reply_to` set NULL —
  the cutoff computed in UTC against the UTC timestamps
  (`TestSweepRetention_RemovesOnlyPastWindowUnpinned`: exactly-at-window
  stays, pinned stays, fresh stays, mentions reversed, files listed). The
  run is journaled in `retention_runs` before any unlink and resumed on the
  next tick; a failing unlink records the attempt
  (`TestRetention_BudgetAndResume`); a budgeted channel records no marker
  and continues (`TestRetention_TickAppliesTheEffectivePolicy`).
- **Holds:** none — retention is absolute (owner decision 5); nothing in
  the schema or the code models one, and this block is the record.
- **Backup/restore interplay (HP-4 decision 6):** a channel swept clean to
  its cutoff records a `messages`-scoped marker (`MarkerStore.RecordMessagesSweep`,
  the cutoff only moving forward); the `erasure-markers` start-up stage
  replays them (`RetentionService.ReplayMarkers`), so a restored backup
  loses the past-cutoff messages again, files included
  (`TestRetention_ReplayMarkersResweepsARestoredBackup`,
  `TestOpenMarkers_ReplaysRetentionMarkers`,
  `TestMarkerStore_MessagesMarkersMoveForwardAndReplay`). No `account`
  marker is written for a retention deletion. The marker carries the
  `channels` sequence as a floor (B4-10's `sequence_floors`), so a restore
  cannot hand a swept channel's id to a new one.
- **The replay tiers (Codex's review of #1521, one finding, confirmed):**
  a swept message's `chat_message` frame stayed replayable, content
  included, in the ring buffer and the `events` table until the events
  pruner reached it. `DB.SweepRetention` now returns the ids it removed and
  each batch purges them behind the run's journal
  (`retention_runs.purge_pending`, written before the purge, cleared after
  it): through the hub when one is installed
  (`Hub.PurgeMessagesFromReplay` — dispatch barrier, persister flush, the
  ring's copies dropped, the persisted rows deleted by
  `DB.DeleteEventsForMessages` over the message-family frames, and the ids
  as the hub's tombstone set until the next sweep, so a late frame about a
  swept message is dropped), or the persisted rows alone at start-up. A
  purge that fails stays journaled and `resumeRuns` retries it on the next
  tick. `TestRetention_PurgeMessagesFromReplay` (ring, rows, the resume
  across the holes, the late frame), `TestDeleteEventsForMessages_MatchesTheMessageFamily`,
  `TestRetention_SweepPurgesTheReplayTiers`,
  `TestRetention_ReplayPurgeIsRetriedFromTheJournal`,
  `TestRetention_ReplayMarkersPurgesPersistedEvents`,
  `TestRetentionRuns_PurgeJournal`.
- **Audit + preview:** `GET /admin/api/retention`,
  `GET /admin/api/retention/preview` ("would delete N" per channel),
  `PUT`/`DELETE /admin/api/channels/{id}/retention`, all `MANAGE_SERVER`
  (`TestAdminAPI_Retention_PolicyPreviewAndOverrides`); UI stays B9.
- **Docs:** `data-lifecycle.md` (O9 with its failure model; classes 8, 12,
  27), `api.md` (the routes, the settings key, the authorization table),
  `security.md` (the audit actions), `schema.md` (039 regenerated), the
  drafts README, this block, the README row, the scorecard.

## B4-12 — The B4-tagged findings

Roadmap rule 2: B4 cannot exit while a B4-tagged `OC-*` row is open unless
re-tagged with a written reason in the scorecard. Eight rows are tagged B4
first; OC-0321 rides B4-3. The remaining seven land test-first in the
`bughunt-fix` shape (RED reproduction, fix, ledger flip in the same PR),
batched by file/surface:

| Batch | Findings          | Surface                                                                                                                                                                                                    | When                                             |
| ----- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| a     | OC-0313 + OC-0329 | Client legacy-key migrations: consume (save-then-delete) the pre-scoping `userVolume_*` and `dm-note` keys, the `channel-mutes.ts:106-111` pattern                                                         | any time (client only)                           |
| b     | OC-0314 + OC-0354 | Client identity truth: surface the partial-success `warning` body on password/TOTP changes; round-trip `totp_enabled` (server field placement per owner question 8's appetite — profile response proposed) | any time; server half coordinates with B4-7's PR |
| c     | OC-0324           | One canonical identity folding for the login lockout key vs `COLLATE NOCASE` lookup, Unicode collision tests                                                                                               | after B4-1 (shares `api/auth_handler.go`)        |
| d     | OC-0340 + OC-0341 | Token CLI: negative `--expires` rejected like the HTTP sibling; revoke-by-numeric-label falls through when the id branch matches zero rows                                                                 | any time (`token_cli.go` only)                   |

Client batches are contained defect fixes under the B2-8 precedent — no
`Client/src/` structural work, no new UX (that boundary stays B7/B9's).
Each batch: one PR, ledger updated in the same PR, `check:docs` counts kept
true. The client unit suite stays green and no assertion is weakened
(CLAUDE.md rule).

Exit: all eight B4-tagged rows `fixed` in the ledger (or re-tagged with a
written reason in the HP-4/exit scorecard — the expectation is zero
re-tags), read back in the exit scorecard.

**Evidence, 2026-09-01 — batch (a), OC-0313 + OC-0329** — branch
`fix/b4-12a-legacy-keys` from `dev` `aabac60`; PR to `dev` #1502 (draft,
opened 2026-09-01). Fix commit `40f6973`; ledger records flipped in
`448ccf7` on the same branch (`fix.commit = 40f6973`, `revertProof = pass`).
Both readers already migrated the pre-scoping value to the host-scoped key
on a miss; neither consumed the legacy entry, so every later brand-new host
missed its own key, read through to the same value and adopted it for its
unrelated user N.

- **OC-0313:** `getSavedUserVolume` (`audioElements.ts`) removes the
  `STORAGE_PREFIX + userVolume_N` entry right after persisting the scoped
  copy — the `channel-mutes.ts` shape from OC-0288. Test in
  `audio-elements.test.ts`: host A inherits the legacy 0 (a silenced user)
  once, the legacy entry is gone from localStorage, host B reads the 100
  default and writes nothing. Revert-proof: fails with the original reader.
- **OC-0329:** `loadNote` (`DmProfileSidebar.ts`) reads through once,
  writes the host's key and removes the legacy one, inside the existing
  try/catch; an empty host still reads the legacy key as before. Test in
  `dm-profile-sidebar.test.ts`: server A shows the note, its scoped copy
  exists, the legacy key is null, server B's user 42 sees an empty note,
  and server A still finds its note afterwards. The pre-existing
  legacy-fallback test keeps passing (its cleanup now also clears the
  scoped copy the migration writes). Revert-proof: fails with the original
  reader.
- **Gates:** `tsc --noEmit`; `oxlint src/` (two pre-existing warnings in
  `messages.store.ts`, unrelated); `eslint` on the two files; prettier
  check; the full client unit suite green — 191 files, 5251 tests, no
  assertion weakened (CLAUDE.md rule); no `Client/src/` structural work
  (the B2-8 precedent boundary). `check:docs` counts move to 331 fixed /
  48 open on this branch (batch (d) and B4-3 move the same lines;
  whichever merges later re-derives).
- **Post-merge review fix (Codex, 2026-09-02, PR #1505):** both migrations
  consumed the legacy key on the strength of a scoped write that can fail
  silently at storage quota, and a first fix that merely kept the key left
  it readable by the next host with the same user id. Both readers now
  migrate through `lib/legacyKeyMigration.ts`: the legacy key is removed
  before the scoped copy is written (its bytes then fit the copy), and a copy
  that still fails is restored under a claim naming the owning scoped key and
  remembered in memory, so only the first host reads it and retries. Pinned
  by `legacy-key-migration.test.ts` and the failed-write cases in
  `audio-elements.test.ts` and `dm-profile-sidebar.test.ts`.

**Evidence, 2026-09-01 — batch (b), client half, OC-0314** — branch
`fix/b4-12b-partial-success` from `dev` `aabac60`; PR to `dev` #1503 (draft,
opened 2026-09-01). Fix commit `b9ddb5a`; ledger record flipped in
`435abcb` on the same branch (`fix.commit = b9ddb5a`,
`revertProof = pass`). OC-0354 stays open: where `totp_enabled` travels
(the `auth_ok` user or the profile response) is owner question 8's field
placement, and it lands as the batch's second PR once decided.

- **OC-0314:** the three credential-change calls (`changePassword`,
  `confirmTotp`, `disableTotp`) are typed `PartialSuccessResponse |
undefined` and hand back the 200 body; `showChangeOutcomeToast`
  (`lib/toast.ts`) shows the server's warning as a `warning` toast for 12 s
  (a new `ToastType` with its `.toast-warning` rule) or the plain success
  message; MainPage's three handlers use it. No server change.
- **Tests:** `api.test.ts` (204 → `undefined`, 200 → the body, for all
  three), `toast-coverage.test.ts` (the warning wins, 204 → success, an
  empty warning → success; four toast types forwarded), `toast.test.ts`
  (the type class on the element), `main-page.test.ts` (the real settings
  overlay's password form → `changePassword` answers the warning body → a
  `.toast-warning` carrying the server's text and no success toast).
  Revert-proof: with the six source files reverted the helper and MainPage
  tests fail and `tsc` rejects the old `void` signatures; the API
  passthrough tests hold either way (the body was always returned — the
  type threw it away), which is why the MainPage-level test exists.
- **Gates:** `tsc --noEmit`; `oxlint src/` (the two pre-existing
  `messages.store.ts` warnings, unrelated); `eslint` on the changed files;
  prettier check; the full client unit suite green — 191 files, 5256
  tests, no assertion weakened. `check:docs` counts move to 330 fixed /
  49 open on this branch (B4-3 and batches (a) and (d) move the same
  lines; whichever merges later re-derives).
- **Review fix (Codex P2, 2026-09-02):** the password form was still
  painting its green "Password changed successfully." beside the warning
  toast. `onChangePassword` now resolves with the outcome, and the form
  keeps the warning inline (yellow, no three-second fade) on a partial
  success — the fields clear either way, because the password did change.
  Pinned in `settings-overlay.test.ts` and the MainPage-level test.

- **Server-side half, OC-0354 (2026-09-02, PR #1507 with B4-7's new-login
  half):** the flag round-trips from `GET /users/me` and a same-account
  re-authentication keeps it — see B4-7's second evidence block; the ledger
  record flips in that PR, closing batch (b).

**Evidence, 2026-09-02 — batch (c), OC-0324** — branch
`fix/b4-12c-lockout-fold` from B4-1's branch (its `service/auth.go` owner;
stacked on #1508); PR to `dev` (draft, opened 2026-09-02). Fix commit
`9553097`; ledger record flipped on the same branch (`fix.commit = 9553097`,
`revertProof = pass`).

- **OC-0324:** the per-username lockout key folded with `strings.ToLower`
  (full Unicode) while the account lookup folds ASCII only (`COLLATE
NOCASE`), so two accounts differing only in non-ASCII case — two rows —
  shared one bucket and hammering one locked the other out. The key now
  uses `db.LowerASCII`, the lookup's fold; ASCII case variants of one
  account still share a bucket. Test:
  `TestLogin_LockoutKeyFoldsLikeTheAccountLookup` (written first, red on
  the old fold: the sibling account was refused as locked).
- **Gates:** `go vet`, `go test` on `service` and `api`, pinned
  `golangci-lint` 0 issues; `check:docs` (337 fixed / 42 open) and the
  ledger check.

**Evidence, 2026-09-01 — batch (d), OC-0340 + OC-0341** — branch
`feat/b4-12d-token-cli` from `dev` `aabac60`; PR to `dev` #1501 (draft,
opened 2026-09-01). Fix commit `190344e`; ledger records flipped in
`fac3d88` on the same branch (`fix.commit = 190344e`, `revertProof = pass`).
Both findings had moved since they were filed: B3-8 put the CLI's logic
behind `TokenService`, so OC-0340's hole was `Create` folding a negative
lifetime into "never" (the admin route refused it at its edge; the CLI did
not), and OC-0341's was still the CLI's revoke committing to the id branch.

- **OC-0340:** `TokenService.Create` refuses `lifetime < 0` as
  `ErrBadRequest` — the seam both callers share, so the CLI's
  `--expires -1h` now exits 2 with the reason and mints nothing; zero stays
  the documented "never" (`TestTokenService_CreateStoresOnlyTheHash` keeps
  pinning that). Tests: the negative cases in
  `TestTokenService_CreateRefusesUnusableInput`;
  `TestTokenCreate_NegativeExpiryIsRefused` at the CLI (also that no-expiry
  and a positive window still mint). Revert-proof: both fail with the
  original `Create`.
- **OC-0341:** `tokenRevoke` tries an all-digit argument as an id first and,
  on `ErrNotFound`, as a label; id precedence is kept and now stated in the
  usage text — the ambiguity the ledger noted ("a token with id 2024 would
  be revoked instead") is the documented rule, not a silent surprise.
  Test: `TestTokenRevoke_NumericLabelFallsThroughToLabel` — a label
  `2024` revokes; an argument matching a live id revokes that token first;
  once it is gone the same argument reaches the label; nothing left exits 1.
  Revert-proof: fails with the original `tokenRevoke`.
- **Gates:** `gofmt`, `go vet`, `go test -race` on `.` (the `main`
  package, its first tests) and `service` green; pinned `golangci-lint`
  v2.11.3 0 issues; `gendocs` drift-free (no route or config change);
  `check:docs` counts moved to 331 fixed / 48 open on this branch (the
  count-bearing documents are edited together with the ledger; B4-3's
  branch moves the same lines for OC-0321 — whichever merges second
  re-derives).

## Exit gate

The roadmap's seven conditions, with the evidence each maps to:

| #   | Condition                                                                                                      | Evidence                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | All registration modes enforce their documented default and transitions                                        | B4-1 state-test matrix; fresh-install and upgrade-mapping tests; transition audit rows                                                             |
| 2   | Recovery works without SMTP, rotates secrets, revokes sessions, rate-limits, content-free audit                | B4-5 + B4-6 test suites (abuse/replay/concurrency/restart); B4-2/B4-5 no-SMTP proofs; audit-redaction tests                                        |
| 3   | Multi-device session contracts list and revoke only the correct account's devices                              | B4-7 two-account integration proof + existing listing/revocation tests                                                                             |
| 4   | Deletion removes every required data class and backup restore cannot resurrect the account                     | B4-9 generated lineage checklist on an alpha copy; B4-10 post-restore proof                                                                        |
| 5   | Retention removes messages and attachments consistently without bypassing legal/operator holds (if introduced) | B4-11 clock/attachment/boundary tests; holds per owner question 5, or the scorecard's explicit no-holds record                                     |
| 6   | Support bundles are user initiated, reviewed for secrets, and no automatic telemetry occurs                    | B4-8 network capture + bundle data contract (endpoint evidence completes at B6/B9 under BG-15 — recorded as the slim scope, owner question 10)     |
| 7   | Alpha-shaped data migrates forward and rolls back according to the declared boundary                           | Every B4 migration's paired rollback rehearsed on an alpha copy (HP-4 drill protocol); the standing canary green at the exit SHA; rehearsal report |
| —   | _(roadmap rule 2)_ No B4-tagged `OC-*` finding open                                                            | B4-3 (OC-0321) + B4-12 batches; ledger read-back in the exit scorecard                                                                             |

The exit evidence is appended to the HP-4 scorecard as a dated "B4 exit"
section the owner signs, measured at the exact exit SHA with the gate green
there — the B3 exit shape. Required roadmap evidence not named in a step
above: the migration and rollback rehearsal report is assembled at exit
from the per-step rehearsals.

## Explicitly out of scope for B4

- Client feature UX for registration modes, recovery, session notices,
  deletion confirmation, retention configuration — B9 (the B4/B9 splits of
  BG-08..12). B4-12's client batches are defect fixes only.
- Client platform/structural work of any kind (B7), and anything in
  `Client/src/platform/`.
- Email columns, SMTP transport, optional SMTP recovery — out unless owner
  question 7 says otherwise; B4-2 pins the absence.
- The support-bundle export endpoint and its UX (B6/B9, BG-15) — B4-8 ships
  contract and proof only, per owner question 10.
- Moderation-driven deletion workflows, message reports, NSFW consent (B5);
  B5 extends the B4-0 data-class inventory when reports exist.
- Capacity, deployment qualification, and the full offline/upgrade drills
  (B6) — B4 touches backups only where deletion markers and restore
  interplay require it.
- Storage quotas (SEC-04 is B3/B6-tagged and its B3 half is done; the
  durable-quota work is B6's).

## Traps carried forward

- **Squash merges hide structure.** Every PR that HP-4 or the exit reviews
  (the identity chain, B4-9..11, every migration PR) records
  `refs/pull/<n>/head` at merge time in its evidence block.
- **`strict: true` — one PR in flight per hot file.** `service/auth.go` is
  the hot file of this phase (B4-1, B4-3..B4-6 all touch it) — hence the
  serial chain. B4-2 writes new test files only; B4-12c waits for B4-1.
- **Schema only through the `db-change` skill; protocol only through
  `protocol-change`.** B4-1, B4-3, B4-5, B4-6, B4-9, B4-10, B4-11 carry
  migrations — each with a rollback rehearsed on an alpha-snapshot copy.
  B4-7 option (a) is the only protocol touch; epoch-1 fixtures extend, never
  mutate.
- **The alpha snapshot is a tracked artifact.** Drills copy it; nothing
  regenerates it casually (its README's rules); the canary and
  `TestAlphaProfileByteIdentical` stay green through every B4 PR.
- **Public repository, destructive-operation content.** Failure models are
  public; exploitable-gap discussion is not (docs/security.md). Commits
  describe the control added, never the gap closed. SEC-01 closes through
  its advisory.
- **Verify with `ci-check`, not ad-hoc builds** — four build-tag variants,
  `-race`, `-tags deadlock ./ws/` (with `-count=10 -timeout 60m` after any
  `ws` change), lint, doc gates.
- **Coverage floors ratchet in the same PR** that raises a package's figure
  (`Server/coverage-floor.json` rules).
- **A pinning/absence test needs a negative control on the exact branch**
  (HP-2 obs #96): every B4-2 absence proof and B4-9 lineage assertion is
  RED-proven with a probe before it counts.
- **`check:docs` counts are watched.** B4-12's ledger flips keep
  [README.md](README.md)'s enumeration exact in the same PR.
- **The shell cwd persists between commands** — subshell `cd`s (the
  pre-bash hook now enforces this).
