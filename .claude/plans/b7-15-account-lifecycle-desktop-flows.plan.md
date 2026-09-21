# Plan: B7-15 — Account lifecycle desktop flows

> **Milestone:** B7-15 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-15-account-lifecycle-desktop-flows`.
> **Worktree:** `.claude/worktrees/b7-15`.
> **Drafted:** 2026-09-21. **Base commit:** `639d5bb3` (`dev`, after B7-5's
> `f5c9ff68`/PR #1646 landed).

## Summary

The PRD outcome is four user-visible flows plus two small server additions:
"Sign-up honestly reflects the server's registration mode including a
pending-approval state, recovery works end to end from the client, deletion
discloses retention, and a user can export their own local support bundle
without a server call; `server-info` gains `registration_mode` and a retention
summary (decisions 2, 3)" (`prd.md:327`).

**Most of it does not exist, and one piece exists but is dishonest.** Recounted
at `639d5bb3`:

| Flow                | State today (re-derived)                                                                                                                                                                                                                                                         | This milestone                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Sign-up mode        | Always demands an invite code (`LoginForm.ts:669-673`); the invite field is shown for every register attempt. `pending_approval` is handled (`main.ts:670-678`) but the mode that produces it is never known before the attempt                                                  | mode-aware form; fetch `registration_mode` first         |
| `server-info`       | 3 fields, no `registration_mode`, no retention (`router.go:651-655`); **no client caller at all** (grep below → none)                                                                                                                                                            | add both fields; add the client read (shared with B7-12) |
| Recovery end to end | Server complete (routes `auth_handler.go:91,97,99,101`); **zero client code** — no kit, no `/auth/recover`, and the login 2FA box refuses anything but six digits (`LoginForm.ts:741`) though the server already accepts an emergency code on the same route (`auth.go:697,716`) | kit enrol + status, recover flow, code acceptance        |
| Deletion retention  | Delete section says "permanent … all your data will be deleted" (`AccountTab.ts:992`); **no retention disclosure anywhere** (`grep -rni retention Client/src` → none)                                                                                                            | disclose the server-default window from `server-info`    |
| Support bundle      | **Nothing** — no zip, no export, no bundle UI; the only save-dialog surface is attachment download (`fileSave.ts:6-11`, caller `attachments.ts:796`)                                                                                                                             | client-local zip via the save dialog (decision 7)        |

**The two server additions are owner decisions, not open design.** Decision 2
(`prd.md:384`) extends `GET /api/v1/server-info` with `registration_mode`,
"one small server change with one test", owned by this plan. Decision 3
(`prd.md:385`) adds the `retention` summary object in the same PR, "server-default
message and attachment retention only; channel overrides stay admin-only". Both
are small precisely because the state they report already exists
(`service/registration.go`, `service/retention.go`); what is missing is the
public read path. `mountPublicV1` currently hands `handleServerInfo` only the
config (`router.go:146,625,729`), and the `api` package has **no** precedent for
reading a setting — the one existing unauthenticated settings read is in
`admin` (`setup_handler.go:105-110`, mounted at `admin/api.go:211`). The
mechanism this plan adds is the `healthDeps` closure shape (`router.go:595-608`),
not a new `db` import: `rt.Services` already holds `Settings` and `Retention`
(`service/service.go:106,117`) and `rt` is already a `NewRouter` parameter.

**Scope, stated against the phase's own boundary rule.** The B4 plan recorded
"client feature UX for registration modes, recovery, … retention configuration
— B9" (`b4-…plan.md:1967-1969`), written before this PRD. The B7 PRD outcome
(`prd.md:327`) allocates the desktop flows to B7-15, and the phase's scope line
repeats it ("alongside the account-lifecycle flows (registration mode,
recovery, deletion disclosure, support-bundle export)", `prd.md:243-244`). This
plan follows the PRD; it does not re-open the B4/B9 split, and it changes no
browser surface (B8 is deferred, `prd.md:253-254`).

**Two file-ownership collisions are expected and named below** — B7-12 is the
PRD's designated first `server-info` caller (`prd.md:274`) and its plan does not
exist yet; the client `server-info` type/API/store this plan adds is the file
B7-12 will also want. Recount, never merge (see Patterns).

## Verify before you implement

Every row was re-derived at `639d5bb3` by the command shown. If a row is false
at your HEAD, **stop that task and record it**; do not improvise around it.

| #   | Claim                                                                                                                                                           | How to re-check                                                                                                                                                                        | Verified |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `serverInfoResponse` has exactly `name`, `protocol_epoch`, `browser_client_enabled`                                                                             | `sed -n '651,655p' Server/api/router.go`                                                                                                                                               | yes      |
| 2   | `handleServerInfo` closes over `cfg` only; `mountPublicV1` is called before `svc := rt.Services` but `rt` is a parameter                                        | `grep -n "mountPublicV1\|svc := rt.Services" Server/api/router.go` → `:146`,`:150`; `grep -n "func handleServerInfo"` → `:729`                                                         | yes      |
| 3   | `healthDeps` is the in-package pattern for injecting DB-backed reads into a public handler without handing it `*db.DB`                                          | `sed -n '595,608p' Server/api/router.go`; `:322-340` builds the closures                                                                                                               | yes      |
| 4   | Four registration modes exist; live read is package-private; a missing row defaults to `invite`, an unparseable one fails closed to `closed`                    | `sed -n '16,62p' Server/service/registration.go`                                                                                                                                       | yes      |
| 5   | `SettingsService.Setting` is the only exported raw-settings read; the fail-closed parse is re-implemented out-of-package                                        | `grep -n "func (s \*SettingsService) Setting" Server/service/settings.go` → `:56`; `Server/admin/setup_handler.go:105-110`                                                             | yes      |
| 6   | `rt.Services` already exposes `Settings` and `Retention`; no new construction is needed                                                                         | `grep -n "Settings:\|Retention:" Server/service/service.go`                                                                                                                            | yes      |
| 7   | The server-default message window is `ServerRetentionDays` (missing/malformed/out-of-range → 0, keep forever); `RetentionPolicy` also carries channel overrides | `sed -n '51,66p' Server/db/retention.go`; `Server/service/retention.go:103-119`                                                                                                        | yes      |
| 8   | **No attachment-retention configuration exists anywhere** — attachments are deleted with their messages; orphan blobs are swept at a hard-coded 1 h             | `grep -rn "attachment_retention\|AttachmentRetention" Server/` → none; `Server/db/erasure.go:362`; `Server/internal/app/maintenance.go:244`                                            | yes      |
| 9   | Recovery endpoints all exist: kit enrol/status, public recover, TOTP + regenerate codes, account delete                                                         | `grep -n 'recovery-kit\|auth/recover\|totp/recovery-codes\|Delete("/account"' Server/api/auth_handler.go`                                                                              | yes      |
| 10  | The login-time 2FA route already accepts an emergency recovery code (shape-routed), so the client gap is validation only                                        | `grep -n "NormalizeRecoveryCode\|consumeRecoveryCode" Server/service/auth.go` → `:697,716`                                                                                             | yes      |
| 11  | Kit secret is 32 base32 chars in groups of four; input is normalised (spacing/case tolerant)                                                                    | `sed -n '14,56p' Server/auth/recovery_kit.go`; `:111-116`                                                                                                                              | yes      |
| 12  | Account erasure is immediate and hard-deletes messages in one transaction; a restored backup is re-swept by the deletion marker                                 | `Server/db/erasure.go:362`; `Server/service/erasure.go:143-167`                                                                                                                        | yes      |
| 13  | **No client calls `server-info`**, and none mentions retention or recovery kit                                                                                  | `grep -rn "server-info\|browser_client_enabled" Client/src --include=*.ts` → none; `grep -rni retention Client/src` → none; `grep -rn "recovery-kit\|/auth/recover" Client/src` → none | yes      |
| 14  | Register mode always requires an invite, and the login 2FA box accepts only `^\d{6}$`                                                                           | `sed -n '669,673p' Client/src/pages/connect-page/LoginForm.ts`; `:741`                                                                                                                 | yes      |
| 15  | `pending_approval` is already handled on the register path                                                                                                      | `Client/src/main.ts:670-678`; `Client/src/lib/types.ts:852-858`                                                                                                                        | yes      |
| 16  | No zip dependency in the client; the Rust `zip` crate is in the lock only transitively via `tauri-plugin-updater`                                               | `grep -in "zip" Client/package.json` → none; `Cargo.lock` `zip 4.6.1`, dependent `tauri-plugin-updater`                                                                                | yes      |
| 17  | `LogFiles` has no read; `FileSaver` is the only save surface, used by attachment download                                                                       | `sed -n '9,21p' Client/src/platform/contracts/logFiles.ts`; `:6-11`; caller `attachments.ts:796`                                                                                       | yes      |
| 18  | The platform counts the docs and a test pin move when a Rust command is added                                                                                   | `Client/tests/unit/platform-contracts-counts.test.ts:57-59` (21/30/35); `docs/architecture/platform-contracts.md:59-61`                                                                | yes      |
| 19  | Server-info is pinned by three tests and a posture-entry reason string; the request field table is hand-written                                                 | `Server/api/router_test.go:188,209,226`; `Server/api/auth_posture_test.go:40`; `docs/api.md:2786-2817`                                                                                 | yes      |
| 20  | The e2e mock harness serves arbitrary HTTP routes, so a mocked recovery flow needs no server                                                                    | `Client/tests/e2e/helpers.ts:443-479`; sibling `Client/tests/e2e/register-flow.spec.ts:14-41`                                                                                          | yes      |

**Row 8 is the constraint that shapes the retention summary.** "Message and
attachment retention" cannot be two independent numbers because no attachment
window exists to read; the only honest object is the message window plus the
documented fact that attachments are removed with their messages. Open
Question 1 decides the exact shape.

## Patterns to Mirror

- **Injecting a public read without a `db` import:** `healthDeps`
  (`router.go:595-608`), whose closures are built by `routerHealthDeps`
  (`:322-340`). `mountPublicV1` takes the built closure, exactly as it already
  takes the built health handler. Do **not** pass `*db.DB` into the handler —
  `api/router.go`'s `DBImportAllow` row (`invariants/db_import_boundary.go:106`)
  freezes its calls at `PingRead`, `SQLDb`, `SQLReaderDB`, and the service-passing
  route is the intended one.
- **One source for the registration mode.** `registrationModeSetting`
  (`registration.go:48`) already owns fail-closed parsing. Add an exported
  accessor beside it and call that; do not re-implement the parse as
  `admin/setup_handler.go:105-110` had to. That duplication is the anti-pattern
  this task removes a second copy of.
- **Fail-safe retention read.** `db.ServerRetentionDays` (`retention.go:53`)
  is the only read that fails closed on a typo; reuse it, never
  `SettingsService.Setting("retention_days")` parsed by hand.
- **Public-endpoint posture.** Adding a **field** to `server-info` does not add
  a route, but the endpoint's `publicSurface` reason string
  (`auth_posture_test.go:40`) says what it discloses and must move with the
  fields. C-2 (`TestAPIV1ServerInfoOmitsVersion`, `router_test.go:226`) forbids
  version/build/commit — none of these fields is one.
- **Client contract suites assert what the caller receives.** If the support
  bundle adds a Rust command behind a contract, its suite mirrors
  `tests/unit/platform/fileSave.suite.ts` and gets a null-subject entry in
  `suites-are-falsifiable.test.ts` (B7-3's rule).
- **A gate that cannot fail is not a gate.** Every new server field gets a test
  that would fail if the field were left out or wrong; every new client branch
  (each mode, closed/approval/open) gets a test, not just the happy path.
- **Counts are recounted, never merged.** A new `#[tauri::command]` moves
  `platform-contracts-counts.test.ts:57-59` and
  `platform-contracts.md:59-61`; a conflicting branch is resolved from the tree.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                                                             | Change                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Server/service/registration.go`                                                                 | exported live-mode accessor beside `registrationModeSetting`                                             |
| `Server/service/settings.go`                                                                     | `SettingsService.RegistrationMode(ctx)` (thin, single-source)                                            |
| `Server/service/retention.go`                                                                    | `RetentionService.ServerDays(ctx)` (no channel list)                                                     |
| `Server/api/router.go`                                                                           | `serverInfoResponse` + `serverInfoDeps`; `mountPublicV1` gains the deps; handler reads                   |
| `Server/api/router_test.go`                                                                      | assert both new fields; a test per mode and for the retention window                                     |
| `Server/api/auth_posture_test.go`                                                                | the `server-info` reason string                                                                          |
| `docs/api.md`                                                                                    | the hand-written `server-info` field table and example (`:2786-2817`)                                    |
| `Client/src/lib/types.ts`                                                                        | `ServerInfoResponse` (registration mode union, retention)                                                |
| `Client/src/lib/api.ts`                                                                          | `getServerInfo`, `enrolRecoveryKit`, `getRecoveryKitStatus`, `recoverAccount`, `regenerateRecoveryCodes` |
| `Client/src/stores/serverInfo.store.ts`                                                          | new: the connect-time `server-info` snapshot (shared with B7-12)                                         |
| `Client/src/pages/connect-page/LoginForm.ts`                                                     | mode-aware invite validation; approval/closed copy; accept a recovery code                               |
| `Client/src/pages/ConnectPage.ts`                                                                | fetch `server-info` for the selected host; recovery entry point                                          |
| `Client/src/main.ts`                                                                             | wire the connect-page fetch and the recovery callbacks                                                   |
| `Client/src/components/SettingsOverlay.ts`                                                       | new `SettingsOverlayOptions` members for the kit and code regeneration                                   |
| `Client/src/components/settings/AccountTab.ts`                                                   | recovery-kit section; regenerate-codes button; retention disclosure on delete                            |
| `Client/src/pages/MainPage.ts`                                                                   | wire the new authenticated callbacks                                                                     |
| `Client/src/lib/supportBundle.ts`                                                                | new: assemble the bundle entries and drive save (Open Question 2)                                        |
| `Client/src/platform/contracts/logFiles.ts`                                                      | `readAll()` for the persisted files                                                                      |
| `Client/src/platform/desktop/logFiles.ts`                                                        | implement `readAll()`                                                                                    |
| `Client/src-tauri/src/lib.rs`                                                                    | `#[tauri::command]` + `generate_handler!` entry, **if** Open Question 2 chooses Rust                     |
| `Client/tests/unit/{connect-page,settings-overlay,totp-settings,main-page,api,logs-tab}.test.ts` | new cases per flow                                                                                       |
| `Client/tests/unit/support-bundle.test.ts`                                                       | new: entries, redaction allowlist, planted-secret negative control                                       |
| `Client/tests/e2e/recovery-flow.spec.ts`                                                         | new: the one scenario decision 8 owes (mocked harness, no server)                                        |
| `Client/tests/unit/platform-contracts-counts.test.ts`, `docs/architecture/platform-contracts.md` | recount, **only if** a Rust command is added                                                             |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, `docs/plans/*`,
`CHANGELOG.md`, or any status row. **Never** edit the PRD — four sibling plans
are editing it in parallel.

