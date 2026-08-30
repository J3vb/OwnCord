# B3 — Strengthen server architecture and permanent guardrails

**Drafted:** 2026-08-29  
**Base commit:** `bf7b886d` (`dev`, post-PR #1445); HP-2 accepted 2026-08-29
([hp-2-scorecard-2026-08-29.md](hp-2-scorecard-2026-08-29.md)) — claims
verified at `bf7b886d`  
**Status:** in progress — plan merged 2026-08-29 (PR #1447 = `ad4defc2`);
B3-0 merged 2026-08-29 (PR #1448 = `d383d8c7`; closes entry-gate item 3);
B3-1 merged 2026-08-29 (PR #1449 = `71d867cb`); B3-2 merged 2026-08-30
(PR #1450 = `75d64dd4`); B3-9 in progress 2026-08-30.
Update this line, not only the step table, when a step lands.

Primary inputs:

- [beta roadmap](repo-health-roadmap-2026-08-23.md), B3 section (17
  workstreams) and HP-3
- [layout-refactor supplement](developer-experience-layout-refactor-2026-08-29.md),
  Phases 1–3, "Pull-request and commit strategy", Phase 8, "First actionable
  slice" — bound into the roadmap as B3 workstream 17
- [bug-detection-improvements.md](bug-detection-improvements.md), Tier 3 —
  the design behind workstreams 2 and 3 (roadmap workstream 13)
- [HP-2 scorecard](hp-2-scorecard-2026-08-29.md), "Open items carried past
  B2" and question 5's residue table
- [issue register](repo-health-issue-register-2026-08-23.md) — every row
  tagged `B3`: S-03, S-04, S-06, S-08, S-09, S-10, S-11, OC-0323, OC-0345,
  OC-0346 (S-12 closed in B2-5)

B3 has no primary product requirement. It is the engineering-enabling phase
every later server phase stands on: the server must stop mixing transport,
domain and persistence before B4–B6 add identity, moderation and operations
surface to it.

## Steps at a glance

| Step     | What                                                                                                                               | Size     | Parallel with                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| **B3-0** | Boundary inventory: every upper-layer `db` import with a disposition; hub lifecycle; before-graph — **DONE 2026-08-29 (PR #1448)** | 1–2 days | B3-6, B3-7                                                       |
| **B3-1** | Auth characterization tests — enumeration, sentinels, sessions, TOTP, rate limits, failure paths — **DONE 2026-08-29 (PR #1449)**  | 1 day    | B3-6, B3-7                                                       |
| **B3-2** | The auth vertical slice (S-10): route → `service.AuthService` → `db`, behaviour-neutral — **DONE 2026-08-30 (PR #1450)**           | 2–3 days | B3-6, B3-7                                                       |
| **HP-3** | First vertical-slice review — scorecard                                                                                            | —        | —                                                                |
| **B3-3** | Lifecycle extraction: `main.go` → `internal/app/` with one composite close contract                                                | 1–2 days | B3-4                                                             |
| **B3-4** | Hub constructor options (S-11): required collaborators validated at construction                                                   | 1 day    | after B3-3                                                       |
| **B3-5** | `ws` in-package split (S-08): responsibilities into named files, pure moves + adjacent rewrites                                    | 2–3 days | after B3-3/B3-4                                                  |
| **B3-6** | Guardrails: coverage floor (S-06), hub simulation + fault transport + fuzz seeds, benchmarks, rules                                | 3–4 days | B3-0..B3-2                                                       |
| **B3-7** | Alpha-shaped test dataset: seed profile + anonymised `v1.2.0-alpha.4` snapshot                                                     | 1–2 days | B3-0..B3-2                                                       |
| **B3-8** | Remaining domain families behind services (S-09), one PR each; S-03/S-04 fold into the channel family                              | spread   | after HP-3, per-family                                           |
| **B3-9** | The B3-tagged findings: OC-0323, OC-0345, OC-0346 + B3-1's OC-0376, OC-0377, OC-0378 (test-first, `bughunt-fix` shape)             | 1 day    | OC-0345/0346: any; OC-0323: with B3-8; OC-0376..0378: after B3-2 |

Order: B3-0 → B3-1 → B3-2 → **HP-3** → B3-3 → B3-4 → B3-5 → B3-8. B3-6, B3-7
and B3-9 run beside the slice (roadmap "Safe parallelism": guardrail tooling
and baseline measurement may run while the first vertical slice is prepared)
provided they do not touch `Server/api/auth_handler.go`, `Server/auth/` or
`Server/service/` — B3-6's hub simulation lives in `ws`, B3-7 in `cmd/seed`.
After HP-3, families in B3-8 proceed in parallel only when they share no
migration, predicate or hub lifecycle ownership.

## Entry gate

| Condition                                                       | State 2026-08-29                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2 contracts are frozen and covered by compatibility tests      | **Met.** HP-2 accepted 2026-08-29; `TestEpoch1Fixtures`, `TestAuth_ProtocolEpoch`, the three `TestAbsenceContract_*`, two predicate parity tables — all under the required `Server Build & Test` check. |
| Server baseline, race, deadlock and security tests are green    | **Met.** #1445 = `bf7b886d`: both `Server Build & Test` jobs green (four tag variants, `-race`, `-tags deadlock ./ws/`, lint); zero B2-owned security rows open (HP-2 condition 7).                     |
| Hotspots and direct database call sites have an owned inventory | **B3-0.** Does not exist. The layout-refactor supplement counts them (44 files) but assigns no dispositions; the count is re-measured below and is already off by one.                                  |

## Verify before you implement

Every claim the roadmap's B3 section and the supplement rest on, re-tested
against `bf7b886d`. Commands are the ones B3-0 automates.

| Claim                                                                        | Verdict                   | What it means for the work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 44 production files in `ws`/`admin`/`api` import `db` (17/16/11)             | **Confirmed, 45**         | `ws` 17, `admin` 16, `api` **12** (`grep -l '"github.com/J3vb/OwnCord/Server/db"'` over non-test files). `service` imports it from 16 of 18 files — expected, it is the layer that should. `auth` from 2 of 10. B3-0 lists every file, not the count.                                                                                                                                                                                                                                                                                               |
| `main.go` exceeds 1,000 lines and owns twelve responsibilities               | **Confirmed**             | 1,019 lines. B3-3 moves the wiring into `internal/app/`; `main.go` stays the `go build .` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `hub_broadcast.go`, `serve.go`, `hub.go` are the coordination hotspots       | **Confirmed**             | 1,032 / 990 / 819 lines; `router.go` 721, `voice_join.go` 680. `ws` is 45 production files, 12,738 lines. B3-5 splits inside the package — the supplement's rule ("keep `ws` one package while its lock invariants need shared private state") stands.                                                                                                                                                                                                                                                                                              |
| Hub wiring uses post-construction setters (S-11)                             | **Confirmed, 7**          | `SetEventPersister`, `SetEventStore`, `SetPluginRegistry`, `SetPluginEventSink` (`hub_events.go`), `SetLiveKit`, `SetLiveKitProcess` (`hub_livekit.go`), `SetPendingVoiceModFlags` (`voice_moderation.go:599`). Called from two places: `api/router.go` (`NewHub` at `:106`, plugin and LiveKit setters `:325-360`) and `main.go:453-454` (persister, event store) — so construction has two owners today, which is why B3-4 follows B3-3. B3-4 decides for each: required (constructor option, validated) or genuinely replaceable (setter stays). |
| Auth routes consume raw database ownership (S-10)                            | **Confirmed**             | `api/auth_handler.go` (786 lines) takes `*db.DB` in `MountAuthRoutes`, `handleRegister`, `handleLogin`, `loginAuthenticate`, `handleLogout`, `handleDeleteAccount`, `issueSession`, `isRequire2FAEnabled`, `isRegistrationOpen`, `getBooleanSetting`; 26 `db.` references. `totp_handler.go` 475 lines, same shape. No `service/auth.go` exists.                                                                                                                                                                                                    |
| A useful service seam exists but does not own all use cases                  | **Confirmed**             | `Server/service/` has 18 production files (block, channel, dm, emoji, invite, mentions, message\*, moderation, permission, role, user). Nothing for auth, sessions, TOTP, uploads, settings, audit or plugins.                                                                                                                                                                                                                                                                                                                                      |
| Coverage is 74.6% with no floor (S-06)                                       | **Confirmed**             | `ci.yml:73` runs `go test -race -coverprofile=coverage.out -cover` and uploads the profile (`:91-96`); nothing reads it. B0 measured 74.6% (`b0-baseline-2026-08-25.md:46`). B3-6 adds the floor at exactly that number.                                                                                                                                                                                                                                                                                                                            |
| Tier 3 (hub simulation, fault transport, model tests) is designed, not built | **Confirmed**             | `bug-detection-improvements.md` §Tier 3; `make fuzz` (Tier 1a) exists (`Server/Makefile:5`). No `ws` simulation test, no fault-injecting transport, no `fc.commands` model test in `Client/tests/unit/*.property.test.ts`. B3-6 builds 3b and 3c; 3a is a client test file and is included (it touches no client structure — B7's rule is about `src/`).                                                                                                                                                                                            |
| `Server/invariants` has rules to extend                                      | **Confirmed, one rule**   | `Rules = []Rule{syncutilLocks}` (`invariants.go:64`). The `seq-enqueue-paired` rule the 2026-08-18 measurement recorded as "adopted narrowed" was never merged under that name — `git log -S seq-enqueue-paired` is empty at `bf7b886d` — so B3-6 item 7 adds `authz-chokepoint` as the registry's second rule and does not build on a sibling that does not exist. `authz-chokepoint` gets HP-2 question 5's residue as its allowlist.                                                                                                             |
| The seed tool has no alpha-shaped profile (workstream 12)                    | **Confirmed**             | `Server/cmd/seed/main.go` (372 lines) takes `-db` and `-confirm-dev` only. No snapshot exists anywhere in the tree. B3-7 builds both.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Docker smoke never runs on `dev` (workstream 16)                             | **Confirmed**             | `Server Docker Build (verify)` skips on every `dev` PR (HP-2 gate run; #1444, #1445 both `skipping`). B3-6 adds a `schedule:` trigger to `ci.yml` scoped to that job.                                                                                                                                                                                                                                                                                                                                                                               |
| Permission rules are mirrored (workstream 7)                                 | **Refuted, done in B2-5** | Six predicates in `Server/permissions/predicates.go`, parity tables in `service/` and `ws/`; residue classified in HP-2 question 5. Workstream 7 reduces to the `authz-chokepoint` rule (workstream 15) and to keeping the residue table current when B3-8 moves families.                                                                                                                                                                                                                                                                          |
| Register rows OC-0323, OC-0345, OC-0346 are open                             | **Confirmed**             | All three `open`, low, in `.superpowers/findings-ledger.json`; B3/B5, B3/B4, B3/B6 tags. Roadmap rule 2: B3 cannot exit with any of them open unless re-tagged with a written reason in HP-3.                                                                                                                                                                                                                                                                                                                                                       |

Net effect: workstream 7 is already done; the inventory (entry-gate item 3)
is the first real work; the auth slice is exactly the size S-10 says; `api`
has one more `db` importer than the supplement counted; one invariant rule
believed adopted is absent and must be traced before B3-6 counts on it.

## B3-0 — Boundary inventory

Layout-refactor Phase 1, items 1–4 and 6. Closes entry-gate item 3 and is the
"boundary and database-call inventory with dispositions" the B3 exit gate
requires.

1. **Database-call inventory.** New `docs/architecture/server-boundaries.md`,
   linked from `docs/architecture/server.md` §D2 and `docs/architecture/README.md`.
   One row per production file outside `Server/db` and `Server/service` that
   imports `db` (45 today + `main.go` + `plugin/`), listing the `db` symbols it
   uses and **one disposition** from the supplement's four:
   `move` (behind a service), `adapter` (retained transport adapter, e.g. a
   handler that only decodes a request and calls one query), `boundary`
   (explicit transaction/composition, e.g. `main.go` opening the database),
   `remove`. The command that produces the file list is recorded in the
   document so the inventory can be re-run:
   ```bash
   cd Server && git grep -l '"github.com/J3vb/OwnCord/Server/db"' -- '*.go' ':!*_test.go' ':!db/*' ':!service/*'
   ```
   Every `move` row names its target family (auth, channel, message, role,
   invite, upload, settings, audit, plugin, admin-UI) so B3-8 is a list, not a
   discovery.
2. **Hub lifecycle inventory.** Same document, second section: the seven
   setters with what calls each and when (`main.go` line), which are required
   before `Run` and which are genuinely replaceable; every lock in `Hub` with
   its owner and the order the `-tags deadlock` pass has proven; the
   start/stop/drain sequence in `main.go` as it exists today, including every
   `defer` and every place a failure returns early. This is B3-3's and B3-4's
   input.
3. **Before-state dependency graph for the auth slice.** `go list -deps` and
   `go mod graph` are module-level; the file-level graph the supplement asks
   for is produced with a small script in `docs/plans/` (like
   `hp-2-trust-model-anchors.py`): for each of `api/auth_handler.go`,
   `api/totp_handler.go`, `auth/*.go`, the imports and the `db.*` symbols
   called. Committed as a table, not an image. Re-run after B3-2 for the
   after-state.
4. **Narrowest mechanical check.** An `invariants` rule `db-import-boundary`
   that fails on any **new** production `db` importer outside `db/`,
   `service/`, `main.go` and the files the inventory marks `adapter` or
   `boundary` — the inventory's rows are the allowlist, checked in as a Go
   slice beside the rule so the document and the gate cannot drift. RED
   proven by adding an import to a file not on the list. This is Phase 1 item
   6 and the exit-gate's "checks can detect a newly introduced violation
   without false positives".
5. Refreshing the **client** baselines (Phase 1 item 5) is **not** B3 — it is
   B7's entry work and is recorded as such here so nobody looks for it.

Exit: every `db` importer has a disposition; the rule is green on HEAD and
red on a synthetic violation; the graph table exists for the three auth
files. One PR.

**Evidence, 2026-08-29** — branch `feat/b3-0-boundary-inventory` from `dev`
`ad4defc2`; PR #1448 to `dev`, squash-merged 2026-08-29 as `d383d8c7`.
Closes entry-gate item 3.

- **Inventory:** `docs/architecture/server-boundaries.md`, linked from
  `docs/architecture/server.md` §D2 and `docs/architecture/README.md`. The
  table is generated by `Server/cmd/dbinventory` (syntactic, `go/ast`; no
  `x/tools` dependency added) and the rows live as `DBImportAllow` in
  `Server/invariants/db_import_boundary.go`, so the document and the gate
  cannot drift: the tool prints each row's disposition from the map and exits
  1 on an unlisted importer or a stale row. Measured: **51 files** import
  `db` outside `db/` and `service/` (ws 17, admin 16, api 12, auth 2, root 2,
  cmd/seed 1, plugin 1) — the supplement's 44 counted three packages, and
  `api` is 12, not 11. **14 are type-only** (they use `db.User`-style shapes
  and never persist) — a distinction the `git grep` count could not make.
  Dispositions: **move 28** (auth 9, channel 6, settings-ops 4, voice 3,
  upload 2, user 2, role 1, connection 1), **adapter 17**, **boundary 6**,
  remove 0. The regex the plan sketched over-counted: `db.` in comments
  matched, and `*db.DB` method calls (`database.GetUserByID`) do not contain
  `db.` at all — the AST walk resolves `*db.DB` receivers (params, fields,
  `db.Open*` assignments) instead.
- **Rule:** `db-import-boundary`, the registry's second rule. Unit RED:
  `TestDBImportBoundary` "unlisted api file importing db is flagged" and the
  aliased-import case. Real-tree RED, B2-7 style — a probe `api/zz_probe.go`
  importing `db`:

  ```
  --- FAIL: TestServerInvariants (0.04s)
      invariants_test.go:20: api/zz_probe.go:3: [db-import-boundary] imports Server/db above the domain layer without an inventory row; route the call through a service (see docs/architecture/server-boundaries.md), or add a DBImportAllow entry with a disposition and reason
  ```

  Probe deleted (`git status` clean), `go test ./invariants/` green.
  `TestDBImportAllowIsLive` is the other direction: every row must name a
  file that exists and still imports `db`, carry a reason, and pair `move`
  with a family — so the list can only shrink honestly.

- **Hub lifecycle:** seven setters with declaration and call site — `NewHub`
  is called in `api/router.go:106`, four setters from the router and two
  from `main.go:453-454`; four are required before `Run` (LiveKit signer,
  persister, event store — and `SetLiveKit` fails voice silently when
  absent), three are genuinely optional. Five `syncutil` locks listed with
  what each guards; **the lock order is not written down anywhere** — only
  the `-tags deadlock` pass proves it — so B3-5 records it in `hub.go` before
  its first move. The `run()` start order and its twelve-entry defer stack
  are tabulated with the three ordering facts B3-3's composite close must
  keep (audit writer after `database.Close`, persistence before it,
  `GracefulStop` on early return).
- **Auth before-graph:** `api/auth_handler.go` imports `auth`, `db`,
  `permissions`, `service` and calls 8 distinct `*db.DB` methods;
  `totp_handler.go` imports `auth`, `db` and calls 3; `auth/` itself is a
  leaf (types only). Eleven methods is the upper bound of B3-2's interface.
- Phase 1 item 5 (client baselines) recorded as B7 entry work, not done here.
- Gates before commit: `check:docs`, `check:hygiene`; from `Server/` the four
  build-tag variants, `go vet`, `go test -race ./...`, `go test -tags deadlock
./ws/`, `golangci-lint run` (the tool's first version tripped `cyclop` at
  30 and the deprecated `parser.ParseDir` — split into helpers, `os.ReadDir`
  - `ParseFile`).

## B3-1 — Auth characterization tests

Layout-refactor Phase 2 item 1 and the supplement's PR strategy step 1
("add or tighten characterization/contract tests" **before** any move). Lands
before B3-2 touches a line of `auth_handler.go`, in its own PR, so the slice's
diff is reviewable against a frozen behaviour set.

1. `Server/api/auth_characterization_test.go`: table tests over the mounted
   router (the `setupRouter`-style harness B2-7's absence test uses) pinning,
   per route (`/register`, `/login`, `/logout`, `/me`, `/account` DELETE, the
   TOTP routes):
   - **enumeration defence** — unknown user vs wrong password vs disabled
     account vs locked-out account return byte-identical status, body and
     timing class (the existing constant-time guard in `auth/` is asserted, not
     re-implemented);
   - **sentinel mapping** — each `db` sentinel (`ErrNotFound`, unique
     violation, `ErrDisabled`, …) to its HTTP status and public message;
   - **session issue/revoke** — cookie/bearer shape, `issueSession` fields,
     logout revokes server-side (the register's admin-logout row is B4's, but
     the user-path behaviour is pinned here);
   - **TOTP** — enrol, verify, partial-login store, `require_2fa` setting;
   - **rate limits** — the `auth.RateLimiter` paths and the persisted
     lockout;
   - **failure paths** — a database that returns an error (not a sentinel)
     yields 500/503 with no enumeration leak, never 401/403.
2. Every row is written against **today's** behaviour. A row that reveals a
   defect is not fixed here: it is pinned as-is with a `// ponytail:`-free,
   plain `// known:` comment and a ledger entry, and fixed in B3-9 or the
   owning phase — the slice must move behaviour, not change it.
3. Coverage of `api/auth_handler.go` and `api/totp_handler.go` after this step
   is recorded in the evidence block (`go test -coverprofile` filtered to the
   two files) so B3-2's "behaviour-neutral" claim has a number behind it.

Exit: the characterization file is green on HEAD; its row count and the two
files' coverage are in the evidence block. One PR.

**Evidence, 2026-08-29** — branch `feat/b3-1-auth-characterization` from `dev`
`d383d8c7`; PR #1449 to `dev`, squash-merged 2026-08-29 as `71d867cb`.

- **Inventory.** The three existing files hold **85** tests (`auth_handler_test.go`
  61, `totp_handler_test.go` 22, `auth_handler_delete_broadcast_test.go` 2 —
  the plan's "82" was a miscount). Route × property, with the test that pins
  it today or `GAP` and the `TestAuthCharacterization_*` row that fills it.
  Two of the plan's words do not exist in the code and are read as their
  nearest state: there is no "disabled" account (banned is the analogue — a
  banned user with the right password is 403 by design, `TestLogin_BannedUser`,
  and with the wrong password is the generic 401), and there is no
  `db.ErrDisabled` (the sentinels the slice sees are `ErrNotFound`, the UNIQUE
  violation, `ErrLastAdmin`, and `(nil, nil)` for a missing user).

  | Route                         | Property                                                                                        | Pinned today by                                                                                                                                                                                                                                                                     | GAP → filled by                                                                                                                                                                                                                                         |
  | ----------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `POST /register`              | enumeration: taken username vs unknown/expired invite share one body                            | `TestRegister_ErrorNeverRevealUsername` (substring only)                                                                                                                                                                                                                            | GAP → `RegisterRejectionsAreIndistinguishable` (byte-identical 400 body, invite `use_count` stays 0)                                                                                                                                                    |
  | `POST /register`              | sentinels: `ErrNotFound` (invite) → 400, UNIQUE → 400, other → 500                              | `TestRegister_InvalidInvite`, `_InviteUsedUp`, `_ExpiredInvite`, `_DuplicateUsername_DoesNotConsumeInvite` (status only)                                                                                                                                                            | GAP (other → 500, invite not consumed) → `RegisterPolicyAndFailurePaths/user insert fails`                                                                                                                                                              |
  | `POST /register`              | policy: `registration_open`, `require_2fa`, unparsable value, missing rows → defaults           | `TestRegister_RegistrationClosed` (403)                                                                                                                                                                                                                                             | GAP → `RegisterPolicyAndFailurePaths/{settings unreadable, registration_open unparsable, require_2fa unparsable, settings rows absent, require_2fa true, registration closed}`                                                                          |
  | `POST /register`              | session issue: token shape, `user` shape, session row device/IP                                 | `TestRegister_Success` (token + user present), `TestRegister_UsesTrustedForwardedIP` (session IP)                                                                                                                                                                                   | GAP (exact key set, 64-hex token, device truncated at 512) → `SessionShape/register`                                                                                                                                                                    |
  | `POST /register`              | failure path: session insert fails after the account commit                                     | —                                                                                                                                                                                                                                                                                   | GAP → `RegisterPolicyAndFailurePaths/session insert fails` — `// known:` OC-0376 (500, user committed, invite burned)                                                                                                                                   |
  | `POST /register`              | rate limit: 3/min per IP                                                                        | `TestRegister_RateLimit`                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                       |
  | `POST /register`              | input: oversized username before sanitizing, HTML escaping, weak password, missing fields       | `TestRegister_OversizedUsernameRejectedBeforeSanitizing`, `_UsernameNotHTMLEscaped`, `_WeakPassword`, `_MissingFields`                                                                                                                                                              | —                                                                                                                                                                                                                                                       |
  | `POST /login`                 | enumeration: unknown vs wrong password vs banned+wrong vs case variant → identical 401          | `TestLogin_UnknownUser`, `_WrongPassword` (status), `_GenericErrorOnBadCredentials` (substring)                                                                                                                                                                                     | GAP → `LoginRejectionsAreIndistinguishable` (status, body, Content-Type and limiter state all equal)                                                                                                                                                    |
  | `POST /login`                 | timing class: the dummy bcrypt compare on the unknown-user path                                 | `auth/password_test.go` `TestCheckPassword_EmptyHashTimingResistance` asserts the return value only; the api suite hashes at `bcrypt.MinCost`, where the compare is unmeasurable                                                                                                    | GAP → `UnknownUserTakesAsLongAsWrongPassword` (cost 10 inside the row, median of 3, unknown ≥ ½ wrong)                                                                                                                                                  |
  | `POST /login`                 | sentinels: `(nil, nil)` → 401; wrapped DB error → 500 with no attempt recorded                  | —                                                                                                                                                                                                                                                                                   | GAP → `LoginFailurePaths/user lookup fails` (500 `login temporarily unavailable`, limiter holds only the route window)                                                                                                                                  |
  | `POST /login`                 | policy: `require_2fa` unparsable → 500; case-insensitive parse; enrolled + required → challenge | `TestLogin_Require2FASettingRejectsUsersWithoutEnrollment` (403)                                                                                                                                                                                                                    | GAP → `LoginFailurePaths/{policy unreadable after a correct password, policy unreadable with a wrong password, require_2fa unparsable, require_2fa parses case-insensitively, require_2fa true and enrolled}`                                           |
  | `POST /login`                 | session issue: one row, device = UA truncated to 512, IP, token 64 hex, exact `user` key set    | `TestLogin_Success` (token present)                                                                                                                                                                                                                                                 | GAP → `SessionShape/login`, `LoginFailurePaths/session insert fails` (500)                                                                                                                                                                              |
  | `POST /login`                 | banned with the right password → 403                                                            | `TestLogin_BannedUser`                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                       |
  | `POST /login`                 | rate limits: per-username lockout (cross-IP, case-folded, concurrent burst, reset on success)   | `TestLogin_UsernameLockoutAcrossDifferentIPs`, `_UsernameLockoutBlocksCorrectPasswordFromFreshIP`, `_UsernameLockoutIgnoresCasing`, `_ConcurrentBurstCannotExceedUsernameBudget`, `_NineFailuresThenCorrectPasswordSucceeds`, `_SuccessResetsUsernameFailureCounter`                | —                                                                                                                                                                                                                                                       |
  | `POST /login`                 | rate limits: route 5/min per IP                                                                 | — (`TestLogin_LockoutUsesTrustedForwardedIP` only proves a second client is not locked)                                                                                                                                                                                             | GAP → `RouteRateLimits/login` (6th request 429 `Retry-After: 60`). The deeper `login_lock:`+ip lockout (10 failures) sits behind this 5/min window inside one minute and is not reachable over HTTP in a test; the limiter itself is covered in `auth/` |
  | `POST /login`                 | rate limits: persisted lockout                                                                  | `auth/ratelimit_persist_test.go`, `db/lockout_queries_test.go` (`NewPersistentRateLimiter`; the api suite mounts the in-memory `NewRateLimiter`)                                                                                                                                    | —                                                                                                                                                                                                                                                       |
  | `POST /login`                 | input: password not trimmed, username trimmed, oversized username before keys, missing fields   | `TestLogin_PasswordWith*Space*`, `_UsernameIsStillTrimmed`, `_OversizedUsernameRejectedBeforeRateLimiterKey`, `_MissingFields`                                                                                                                                                      | —                                                                                                                                                                                                                                                       |
  | `POST /logout`                | revoke: session deleted server-side, second logout 401                                          | `TestLogout_Success`, `_SessionGoneAfterLogout`, `_NoAuth`, `_InvalidToken`                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                       |
  | `POST /logout`                | side effect: custom status cleared; clear failure is best-effort                                | —                                                                                                                                                                                                                                                                                   | GAP → `Logout/{clears the custom status, custom-status clear fails}`                                                                                                                                                                                    |
  | `POST /logout`                | failure path: session delete fails → 500, session survives                                      | —                                                                                                                                                                                                                                                                                   | GAP → `Logout/session delete fails`                                                                                                                                                                                                                     |
  | `GET /me`                     | shape and auth                                                                                  | `TestMe_Success`, `_ReturnsCorrectUserFields`, `_NoAuth`, `_InvalidToken`                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                       |
  | every authenticated route     | failure path: token resolution hits a DB error → 503, never 401                                 | `coverage_push_test.go` (middleware, one route outside the slice)                                                                                                                                                                                                                   | GAP → `TokenResolutionFaultIs503` (`/me`, `/logout`, `/account`, `/totp/enable`, `/totp/confirm`, `DELETE /users/me/totp`)                                                                                                                              |
  | `DELETE /account`             | sentinels: `ErrLastAdmin` → 403; other → 500 with the transaction rolled back                   | `TestDeleteAccount_LastAdmin`, `_Success` (anonymised, banned, session gone), `_BroadcastsMemberBan`, `_NoBroadcasterOmitted`                                                                                                                                                       | GAP (other → 500) → `DeleteAccountFailurePaths/purge fails` (user intact, session still answers `/me`)                                                                                                                                                  |
  | `DELETE /account`             | password confirmation, lockout after 3 failures, malformed body not counted                     | `TestDeleteAccount_MissingPassword`, `_WrongPassword`, `_LockoutAfterRepeatedFailures`, `_NoAuth`                                                                                                                                                                                   | GAP (exact bodies, limiter accounting) → `DeleteAccountFailurePaths/{malformed body, wrong password}`                                                                                                                                                   |
  | `DELETE /account`             | rate limit: route 5/min per IP                                                                  | —                                                                                                                                                                                                                                                                                   | GAP → `RouteRateLimits/delete account`                                                                                                                                                                                                                  |
  | `POST /verify-totp`           | partial-login store: challenge shape, consumed after 5 failures, replay, banned mid-window      | `TestLogin_RequiresTOTPChallenge`, `TestVerifyTotp_Success`, `_ConsumesChallengeAfterRepeatedFailures`, `TestVerifyTOTP_{InvalidCode, MissingToken, InvalidPartialToken, MalformedBody, ReplayProtection, BannedAfterPasswordStep}`, `TestLogin_UsernameLockoutBlocksTOTPChallenge` | —                                                                                                                                                                                                                                                       |
  | `POST /verify-totp`           | sentinels: secret removed → 401; undecryptable secret → 500                                     | —                                                                                                                                                                                                                                                                                   | GAP → `VerifyTOTPFailurePaths/{secret removed, secret encrypted under another key}`                                                                                                                                                                     |
  | `POST /verify-totp`           | failure path: user lookup DB error                                                              | —                                                                                                                                                                                                                                                                                   | GAP → `VerifyTOTPFailurePaths/user lookup fails` — `// known:` OC-0377 (401 today, 5xx by the rule)                                                                                                                                                     |
  | `POST /verify-totp`           | failure path: session insert fails                                                              | —                                                                                                                                                                                                                                                                                   | GAP → `VerifyTOTPFailurePaths/session insert fails` — `// known:` OC-0378 (500, challenge already consumed)                                                                                                                                             |
  | `POST /verify-totp`           | session issue: bound to the login request's device/IP, not the verify request's                 | —                                                                                                                                                                                                                                                                                   | GAP → `SessionShape/verify-totp`                                                                                                                                                                                                                        |
  | `POST /verify-totp`           | rate limits: per-user `totp_fail` cap (10, unscaled) across challenges; route 10/min per IP     | —                                                                                                                                                                                                                                                                                   | GAP → `VerifyTOTPFailurePaths/per-user failure cap spans challenges`, `RouteRateLimits/verify-totp`                                                                                                                                                     |
  | `POST /users/me/totp/enable`  | enrol: pending secret not persisted, password confirmation, unauthenticated                     | `TestEnableConfirmDisableTotp`, `TestTOTPManagement_RequiresPasswordConfirmation`, `TestEnableTOTP_{Success, WrongPassword, Unauthenticated}`                                                                                                                                       | GAP → `TOTPManagementFailurePaths/{enable while enrolled → 409, enable with malformed body, enable with empty password}`                                                                                                                                |
  | `POST /users/me/totp/confirm` | verify + persist, revoke other sessions, API-token principal, revoke failure → 200 + warning    | `TestConfirmTOTP_{Success, InvalidCode, InvalidCode_Handler, NoPendingSecret, NoPendingEnrollment, MissingPassword, WrongPassword, WrongPassword_Handler, NoAuth, APITokenPrincipal_RevokesAllSessions, RevokeFailureSurfacesWarning}`                                              | GAP (persist fails → 500) → `TOTPManagementFailurePaths/{confirm: secret persist fails, confirm with malformed body}`                                                                                                                                   |
  | `DELETE /users/me/totp`       | disable, `require_2fa` blocks, API-token principal, revoke failure → 200 + warning              | `TestDisableTOTP_{Success, WrongPassword, WrongPassword_Handler, Require2FABlocksDisable, BlockedByServerPolicy, NoAuth, Unauthenticated, APITokenPrincipal_RevokesAllSessions, RevokeFailureSurfacesWarning}`                                                                      | GAP → `TOTPManagementFailurePaths/{disable: policy unreadable → 500, disable: secret clear fails → 500, disable when not enrolled → 204, disable with an empty body → 400, disable with a malformed body → 400}`                                        |
  | the three TOTP routes         | rate limits: shared `pw_confirm` lockout (3 failures); shared `totp:` route window 5/min        | —                                                                                                                                                                                                                                                                                   | GAP → `TOTPManagementFailurePaths/password-confirmation lockout is shared`, `RouteRateLimits/totp management`                                                                                                                                           |

- Not injectable without a mock seam, left unpinned on purpose: `GetUserByID`
  failing _after_ the register commit (`handleRegister`, "registration
  succeeded but user fetch failed"), `auth.GenerateToken`/`HashPassword`
  failing (crypto/rand), and the partial-token TTL expiry (no clock on the
  store). B3-2's service interface is where a seam for these would go; they are
  not behaviour the slice moves.
- **Characterization file:** `Server/api/auth_characterization_test.go` —
  **12 tests, 44 table rows** (56 `PASS` lines under `-v`), green on HEAD and
  under `-race`. Fault injection is the database itself (`ALTER TABLE x RENAME
TO x_gone` for read faults, `RAISE(FAIL)` triggers for write faults), so no
  handler is mocked. Three `// known:` rows → ledger **OC-0376**, **OC-0377**,
  **OC-0378** (all `low`, open, B3-9). Because a pinning test is green by
  construction, three mutations stood in for RED: `401→500` in
  `totpChallengeSecret` (2 rows RED), `500→401` in `loginAuthenticate` (1 row
  RED), `503→401` in `AuthMiddleware` (1 test RED); tree restored.
- **Coverage** (`go test -coverprofile=cover.out ./api/` from `Server/`, statements, filtered to the two
  files — B3-2 must not drop it):

  | File                  | Before (`d383d8c7`) | After B3-1          |
  | --------------------- | ------------------- | ------------------- |
  | `api/auth_handler.go` | 198/254 = **78.0%** | 229/254 = **90.2%** |
  | `api/totp_handler.go` | 141/179 = **78.8%** | 163/179 = **91.1%** |
  | `api` package         | 83.5%               | 85.8%               |

  Functions still short of 100%: `handleRegister` 80.6% (the post-commit
  `GetUserByID` failure and `GenerateToken` failure, not injectable),
  `registerReadRequest`/`loginReadRequest` (invalid-username and
  password-strength branches are `auth/` tests), `handleMe` 66.7% (the
  no-principal branch is unreachable behind `AuthMiddleware`), `issueSession`
  83.3% (`GenerateToken` failure).

- **Pre-squash SHAs:** `659c8cbd` (B3-0 SHA recorded), `0905a942` (inventory
  table), `b7317d03` (characterization file + ledger + claim updates), `a0356ee1`
  (this coverage bullet); Codex rounds `7c38c2bd`, `bf49453c`, `8614603b` (head).
- Gates before every commit: `check:docs`, `check:hygiene`; from `Server/` the
  four build-tag variants, `go vet`, `go test -race ./...`, `go test -tags
deadlock ./ws/`, `golangci-lint run` (first run tripped `prealloc` and
  `modernize` on the timing row — fixed), `sqlc generate` and `genprotocol`
  drift checks.

## B3-2 — The auth vertical slice (S-10)

Layout-refactor Phase 2 items 2–6; the HP-3 subject. One PR, commits in the
supplement's order: boundary + rule, move one responsibility, mechanical
rewrite, remove old path — with B3-1's tests green after every commit.

1. **Interface beside the consumer.** `Server/api/auth_deps.go` declares the
   narrow interface the handlers need — nothing more than the calls the B3-0
   graph table shows them making (register, authenticate, issue/revoke
   session, read the two boolean settings, delete account, TOTP enrol/verify).
   Consumer-owned, per the supplement's dependency direction.
2. **`Server/service/auth.go`** implements it: `AuthService` constructed with
   `*db.DB`, the `auth.RateLimiter`, the partial-login store and the
   broadcaster the delete path needs. Orchestration moves here verbatim —
   the enumeration guard, the sentinel-to-domain-error mapping (`service`
   already has the `ErrPermissionDenied`-style sentinel pattern from B2-5;
   auth errors join it), the transaction intent. Persistence stays in `db`.
3. **Handlers become thin**: decode, call the interface, encode. `*db.DB`
   leaves every handler signature in `auth_handler.go` and `totp_handler.go`;
   `MountAuthRoutes` takes the interface. `main.go` constructs the service
   (B3-3 later moves that into `internal/app/`).
4. **Error semantics preserved at the boundary**: B3-1's sentinel-mapping rows
   are the proof; they do not change in this PR. If a mapping must change to
   be expressible through the service, that is a behaviour change and goes to
   a separate PR first (supplement: "Functional changes discovered during
   extraction belong in separate pull requests").
5. **After-state graph** — the B3-0 script re-run; `db-import-boundary`
   allowlist loses `api/auth_handler.go` and `api/totp_handler.go` in the same
   commit that removes their import, so the rule proves the move.
6. Evidence block records: pre-squash SHAs per commit, the before/after graph
   tables, `go test -race ./api/ ./service/ ./auth/`, the full server gate,
   and coverage of the two files before and after (must not drop).

Exit: HP-3.

**Evidence, 2026-08-30** — branch `feat/b3-2-auth-slice` from `dev`
`71d867cb`; PR #1450 to `dev`, merged 2026-08-30 as `75d64dd4`.

- **Pre-squash SHAs**, one per numbered item. For each, the characterization
  file was run against that exact tree in a detached worktree
  (`go test -count=1 -run TestAuthCharacterization ./api/`) and the frozen
  files (`auth_characterization_test.go`, `totp_handler_test.go`) diffed
  against `71d867cb`:

  | Commit      | Item                                                                                                                                          | Characterization | Frozen files vs `71d867cb` |
  | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------- |
  | `825b406f`  | B3-1's merge SHA recorded in this plan                                                                                                        | ok 1.860 s       | identical                  |
  | `448c50f6`  | 1 — `api/auth_deps.go`: the consumer-owned interface, and the input/result types it names in `service/auth.go`                                | ok 1.852 s       | identical                  |
  | `24ed138d`  | 2 — `service/auth.go`: orchestration moved verbatim, the `Err*` set; `auth/ratescale.go`                                                      | ok 1.854 s       | identical                  |
  | `fe1d11b8`  | 3 — thin handlers; `MountAuthRoutes(r, svc, requireAuth, limiter, proxies)`; `router.go` builds the service; two `DBImportAllow` rows deleted | ok 1.849 s       | identical (see wiring)     |
  | `3f0d24ec`  | 4 — after-state inventory and graph rows in `server-boundaries.md`                                                                            | ok 1.832 s       | identical                  |
  | this commit | 5 — this block                                                                                                                                | docs only        | —                          |

- **The interface.** Nine methods — `RegistrationPolicy`, `Register`,
  `Login`, `VerifyTOTP`, `Logout`, `DeleteAccount`, `EnableTOTP`,
  `ConfirmTOTP`, `DisableTOTP` — against the ten distinct `*db.DB` methods,
  two `db` functions and two `db` sentinels the handlers called at
  `71d867cb`. `RegistrationPolicy` is the ninth: two characterization rows
  pin `/register`'s 403 "before any credential is read" (a malformed body
  still receives the policy's 403), so that gate stays ahead of the body
  decode as its own call. `service.AuthService` is constructed with the
  `Store` (`*db.DB`), the shared `auth.RateLimiter`, the TOTP key and the
  `AuthBroadcaster`; it creates the partial-login, pending-TOTP and used-code
  stores itself with the fixed TTLs the route mount used to own.
- **Error semantics** (item 4): every refusal is a named `service.Err*` value
  whose `Error()` is the exact public message the handler wrote and whose
  category (`ErrRateLimited`, `ErrForbidden`, `ErrBadRequest`, `ErrConflict`,
  `ErrInternal`, plus the new `ErrUnauthorized` and `ErrInvalidInput`) the one
  `writeAuthError` switch maps to a status and code; two values carry their
  own code (`INVALID_CREDENTIALS`, `TOTP_ALREADY_ENABLED`). Thirty-one values,
  because the pre-slice handlers had thirty-one distinct refusal triples. No
  sentinel-mapping row changed.
- **Behaviour notes** — no row changed; listed because HP-3 Q1 asks:
  1. _Decode before gate on five routes._ At `71d867cb`, `DELETE /account`,
     the three TOTP-management routes and `/verify-totp` ran a gate (per-user
     lockout; already-enrolled; challenge lookup) before decoding the body. A
     thin handler decodes first and the service runs the same gates in the
     same order. Observable only for a _malformed_ body behind a gate:
     locked-out + malformed → 400 (was 429); enrolled + malformed enable →
     400 (was 409); unknown partial token + malformed verify body → 400 (was
     401). No frozen row exercises those; every well-formed request is
     byte-identical. `/register` kept its gate first (above).
  2. _One `AuthMiddleware` for the six authenticated auth routes._ The caller
     builds it once and passes it in; before, each `r.With(AuthMiddleware(database))`
     had its own `last_used` touch throttle. Fewer writes, same semantics.
  3. `confirmPassword` folds the three identical password-confirmation blocks
     of the TOTP routes into one method (verbatim otherwise; the accounting
     — a missing or wrong password counts, a correct one resets — is
     unchanged).
  4. The auth-slice limits left `api/constants.go` with the code that reads
     them; the shared `pw_confirm` budget is exported as `service.PwConfirm*`
     and `profile_handler.go` reads it there. The auth rate multiplier moved
     to `auth/ratescale.go` (`SetRateScale`, `ScaledLimit`) so the route
     mounts and the service's login accounting read one value; `api` keeps
     `setAuthRateScale`/`scaledAuthLimit` as wrappers, and
     `TestPerUserFailureCapsStayUnscaled` now pins `../service/auth.go`.
  5. `userResponse`/`toUserResponse` moved to `profile_handler.go` (the other
     consumer, which still imports `db`); `middleware.go` gained
     `principal(r)`, which hands the handlers the context's `*db.User` and
     `*db.Session` as `service.Principal`.
- **Test files changed** — wiring only (`git diff -U0 71d867cb fe1d11b8 -- '*_test.go'`):
  `auth_handler_test.go` (+1 import, the one mount line in
  `buildAuthRouterWithProxies`), `auth_handler_delete_broadcast_test.go` (+1
  import, two mount lines, one comment), `coverage_push_test.go` and
  `invite_handler_test.go` (one mount line each), `constants_test.go` (the
  scale tests follow the constant), `router_delete_account_broadcast_test.go`
  (comment and failure message), `invariants/db_import_boundary_test.go`
  (fixture path). `auth_characterization_test.go` and `totp_handler_test.go`:
  untouched. No assertion, row or expected value moved.
- **Graph tables:** [server-boundaries.md](../architecture/server-boundaries.md)
  §"Auth slice" — before at `ad4defc2`, after at `fe1d11b8`. `api` `db`
  importers **12 → 10**, `move` rows 28 → 26, 51 → 49 files. The handlers
  import `service` (the interface's types, the `Err*` categories,
  `SanitizeText`), so the plan's "neither `db` nor `service`" is met for
  `db` only — stated there, not bent.
- **Gates**, before every commit per `ci-check`: from `Server/` the four
  build-tag variants, `go vet ./...`, `go test -race ./...` (18 packages
  ok), `go test -tags deadlock -count=1 ./ws/` (ok, 59.9 s),
  `golangci-lint run` (0 issues — one `funlen` on `NewRouter` at 101 lines
  during item 3, fixed by folding the constructor into the mount call),
  `sqlc generate` and `genprotocol` drift clean, `go test ./invariants/` ok;
  from the root `check:docs` and `check:hygiene`.
  `go test -count=1 -race ./api/ ./service/ ./auth/` at `3f0d24ec`:
  `ok api 51.447s`, `ok service 84.403s`, `ok auth 1.802s`.
- **Coverage** (statements; `go test -coverprofile` blocks merged per file —
  before is `-coverprofile ./api/` at `71d867cb`, after is the same run for
  the handler files plus `-coverpkg=./api/,./service/ ./api/ ./service/` for
  the slice, each profile block counted once):

  | File                           | Before (`71d867cb`) | After (`fe1d11b8`)  |
  | ------------------------------ | ------------------- | ------------------- |
  | `api/auth_handler.go`          | 229/254 = 90.2%     | 98/114 = 86.0%      |
  | `api/totp_handler.go`          | 163/179 = 91.1%     | 54/60 = 90.0%       |
  | `service/auth.go`              | —                   | 240/253 = 94.9%     |
  | **slice (handlers + service)** | **392/433 = 90.5%** | **392/427 = 91.8%** |

  The same 392 statements are exercised after the move; the total shrank by
  six (the folded confirmation blocks). The handler files' percentages dip
  because their unreachable branches are now a larger share of a smaller
  file: `writeNotAuthenticated` (the no-principal branch behind
  `AuthMiddleware` — B3-1's `handleMe` note), `writeAuthError`'s default (a
  service contract bug, unreachable by construction), and
  `registerReadRequest`/`loginReadRequest`, unchanged at 78.9%/83.3% (B3-1's
  note: those branches are `auth/` tests). The service's gaps are B3-1's
  not-injectable set: `Register` 85.0% (hash failure, post-commit
  `GetUserByID`), `issueSession` 83.3% (`GenerateToken`), `Logout` 90.0% (the
  nil-session guard the handler answers first).

## HP-3 — First vertical-slice review

`docs/plans/hp-3-scorecard-<date>.md`, in the HP-2 shape. Questions:

1. Did the slice move behaviour without changing it? B3-1's characterization
   file unchanged and green at every pre-squash commit; the sentinel-mapping
   table byte-identical.
2. Did it reduce coupling? Before/after graph tables; `db` importers in `api`
   12 → 10; the interface's method count vs the `db` symbols the handlers used
   to touch.
3. Did it weaken a B2 contract? `TestEpoch1Fixtures` (`auth-failure`,
   `fresh-connect`), `TestAuth_ProtocolEpoch`, the absence tests, the
   predicate parity tables — all unchanged and green.
4. Is the pattern repeatable? The interface/service/handler shape written down
   in `docs/architecture/server.md` as the rule for B3-8, with the one thing
   that was awkward named honestly.
5. Are the guardrails from B3-6 that landed in parallel green on the slice's
   SHA (coverage floor, `db-import-boundary`, hub simulation)?

Owner signs. Acceptance authorises B3-3 onward and B3-8's per-family repeats.

## B3-3 — Lifecycle extraction into `internal/app/`

Roadmap workstream 8; supplement Phase 3 item 1. After HP-3.

1. `Server/internal/app/` owns: config and data-directory preparation,
   database open/migrate, telemetry, plugin registry, event persistence,
   audit writer, maintenance workers, **hub construction** (moved out of
   `api.NewRouter`, `router.go:106`, together with the plugin and LiveKit
   setters at `:325-360`; `NewRouter` gains a `*ws.Hub` parameter and stops
   returning one), HTTP server construction, health, replay seeding, and
   **one composite close** — `App.Close(ctx)` that stops
   in the reverse of start order and reports the first error without skipping
   later closes. `main.go` becomes `cfg := …; app, err := app.New(cfg); err =
app.Run(ctx)`.
2. Moved in the supplement's order: pure move of each block into a named
   file (`app/database.go`, `app/telemetry.go`, `app/plugins.go`,
   `app/http.go`, `app/lifecycle.go`), then the rewrite that threads
   dependencies through `App` fields instead of `main` locals — adjacent
   commits, HP-1's normalised-diff proof (`sort | uniq -u` over the
   substituted lines) recorded for the move commit.
3. **Failure-injection test** (`internal/app/lifecycle_test.go`): each
   collaborator's start made to fail in turn; assert no goroutine leaks
   (`goleak`, the server's convention), the database handle is closed, the
   listener is not left bound, and the returned error names the stage. This
   is the exit gate's "lifecycle failure-injection report".
4. `go build .` from `Server/` still produces `chatserver`; `release.yml` and
   `Dockerfile` are untouched (B2-7's no-`wazero`-tag finding stays true).

Exit: `main.go` under 150 lines; the failure-injection test green under
`-race`; four tag variants build. One PR.

## B3-4 — Hub constructor options (S-11)

Roadmap workstream 6; supplement Phase 3 item 2. **After B3-3, not
parallel with it:** at `bf7b886d` the production `ws.NewHub` call is inside
`api.NewRouter` (`Server/api/router.go:106`), which also wires
`SetPluginRegistry`/`SetPluginEventSink` (`:325-328`) and
`SetLiveKit`/`SetLiveKitProcess` (`:342-360`), while `main.go:453-454` sets
the event persister and store after the router returns. Two construction
boundaries means two owners; B3-3 collapses them first (below), then B3-4
has one call site to change.

1. From B3-0's setter table: each of the seven becomes either a field of
   `HubOptions` validated in `NewHub` (required → construction fails without
   it; the failure is a test) or stays a setter with a comment naming why it
   is replaceable at runtime (`SetPendingVoiceModFlags` is the likely
   survivor; `SetLiveKitProcess` depends on whether the supervised process can
   restart).
2. `NewHub` returns `(*Hub, error)`; the single call site — `internal/app/`
   after B3-3, which passes the built `*ws.Hub` into `api.NewRouter` instead
   of having the router construct it — passes everything the seven setters
   used to set. Tests
   that build a `Hub` use a `testHubOptions()` helper so 170+ test files do
   not each grow a struct literal.
3. RED first: a test that constructs a `Hub` without a required collaborator
   and expects an error — it fails today because construction succeeds and
   `Run` panics or silently drops events later.

Exit: no required collaborator can be omitted after construction; the
`-tags deadlock` pass still green. One PR.

## B3-5 — `ws` in-package split (S-08)

Roadmap workstream 9; supplement Phase 3 item 3. After B3-3/B3-4.

1. One pure-move commit per responsibility, each followed by its mechanical
   rewrite commit, in this order: handshake authentication (`serve_auth.go`
   exists — grow it from `serve.go`), fresh-connect initialisation
   (`serve_ready.go` exists), replay selection and delivery (`replay*.go`),
   registry and supersession (`registry.go` — today inside `hub.go`),
   visibility and permission refresh (`hub_visibility.go` — today inside
   `hub_broadcast.go`), broadcast delivery and backpressure
   (`hub_broadcast.go` keeps only this), voice session and moderation
   lifecycle (already `voice_*.go`; only leftovers move).
2. **No new package.** The lock order proven by `-tags deadlock` is shared
   private state; a subpackage would force exports. `Server/CLAUDE.md`'s
   FIFO/seq statement is re-read before every move and the `-tags deadlock
-count=10 ./ws/` pass runs after each.
3. Every move commit carries HP-1's proof: `git diff -M --summary` shows only
   renames/moves, and the normalised-diff of the rewrite commit is empty or
   its residue is listed.
4. `hub_broadcast.go` and `serve.go` each under 500 lines at exit; `hub.go`
   under 400. Numbers, not adjectives, in the evidence block.

Exit: the file table in `docs/architecture/server-boundaries.md` §hub updated;
race + deadlock + `TestEpoch1Fixtures` green on every commit. One PR per two
responsibilities at most, so each is reviewable.

## B3-6 — Permanent guardrails

Roadmap workstreams 1, 2, 3, 10, 11, 13, 14, 15, 16. Runs beside B3-0..B3-2;
each item is its own PR so none blocks another. Nothing here edits
`api/auth_*`, `auth/` or `service/`.

1. **Coverage floor (S-06, workstreams 1 and 14).** `Server/scripts/coverage-floor.sh`
   reads `coverage.out`, computes the aggregate and per-package figures for a
   named core set (`ws`, `service`, `permissions`, `auth`, `db`), and fails
   below `Server/coverage-floor.json` — aggregate starts at **74.6**, core
   packages at their measured value on the SHA that lands this, exclusions
   (generated `db/dbgen`, `cmd/`) listed in the JSON. Wired into `ci.yml` after
   the test step; the ratchet rule ("a PR that raises a figure raises the
   floor in the same PR; nobody lowers it without an HP entry") written into
   `Server/CLAUDE.md`. RED proven by setting the floor to 99 locally.
2. **Hub simulation (Tier 3b, workstreams 2 and 13).** `Server/ws/hub_sim_test.go`:
   a seeded `math/rand/v2` interleaving of subscribe, broadcast, ack,
   disconnect and reconnect-transfer over a real `Hub` under `-race`,
   asserting per-client FIFO and monotonic `seq` (the `Server/CLAUDE.md`
   statement) after every step; the seed printed on failure and settable via
   `OWNCORD_SIM_SEED` so a failure replays exactly. 200 steps × 20 seeds in
   CI; `make sim` runs 10,000.
3. **Fault-injected transport (Tier 3c).** `Server/ws/faultconn_test.go` — a
   test-only `net.Conn`/frame wrapper that drops, duplicates, reorders and
   delays frames from a seed; used by the simulation's reconnect cases and
   exported through `export_test.go` for the epoch-fixture harness.
4. **Client model test (Tier 3a).** `Client/tests/unit/connection.model.test.ts`
   with `fc.commands` (`Connect`, `Disconnect`, `RegisterNow`, `Receive(seq)`,
   `Supersede`, `Resync`, `Logout`) against a minimal model; invariants from
   the design (no duplicate ids, monotonic seq, verified never flips to
   unverified and back, aborted attempt never tears down a newer session).
   A test file only — no `Client/src/` change, so B7's rule holds.
5. **Fuzz seeds (workstream 3).** Corpus entries under `testdata/fuzz/` for
   the targets `make fuzz` already loops over, plus new `Fuzz*` targets for
   `protocol` parsing (`ws/messages.go` decoders), `permissions.Subject`
   round-trips, upload admission and recovery-token parsing — each seeded from
   the epoch-1 fixtures so CI's replay covers the real wire.
6. **Benchmarks and baselines (workstream 11).** `Benchmark*` for permission
   invalidation, read-state write, broadcast fan-out, replay selection,
   reconnect storm (the simulation with N clients) and upload admission;
   `Server/scripts/bench-baseline.sh` writes `benchstat` output to
   `docs/plans/b3-bench-baseline-<date>.md`. Baselines are recorded, not
   gated — the gate is B6's.
7. **`authz-chokepoint` rule (workstream 15).** Added to `Server/invariants`
   with HP-2 question 5's residue table as its allowlist (the 21 hits by
   file:line-independent symbol, since lines move); RED proven by a synthetic
   `permissions.HasPerm` call in `api/`. B3-8 shrinks the allowlist as
   families move.
8. **Docker smoke nightly on `dev` (workstream 16).** `ci.yml` gains
   `schedule: [{cron: "0 3 * * *"}]`. The `Server Docker Build (verify)`
   job's condition (`ci.yml:520`, today
   `github.ref_name == 'main' || github.base_ref == 'main'`) **keeps both
   existing terms** — a PR to `main` runs on the synthetic
   `refs/pull/<n>/merge` ref and is matched by `base_ref`, not `ref_name` —
   and adds `|| github.event_name == 'schedule'`. A scheduled run executes
   the workflow file from the default branch (`main`) and the job's
   `actions/checkout` has no `ref`, so it would smoke `main`; the checkout
   step gains `ref: ${{ github.event_name == 'schedule' && 'dev' || '' }}`
   (empty = the event's own ref, unchanged for pushes and PRs). The nightly
   therefore builds `dev`'s `Server/` from a workflow definition taken from
   `main` — acceptable while the job's steps are identical on both branches,
   and the reason the job is not moved to its own workflow file.
   `concurrency` and `timeout-minutes` are already present (B1-7's guard
   check enforces both). Proof before enabling the schedule: a
   `workflow_dispatch` run with the same `ref` expression and a
   `git rev-parse HEAD` step showing `dev`'s SHA.
9. **Machine-readable contract drift (workstream 10).** `check:server`
   already diffs the two generators; this adds `docs/api.md` route-table
   generation from the mounted router (the absence test's walker, printed as
   a table) and a `git diff --exit-code` on it, plus `docs/schema.md` from
   `sqlc`'s catalog. Configuration keys: the koanf walker from
   `TestAbsenceContract_NoFederationDirectoryOrListingConfigKeys`, printed
   into `docs/deployment.md`'s reference table.

Exit: each item green in CI on its own PR; the numbers (floor, seeds, bench
baseline) in this section's evidence block.

## B3-7 — Alpha-shaped test dataset

Roadmap workstream 12. Beside the slice.

1. `Server/cmd/seed -profile alpha` — deterministic (fixed seed, fixed
   clock). `load-baseline.yml` defines only `users` (default 100) and one
   channel, so it cannot be the source of the shape; the profile is defined
   here and lives as constants in `Server/cmd/seed/profile_alpha.go`, and
   `load-baseline.yml`'s `users` default is the one value the two share:
   **100 users** (4 roles: owner, admin, moderator, member — 1/2/5/92), **12
   channels** (10 text, 2 voice; 3 with role overrides, 2 with user
   overrides, 1 archived), **20,000 messages** over 30 simulated days with a
   diurnal curve, **300 attachments** (image/audio/video/other 60/10/10/20 %,
   sizes 10 KB–5 MB), **15 % of messages in DMs** across 40 DM pairs,
   **200 voice sessions** (1–45 min, 2–6 participants), **500 reactions**,
   **30 invites** (10 revoked), **1 plugin row** (disabled). A number that
   B3-7 finds unrepresentative is changed in `profile_alpha.go` with the
   reason in its evidence block — never silently. `-confirm-dev` stays
   mandatory.
2. One anonymised `v1.2.0-alpha.4` snapshot at `Server/testdata/snapshots/v1.2.0-alpha.4.sqlite`
   (Git LFS if over 5 MB; the path documented in `docs/deployment.md`
   §Upgrading and in `Server/CLAUDE.md`), produced by running alpha.4 against
   the profile and scrubbing identities with a script committed beside it.
   Consumers named in the file's README: B4 HP-4 drills, B6 upgrade
   rehearsal, B10 in-place upgrade.
3. A test that opens the snapshot with HEAD's migrations and asserts the
   migration count and a row-count checksum — the "upgrade still applies"
   canary.

Exit: profile reproducible byte-for-byte across two runs; snapshot opens and
migrates on HEAD. One PR.

## B3-8 — Remaining domain families behind services (S-09)

Roadmap workstream 5; supplement Phase 3 item 5. After HP-3, one PR per
family, the B3-2 pattern each time (characterization → interface → service →
thin handler → allowlist shrinks). Families from B3-0's `move` rows, in an
order that keeps shared migrations apart: settings/audit → channel (S-03's
rune/normalisation contract and S-04's one non-DM resolution policy land
here, test-first, because they are exactly the "canonical rule the handlers
mirror" the family exists to own) → invite → upload → role → message/read
state (OC-0323 lands here) → admin-UI adapters last (most stay `adapter`).
Each family's evidence block: before/after `db` importer count, allowlist
diff, the family's characterization file.

Exit: every remaining `db` importer above the domain layer is `adapter` or
`boundary` with its reason in `server-boundaries.md`; the exit-gate's "every
direct database use above the domain layer is justified or removed".

## B3-9 — The B3-tagged findings

Roadmap rule 2. `bughunt-fix` on OC-0345 (owner middleware role re-read →
reuse the authenticated context; unavailable stays 503, not 403) and OC-0346
(recovery middleware ordered after tracing so the panic log carries the
trace id). OC-0323 rides B3-8's message/read-state family. B3-1 added three
more, all in the auth slice and all pinned as-is by its characterization
rows: OC-0376 (register commits the account and burns the invite, then 500s
when the session insert fails), OC-0377 (verify-totp maps a database error to
401), OC-0378 (verify-totp consumes the challenge before the session insert).
They are fixed here, after B3-2 has moved the orchestration into
`service.AuthService` — each fix flips its `// known:` row in the same commit.
Any of the six that cannot land in B3 is re-tagged in HP-3's scorecard with
the reason.

## Exit gate

The roadmap's six conditions, with the evidence each maps to:

| #   | Condition                                                                                             | Evidence                                                            |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Every direct database use above the domain layer is justified or removed                              | `server-boundaries.md` — zero rows without a disposition; B3-8 done |
| 2   | Required hub wiring cannot be omitted after construction                                              | B3-4 RED/GREEN                                                      |
| 3   | Permission rules have one production implementation per security property                             | B2-5 + `authz-chokepoint` rule green (B3-6 item 7)                  |
| 4   | Start, stop, drain and failure ownership is explicit and tested                                       | B3-3 failure-injection test                                         |
| 5   | Race, deadlock, compatibility, fuzz seeds, model simulation, coverage and load baselines remain green | The gate run on the exit SHA; B3-6 items 1, 2, 5, 6                 |
| 6   | No measured regression exists outside a recorded tradeoff accepted at HP-3                            | Coverage and bench figures before/after; HP-3 tradeoff table        |
| —   | _(roadmap rule 2)_ No B3-tagged `OC-*` finding open                                                   | B3-9; ledger read-back in the exit scorecard                        |

Required evidence per the roadmap: boundary and database-call inventory
(B3-0), before/after dependency graph per extraction (B3-2, B3-8), coverage /
benchmark / race / deadlock / fuzz / model-test reports (B3-6), lifecycle
failure-injection report (B3-3), generated-contract drift check (B3-6 item
9). There is no HP at B3's exit — HP-3 sits mid-phase; the exit evidence is
appended to the HP-3 scorecard as a dated "B3 exit" section the owner signs.

## Explicitly out of scope for B3

- `Client/src/platform/` and every client feature move (B7). B3-6 item 4 is a
  test file, not a seam.
- Refreshing the client baselines (supplement Phase 1 item 5) — B7 entry.
- Any schema change beyond what a family move strictly needs; new domain
  services for B4–B6 features.
- Turning the benchmark baselines into gates (B6).
- The `ws` subpackage split — in-package only.

## Traps carried forward

- **Squash merges hide structure.** Every B3 PR that a hold point reviews
  (B3-2, B3-3, B3-5, every B3-8 family) records `refs/pull/<n>/head` SHAs at
  merge time in its evidence block, as HP-1/HP-2 did.
- **`strict: true`.** One PR in flight per hot file; B3-6's PRs never touch
  `api/auth_*`, `auth/`, `service/` while B3-1/B3-2 are open.
- **The shell cwd persists between commands** (HP-2 obs #95): every
  multi-step command starts with `cd /d/Local-Lab/Repos/OwnCord` or scopes
  its `cd` in a subshell.
- **A pinning test needs a negative control on the exact branch** (HP-2 obs
  #96): a mutation that does not fail the test is a finding about the test.
- **Check the PR is still open before pushing a review fix** (HP-2 obs #97).
- **`make` is not on PATH on Windows**; `npm run check:server` runs the same
  steps. `go test -tags deadlock -count=10 ./ws/` after every `ws` move.
- **`check:docs` counts.** `docs/plans/README.md` is watched; the register's
  row count and the ledger's status counts must agree with it.
