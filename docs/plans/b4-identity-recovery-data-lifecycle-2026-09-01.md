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
**B4-12 batch (d) opened 2026-09-01** (branch `feat/b4-12d-token-cli`,
PR #1501; evidence in the B4-12 section — OC-0340 and OC-0341 fixed
test-first, revert-proofs pass). The owner decisions listed below block the steps that
name them. _Update this line — not only the step table — as steps land; the
[README.md](README.md) row is the status authority._

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

Exit: lineage checklist green on the alpha copy; interruption/restart tests
green; `trust-model.md:345`'s "No secure deletion" paragraph rewritten to
the new truth (backup caveat remains until B4-10).

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

Exit: unlinkability and non-resurrection tests green on alpha copies;
`trust-model.md` backup caveat updated; BPR-053 row satisfied.

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

Exit: retention clock/attachment cleanup tests green (roadmap evidence);
default-indefinite proven for fresh + upgraded (alpha copy) servers; holds
per decision; backup/restore interplay tested (a restore does not
resurrect messages the policy already deleted — same marker question
resolved at HP-4, or window-based re-sweep on restore).

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