**Shared with other in-flight milestones (expected conflicts; keep both edits):**

- `Client/src/lib/api.ts`, `Client/src/lib/types.ts`,
  `Client/src/stores/serverInfo.store.ts` — **B7-12** is the PRD's first
  `server-info` caller (`prd.md:274`) and will add the same read. Land the read
  once, in a shape both can use.
- `Client/src/components/settings/AccountTab.ts`,
  `Client/src/pages/connect-page/LoginForm.ts`,
  `Client/src/pages/ConnectPage.ts` — B7-12 (epoch/update notice) and B7-13/14
  (profile switch, sessions) may touch these files. Different functions.
- `Client/tests/unit/platform-contracts-counts.test.ts`,
  `docs/architecture/platform-contracts.md` — every milestone that adds a Rust
  command touches these; recount from the tree.

## Tasks

Commit after every task — conventional subject, scope `b7-15`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Branch, bootstrap and baseline

- **Action:** confirm the worktree is on
  `feat/b7-15-account-lifecycle-desktop-flows` at `639d5bb3` or later. Run
  `nvm use 26` (the client requires Node 26; `Client/.nvmrc` is the source of
  truth) and `npm run bootstrap` if `node_modules/` is missing. Run the
  one-line Verify rows (1–3, 5, 7–11, 13–19) and record their output.
- **Why:** the plan's counts and its "does not exist" rows are the whole task
  list; a stale base invalidates them.
- **Validate:** `npm --prefix Client test` green, and record the totals **at
  your HEAD** — the figure is a floor to re-measure, never a constant to assert.
  Also record the counts test's 21 / 30 / 35 (`platform-contracts-counts.test.ts:57-59`)
  so Task 8 can show the delta if a command is added.

### Task 1: `server-info` gains `registration_mode` and `retention` (decisions 2, 3)

- **Action:**
  1. `Server/service/registration.go`: add an exported accessor that wraps the
     existing `registrationModeSetting` (`:48`) — e.g.
     `func RegistrationModeOf(ctx context.Context, st Store) (RegistrationMode, error)`
     — so the fail-closed default lives in one place.
  2. `Server/service/settings.go`: `func (s *SettingsService) RegistrationMode(ctx) (RegistrationMode, error)`
     delegating to it (the `Settings` service is what `rt.Services` already holds).
  3. `Server/service/retention.go`: `func (s *RetentionService) ServerDays(ctx) (int, error)`
     delegating to `s.st.ServerRetentionDays` — `Policy` would pull every channel
     override, which decision 3 keeps admin-only (`prd.md:385`).
  4. `Server/api/router.go`: add `serverInfoDeps { registrationMode func(ctx) (string, bool); retentionDays func(ctx) (int, error) }`,
     build it in `NewRouter` from `rt.Services`, pass it through `mountPublicV1`
     (its call at `:146` already has `rt` in scope — no reordering), and extend
     `serverInfoResponse` with `RegistrationMode string \`json:"registration_mode"\``and`Retention *retentionSummary \`json:"retention"\`` (shape per Open
     Question 1).
  5. Read failure: `registration_mode` follows the service's own fail-closed
     semantics (missing → `invite`, unparseable → `closed` + log); a hard read
     error answers `500` rather than guessing, because the endpoint exists to
     state the server's configuration honestly.
- **Why:** decisions 2 and 3 name this plan as owner and say one server PR.
- **Gotchas:** no new `db` import in `api/`; C-2 still forbids version/build
  (`router_test.go:226`); the field table in `docs/api.md:2786-2817` is
  **hand-written** (the route index at `:176` is generated and does not change).
- **Validate:** `( cd Server && go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./... )`;
  `( cd Server && go test ./api/ ./service/ )`; a test asserts the field per mode
  and the retention window, and `TestAPIV1ServerInfoOmitsVersion` stays green.
  Commit.

### Task 2: Client reads `server-info` (shared with B7-12)

- **Action:** add `ServerInfoResponse` to `Client/src/lib/types.ts` (the mode is
  a union `"closed" | "invite" | "approval" | "open"`, matching
  `service/registration.go:18-27`; retention is the Task 1 shape);
  `api.getServerInfo(signal?)` via the existing `GET` path (`api.ts:280` is the
  shape to copy); a small `stores/serverInfo.store.ts` holding the last snapshot,
  populated where the host is chosen (`Client/src/main.ts`'s connect-page wiring,
  beside the health checks).
- **Gotcha:** the endpoint is public, so the read must work **before** a token
  exists; it goes to the same TOFU proxy origin as the health check
  (`profiles.ts:230-232`) and must not carry a stale `Authorization` header.
- **Validate:** `npm --prefix Client run typecheck`; a unit test asserts the
  parse and that a failed read leaves the store unset (so callers fall back to
  today's behaviour). Commit.

### Task 3: Honest sign-up for every registration mode

- **Action:** in `LoginForm.ts`, replace the unconditional invite requirement
  (`:669-673`, `validateForm` at `:636`) with mode-aware validation driven by the
  store: `invite` requires a code (today's behaviour); `open` and `approval`
  submit without one; `closed` disables the register control and states why.
  For `approval`, show the pending-approval notice up front, not only after a 202. Keep the `pending_approval` branch (`main.ts:670-678`) as the
  authoritative post-submit state. When `server-info` is unavailable (older
  server, failed read), fall back to today's invite-required form — never
  silently widen registration.
- **Why:** the outcome's first clause; the mode is knowable only from the new
  field, which is why Task 1 precedes this.
- **Validate:** `connect-page.test.ts` and `register-flow.spec.ts` green, with a
  new case per mode (including `closed` refusing and `approval` showing the
  notice). Commit.

### Task 4: Recovery kit — enrol, show once, status

- **Action:** `api.enrolRecoveryKit(password, kitSecret?)` (`POST /users/me/recovery-kit`)
  and `api.getRecoveryKitStatus()` (`GET /users/me/recovery-kit`), shaped from
  `recovery_handler.go:23-33`; a recovery-kit section in `AccountTab.ts` beside
  the TOTP section (`:1215`): enrol with password confirmation, render the
  secret once with copy (the `buildTotpConfirmArea` display-once pattern at
  `:530-616`), and an enrolled/used status badge.
- **Gotcha:** the kit secret is the account's recovery root — never log it,
  never write it to `localStorage`, and clear it from the DOM once the user
  leaves the section. It is shown once by the server; the client must not
  pretend otherwise.
- **Validate:** `totp-settings.test.ts` and `settings-overlay.test.ts` gain kit
  cases; a planted-secret assertion proves it is not persisted. Commit.

### Task 5: Account recovery end to end, including emergency codes at login

- **Action:**
  1. `api.recoverAccount(username, kitSecret, newPassword)` (`POST /auth/recover`,
     shape `recovery_handler.go:35-42`); an "Account recovery" entry on the
     connect page that collects the three fields and, on success, signs the
     returned session in exactly as `onLogin` does.
  2. Widen the login 2FA box (`LoginForm.ts:741`) to accept the emergency-code
     shape as well as `^\d{6}$`. The server already routes by shape on the same
     route (`auth.go:697,716`), so this is a validation fix, not a second
     request.
- **Why:** the outcome's second clause; the server half is done (`prd.md:287-290`).
- **Gotcha:** a recovery code is single-use and the login overlay's re-entrancy
  guard must stay (`LoginForm.ts:729-745`); a wrong code must not clear the
  partial token.
- **Validate:** new cases in `login-form-totp-*.test.ts` for a recovery-shaped
  code; a connect-page test for the recover flow. Commit.

### Task 6: Regenerate emergency recovery codes

- **Action:** `api.regenerateRecoveryCodes(password)`
  (`POST /users/me/totp/recovery-codes`, handler `totp_handler.go:97`), and a
  password-confirmed button in the TOTP section that replaces and once-shows the
  set, reusing the display-once area.
- **Validate:** `totp-settings.test.ts` green with a regenerate case; the old
  set is not retained client-side. Commit.

### Task 7: Deletion discloses retention

- **Action:** the delete section (`AccountTab.ts:947-1083`) renders the retention
  sentence from the `server-info` store: the server-default message window
  (`0` = kept indefinitely; otherwise `N` days) and that attachments are
  removed with their messages (`Server/db/erasure.go:362`). Keep the existing
  immediate, irreversible warning (`:992`) — the server erases immediately, so
  the copy must not imply a grace window. When `server-info` is unavailable,
  state only what is certain ("deleted immediately and permanently") rather than
  inventing a window.
- **Why:** the outcome's third clause; today the only copy is at
  `AccountTab.ts:992`.
- **Validate:** `settings-overlay.test.ts` delete cases gain retention
  assertions; observed red with the store value ignored. Commit.

### Task 8: Local support-bundle export (decision 7, Open Question 2)

- **Action:** per Open Question 2's resolution, add:
  1. `platform/contracts/logFiles.ts` + `desktop/logFiles.ts`: a `readAll()`
     returning the persisted `{name, bytes}` set (the capability already allows
     `fs:allow-read-text-file` on `$APPLOG/**`, `capabilities/default.json:104-109`).
  2. `lib/supportBundle.ts`: assemble the bundle — the rotating log files, the
     connection-diagnostics text (`connectionDiagnostics.ts`/the LogsTab
     `getSessionDebugInfo` JSON at `LogsTab.ts:288-335`), and an **allowlisted**
     settings JSON (never a denylist): the `owncord:settings:` prefs
     (`preferences.ts:16`) plus the profile list. Credentials live in the OS
     keychain (`desktop.credentials`) and are never read into the bundle.
  3. A save-dialog write through the existing `FileSaver` (`fileSave.ts:6-11`),
     reached from a button in the Logs tab beside "Copy Diagnostics".
  4. If Open Question 2 chooses Rust: one `#[tauri::command]` that zips the
     entries using the already-locked `zip` crate (transitive via
     `tauri-plugin-updater`), registered in `lib.rs`'s `generate_handler!`; then
     recount `platform-contracts-counts.test.ts:57-59` and
     `platform-contracts.md:59-61` in **this** commit.
- **Gotcha:** the bundle must contain **no** token, password, kit secret,
  recovery code or TOTP secret. Mirror the server bundle's enumerated-contents
  rule (`docs/architecture/diagnostics.md:151-197`, forbidden classes) and ship
  a planted-secret negative control.
- **Validate:** `support-bundle.test.ts` green, including the planted-secret
  test; the counts test green; `npm --prefix Client run typecheck`. Commit.

### Task 9: The e2e scenario, docs and the final gate (decision 8)

- **Action:** add **one** mocked Playwright scenario (`decision 8`, `prd.md:390`)
  — `Client/tests/e2e/recovery-flow.spec.ts` — driving the recovery path through
  the existing mock harness (`helpers.ts:443-479`), plus a smoke-config entry.
  Record the new fields in `docs/api.md`'s hand-written table (Task 1) if that
  did not land with the server commit. Do **not** touch the PRD.
- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run typecheck:e2e
  npm --prefix Client run lint
  ( cd Server && go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./... )
  ( cd Server && go test -race ./... )
  npm run check:docs
  npm run check:hygiene
  ```

  `npm run check:docs` / `check:hygiene` must be green because the plan and docs
  changed. Commit.

## Validation

```
npm --prefix Client test                                  # count not lower than Task 0's
npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
npm --prefix Client run typecheck:e2e                     # tests/e2e is excluded from the app graph
npm --prefix Client run lint                               # 0 warnings, cycles <= ceiling
( cd Server && go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./... )
( cd Server && go test -race ./... )
npm run check:docs && npm run check:hygiene
git grep -n "server-info" Client/src                        # the one new caller, no stray ones
# → then the ci-check skill; this PR touches Client/, Server/api+service and docs/,
#   so expect the client, browser and server legs
```

## Risks

| Risk                                                                                                   | Mitigation                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A new `server-info` field leaks build identity (C-2)                                                   | Neither field is version/build/commit; `TestAPIV1ServerInfoOmitsVersion` (`router_test.go:226`) stays green and the posture reason moves with it |
| The two server fields are added but silently never read by the client                                  | Tasks 2–3/7 consume them; the e2e and unit cases would fail if the field were absent                                                             |
| The support bundle carries a secret (token, kit secret, recovery code, TOTP seed)                      | Enumerated-contents allowlist, credentials never read, and a planted-secret negative control mirrors the server bundle's rule                    |
| The bundle implies an attachment-retention control that does not exist                                 | The disclosed window is the message window; attachments are stated as removed with their messages (Verify row 8)                                 |
| Sign-up widens registration on a server whose mode could not be read                                   | Fall back to today's invite-required form; never treat an unknown mode as `open`                                                                 |
| Collisions with B7-12/13/14 on `api.ts`, `types.ts`, `AccountTab.ts`, `LoginForm.ts`, the counts files | Named in Files to Change; resolve by keeping both edits and recounting pinned numbers from the tree                                              |
| The recovery kit secret is logged or persisted by the new UI                                           | Shown once, never stored, cleared from the DOM; a test asserts no persistence                                                                    |

## Out of scope

- **Browser/PWA/mobile surfaces** — B8, deferred post-beta (`prd.md:253-254`).
- **The server's admin support bundle** (`/admin/api/support-bundles/*`) — it
  exists and is untouched; decision 7 (`prd.md:389`) chooses a user-initiated
  local export instead.
- **The B4/B9 "client feature UX" note** — the B7 PRD allocates these flows to
  B7-15 (`prd.md:243-244,327`); this plan follows the PRD and re-opens nothing.
- **Protocol or schema changes.** None is needed: every endpoint already exists.
- **A new server retention control** (e.g. a separate attachment window) —
  decision 3 says server-default only; channel overrides stay admin-only.
- **Redesigning the settings or connect UI** beyond the copy and controls each
  flow needs.
- **B7-12's epoch/update-notice work, B7-14's session UI, B7-13's profile
  isolation** — named only as file collisions.

## Open questions for the owner

- [ ] **Q1 — the `retention` summary shape.** Decision 3 says "server-default
      message and attachment retention only" (`prd.md:385`), but no separate
      attachment window exists to report (Verify row 8): attachments are deleted
      with their messages, and orphan blobs are swept at a hard-coded 1 h
      (`maintenance.go:244`). Options: - **(a)** `{"messages_days": N}` (`0` = kept indefinitely), attachments
      documented as removed with their messages. **Recommended** — the only
      real window, and the client states the attachment invariant in copy. - **(b)** `{"messages_days": N, "attachments_days": N}`, mirrored. Risks
      implying two independent controls. - **(c)** `{"messages_days": N, "attachments": "with-messages"}`, the
      invariant made machine-readable. Self-describing, at the cost of a
      one-value enum.
      The choice changes the response type, the client copy and the tests, not
      the server read.
- [ ] **Q2 — how the bundle is zipped.** Decision 7 names "a zip"
      (`prd.md:389`); no zip exists in the client (Verify row 16). Options: - **(a)** one Rust `#[tauri::command]` using the `zip` crate already in
      `Cargo.lock` via `tauri-plugin-updater` (adds a handler → the counts
      test/doc move), the renderer supplying the entries. **Recommended** —
      zip is a binary format, the crate is already compiled in, and a
      hand-rolled writer is more code to own and get wrong. - **(b)** a small store-only zip writer in TypeScript over the existing
      `FileSaver` — no new command, contract or count, but ~60 lines of
      format code plus tests to own.
      Either way `LogFiles` gains `readAll()`.

## Acceptance

- [ ] `GET /api/v1/server-info` returns `registration_mode` (the live mode, or
      the service's fail-closed default) and a `retention` summary, with a test
      that observes each; decisions 2 and 3 followed
- [ ] `docs/api.md`'s field table, `auth_posture_test.go`'s reason string and
      `TestAPIV1ServerInfoOmitsVersion` are all consistent with the new fields
- [ ] Sign-up reflects `closed` / `invite` / `approval` / `open`; `approval`
      shows the pending state; an unreadable mode falls back to invite-required,
      never to open
- [ ] Recovery works end to end from the client: kit enrol + status, the
      `/auth/recover` flow, and the login-time 2FA box accepts an emergency code
      as the server already does; emergency codes can be regenerated
- [ ] Account deletion discloses the server-default retention window and that
      attachments are removed with their messages, and stays honest when
      `server-info` is unavailable
- [ ] A user exports a local support bundle (logs + connection diagnostics +
      allowlisted settings) through the save dialog, with no server call and no
      secret in it; a planted-secret test is green
- [ ] One mocked e2e scenario for the recovery path (decision 8)
- [ ] If a Rust command was added, the counts test and
      `platform-contracts.md` were recounted in the same commit
- [ ] No new `@tauri-apps` import outside `platform/desktop/`; no loosened
      assertion; cycle ceiling not raised; test count not lower than Task 0's
- [ ] `npm run check:docs`, `npm run check:hygiene` and the `ci-check` skill
      green; the PRD, other plans and the register were not edited
