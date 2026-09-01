# B3 — Strengthen server architecture and permanent guardrails

**Drafted:** 2026-08-29  
**Base commit:** `bf7b886d` (`dev`, post-PR #1445); HP-2 accepted 2026-08-29
([hp-2-scorecard-2026-08-29.md](hp-2-scorecard-2026-08-29.md)) — claims
verified at `bf7b886d`  
**Status:** in progress — plan merged 2026-08-29 (PR #1447 = `ad4defc2`);
B3-0 merged 2026-08-29 (PR #1448 = `d383d8c7`; closes entry-gate item 3);
B3-1 merged 2026-08-29 (PR #1449 = `71d867cb`); B3-2 merged 2026-08-30
(PR #1450 = `75d64dd4`); B3-9 merged 2026-08-30 (PR #1454 = `123c0899`;
OC-0323 rides B3-8); HP-3 accepted 2026-08-30 by the owner (PR #1461 =
`52601114`); B3-3 (lifecycle extraction) — PR #1464 to `dev`, opened
2026-08-30; its squash SHA is recorded here at merge. B3-4 next.
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

| Step     | What                                                                                                                                                                    | Size     | Parallel with                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| **B3-0** | Boundary inventory: every upper-layer `db` import with a disposition; hub lifecycle; before-graph — **DONE 2026-08-29 (PR #1448)**                                      | 1–2 days | B3-6, B3-7                                                       |
| **B3-1** | Auth characterization tests — enumeration, sentinels, sessions, TOTP, rate limits, failure paths — **DONE 2026-08-29 (PR #1449)**                                       | 1 day    | B3-6, B3-7                                                       |
| **B3-2** | The auth vertical slice (S-10): route → `service.AuthService` → `db`, behaviour-neutral — **DONE 2026-08-30 (PR #1450)**                                                | 2–3 days | B3-6, B3-7                                                       |
| **HP-3** | First vertical-slice review — scorecard — **ACCEPTED 2026-08-30** ([hp-3-scorecard-2026-08-29.md](hp-3-scorecard-2026-08-29.md))                                        | —        | —                                                                |
| **B3-3** | Lifecycle extraction: `main.go` → `internal/app/` with one composite close contract — **PR #1464 open 2026-08-30**                                                      | 1–2 days | B3-4                                                             |
| **B3-4** | Hub constructor options (S-11): required collaborators validated at construction                                                                                        | 1 day    | after B3-3                                                       |
| **B3-5** | `ws` in-package split (S-08): responsibilities into named files, pure moves + adjacent rewrites                                                                         | 2–3 days | after B3-3/B3-4                                                  |
| **B3-6** | Guardrails: coverage floor (S-06), hub simulation + fault transport + fuzz seeds, benchmarks, rules                                                                     | 3–4 days | B3-0..B3-2                                                       |
| **B3-7** | Alpha-shaped test dataset: seed profile + anonymised `v1.2.0-alpha.4` snapshot                                                                                          | 1–2 days | B3-0..B3-2                                                       |
| **B3-8** | Remaining domain families behind services (S-09), one PR each; S-03/S-04 fold into the channel family                                                                   | spread   | after HP-3, per-family                                           |
| **B3-9** | The B3-tagged findings: OC-0323, OC-0345, OC-0346 + B3-1's OC-0376, OC-0377, OC-0378 (test-first, `bughunt-fix` shape) — **DONE 2026-08-30 (PR #1454; OC-0323 → B3-8)** | 1 day    | OC-0345/0346: any; OC-0323: with B3-8; OC-0376..0378: after B3-2 |

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

**Evidence, 2026-08-30** — branch `feat/b3-3-lifecycle` from `dev` `52601114`
(HP-3, PR #1461); PR #1464 to `dev`.

- **Pre-squash SHAs**, one per numbered item. The full server gate ran before
  each commit, and `go test -count=1 -run TestAuthCharacterization ./api/`
  after it — the only allowed touch in the auth tests was `NewRouter`'s
  signature at the call site, and no auth test file changed at all:

  | Commit      | Item                                                                                                            | Gate        | `TestAuthCharacterization` |
  | ----------- | --------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------- |
  | `b5827d23`  | status line: HP-3's merge SHA, B3-3 in progress                                                                 | docs only   | —                          |
  | `03c1295c`  | 1 — pure move of every `run*` block into `Server/internal/app/`                                                 | full, green | ok 0.946 s                 |
  | `556cdb11`  | 2 — `type App`, `app.New`/`Run`, one composite `App.Close`                                                      | full, green | ok 0.939 s                 |
  | `beebd3f9`  | 3 — hub construction out of `api.NewRouter`; `NewRouter` takes `api.Runtime`                                    | full, green | ok 0.943 s                 |
  | `ca59ad44`  | 4 — `internal/app/lifecycle_failure_test.go`, the failure-injection report                                      | full, green | ok 0.929 s                 |
  | `0c29636c`  | 5 — this block, the after-state rows in `server-boundaries.md`, status line, step table, `docs/plans/README.md` | docs only   | —                          |
  | this commit | 6 — Codex P2: `bgCtx` must not inherit `Run`'s caller cancellation                                              | full, green | ok 0.9 s                   |

- **`main.go`: 1,019 → 99 lines.** What is left is the two CLI dispatches
  (`healthcheck`, `token`), the ring buffer and log handlers, the restart
  coordinator and its handoff, and eleven lines of `runServer`:
  `app.LoadConfig` → `app.New` → `a.Run(ctx)`. The exit target was 150.

- **Normalised-diff proof for the pure move (`03c1295c`).** HP-1's shape:
  re-apply the substitutions the commit claims to make, then look for any
  `+`/`-` line left unpaired.

  ```bash
  git diff b5827d23 03c1295c -- Server/ ':!Server/invariants/' \
    | grep -E '^[+-]' | grep -v '^[+-][+-]' \
    | sed -E 's/^[+-]//;
              s/^package app$/package main/;
              s/\bapp\.//g;
              s/\bRunHealthcheckCLI\b/runHealthcheckCLI/g;
              s/\bNewRestartCoordinator\b/newRestartCoordinator/g;
              s/\bRestartCoordinator\b/restartCoordinator/g;
              s/\bRestartBackstopDelay\b/restartBackstopDelay/g;
              s/\bPerformRestartHandoff\b/performRestartHandoff/g;
              s/\bDisarm\b/disarm/g;
              s/\brun\(\)/Run/g;
              s/\bRun\(\)/Run/g;
              s/func Run\(version string, log /func run(log /;
              s/Run\("test", log, logBuf, levelVar, rc\)/run(log, logBuf, levelVar, rc)/;
              s/Run\(version, log, logBuf, levelVar, rc\)/run(log, logBuf, levelVar, rc)/;
              s/srv \*http\.Server, tlsCfg \*tls\.Config, addr, version string/srv *http.Server, tlsCfg *tls.Config, addr string/;
              s/runServeAndWait\(ctx, log, rc, srv, tlsCfg, addr, version\)/runServeAndWait(ctx, log, rc, srv, tlsCfg, addr)/;' \
    | sort | uniq -u
  ```

  **Result: 45 unpaired lines, every one of them comment prose or the new
  import.** No code line is unpaired.

  | Unpaired | Where                       | What                                                                                                       |
  | -------: | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
  |        1 | `main.go`                   | the new `internal/app` import                                                                              |
  |       28 | `main.go`                   | three comment blocks inside `main()` re-wrapped (the level var, the coordinator, the handoff) — same prose |
  |        2 | `main.go`                   | `version`'s doc gains why the symbol stays in `package main` (`-X main.version`)                           |
  |       12 | `internal/app/lifecycle.go` | the package doc comment (5, new) and `Run`'s doc re-wrapped for the `version` parameter (3 out, 4 in)      |
  |        2 | `internal/app/restart.go`   | "the DB-lock and bind retries in `db/` and `main.go`" → "… in `db/` and `internal/app`"                    |

  The five substitutions are exactly what the commit message names: the
  package clause, `run`→`Run` and `runHealthcheckCLI`→`RunHealthcheckCLI`
  (the two entry points `main()` calls), the five restart-coordinator
  identifiers `main()` still names, and `version` becoming a parameter
  instead of a package-level var.

- **Composite close, test-first.** `internal/app/close_test.go` was written
  before the rewrite and failed to compile against `03c1295c` (`undefined:
App`, `undefined: New`, `undefined: LoadConfig`, `undefined: Deps`). Each
  row has a negative control run on this branch:

  | Property pinned                                      | Mutation applied                | Result         |
  | ---------------------------------------------------- | ------------------------------- | -------------- |
  | close order is the reverse of start order            | walk the closers forward        | FAIL           |
  | the first error is returned, later closes still run  | `return` on the first error     | FAIL           |
  | the hub stops when a stage after the router fails    | skip teardown on a failed start | FAIL           |
  | the database close step actually releases the handle | drop the `database` close step  | FAIL (11 rows) |
  | the hub close step actually stops the dispatch loop  | drop the `hub` close step       | FAIL (12 rows) |

- **Codex review (P2), fixed test-first.** Codex read the rewrite and found
  that `Run(ctx)` derived `bgCtx` from its caller's context, so cancelling
  that context killed the event persister, the audit writer and the
  maintenance loop _before_ `Close` ran its HTTP-first drain — the one
  ordering the drain exists for, since in-flight handlers' broadcasts and
  audit records have to reach live consumers. It also made caller-context
  shutdown behave unlike the SIGTERM and restart paths, which cancel only the
  serve context. `run()` had this right for free by rooting `bgCtx` at
  `context.Background()`. `main.go` passes `context.Background()`, so no
  released build was affected; the defect was in B3-3's own new `Run(ctx)`
  contract. Fixed with `context.WithoutCancel(ctx)` — values inherited,
  cancellation not — and pinned by
  `TestAppRun_CallerCancel_KeepsBackgroundWorkersAliveThroughTheDrain`, which
  records `bgCtx.Err()` as each close step runs (a new test-only
  `onCloseStep` seam makes the walk observable) and requires it still live at
  `signals`, `http`, `maintenance` and `audit-writer`, and already cancelled
  by `database`. RED before the fix on all four rows; the negative control —
  restoring `context.WithCancel(ctx)` — fails it again.

- **Failure-injection report** (item 3, and exit-gate row 4's evidence).
  `internal/app/lifecycle_failure_test.go`. The table is generated from
  `App.stages()`, so a stage added later is covered the day it is added. Every
  row asserts the same four properties: the error names the stage, no
  goroutine is left running (`goleak`), the database handle is closed, and the
  listener is not left bound. Green under `go test -race ./internal/app/`.

  | Stage failed                            | Error names the stage | No goroutine leak | DB handle closed | Listener free     |
  | --------------------------------------- | --------------------- | ----------------- | ---------------- | ----------------- |
  | `data-dir`                              | PASS                  | PASS              | n/a (not opened) | PASS              |
  | `tls`                                   | PASS                  | PASS              | n/a (not opened) | PASS              |
  | `database`                              | PASS                  | PASS              | n/a (not opened) | PASS              |
  | `migrate`                               | PASS                  | PASS              | PASS             | PASS              |
  | `telemetry`                             | PASS                  | PASS              | PASS             | PASS              |
  | `plugins`                               | PASS                  | PASS              | PASS             | PASS              |
  | `hub`                                   | PASS                  | PASS              | PASS             | PASS              |
  | `router`                                | PASS                  | PASS              | PASS             | PASS              |
  | `event-persistence`                     | PASS                  | PASS              | PASS             | PASS              |
  | `audit-writer`                          | PASS                  | PASS              | PASS             | PASS              |
  | `maintenance`                           | PASS                  | PASS              | PASS             | PASS              |
  | `acme`                                  | PASS                  | PASS              | PASS             | PASS              |
  | `http`                                  | PASS                  | PASS              | PASS             | PASS              |
  | `signals`                               | PASS                  | PASS              | PASS             | PASS              |
  | listener bind (real, out-of-range port) | PASS                  | PASS              | PASS             | n/a (never bound) |
  | none — context cancelled while serving  | n/a (nil error)       | PASS              | PASS             | PASS              |

  The last row is the control: the same four properties on the path where
  nothing fails, so the rows above are not passing merely because something
  went wrong.

- **Hub ownership.** `ws.NewHub` moves from `api.NewRouter` (`router.go:106`)
  to `app.StartRuntime` (`internal/app/hub.go`), which also applies the four
  pre-`Run` setters that were at `router.go:325-360` and starts the dispatch
  goroutine. `NewRouter` gains an `api.Runtime` parameter (the hub, the
  limiter, the service layer, and `VoiceEnabled` — the `lkErr == nil` guard
  the voice routes were already mounted behind) and returns
  `(http.Handler, func())`. The limiter and the service layer move with the
  hub because it needs the same instances: the limiter persists auth
  lockouts and the services hold the permission cache the hub invalidates.
  Six `api_test` files and `cmd/gendocs` were updated at the call site only —
  wiring, no assertion changes — and `gendocs` still emits a byte-identical
  route index (its drift check is in the gate). Before/after tables:
  [server-boundaries.md](../architecture/server-boundaries.md#hub-lifecycle-inventory).

- **Build and packaging** (item 4). `Server/Makefile`, `Server/Dockerfile`
  and `.github/workflows/release.yml` are untouched, and B2-7's
  no-`wazero`-tag note stays true. The release build still resolves the
  version symbol: `go build -o chatserver -ldflags "-s -w -X
main.version=9.9.9-b33check" .` embeds the string (3 occurrences in the
  binary), because `version` deliberately stays in `package main` and is
  passed into the App through `app.Deps`. Note for the record that a _plain_
  `go build .` from `Server/` produces a binary named `Server`, not
  `chatserver` — that is derived from the module path (`.../OwnCord/Server`)
  and is unchanged by B3-3; every packaging path passes `-o` explicitly.

- **Gate**, run in full before every commit through one `set -euo pipefail`
  script: four build-tag variants (default, `otel`, `wazero`, `otel,wazero`),
  `go vet ./...`, `go test -race -timeout 20m ./... -coverprofile -cover`,
  `scripts/coverage-floor.sh`, `go test -tags deadlock -count=1 ./ws/`,
  `golangci-lint run ./...` at CI's pinned v2.11.3 (**0 issues**), sqlc and
  genprotocol and gendocs drift, `check:docs`, `check:hygiene`.

- **Coverage.** Aggregate 80.1% before (11446/14273 statements) → 80.2% after
  (floor 79.8%); no core-package floor moved. The `Server` root package drops
  to 0.0% because everything testable left it; `internal/app` carries it at
  65.9%, up from the root package's pre-move 45.7% because `main()` — never
  covered — is no longer counted with the lifecycle.

- **Inventory.** `DBImportAllow` loses its `main.go` row and gains six
  `internal/app` rows, all `boundary`; `api/router.go`'s note is updated now
  that hub construction has left. `docs/architecture/server-boundaries.md` is
  regenerated from the map (50 → 55 importers, `boundary` 7 → 12) and its
  summary table's stale `boundary 6` is corrected to agree with the generated
  line.

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

**Evidence, 2026-08-31** — branch `feat/b3-4-hub-options` from `dev`
`e524f28b`. `ws.NewHub(opts HubOptions) (*Hub, error)`; the setter table's
dispositions, decided by what each setter's own implementation said rather
than by the plan's guesses:

- **Options, setters deleted** — the four wired-before-`Run` knobs, every
  one already guarded by `rejectIfRunning` (construction-phase wiring
  pretending to be mutable state): `SetLiveKit`, `SetLiveKitProcess`,
  `SetPluginRegistry`, `ConfigureReplay`. `rejectIfRunning` itself died
  with them — no half-state remains to guard. The plan left
  `SetLiveKitProcess` "depends on whether the supervised process can
  restart": it cannot — the restart path relaunches the whole app
  (`internal/app/restart.go`), nothing re-sets a process on a live hub —
  so it is an option, validated: a process without a client is refused
  (`TestHub_LiveKitProcessRequiresClient`).
- **Setters kept, each with its why in the doc comment** —
  `SetEventPersister` / `SetEventStore` / `SetPluginEventSink` are atomic
  hot-swaps that `internal/app` wires one lifecycle stage after `Run`
  starts (the persister cannot exist before the hub; the sink consumes the
  built hub's broadcaster), and `SetPendingVoiceModFlags` is per-user
  runtime state.
- **Required and validated**: `DB` and `Limiter` (`Services` stays
  optional — nil is the degraded fixture half the `ws` suite builds, and
  forcing a real service layer would change which handler paths the frozen
  tests take). RED history: before this change
  `ws.NewHub(nil, nil, nil)` succeeded — `api`'s LiveKit-proxy tests built
  exactly that hub — and the first missing-collaborator failure was a
  later panic. `TestNewHub_RequiredCollaborators` pins the refusals;
  the api fixture is now `newBareHub`, which must supply a real database.
- **Single production call site**: `internal/app.StartRuntime` builds the
  LiveKit client/process first (`buildVoice`), passes everything through
  `HubOptions`, and starts the supervised process only once the hub holds
  it (OC-0019 ordering preserved); construction failure is now a
  `startHub` error instead of a later panic. `cmd/gendocs` follows the
  same shape.
- **Test migration**: `newTestHub` / `newTestHubDeps` / `newTestHubWith`
  (`ws/testhub_internal_test.go`, `ws/testhub_ext_test.go`) keep the
  pre-B3-4 call shape at ~76 sites across both `ws` package namespaces;
  the eighteen former setter call sites construct with options.
- Pre-squash SHAs recorded at merge time in the PR (squash hides
  structure); gate results in the PR's test plan.

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

**Evidence — split PR 1 of the series, 2026-08-31** — branch
`feat/b3-5-ws-split` from `dev` `e13adaf8`. Responsibilities 1 and 2
(handshake authentication, fresh-connect initialisation); both destination
files already existed, so `git diff -M --summary` records no file-level
rename and the purity proof is the normalised line-diff per move:

- **Move 1** — `handshakeWrite`, `upgradeAndAuth`,
  `unregisterFailedHandshake` (99 lines) → `serve_auth.go`, beside
  `authenticateConn`. Residue: three import lines (`log/slog`, `net/http`,
  `strings`) added to the destination; `serve.go` keeps its copies for the
  remaining code. Gate: `-tags deadlock -count=10 ./ws/` ok 648.7 s,
  `-race` ok 228.8 s.
- **Move 2** — `handleFreshConnect`, `freshConnectCleanStaleVoice`
  (187 lines) → `serve_ready.go`, beside the `buildReady`/`buildAuthOK`
  family they drive. Residue: one import line (`github.com/coder/websocket`).
  Gate: `-tags deadlock -count=10 ./ws/` ok 649.8 s, `-race` ok 233.6 s.
- **Deliberately not moved**: `applyConnectStatus`,
  `announceConnectPresence`, `refreshUserSnapshot` are called from both the
  reconnect and fresh-connect paths, so they stay in `serve.go` with the
  composition point; `computeAllowedChannels` (also called from
  `hub_broadcast.go`) waits for the visibility responsibility.
- **Sizes**: `serve.go` 990 → 704, `serve_auth.go` 105 → 207,
  `serve_ready.go` 375 → 564. The `serve.go` < 500 exit figure lands when
  the replay/reconnect family moves (next PR).
- Boundaries doc re-measured (dbinventory table, two `DBImportAllow`
  reasons, the reader note: 45 → 48 references, 7 → 11 distinct queries).
- Pre-squash SHAs recorded at merge time in the PR; the mechanical-rewrite
  half of each pair was empty (no identifier changed), so each move is one
  commit.

**Evidence — split PR 2 of the series, 2026-08-31** — branch
`feat/b3-5-ws-split-2` from `dev` `1d1804ce` (split PR 1's squash).
Responsibilities 3 and 4 (replay selection and delivery, registry and
supersession); both destinations are new files, so the purity residue is
each file's scaffolding plus any import the source keeps:

- **Move 3** — `handleReconnect`, `reconnectPrecheck`,
  `reconnectSelectReplay`, `reconnectVetColdTail`, `reconnectRegister`,
  `reconnectWriteReplay`, `liveVoiceEventsSince`, and the replay-only
  `maxColdReplay` const (cut from `serve.go`'s shared const block) →
  new `replay.go` (474 lines out, 486 in). Residue: scaffolding
  (`package`/`import (`/`const (` openers) plus duplicates of the four
  imports `serve.go` retains (`context`, `log/slog`, `db`, `websocket`);
  `sync/atomic` and `telemetry` moved outright. Gate: `-tags deadlock
-count=10 ./ws/` ok 629.3 s, `-race` ok 202.2 s.
- **Move 4** — `Register`, `Unregister`, `registerNow`, `unregisterNow`,
  `shouldMarkOffline` → new `hub_registry.go` (250 lines out, 253 in).
  Residue: the package line and a `log/slog` import. `clientEvent` stays
  in `hub.go` — `Run`'s dispatch loop owns the channel. Gate: recorded in
  the PR's test plan.
- **Deviation from the plan's letter**: the plan named `registry.go` as the
  destination, but that file holds the message-type `HandlerRegistry` — a
  different registry; growing it would conflate the two, so the connection
  registry gets its own `hub_registry.go`.
- **Inventory**: `replay.go` gains a `DBImportAllow` row (`move`,
  `connection`) — a split of `serve.go`'s row, type-only (the family's
  actual calls stayed with the shared helpers in `serve.go`); the registry
  family makes no `db` use, so `hub_registry.go` needs no row. The
  boundaries doc's ratchet sentence now says it is the `db` surface, not
  the row count, that only shrinks (26 → 27 `move` rows with zero new
  calls).
- **Sizes**: `serve.go` 230 (exit target < 500 met), `replay.go` 486,
  `hub.go` 866 → 616 (exit target < 400 still open — the settings cache,
  lifecycle and stats surfaces remain for later PRs), `hub_registry.go`
  253, `hub_broadcast.go` 1032 (untouched; visibility and backpressure are
  the next responsibilities).

**Evidence — split PR 3 of the series, 2026-08-31** — branch
`feat/b3-5-ws-split-3` from `dev` `f9258ef8` (split PR 2's squash).
Responsibilities 5 and 6 (visibility and permission refresh; broadcast
delivery and backpressure — the latter satisfied by what
`hub_broadcast.go` keeps once visibility leaves):

- **Move 5** — one pure-move commit gathers the visibility responsibility
  from the three files it was spread across into the new
  `hub_visibility.go` (478 lines out, 487 in): the `channelReadAudience`
  family, `RefreshChannelVisibility`, `refreshChannelVisibilityCanSend`,
  `RefreshAllChannelVisibility` and `revokeUnreadableChannels` from
  `hub_broadcast.go`; `computeAllowedChannels` from `serve.go` (flagged
  for this move in split PR 1); `bumpVisibilityWatermark` and
  `MarkVisibilityChanged` from `hub.go`. Residue: the new file's
  scaffolding plus duplicates of five imports the sources keep; the
  `permissions` import moved outright (out of `hub_broadcast.go` and
  `serve.go`, into the new file). Gate results in the PR's test plan.
- **Audience placement**: the `channelReadAudience` family rides with
  visibility, not delivery — it is permission-derived recipient
  resolution, the same rule set `computeAllowedChannels` and the ready
  filter share; delivery consumes its output.
- **Inventory**: `hub_visibility.go` gains a `DBImportAllow` row
  (`move`, `channel`); `hub_broadcast.go`'s row shrinks to the
  member/presence payload reads (27 → 28 `move` rows, zero new calls).
- **Sizes**: `hub_broadcast.go` 1032 → 632 (< 500 at exit still open —
  the presence queue and typed event wrappers remain; the voice-leftover
  PR decides what else moves), `serve.go` 230 → 183, `hub.go` 616 → 585,
  `hub_visibility.go` 487.

**Evidence — split PR 4 of the series, 2026-08-31** — branch
`feat/b3-5-ws-split-4` from `dev` `70875a3f` (split PR 3's squash).
Responsibility 7 (voice leftovers) plus the presence coalescer split
that responsibility 6's size target needed:

- **Move 6** — `broadcastVoiceEvent`, `broadcastVoiceEventWithLeaver`
  (from `hub_broadcast.go`) and `VoiceSessionCount` (from `hub.go`) →
  the existing `voice_broadcast.go`, beside the voice rate-limit and
  quality tables (76 lines out, 77 in). Residue: one `context` import.
  Gate: `-tags deadlock -count=10 ./ws/` ok 648.9 s, `-race` ok 228.5 s.
- **Move 7** — the presence coalescer (`pendingPresence`,
  `QueuePresence`, `dropQueuedPresenceAndBroadcast`,
  `presenceCoalesceWindow`, `presenceFlushRaceHook`,
  `flushPresenceQueue`, `BroadcastPresence`) → new `hub_presence.go`, in
  source order (145 lines out, 153 in). Residue: scaffolding plus
  duplicates of two imports the source keeps (`time`, `db`). Presence is
  not one of the plan's seven responsibilities; the cut is what brings
  `hub_broadcast.go` to its < 500 exit figure while keeping it pure
  delivery and backpressure, and the coalescer is a coherent family of
  its own. Gate results in the PR's test plan.
- **Inventory**: `voice_broadcast.go` needs no row (no `db` use);
  `hub_presence.go` is an `adapter` row — its only `db` use is the pure
  `BroadcastStatus` helper, the doc's own example (17 → 18 `adapter`);
  `hub_broadcast.go`'s reason drops the presence half.
- **Sizes**: `hub_broadcast.go` 632 → **424 (< 500 exit target met)**,
  `hub.go` 585 → 572 (< 400 still open — the finisher PR moves
  construction/options and the replay-limit accessor), `voice_broadcast.go`
  38 → 115, `hub_presence.go` 153.

**Evidence — finisher PR and B3-5 exit, 2026-08-31** — branch
`feat/b3-5-ws-split-5` from `dev` `df717e48` (split PR 4's squash).

- **Move 8** — one pure-move commit closes `hub.go`'s size target:
  `HubOptions` and `NewHub` → new `hub_options.go`; `getCachedSettings`
  and `refreshSettingsLocked` → new `hub_settings.go`;
  `maxColdReplayLimit` → `replay.go`, beside the family that reads it
  (211 lines out, 229 in). Residue: the new files' scaffolding plus
  duplicates of five imports `hub.go` retains (`auth`, `db`,
  `permissions`, `plugin`, `service`); `errors`, `fmt` and `os` moved
  outright. Gate results in the PR's test plan.
- **Inventory**: `hub.go`'s `GetSetting` calls left with the settings
  cache, so its row turns type-only `boundary` (the handle the families
  read through); `hub_options.go` is a type-only `boundary` row
  (validates and stores the handle). `hub_settings.go` reads through the
  `h.db` field, which needs no import — Codex's P2 on the finisher PR
  caught that this made the settings-ops item invisible to the
  import-tracking rule and table — so the file pins the `db` import
  (a documented `var _ *db.DB`) and keeps its `move`/`settings-ops` row,
  `GetSetting×2` visible. The disposition counts were re-derived from
  the tool's summary (`boundary` had been stale at 12 since the
  seed-profile row landed).

**B3-5 exit.** All seven responsibilities relocated across five squash
merges — #1472 (handshake auth; fresh-connect), #1473 (replay; registry),
#1474 (visibility), #1475 (voice leftovers; presence coalescer split),
plus this finisher — every move a pure move with its normalised-diff
residue listed, `git diff -M --summary` recording no file-level rename
(all function-level motion between files), and the
`-tags deadlock -count=10 ./ws/` + `-race` pass green after every move
with `TestEpoch1Fixtures` inside those runs. The plan's named destination
`registry.go` was already the message-type `HandlerRegistry`, so the
connection registry lives in `hub_registry.go` (recorded in split PR 2).
Exit sizes, measured on this branch:

| File               | Before B3-5 | After | Target  |
| ------------------ | ----------: | ----: | ------- |
| `serve.go`         |         990 |   183 | < 500 ✓ |
| `hub.go`           |         866 |   361 | < 400 ✓ |
| `hub_broadcast.go` |        1032 |   424 | < 500 ✓ |

New files: `replay.go` 496, `hub_registry.go` 253, `hub_visibility.go`
487, `hub_presence.go` 153, `hub_options.go` 174, `hub_settings.go` 45;
grown files: `serve_auth.go` 105 → 207, `serve_ready.go` 375 → 564,
`voice_broadcast.go` 38 → 115. The `db`-inventory file table in
`server-boundaries.md` was re-measured in every split PR; no new `db`
call was added anywhere in the series.

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

#### Evidence — item 7 (`authz-chokepoint`)

- Branch `feat/b3-6-authz-chokepoint`; commits: `2f4d18fa` `feat(b3-6): authz-chokepoint rule — raw permission checks route through the B2-5 predicates`, plus this evidence commit
- RED: a temporary `permissions.HasPerm(0, permissions.ReadMessages)` inside
  `api/diagnostics_handler.go`'s `isPrivateIP`, then
  `cd Server && go test -count=1 ./invariants/` →
  `api/diagnostics_handler.go:89: [authz-chokepoint] raw permissions.HasPerm decides authorization at the call site; … or add an AuthzResidueAllow entry for api.isPrivateIP with a class and a reason`.
  Probe reverted (`git checkout -- api/diagnostics_handler.go`, `git status` clean).
- RED (allowlist, both directions): a bogus row →
  `TestAuthzResidueAllowIsLive … AuthzResidueAllow["ws.(*Hub).movedBehindAPredicate"] no longer performs a raw permission check — delete the row`;
  deleting the real `ws.(*Hub).readyVisibleChannels` row →
  `TestServerInvariants … ws/serve_ready.go:169: [authz-chokepoint] raw permissions.HasAdmin …`.
  Every row is load-bearing, and `TestAuthzResidueAllowIsLive` proves all 19 at
  once on every run.
- GREEN: `cd Server && go test -count=1 ./invariants/` → `ok github.com/J3vb/OwnCord/Server/invariants`
- RED (Codex P2 on #1451 — a row must not exempt the whole function): a second
  `permissions.HasAdmin` inside `api/serveFileAuthorize` →
  `api/upload_handler.go:405: … the residue row binds 1 call(s) of HasAdmin here, found 2`;
  swapping that call to `permissions.HasPerm` →
  `api/upload_handler.go:404: … binds 0 call(s) of HasPerm here, found 1`;
  setting the row to `HasAdmin: 2` →
  `TestAuthzResidueAllowIsLive … binds map[HasAdmin:2] but the tree has map[HasAdmin:1]`.
  All three restored.
- Numbers: allowlist **19 rows / 21 bound calls**, which is HP-2 question 5's
  21 code hits exactly — re-measured at `dev` `75d64dd4`, zero hits outside its
  five classes and zero unclassified. A row binds symbol **and** helper **and**
  count, so the residue cannot grow inside an allowlisted function; 18 rows bind
  one call, `service.(*MessageService).mentionReaders` binds three
  (`EffectivePerms` 1, `HasAdmin` 2). By helper: `HasAdmin` 13,
  `HasServerPerm` 6, `HasAnyPerm` 1, `EffectivePerms` 1. Classes:
  `server-scoped` 6, `admin-short-circuit` 6, `admin-perimeter` 5,
  `bulk-reader-walk` 3 (one symbol), `base-bit-rejection` 1. Six flagged call
  targets (`HasPerm`, `HasAnyPerm`, `HasServerPerm`, `HasAdmin`,
  `EffectivePerms`, `EffectiveChannelPerms`) — the whole exported surface of
  `permissions.go` except `Name`. Registry is now three rules.
- Verified against HEAD: the plan's "`Rules = []Rule{syncutilLocks}` … one
  rule" predates B3-0; `authz-chokepoint` is the third, not the second. The
  residue table's line numbers had moved (B3-2 shifted `api/middleware.go`
  200→213), which is why rows are keyed by `<dir>.<enclosing symbol>` and never
  by `file:line`; the hit count is unchanged at 21. No production code changed.

#### Evidence — item 1 (coverage floor)

- Branch `feat/b3-6-coverage-floor`; commits: `843dd6c6` feat(b3-6): coverage
  floor — script, floors and CI step (S-06), the commit carrying this block, and
  the review-fix commit that follows them on this branch.
- RED: `bash scripts/coverage-floor.sh --floor <99-aggregate.json> coverage.out`
  → `coverage-floor: FAIL aggregate 79.1% (floor 99.0%, 11241/14194 statements)`
  (exit 1); `bash scripts/coverage-floor.sh --floor <99-ws.json> coverage.out`
  → `coverage-floor: FAIL ws 84.5% (floor 99.0%, 3181/3763 statements)`
  (exit 1). The parser also fails closed on a floor file it cannot read whole: a
  Prettier-wrapped `"exclude"` array exits 2 rather than silently excluding
  nothing; a package entry sharing the closing-brace line is enforced, not
  dropped (`"ws": 99.0 }` → `FAIL ws 84.5% (floor 99.0%)`, exit 1); a value that
  is not an unquoted number exits 2 naming the line (`"auth": "90.8"` →
  `floor file line 6 is not a "name": <number> entry`); and a floor file missing
  any of the five core packages exits 2 naming it (`no floor for core package
db`). No control file is committed.
- GREEN: the `Check coverage floor` step of CI run `33302062524` (ubuntu leg) →
  exit 0, six lines, `coverage-floor: ok aggregate 79.9% (floor 79.9%, 11344/14191 statements)`
  and one `ok` line per core package. The RED runs above are local, against the
  Windows profile, which is why their measured column reads 79.1/84.5 rather
  than the committed Linux floors.
- Numbers. The floors are **Linux** figures, measured by the gate itself on the
  ubuntu leg of PR #1453 — the leg that enforces them. Two runs were needed:
  the second (`33302732286`) failed `ws` at 86.8 against a floor of 86.9 set
  from the first (`33302062524`), so the leg is not bit-for-bit repeatable. The
  rule the numbers now follow: **the lowest observed Linux figure, truncated to
  0.1, minus 0.1 where the package varied between runs.**

  | figure        | run 33302062524 | run 33302732286 | varies | floor     |
  | ------------- | --------------- | --------------- | ------ | --------- |
  | aggregate     | 11344/14191     | 11340/14191     | yes    | **79.8**  |
  | `auth`        | 418/460         | 418/460         | no     | **90.8**  |
  | `db`          | 1738/2189       | 1738/2189       | no     | **79.3**  |
  | `permissions` | 94/94           | 94/94           | no     | **100.0** |
  | `service`     | 1204/1775       | 1204/1775       | no     | **67.8**  |
  | `ws`          | 3271/3763       | 3267/3763       | yes    | **86.7**  |

  Only `ws` moves — four statements, timing-dependent branches under `-race` —
  and it carries the aggregate with it; the other four packages are identical
  across both runs, so they take no headroom.

  The Windows/Linux gap is separate and was measured locally with
  `go test -race -timeout 20m ./... -coverprofile=coverage.out -cover` at the
  merge base with `origin/dev` (`75d64dd4`): aggregate 79.1 (11241/14194),
  `auth` 90.8, `db` 79.4 (1738/2188), `permissions` 100.0, `service` 67.8, `ws`
  84.5 (3181/3763). It falls exactly where the pre-merge analysis said it would:
  `ws` is higher on Linux because three `EnsureLiveKitBinary` tests and one
  `harvest_s5` case skip on Windows, and `db` is one statement larger on Linux
  (`lockfile_unix.go` has 11 statements where `lockfile_windows.go` has 10),
  which costs it a tenth. `auth`, `permissions` and `service` carry no
  OS-conditional code and are identical everywhere. Running the committed
  floors against a Windows profile therefore reports `aggregate` and `ws` under
  floor — expected, and the reason the gate is Linux-only.

  The spec's starting aggregate of 74.6 is the B0 baseline at an older SHA; the
  ratchet rule applies to this PR, so the committed floor is 79.8.

- Verified against HEAD: `ci.yml:73` matched the spec. The gate step runs on the
  **ubuntu-latest** leg only, and after the job's other test steps so a floor
  miss does not hide them. Two legs would not be deterministic: the table above
  is the measured proof that the profile is not the same on both.

#### Evidence — item 4 (client connection model test)

- Branch `feat/b3-6-client-model-test`; commits: `7b2dc055`
  `test(b3-6): client connection model test — fc.commands over the real stack`,
  plus this evidence block.
- File: `Client/tests/unit/connection.model.test.ts` (test only; no
  `Client/src/` change, so B7's rule holds). System under test is the real
  `createWsClient()` + `wireDispatcher()` + the real stores; only the Tauri
  IPC wire (shared `tests/unit/helpers/ws-mocks.ts`) and the LiveKit /
  notification / toast / identity leaves are mocked, as in `dispatcher.test.ts`.
- Commands: `Connect` (fresh → `auth_ok(none)` + `ready`; resume → `auth_ok`
  - the replayed events, no `ready`), `Disconnect`, `RegisterNow`,
    `Receive(id, seq)`, `Supersede(channel, stale|live)`, `Resync(dropPeer)`,
    `Logout`.
- Invariants (checked after every command): (1) no duplicate message ids and
  the store holds exactly the ids delivered; (2) the seq watermark ws.ts
  declares in the auth frame is monotonic except at the modelled epoch resets
  (`replay_source: "none"`, logout); (3) a verified peer never flips to
  unverified — only a real departure clears it; (4) a teardown frame for a
  superseded attempt never tears down the newer session.
- RED (each control reverted before commit):
  - ids — model pushes every received id without deduping →
    `npx vitest run tests/unit/connection.model.test.ts` →
    `Counterexample: [Connect,Receive(id=2,seq=0),Receive(id=2,seq=0)]`,
    `expected [ 2 ] to deeply equal [ 2, 2 ]`
  - seq — model takes each frame's seq verbatim instead of `max` →
    `Counterexample: [Connect,Receive(id=1,seq=1),Receive(id=1,seq=0),Disconnect,Connect]`,
    `expected 1 to be +0`
  - verified — model keeps a peer the resync roster dropped →
    `Counterexample: [Connect,Supersede(channel=10,live),Resync(dropPeer=true)]`,
    `expected [] to deeply equal [ 3 ]`
  - aborted attempt — stale teardown retargeted at the live channel →
    `Counterexample: [Connect,Supersede(channel=10,stale)]`,
    `expected null to be 10`
  - resume replay — resume handshake reverted to `auth_ok` + `ready` with no
    replayed events (the pre-Codex-P2 shape) →
    `Counterexample: [Connect,Receive(id=1,seq=1),Disconnect,Connect]`,
    `expected [ 1 ] to include 2`, plus
    `invariant family "resumeReplay" was never exercised`
- GREEN: `npx vitest run tests/unit/connection.model.test.ts` →
  `Test Files 1 passed (1) / Tests 2 passed (2)`; `npm test` →
  `Test Files 194 passed (194) / Tests 5275 passed (5275)`.
- Numbers: seed `20260830` (a non-integer `OWNCORD_MODEL_SEED` override
  throws rather than reaching fast-check), `numRuns` 150, `maxCommands` 30,
  `size: "large"` → ~2.2k generated commands and ~1080 invariant checks per
  run of the file; 120 ms of test time, 0.83–0.92 s wall for the file. The
  full client suite measured 10.8 s and 11.9 s on two runs of the same tree,
  so its run-to-run spread is larger than this file's whole cost and no
  meaningful delta can be quoted. A second test asserts every invariant family
  was actually reached, counting only the non-trivial case for each (a resume
  declaring `last_seq > 0`; a verification check that survived a command other
  than the one that wrote it), so a family that degrades to its no-op form
  fails instead of silently passing.
- Verified against HEAD: `fast-check ^4.9.0` and the property-test conventions
  are as the spec says. Three details were resolved against the code:
  - The handshake has two wire shapes and they are not interchangeable.
    `handleFreshConnect` writes `auth_ok` (`replay_source: "none"`) then
    `ready`; `reconnectWriteReplay` (`serve.go:593`) writes `auth_ok` with the
    tier then the missed events and **never a `ready`**, and
    `reconnectPrecheck` returning false is what falls through to the full
    ready. The epoch-1 fixtures record exactly that: `fresh-connect.json` is
    `auth_ok(none)` → `ready` → …, `resume-replay.json` is `auth_ok(buffer)` →
    `presence` → `chat_message` → `presence`, with no `ready` anywhere. The
    model drives both shapes, and `ready` never travels without the `auth_ok`
    that precedes it on the wire (Codex P2 on #1455).
  - The design's `RegisterNow` has no client-side symbol — it is the server's
    hub registration, and the client-visible effect is the
    ready-snapshot/queued-frame redelivery the OC-0328 and OC-0242 guards
    handle.
  - The design's "aborted voice attempt" is reachable from the connection
    layer through the stale `voice_leave` guard in the dispatcher
    (OC-0031/OC-0033/OC-0311), not through `LiveKitSession`'s join
    generations, which need a real LiveKit room.

#### Evidence — item 9 (machine-readable contract drift)

- Branch `feat/b3-6-contract-drift` from `dev` `75d64dd4`; commits: `f5f467ed`
  feat(b3-6): contract drift — generated route, table and config-key indexes
  (tool, three blocks, wiring), plus this evidence commit.
- The drift check is `make docs-verify`, which reduces to
  `go run ./cmd/gendocs` then `git diff --exit-code ../docs/api.md ../docs/schema.md ../docs/server-configuration.md`, both from `Server/`. `make` is not on PATH on this machine, so the three controls below ran that pair directly; `node scripts/run.mjs --list` shows `check:server` running exactly those two steps.
- RED (a), a stale committed block — one row deleted from the route index and
  staged, then the pair above: the diff puts the deleted `GET /api/v1/health`
  row back and `git diff --exit-code` exits 1.
- RED (b), a route added without regenerating — a throwaway
  `r.Get("/gendocs-red-proof", handleInfo(cfg))` in `api/router.go`, then the
  pair: the header line goes from "111 routes." to "112 routes." and a
  `GET /api/v1/gendocs-red-proof` row appears; exit 1.
- RED (c), a config key documented nowhere — the hand-written `voice.quality`
  row removed from `docs/server-configuration.md`, then `go run ./cmd/gendocs`
  alone: `gendocs: config index: 1 config key(s) are documented nowhere under "## Config Key Reference" in ../docs/server-configuration.md … voice.quality`, exit status 1, and no document written.
- GREEN, all three controls reverted (`git status` clean): the same pair exits
  0; `npx prettier --check .` → "All matched files use Prettier code style!";
  `.githooks/pre-commit` run by hand over the staged change → exit 0 with the
  generator's own log lines in its output.
- Numbers: **121 routes** (`chi.Walk`; the floor of 100 and the admin-route
  guard are carried over from the absence contract, the latter tightened to
  require a real `/admin/api/` subroute so the `/admin/*` mount catch-alls
  cannot satisfy it alone), **32 tables**, **56 config keys**, **0 undocumented keys at HEAD** — the hand-written reference
  already named every koanf tag, so no documentation fixes were needed.
  Generated blocks: three, adding 134 + 45 + 67 lines to their documents.
  Output is byte-identical across two consecutive runs.
- Verified against HEAD: the plan's pointer to `docs/deployment.md` is wrong —
  that document has no configuration table; the reference table is
  `docs/server-configuration.md` "## Config Key Reference", and the key index
  went there. `sqlc` exposes no catalog at HEAD (`Server/sqlc.yaml` declares no
  plugins and no vet rules; its schema source is `migrations/`), so the
  migrated in-memory schema is the catalog: `db.Open(":memory:")` plus
  `db.Migrate`, then `sqlite_master` and `pragma_table_info`. `schema_versions`
  is **included** rather than excluded, along with `sqlite_sequence` and the
  FTS5 shadow tables behind `messages_fts` — they are what the migrations
  create, and a change to any of them is a schema change worth seeing in the
  diff. The route index is generated from the **`otel,wazero` build**, not the
  default one: `/metrics` mounts only when `telemetry.PrometheusHandler()`
  returns non-nil (`api/router.go:431-437`), which needs `-tags otel` and
  telemetry enabled at runtime, so the tool calls `telemetry.Init` the way
  `main.go` does with the Prometheus exporter and every invocation passes
  `-tags otel,wazero` (Makefile, `run.mjs`, the hook, the block header lines,
  the `CLAUDE.md` row; `ci.yml` inherits it through `make docs-verify`). The
  tool refuses to run when that handler is absent, so the default build cannot
  quietly generate a short index. Nothing under `Server/api` or `Server/admin`
  carries a build constraint, so `wazero` adds and removes no route; it rides
  along so one build serves the repository. The `sqlite_stat*` tables are
  **excluded**: `db.Migrate` runs `ANALYZE`
  after applying the migrations, so they carry planner statistics rather than
  schema, and `sqlite_stat4` exists only because the current
  `modernc.org/sqlite` build has STAT4 — including them would fail this drift
  check on an unrelated driver bump. `cmd/gendocs/main.go` imports `db` for that catalog, so it takes a
  `boundary` row in `DBImportAllow` and `server-boundaries.md` was regenerated
  with it (50 importers, was 49); the dbinventory block is otherwise untouched
  and still has no automated drift check of its own.

#### Evidence — item 5 (fuzz seeds)

- Branch `feat/b3-6-fuzz-seeds`; commits: `aee0b2b` test(b3-6): fuzz seeds —
  epoch-1 corpora for every target, protocol + predicate-parity fuzz targets,
  plus the commit adding this block
- RED: `go test ./ws -run FuzzHandleMessageDecode -v`, with
  `handleMessageDecode` temporarily returning `false` for a valid `chat_send`
  envelope → `--- FAIL: FuzzHandleMessageDecode/chat-send-fanout-a-chat_send`
  (`ok = false, but json.Unmarshal into an envelope succeeds`). 3 failures,
  all three fixture-derived corpus entries; **0 of the 22 hand-written
  `f.Add` seeds caught it** — the corpus is what covers the real wire.
  Second control: `CanViewChannel` letting an administrator see an archived
  channel → `--- FAIL: FuzzPredicateParity/ready-owner-voice-archived`
  (`= <nil>, want channel is archived`) plus 30 seeds. Both reverted.
- GREEN: `go test ./api ./auth ./db ./permissions ./plugin ./service ./storage ./ws -run Fuzz -v`
  → 20 `--- PASS`, corpus entries listed by fixture name
  (`FuzzHandleMessageDecode/voice-join-e2ee-leave-a-voice_e2ee_offer`, …).
  Full gates: 4 build variants, `go vet ./...`, `go test -race ./...`,
  `go test -tags deadlock -count=10 -timeout=40m ./ws/`, `golangci-lint run`
  (0 issues), `npm run check:docs`. **`-timeout` matters there:** ten
  sequential `ws` runs under the deadlock tag take ~592 s, inside Go's default
  600 s only on an otherwise-idle box — a run competing with other `go test`
  work was killed at 601.393 s, a wall-clock artifact and not a lock-ordering
  failure. Anything that raises `-count` on this package must raise
  `-timeout` with it.
- Numbers: **17 → 21** `Fuzz*` targets; **3 → 21** with a committed corpus;
  **6 → 114** corpus files (**108 added**). Per target: HandleMessageDecode 17,
  CommandPayloads 25 (the 15 distinct `c2s` command frames of the 11 epoch-1
  journeys, placeholders concretised, plus a minimal valid payload for each of
  the 10 command types no journey exercises), AuthPayload 2,
  PredicateParity 12, ValidateFileType 6,
  SanitizeFTSQuery / EffectivePerms / EffectiveChannelPerms / ParseMentionTokens
  4 each, SanitizeUploadFilename +4 (2 → 6), ValidateAvatarURL /
  ValidateDisplayName / ValidateUsername / ValidateRelativePath /
  ValidateShortcode / SanitizeFilename / ParseParticipantIdentity /
  ParseRoomChannelID 3 each, ValidatePasswordStrength 2. Replay cost: every
  target ≤ **0.02 s** (`FuzzSanitizeFTSQuery`, which runs each entry through a
  real FTS5 `MATCH`); every other ≤ 0.01 s. 30 s of `-fuzz` on each of the
  three new targets found nothing (1.09 M, 0.74 M and 34.9 M execs); a 20 s
  pass over each previously corpus-less target is written up in the item's
  report, which is also where anything it turned up is recorded.
- `make fuzz` was red at HEAD on `FuzzParseMentionTokens`, which still asserted
  the Unicode fold (`strings.ToLower`) that OC-0131 replaced with
  `db.LowerASCII` in `parseMentionTokens` — a stale assertion in the target,
  not a production defect. Before: `FAIL … spelling "Ł" is not lowercased`
  after 66,255 execs (3.69 s, empty corpus and cleared fuzz cache). After the
  one-line swap, the same 30 s `-fuzz` run on a cleared cache is `PASS` at
  1,159,227 execs, and the corpus replay stays green.
- Verified against HEAD: the item's four pointers were all stale, and each was
  resolved rather than followed. (1) `ws/messages.go` holds only outbound
  builders plus `parseChannelID`, so "protocol parsing" is
  `handleMessageDecode` (`ws/handlers.go`) for the envelope and
  `commandConstructors` (`ws/command.go`) for the payloads; every constructor
  in that map is a pure `func(userID, reqID, raw)`, so `FuzzCommandPayloads`
  reaches them directly — no hub, no DB, better than the fallback the brief
  allowed. The table registers **26** constructors and all **26** are now
  seeded: 15 come from the journeys, 10 have a minimal valid corpus payload
  because no journey exercises them, and
  `TestCommandPayloadSeedsCoverEveryConstructor` fails if a newly registered
  command arrives without one (RED: removing
  `FuzzCommandPayloads/voice-mod-kick-target` fails the test with
  `1 of 26 … have no seed or corpus entry: [voice_mod_kick]`).
  `auth` is **not** in the
  table — `authenticateConn` (`ws/serve_auth.go:40`) decodes it before the hub
  knows the client — so its entries moved to their own headless target,
  `FuzzAuthPayload`, which pins that no numeric handshake field accepts a value
  its Go type cannot hold (a `last_seq` of `-1` wrapping to 2^64-1 would let a
  reconnecting client skip its whole replay). That decode is inline behind a
  live socket read and a session lookup, so the target mirrors the struct and
  says so rather than changing production to expose it; 30 s of `-fuzz` on it
  found nothing (1.37 M execs). (2) `permissions.Subject` has no wire form, so there is
  nothing to round-trip; `FuzzPredicateParity` is the honest reading —
  every B2-5 predicate against the raw two-layer bit formula written out
  longhand, plus the two definitional identities (`CanAdmitSession` ≡
  `CanViewChannel`, `CanType` ≡ `CanSendMessage`). Writing the formula out
  surfaced one ordering worth stating: `Subject.Has` applies the Administrator
  bypass **before** the zero-permission refusal, so an administrator holds the
  empty mask while `HasPerm(_, 0)` is false. Parity is the target's purpose, so
  the oracle keeps that ordering and
  `TestSubjectHasZeroPermIsAdminBypassed` records the divergence as observed
  behaviour. **Call-site survey at HEAD: nothing can reach it.** `Subject.Has`
  is called from `permissions/predicates.go` (five fixed masks) and from
  `Checker.HasChannelPerm` / `HasChannelPermBatch`; every leaf caller across
  `api/`, `service/` and `ws/` names a `permissions.*` constant or an OR of
  two. The only variable-forwarding chains are `ws/deps.go`
  (`requirePerm`/`hasPerm`), `service/permission.go` and
  `checker.go:156`, and their callers are all named constants — the one
  table-driven site, `ws/voice_controls.go:148`, has exactly two rows
  (`UseVideo`, `ShareScreen`). Both `RequireChannelAccess` overloads have no
  production caller at all. No production change was made. (3) There is no pure upload
  admission function at HEAD — `handleUpload` inlines `MaxBytesReader`,
  `ParseMultipartForm`, `DetectContentType` and `store.Save` — so no
  `FuzzUploadAdmission` was created (it would have needed production code);
  upload admission is covered by corpora for `FuzzValidateFileType` (6 real
  magic headers) and `FuzzSanitizeUploadFilename` (+4 attachment names).
  (4) There is no recovery-token parser: backup codes exist only as
  `[]string{}` in `totp_handler.go`'s response, and
  `(*PartialAuthStore).Consume` is a mutex-guarded map lookup with an expiry
  check, not a parse — skipped, and no file under `auth/`, `service/` or
  `api/auth_*` was touched.

#### Evidence — item 8 (Docker smoke nightly on `dev`)

- Branch `feat/b3-6-docker-smoke-nightly`. Code commit: `3f27447e` feat(b3-6):
  nightly docker smoke on dev — its own workflow, plus a timeout on ci.yml's
  verify job. A temporary commit added a `push:` trigger so the proof run
  below could happen at all — neither of the file's real triggers can fire
  before it is on the default branch — and was dropped once the run was
  recorded.
- **Deviation from this item's text, and why.** The item says `ci.yml` gains
  the `schedule:` trigger and that the job is deliberately "not moved to its
  own workflow file". It is moved. Scoping a schedule inside `ci.yml` means
  skipping the other jobs with a job-level `if:`, and **a skipped job still
  writes a check run** — observed on `main`'s tip, where
  `Tauri Full Build (${{ matrix.os }})` reports `conclusion: skipped` beside
  the green required contexts (`gh api repos/J3vb/OwnCord/commits/main/check-runs`).
  A scheduled run is attached to the **default branch's tip SHA** whatever it
  later checks out, so each nightly would stamp `skipped` onto `main`'s tip
  under seven of the twelve `contexts` in `b0-dev-branch-protection.sh`:
  Client Static Checks, Client Unit Tests, Rust Unit Tests, Repository
  Hygiene, Docs & Ledger Consistency, Client E2E (Playwright), Client E2E
  (parity subset, blocking). `scripts/verify-gate-evidence.mjs:45-61` keeps
  the latest attempt per name and treats `skipped` as not-success, and
  `release.yml`'s `gate-evidence` job runs it on the tagged SHA and gates
  every build and publish job — so a release cut from a `main` tip that had
  sat through one nightly would be refused, for a reason that has nothing to
  do with that commit. `nightly-docker-smoke.yml`'s single job matches no
  required context, so it cannot overwrite gate evidence, and `ci.yml`'s job
  selection is untouched.
  (`server-build-test` would have escaped: a skipped matrix job reports under
  the unexpanded name, which is not a required context. `admin-e2e` is not
  required, and the three `Analyze` contexts come from CodeQL default setup.)
- **When the nightly actually starts.** A scheduled workflow only ever runs
  from the default branch, so this file does nothing on `dev`: the first
  nightly fires after it reaches `main` at the next release merge. Until
  then, `workflow_dispatch` is the only way to run it.
- Contents: `on: schedule` (`0 3 * * *`) + `workflow_dispatch`; a
  `concurrency` group with `cancel-in-progress: true`;
  `permissions: contents: read`; one job, `nightly-docker-smoke`, with
  `timeout-minutes: 20`; `actions/checkout` on the same pinned SHA `ci.yml`
  uses, with `ref: dev`, since a schedule reads the file from `main`; a
  "Print checked-out revision" step logging `github.event_name`,
  `github.ref` and `git rev-parse HEAD`; then the buildx, build and
  `Server/scripts/docker-smoke.sh` steps of `server-docker-build`, verbatim.
  Both jobs carry a one-line keep-in-sync comment naming the other.
- Numbers: `ci.yml` +3 lines (a two-line comment and `timeout-minutes: 20`);
  `nightly-docker-smoke.yml` 68 lines; the shared buildx/build/smoke steps
  diff clean between the two files, ignoring comments.
- GREEN: `npx prettier --check` on both workflows → "All matched files use
  Prettier code style!"; `actionlint` on all five workflows → clean;
  `node scripts/check-workflow-guards.mjs` →
  `4 guard(s) present in 1 metered workflow(s)`, and its `--selftest` → all
  assertions pass;
  `npm run check:docs` → passed; `node scripts/run.mjs --list` → picks the new
  workflow up in the actionlint file list, which is built from `git ls-files`.
- Proof, observed: run `33301623322`
  (https://github.com/J3vb/OwnCord/actions/runs/33301623322), workflow
  "Nightly Docker Smoke", fired by the temporary push trigger that was dropped
  from the branch afterwards. "Print checked-out revision" logged
  `event=push ref=refs/heads/feat/b3-6-docker-smoke-nightly`, and
  `git rev-parse HEAD` printed `75d64dd412b6e81a19ae0cb2e09ecfc84d6f644e` —
  `origin/dev`'s tip (`75d64dd4`) at the time of the run, not the branch's,
  which is the whole point of `ref: dev`. Build and boot-smoke green. Re-read
  it with
  `gh run view 33301623322 --log | grep -A2 "Print checked-out revision"`.
- The one behavioural difference from `ci.yml`'s job: a scheduled run has
  `github.ref = refs/heads/main`, so the buildx `type=gha` cache is scoped to
  the default branch while the layers written into it come from `dev`'s tree.
  The cache is content-addressed, so a layer is only ever reused where its
  content matches — the mismatch costs cache hits, never correctness.
- A red nightly is the repository owner's: GitHub emails a scheduled
  workflow's failure to the account that owns it. No new process, just where
  it lands.
- Verified against HEAD: the item states "`concurrency` and `timeout-minutes`
  are already present (B1-7's guard check enforces both)". Only `concurrency`
  was. `scripts/check-workflow-guards.mjs` audits only the workflows in
  `METERED`, which is `[".github/workflows/claude.yml"]` — it never looked at
  `ci.yml` — and `server-docker-build` was one of seven jobs of eleven there
  with no `timeout-minutes`, so it inherited GitHub's 360-minute default.
  Hence the one-line `ci.yml` change; the new workflow declares its own.

#### Evidence — items 2 + 3 (hub simulation + fault-injected transport)

- Branch `feat/b3-6-hub-sim`; commits: 3c5d75f8 `test(b3-6): seeded hub
simulation and fault-injected transport (items 2 and 3)`, 932b5d6b the docs
  commit carrying this block, and the review-fix commit `fix(b3-6): hub sim
— deterministic topic limiter for exact replay, a floor on the step mix,
auth-frame-wins under transfer, wire-seed mixing` (it carries this text, so
  its own SHA is in the PR, not here).
- Oracle (the doc comment of `Server/ws/hub_sim_test.go`, written before the
  driver): I1 per-connection strictly increasing `seq`, never on the high or
  low queue; I2 a live connection yields exactly the seqs allocated for its
  audience, in order — nothing missing, extra or twice — with the unread count
  checked after every step; I3 a resume from watermark W is replayed exactly
  `{s in (W, S] : channel 0 or READ-allowed}` where S is the hub seq at the
  instant `registerNow` ran (atomic with the snapshot under `seqMu`) and every
  audience seq above S arrives live; I4 `h.seq` advances only for a frame that
  reached the ring; I5 an evicted W is refused a replay and registered as the
  full-ready fallback; I6 a replaced socket's late teardown reports
  `replaced=true`. The one narrowing: frames the dying socket still held above
  W are delivered again by the replay — a cross-connection duplicate the
  max(seq) ack makes by design — and the oracle allows exactly that.
- RED (a): inverted the I2 head check →
  `hub simulation: seed 1 step 28: I2: c3 conn 2: expected seq 4 next, got 4 (owed [4 6 8 9])`
  plus the replay line, on 20/20 seeds.
- RED (b): `OWNCORD_SIM_SEED=1 OWNCORD_SIM_STEPS=200 go test -race -count=1 -run '^TestHubSimulation$' ./ws/`
  → `seed 1 step 28: I2: c3 conn 2: expected seq 4 next, got 4` — the same
  step, the same frame.
- RED (c): `FaultSchedule{Drop: 1}` (silent, no tail cut) on the resumed
  connection's wire →
  `seed 1 step 121: I2: c6 conn 3: owed [45 46 47 48 49] but only 0 unread frame(s) remain (W=44)`
  on 20/20 seeds. With `DropTail` instead, the same drop is a socket death and
  correctly invisible: the client resumes from W and the replay repairs it.
- RED (d, extra): replay snapshot and `registerNow` outside one `seqMu`
  section with a 1 ms gap →
  `seed 1 step 100: I2: c3 conn 3 holds 33 unread frame(s) but is owed 34`
  on 19/20 seeds — the registerNow-gap class `hub_register_race_test.go` pins,
  found by the generated orderings rather than a hand-written interleaving.
- GREEN: `go test -race -count=1 -run '^TestHubSimulation$' ./ws/` →
  `ok github.com/J3vb/OwnCord/Server/ws 2.258s`.
- Exact replay (review fix): the topic limiter is frozen to a per-channel
  count (`FreezeTopicLimiterForTest`), the racing burst is aimed only at the
  resuming client's own audience, its frames are pulled into the wire at
  attach time, and a resume within the burst's reach of the ring's eviction
  boundary is not raced — so every figure on the stats line is a pure
  function of the seed. Proof, three runs of
  `OWNCORD_SIM_SEED=1 OWNCORD_SIM_STEPS=10000 go test -race -count=1 -v -run '^TestHubSimulation$' ./ws/`:
  `seed 1: 10000 steps, seq 4500, map[bursts:508 channel:300 cut:142 dm:1285 fallback:751 fresh:22 global:1975 kicked:38 recipients:940 resume:710 shed:1630]`
  three times, byte-identical. What still varies between runs is the
  scheduler's interleaving inside a racing reconnect step — how many of the
  racing seqs land in the replay burst rather than the live queue (420, 424
  and 425 in earlier runs) and how many resumes are observed overlapping a
  broadcast at all (`raced`), both printed on a second line — so a model
  defect that depends on that split replays only probabilistically; run the
  seed with `-count`.
- Floor (review fix, Codex P2 on #1458): `TestHubSimulation` aggregates the
  per-seed stats and requires `global`, `channel`, `recipients`, `dm`,
  `resume`, `bursts` (a resume that got a replay with a burst requested),
  `fallback`, `fresh`, `cut` and `kicked` each ≥ 1 across the default run —
  every one a function of the seed — plus `raced`, a resume where a
  broadcast allocated a seq while the registration goroutine had not yet
  been observed to return. That overlap is the scheduler's, so `raced` lives
  on the second (scheduler-decided) line, not the stats line, and is floored
  only in aggregate across the 20 seeds: the default run has 179 bursts and
  178–179 of them were observed overlapping in three measured runs
  (registerNow makes two slog syscalls before the goroutine can return), so
  an all-miss run is a scheduler or lock change, not luck. Skipped, with a
  log line, for `OWNCORD_SIM_SEED` or fewer than 20 seeds; totals logged.
  RED: reconnect weight set to 0 →
  `hub simulation: "resume" never happened across 20 seeds x 200 steps — the step mix no longer reaches it`
  (and `bursts`, `fallback`, `fresh`); goroutine joined before the burst →
  `hub simulation: "raced" never happened across 20 seeds x 200 steps — the step mix no longer reaches it`;
  both restored.
- Numbers: 8 clients, 3 channels, ring 48, normal queue 12; default 20 seeds ×
  200 steps in 2.3 s under `-race` (CI budget: under 10 s); `make sim` = 20 ×
  10,000 steps in 16.5 s (18 s wall with compile) under `-race`; per seed at 200 steps ≈ 13
  buffer resumes, 5 evicted-ring fallbacks, 12 fresh reconnects, 4 wire cuts,
  1–3 overflow kicks on about half the seeds, ~105 seqs; at 10,000 steps per
  seed ≈ 4,500 seqs, 700 resumes, 750 fallbacks, 140 cuts, 40 kicks, 300
  channel frames allocated and ≈1,630 shed by the frozen limiter;
  `BenchmarkReconnectStorm-32` 1590 ops, 702,410 ns/op for 50 resumes (≈14 µs
  each), 608,031 B/op, 954 allocs/op. Gates on the fix commit: `go vet ./...`
  clean; `go test -race ./ws/` → `ok 119.767s`;
  `go test -tags deadlock -count=10 -timeout 60m ./ws/` → `ok 586.646s`;
  `golangci-lint run` → 0 issues; `npm run check:docs` passed; prettier
  clean. (Before the fix: the four build variants clean, deadlock ×10
  `ok 594.098s`, `go test -race ./...` every package ok.)
- Not simulated (the driver's five steps only): hub-originated frames —
  `hub.Run()` is never started, the driver is the sole allocator; tier
  selection is always "buffer", so the db tier, `mustFullResync` and
  visibility resyncs never interleave with a resume; `c.allowed` is the
  driver's own map (every text channel plus synthetic DM ids), not
  `computeAllowedChannels`, so permission variance is out of scope
  (`hub_register_test.go` covers the denial branch); there is no `writePump`,
  so I1's high/low-queue check is vacuous today — nothing in the step mix
  emits a priority frame; no voice supersession, no concurrent allocators.
- Epoch harness: no use added. `TestEpoch1Fixtures` reads real sockets with
  expects interleaved across two connections, so a lag would wait for frames
  the journey has not produced yet (a deadlock) and any drop, duplicate or
  reorder changes the frame list the fixture pins; only the identity schedule
  is harmless, and that proves nothing. `NewFaultConnForTest` stays exported
  for item 4's client model and for a network-pattern proxy if one is needed.
- Verified against HEAD: there is no ack message — the only ack is `last_seq`
  on the next auth frame — so the simulation's ack step is the client reading
  frames and advancing max(seq); the headless pattern expresses
  reconnect-transfer faithfully because `reconnectRegister` (the snapshot and
  `registerNow` under one `seqMu` section) is exported as-is, not
  re-implemented, and the fresh/fallback paths call the same `registerNow`
  handleFreshConnect does; no production file changed
  (`newTestHub`/`openTestDB`/`seedOwnerUser`/`seedTestChannel`/`seedTestUser`
  in `hub_test.go` now take `testing.TB` so the benchmark can share them). The
  shared rules' `go test -tags deadlock -count=10 ./ws/` overruns `go test`'s
  default 10-minute timeout on a 16-core desktop (601 s, "test timed out
  after 10m0s" with a goroutine dump that is not a detector hit); the gate
  needs `-timeout 60m`.

#### Evidence — item 6 (benchmarks and baselines)

- Branch `feat/b3-6-benchmarks`, rebased onto `feat/b3-6-hub-sim` tip
  `84568330` so `BenchmarkReconnectStorm` is on the base; commits: 2b313730
  `test(b3-6): benchmarks and the bench-baseline script (item 6)`, ec8ef24a
  `docs(b3-6): recorded bench baseline 2026-08-30 and the item 6 evidence
block`, plus the review-fix commit carrying this text (its own SHA is in the
  PR, not here).
- The six, one `_test.go` per package touched: `PermissionInvalidation`,
  `BroadcastFanout`, `ReplaySelection`, `ReconnectStorm` (`ws/hub_bench_test.go`),
  `ReadStateWrite` (`service/readstate_bench_test.go`), `UploadAdmission`
  (`api/upload_bench_test.go`). Each drives a real entry point —
  `RefreshChannelVisibility`, `deliverBroadcast`, `EventRingBuffer.EventsSince`,
  `reconnectRegister`, `ChannelService.HandleChannelFocus`,
  `sanitizeUploadFilename` + `storage.ValidateFileType` — with setup outside the
  timer and `b.ReportAllocs()`.
- RED (guard 1, the name is gone): `BenchmarkReplaySelection` renamed to
  `BenchmarkReplaySelectionRenamed`, then
  `BENCH_COUNT=1 ./scripts/bench-baseline.sh` →
  `bench-baseline: expected benchmark(s) missing from the run: ReplaySelection`
  / `renamed or deleted. Restore the name, or edit EXPECTED in` /
  `scripts/bench-baseline.sh on purpose. No baseline written.`, exit 1 and no
  file written. Name restored.
- RED (guard 2, the row is gone but the name is not): `quietLogs(b)` removed
  from `BenchmarkReconnectStorm` so its result line is corrupted by the hub's
  own log output, then `BENCH_COUNT=1 ./scripts/bench-baseline.sh` → guard 1
  passes (the raw line still starts with `BenchmarkReconnectStorm-`), benchstat
  warns `parsing iteration count: invalid syntax` and exits 0, and guard 2
  fires: `bench-baseline: benchstat produced no row for: ReconnectStorm` /
  `the benchmark ran but its result line was unparseable —` / `No baseline
written.`, exit 1. The committed baseline's checksum was unchanged across the
  run. Restored.
- RED (no truncation on a render failure): the benchstat pin temporarily set to
  `v0.0.0-00010101000000-000000000000`, then
  `BENCH_COUNT=1 ./scripts/bench-baseline.sh` →
  `go: golang.org/x/perf/cmd/benchstat@…: invalid version: unknown revision
000000000000`, exit 1, and the committed baseline unchanged (4593 bytes, same
  md5 before and after). The document renders into the temp directory and is
  `mv`-ed onto its path only after both guards pass. Pin restored.
- GREEN (guardrail): `./scripts/bench-baseline.sh` →
  `bench-baseline: wrote ../docs/plans/b3-bench-baseline-2026-08-30.md`,
  64 s wall at `-count=6` — inside the ~5 minute budget the item sets.
- GREEN (smoke): `go test -run '^$' -bench '^Benchmark(PermissionInvalidation|ReadStateWrite|BroadcastFanout|ReplaySelection|UploadAdmission|ReconnectStorm)$' -benchmem -benchtime=1x ./...`
  → all six ran, one iteration each: `BenchmarkUploadAdmission-32 1 5600 ns/op`,
  `BenchmarkReadStateWrite-32 1 145300 ns/op`,
  `BenchmarkReconnectStorm-32 1 347200 ns/op`,
  `BenchmarkPermissionInvalidation-32 1 947800 ns/op`,
  `BenchmarkBroadcastFanout-32 1 5500 ns/op`,
  `BenchmarkReplaySelection-32 1 4000 ns/op`.
- Numbers — benchstat medians over `-count=6` at ec8ef24a, go1.26.7
  windows/amd64, Ryzen 9 7950X3D. Full table in
  [b3-bench-baseline-2026-08-30](b3-bench-baseline-2026-08-30.md):

| Benchmark              | sec/op       | B/op    | allocs/op |
| ---------------------- | ------------ | ------- | --------- |
| PermissionInvalidation | 884.2µ ± 6%  | 121.0Ki | 3601      |
| ReconnectStorm         | 428.0µ ± 9%  | 592.2Ki | 952       |
| ReadStateWrite         | 54.59µ ± 12% | 5.599Ki | 163       |
| ReplaySelection        | 14.82µ ± 14% | 31.35Ki | 10        |
| BroadcastFanout        | 3.390µ ± 1%  | 992.0   | 2         |
| UploadAdmission        | 260.9n ± 4%  | 56.00   | 3         |

- Verified against HEAD: (a) `BenchmarkReconnectStorm` is on the base, so the
  expected set is six, as the item's base note allows. (b) `golang.org/x/perf`
  publishes no semver tags — `proxy.golang.org/golang.org/x/perf/@v/list` is
  empty — so the pin is the newest resolvable version, the pseudo-version
  `v0.0.0-20260825160852-19be9d8e6c70`, run through `go run` and deliberately
  absent from `go.mod`. (c) `newTestHub` already took `testing.TB`; the three
  `service` seed helpers the read-state benchmark reuses (`newTestDB`,
  `seedRole`, `seedChannel`) took `*testing.T` and were widened to `testing.TB`,
  which every existing caller still satisfies — no production file changed.
  (d) `go test` prints a benchmark's name and padding _before_ running it, so
  the hub's per-registration `INFO` line landed inside the result line and
  benchstat dropped three of the six from the table without failing; the
  benchmarks now point the default logger at `io.Discard` for their duration
  (`quietLogs`), which is the one line added to the hub-simulation item's
  `BenchmarkReconnectStorm`. (e) `HandleChannelFocus` skips a no-op read-state
  write, so a repeated focus by one user measures the skip; the benchmark
  focuses a distinct pre-seeded user per iteration to stay on the write branch.
  (f) Review round 1: the document is rendered into the temp directory and
  `mv`-ed onto its path only after both guards pass, so a benchstat failure can
  no longer truncate the committed baseline; and the expected-name loop runs a
  second time over the rendered table, because a result line corrupted from
  inside the benchmark still starts with the benchmark's name and so satisfies
  the raw-output guard while benchstat silently drops the row.

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

**Evidence — settings/audit family, 2026-08-31** — branch
`feat/b3-8-settings-family` from `dev` `528ae264` (the B3-5 finisher's
squash). The B3-2 pattern:

- **Characterization**: the admin surface was already pinned —
  `admin/api_test.go`'s eleven `TestAdminAPI_*Settings*` rows (GET shape,
  PATCH happy path, invalid body, unknown key, mixed keys, every
  whitelisted key, empty payload, both require_2fa preconditions, invalid
  boolean, the unrelated-key gate) are the family's characterization file
  and stayed green untouched through the extraction. The service seam adds
  its own: `service/settings_test.go` (nine `TestSettings_*` rows) pins
  the same policy at the service plus the service-only contracts
  (`ErrNotFound` wrap, audit rows, multi-key apply).
- **Interface/service**: `service.SettingsService` — `List`, `Patch`
  (whitelist, boolean normalization, the require_2fa preconditions
  including the TOTP census and the unrelated-key guard, atomic apply,
  one audit row per changed key), `Setting`. `db.ApplySettings` is the
  handler's raw upsert loop as one hand-written transactional wrapper —
  the raw SQL left the handler for `db/`, where it belongs. Response
  messages are wrapped with `%.0w` so the pinned bodies stay prefix-free.
- **Thin handlers**: `handleGetSettings`/`handlePatchSettings` decode,
  delegate and map `ErrBadRequest` → 400; the whitelist copy in
  `admin/types.go` is gone. `MaintainBackups` reads `backup_schedule`
  and `backup_retention` through the service. The hub's settings cache
  consumes a required consumer-side `ws.SettingsReader`
  (`HubOptions.Settings`, refusal pinned in
  `TestNewHub_RequiredCollaborators`); production wires
  `Services.Settings`, the test-hub helpers default it over the test
  database.
- **Allowlist diff**: `admin/handlers_settings.go` and
  `ws/hub_settings.go` stop importing `db` — both rows deleted (the
  B3-5 finisher's import pin is gone with the reads themselves). The
  backup pair takes the forecast `boundary` disposition:
  `backup_maintenance.go` (backup mechanics only; settings via the
  service) and `handlers_backup.go` (VACUUM INTO, WAL checkpoint,
  close-and-swap restore own the handle). `settings-ops` disappears
  from the move targets.
- **Importer count**: 60 → 59 files import `db` above the domain layer
  (admin 16 → 15); dispositions 28/18/15 → 24/18/17 move/adapter/boundary
  (tool summary, re-derived).

**Evidence — channel family part 1 of 3, 2026-08-31** — branch
`feat/b3-8-channel-family` from `dev` `63c87df8` (family 1's squash). The
channel family is the largest (seven `move` rows spanning admin and the
hub's read paths), so it lands as three reviewable PRs — the same
reviewability rationale B3-5's two-responsibility cap recorded — part 1
here (S-03 + S-04 + admin CRUD), part 2 the override CRUD, part 3 the
`ws` read rows:

- **S-03, test-first**: one rune/normalization contract for channel
  name/topic/category in `service.cleanChannelMeta` —
  `cleanTextBounded` like every sidebar-rendered field, bounds counted
  in runes (pinned with multibyte names at the service seam AND the
  admin surface), name 100 = `MaxGroupDMNameLen` (now a checked fact,
  `TestChannelMeta_SharesTheGroupDMNameCap`), topic 1024 (the client's
  own input cap), category 100. The admin surface previously enforced
  no length at all.
- **S-04, test-first**: `ResolveGuildChannel` is the one non-DM
  resolution policy; `TestS04_DMAndMissingChannelAnswerIdentically` was
  written RED against the permissions path's 400 "DM channels do not
  support permission overrides" — which confirmed exactly what the
  channels path's 404 conceals (A-2026-08-02) — and is GREEN with both
  resolvers delegating. The two old tests pinning that 400 are
  re-pinned to the corrected contract.
- **Service**: `ChannelService` gains the admin CRUD with its audit
  rows, OC-0158 post-commit tails and the OC-0035
  archive-before-eviction delete ordering (pinned by a callback
  observing archived=1 mid-delete); the audit-log page read joins
  `SettingsService.AuditLog` (settings/audit family owns it).
- **Allowlist diff**: `admin/handlers_channels.go` `move` → type-only
  `adapter`; `admin/handlers_channel_perms.go` keeps `move` (override
  CRUD) with resolution via the service. 24 → 23 `move`,
  18 → 19 `adapter`; channel `move` targets 7 → 6.
- **Characterization**: the existing `TestCreateChannel_*` /
  `TestPatchChannel_*` admin rows stayed green through the extraction
  (byte-identical bodies via `%.0w`-wrapped service errors);
  `service/channel_admin_test.go` and the `s03_`/`s04_` surface files
  are the family's new pins.

**Evidence — channel family part 2 of 3, 2026-08-31** — branch
`feat/b3-8-channel-family-2` from `dev` `c0ede584` (part 1's squash). The
override CRUD's policy moves behind the service:

- **Service**: `service/channel_perms.go` — the union escalation guard
  (`requireGrantableChannelOverride`, deliberately stricter than
  role.go's `requireGrantable`: clearing an existing deny is a grant, so
  the guard runs against the union of written and existing bits), both
  hierarchy rules (role strictly below the actor; a per-user override
  may not target a member ranked at or above), mask clamping to defined
  bits, the write/clear/audit sequences, and the invalidation scope
  (role-holders with the full-flush fail-safe; the one target user for
  the per-user layer). `Store` gains the six override CRUD methods.
- **Handlers**: the four mutation handlers and the GET become thin
  (decode → delegate → invalidate-then-refresh from the returned
  `OverrideResult`); the shared preamble is one helper. Error bodies
  stay prefix-free via `%.0w`.
- **Chokepoint residue**: the two `HasAdmin` rows
  (`admin.requireGrantableOverride`, `admin.requireManageableUser`)
  moved to their service symbols with the code
  (`service.requireGrantableChannelOverride`,
  `service.(*ChannelService).resolveOverrideUser`) — an entry relocating
  with its function, not growth.
- **Characterization**: all twenty-plus existing
  `Test{Get,Put,Delete}Channel*Permission_*` surface rows — escalation,
  the zero-mask union case, hierarchy on both layers, mask clamping,
  unknown targets, invalidation and audits — stayed green untouched
  through the extraction; `service/channel_perms_test.go` covers the
  seam itself (and what the `service` coverage floor demands).
- **Allowlist diff**: `admin/handlers_channel_perms.go` `move` →
  type-only `adapter`; 23 → 22 `move`, 19 → 20 `adapter`. The channel
  family's admin rows are done — only the five `ws` read rows (part 3)
  remain.

**Evidence — channel family part 3 of 3, 2026-08-31** — branch
`feat/b3-8-channel-family-3` from `dev` `d5f88266` (part 2's squash). The
hub's read paths lose their direct handle calls behind consumer-side
seams — the owner chose the SettingsReader pattern over making
`HubOptions.Services` required (which would have rewired the degraded
fixture half the `ws` suite builds) or deferring to the B3 exit:

- **Seams** (`ws/readers.go`): `VisibilityReader`, `ReadySnapshotReader`,
  `MemberPayloadReader`, `DispatchReader`, `StaleVoiceCleaner` — one per
  concern, each naming exactly the reads its consumer may make (the
  stale-voice pair is deliberately separate: the write does not belong on
  a snapshot seam). `HubOptions.Readers` is required and validated;
  production wires `DBReaders(database)` at the composition root; the
  test helpers default it over the test database, so no test changed
  semantics. `applyConnectStatus`'s status write stays on the raw handle
  (connection family, not a read).
- **Service seam sharpened in passing**: `service.RequireDMNotBlocked`
  took the full `Store`; it now takes its own three-read `DMBlockReader`
  (`IsGroupDM`, `GetDMRecipient`, `IsEitherBlocked`), which the ws
  `DispatchReader` carries — both packages state their real contracts.
- **Measurement honesty**: seam calls run through interface fields the
  syntactic walker cannot see, so the five rows are type-only by
  construction — the boundaries doc's caveat paragraph now names the
  seams as the deliberate instance of that shape, and each row's reason
  names its seam. The seam interfaces, not the walker, are the
  authoritative read list for those files; later B3-8 families narrow
  individual seams onto their services without touching the consumers.
- **Allowlist diff**: `deps.go`, `handlers.go`, `hub_broadcast.go`,
  `hub_visibility.go`, `serve_ready.go` all `move` → seam-named
  `adapter`; `readers.go` added as a type-only `adapter` row. **The
  channel family is complete** — `channel` disappears from the move
  targets: 22 → 17 `move`, 20 → 26 `adapter`.
- **Characterization**: no behavior change anywhere — the frozen
  `TestEpoch1Fixtures` and the whole `ws` suite run unchanged (the seams
  are satisfied by the same handle); `TestNewHub_RequiredCollaborators`
  gains the Readers refusal case.

**Evidence — invite family, 2026-08-31: vacuous, and why** — the plan's
family order names `invite` after the channel family, but there is no
invite work to do and never was. Checked against B3-0's own inventory at
`d383d8c` (the commit that created it): the only `move` rows that touch
invites were `api/auth_handler.go` and `admin/setup_handler.go`, both
assigned to the **auth** family (register burns an invite; first-run setup
creates one), and `api/invite_handler.go` was `adapter` from the first
measurement — its CRUD already went through `service.InviteService`, which
predates B3 entirely. B3-2 moved the auth rows it could reach. So the
family list's `invite` entry was a discovery artifact, not a debt: nothing
is deleted, nothing is deferred, and the count does not move. Recorded here
rather than silently skipped, because a family that disappears without a
reason is indistinguishable from one that was forgotten.

**Evidence — upload family, 2026-08-31** — branch
`feat/b3-8-upload-family` from `dev` `227ae08c` (the channel family's
completion). Two `move` rows, both in `api`, and the last raw SQL escape
above the domain layer:

- **Service** (`service/upload.go`): `UploadService` with three methods —
  `Record` (the attachment row for already-stored bytes), `Resolve` (the
  lookup plus the soft-delete tombstone, which is what makes a deleted
  message's files stop being servable _to everyone_, administrators
  included — it is deliberately not in `Authorize` for that reason), and
  `Authorize` (DM participation ahead of the admin bypass; the unlinked
  file private to its uploader except while an avatar column points at
  exactly its URL; the M-2 refusal of a legacy NULL-uploader row;
  READ_MESSAGES for a guild channel). The bytes stay with the transport —
  multipart parsing, MIME sniffing, image measurement and the FileStore
  write are HTTP and filesystem work with no domain decision in them.
- **The raw SQL escape is gone**: `api/upload_handler.go`'s bare
  `QueryRowContext("SELECT deleted FROM messages WHERE id = ?")` is now
  `db.IsMessageDeleted`, a hand-written narrow read beside its siblings in
  `db/message_queries.go` (still not `GetMessage`, whose SELECT list
  carries every column — the original comment's reasoning survives the
  move). It reports `found` separately, so "no message row" stays
  distinguishable from "not deleted" and keeps falling through to the ACL.
  No sqlc query or migration change, so generation drift stays clean.
- **Authz chokepoint**: the `HasAdmin` row moved with its symbol,
  `api.serveFileAuthorize` → `service.(*UploadService).Authorize`, same
  class (`admin-perimeter`) and same single bound call. The rule's own
  fixture tests used that row as their worked example, so they now use
  `admin.logStreamAuthorize` — a row that is still live and the same shape
  (plain function, one bound `HasAdmin`).
- **Thin handlers**: `handleServeFile` resolves and authorizes through the
  service and maps the two refusals with one `writeFileAccessError` helper
  (404 and the single "you do not have access to this file" body, so no
  branch leaks which rule refused); `handleUpload` and `handleUploadAvatar`
  record through `Uploads.Record`. `MountUploadRoutes` takes the
  `*service.UploadService` in place of the `*service.PermissionService` and
  keeps its fail-fast nil check.
- **Characterization**: `api/upload_handler_test.go`,
  `upload_handler_deleted_message_test.go` and `avatar_handler_test.go` are
  the family's characterization file and stayed green with **no assertion
  touched** — the only edits are the two mount-helper lines that name the
  new service. `service/upload_test.go` adds nine service-seam rows
  (tombstone covers administrators, avatar public only while in use, legacy
  row denied, DM participation binds administrators, guild READ_MESSAGES,
  refusals indistinguishable, `Record`'s unlinked row). Both negative
  contracts were mechanically proven: with the admin bypass moved ahead of
  the DM check, `DMParticipationBindsAdministratorsToo` fails
  (`error = <nil>, want ErrForbidden`); with the tombstone branch disabled,
  `TombstonedMessageHidesItsAttachments` fails the same way. Both mutations
  reverted.
- **Allowlist diff**: `api/upload_handler.go` and `api/profile_handler.go`
  `move` → `adapter` (db types while serving the bytes and shaping
  responses; the services own the calls). **`upload` disappears from the
  move targets**: 17 → 15 `move`, 26 → 28 `adapter`. Remaining targets:
  auth 7, connection 2, voice 3, user 2, role 1.
- **Floors**: `service` 69.5 → **69.8** in this PR (the raise the seam's own
  tests earned). `db` stays at 79.3: `IsMessageDeleted` is new db-package
  code, so the profile dipped to 79.1 until `db/message_deleted_test.go`
  covered it and restored 79.5 — a restore, not a deliberate raise, the same
  call the settings family made for `ApplySettings`. Cross-package coverage
  does not count (CI runs no `-coverpkg`), which is why a db method reached
  only from `service` needs a db-package test of its own.

**Evidence — role family, 2026-08-31** — branch `feat/b3-8-role-family`
from `dev` `227ae08c`, synced onto `18deb38` (the upload family) before
merge. One inventory row and one ledger finding, and the
row is the first since B3-2 to be **deleted** rather than downgraded:

- **OC-0374, test-first.** `ReorderRoles` wrote the manageable roles to
  positions N, N-1, … 1 — a gapless block ending at 1 — while
  `CreateRole`'s default placement takes the highest free slot strictly
  below the actor. After a single reorder no such slot existed for any
  actor below the owner, so role creation failed permanently, and the
  refusal told the admin to "reorder existing roles first", which
  re-compacted to the same block. Positions are now spread with the
  largest stride that still fits every role below the actor
  (`actor.Position / (len(orderedIDs)+1)`, at least 1), which keeps the
  order and the uniqueness, is stable under repeated reorders, and makes
  reordering the default four under the owner reproduce their shipped
  80/60/40/20. RED first, both rows of
  `service/role_reorder_spacing_test.go` against the unfixed code:
  `CreateRole after a reorder: bad request: no free position below your
rank — reorder existing roles first`. Two existing tests asserted the
  dense block (`service/role_test.go`'s `TestReorderRoles_NormalizesPositions`,
  `admin/handlers_roles_test.go`'s `TestAdminAPI_ReorderRoles_NormalizesAndBroadcasts`)
  and are re-pinned to the spread with the finding cited — a mandated
  contract change, not a weakened assertion. The ledger's own suggested
  fix is the same stride, arrived at independently — but a stride is not
  enough, which Codex's review caught: `actor.Position / (N+1)` collapses to
  1 once N approaches the actor's position, so a server with 50 roles under
  the owner still compacted to 50…1 and stranded every slot from 51 up,
  leaving the defect exactly where a big hierarchy needs it fixed. The
  spacing is proportional instead — the k-th role from the bottom lands at
  `actor.Position * k / (N+1)`, using the whole range (50 roles land on
  98, 96, … 2). Identical for the counts a normal server has, so both
  re-pins below stand unchanged; `TestReorderRoles_SpreadsAcrossTheWholeRangeAtHighRoleCounts`
  pins the high-count case and fails against the stride version with
  `highest managed position = 50 with 50 roles`.
- **The reads.** `handlers_roles.go` held the last two. The pre-update
  `GetRoleByID` existed only to compare names for the rename fan-out and
  duplicated a row `UpdateRole` already reads: `UpdateRole` now returns a
  `RoleUpdateResult` (`PermsChanged`, `Renamed`), so the handler asks for
  nothing extra and **one query disappears** rather than moving. The
  `broadcastRoles` list reads through `RoleService.AllRoles`, the
  unscoped list the `roles_update` fan-out ships; `ListRoles` stays the
  actor-scoped panel view and the two are deliberately not
  interchangeable.
- **Allowlist diff**: `admin/handlers_roles.go` stops importing `db`
  altogether, so its row is deleted — `role` leaves the move targets and
  the table loses a file: 60 → 59 importers, 15 → 14 `move` (measured after
  merging the upload family, which landed as #1481 while this branch was
  open and took the count 17 → 15 itself). Remaining targets: auth 7,
  connection 2, voice 3, user 2 — every one of them outside the family list
  B3-8 set out, which is the B3 exit question, not this PR's.
- **Characterization**: the admin role suite is the family's
  characterization file and every assertion stands except the one the
  finding mandates; `service/role_test.go` gains the `Renamed` and
  `AllRoles` rows.

**Evidence — message/read-state family, 2026-08-31** — branch
`feat/b3-8-message-family` from `dev` `227ae08c`. Like invite, this family
is **inventory-vacuous**: no `move` row names `message` or `read-state`,
because the message paths went behind `MessageService` before B3 began and
what remains in `db/` is the persistence layer itself. What the family
does carry is the three ledger findings the plan assigned to it, and they
are its whole content. Each is the same shape — a guard one sibling writer
already had and this one lacked:

- **OC-0323** (the one the B3 exit gate names). `mark_read`/`channel_focus`
  read the channel's newest message id and wrote it back two round trips
  later with `mention_count = 0`, so a mention raised in that window was
  wiped while `last_message_id` still pointed behind the mentioning
  message: an unread mention with no badge, and nothing that recomputes
  one. `db.MarkChannelReadAtLatest` computes the watermark inside the
  writer statement, so a message committed before it is covered by
  `last_message_id`, and one committed after it finds
  `IncrementMentionCounts`' own `last_message_id < msgID` guard true.
  Both are single-writer statements, which is what makes the pair atomic.
  `UpdateReadState` stays for the send path, which already holds the exact
  id it means. The ledger's suggested fix is this query, arrived at
  independently.
- **OC-0357.** `sanitizeFTSQuery` dropped every separator except `-`
  instead of folding it to a space. `messages_fts` tokenizes on those
  separators — `user_id` is indexed as `user` and `id` — so dropping the
  underscore asked for `userid`, which exists nowhere in the index: any
  query containing `_`, `.`, `@`, `/`, an apostrophe or a colon silently
  matched nothing. Every non-alphanumeric rune folds to a space now, which
  is both what the index expects and what keeps FTS5's operator grammar
  inert; a new test drives ten operator strings through and requires each
  to be harmless rather than merely unmatched.
- **OC-0358.** `EditMessage`'s UPDATE was keyed on id alone, so an edit
  racing a delete rewrote a tombstone and reported success — the caller
  then broadcast `chat_edited` for a message every client had already
  replaced. It carries `AND deleted = 0` now, the guard OC-0284 gave
  `SoftDeleteMessage` and `SetMessagePinned`, and the losing edit surfaces
  as `ErrNotFound`.
- **Revert-proofs**, all three mechanical: OC-0323 with the write pointed
  back at a snapshot (`read state is (last_message_id=3, mention_count=0):
the mention for message 4 was cleared`); OC-0357 and OC-0358 red before
  the fix (`SearchMessages("user_id") found nothing`; `EditMessage on a
deleted row: err = <nil>, want ErrNotFound … Content:resurrected
Deleted:true`).
- **Generated code**: one new sqlc query and one guard added to an
  existing one, regenerated through the `db-change` skill;
  `make sqlc-verify` clean on the committed tree. No migration.
- **Inventory**: unchanged, as expected for a family with no rows — the
  fixes live inside `db/` and `service/`, the two layers that may import
  `db` freely.

**Evidence — user family, 2026-09-01** — branch `feat/b3-8-user-family`
from `dev` `a6fca0c`. Two rows, one on each side of the process:

- **The admin panel's reads** (`admin/handlers_users.go`) — the stats tile,
  the paginated member table and the two single-user lookups the PATCH flow
  makes around its mutations — go behind `UserService`: `ServerStats`,
  `ListAll`, `Get` and `GetWithRoleName`. Two contracts moved with them and
  are pinned at the seam: a missing user is `ErrNotFound` rather than the
  raw wrapper's `(nil, nil)` that every caller had to remember to check, and
  the role name on a user response is best-effort — a user whose role row is
  gone is still returned, because the panel must be able to see and fix
  exactly that user. `admin/types.go`'s response builder loses the
  `GetRoleByID` it made itself; the mutations were already
  ModerationService's and RoleService's, so the reads were all that was left.
- **The connection teardown's one write** (`ws/serve_pumps.go`) — stamping
  the user offline when their last pump exits — goes through a new
  `DisconnectMarker` seam in `ws/readers.go`, deliberately its own interface
  rather than a method on a reader because it writes. `HubReaders` gains it
  as a required field, and `TestNewHub_RequiredCollaborators` now also
  refuses a _partial_ bundle, so a future family adding a seam cannot leave
  an older construction site handing the hub a nil to dereference on the
  first connection that needs it.
- **The admin constructor stops growing.** `NewAdminAPI` took its services as
  four positional parameters; every family that moved an admin handler added
  one, and the auth family would have added a fifth to a 12-parameter
  signature with ~210 call sites. It takes the `*service.Services` the caller
  already holds instead. A nil bundle, or a nil service inside one, stays the
  fail-closed case the handlers already implement — the rows that pin that
  behaviour construct exactly that and still pass.
- **Allowlist diff**: both rows `move` → `adapter` (`handlers_users.go` keeps
  `UserWithRole`/`User`/`Role` in its response shapes; `serve_pumps.go` keeps
  the pure `StatusOffline` const). **`user` leaves the move targets**: 14 →
  12 `move`, 28 → 30 `adapter`. Remaining: auth 7, connection 2, voice 3.
- **Characterization**: the admin user suite is unchanged apart from the
  mechanical constructor sweep; `service/user_admin_reads_test.go` adds the
  not-found, orphaned-role, pagination, hub-count-is-the-caller's and
  fail-loud rows.

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

**Evidence, 2026-08-30** — branch `fix/b3-9-findings` from `dev` `75d64dd4`;
PR #1454 to `dev`, merged 2026-08-30 as `123c0899`. Five of the six findings
land here; **OC-0323 is not in this PR** — it rides B3-8's message/read-state
family (the fix is a shared read-state query, the family's own
characterization file is the right home) and stays `open`, low, tagged B3.

- **Shape.** Test-first, one fix commit per finding (the RED test and the
  fix, plus that finding's `// known:` row flipped to the fixed behaviour in
  the same commit), then one ledger commit closing all five with their
  pre-squash SHAs — a commit cannot cite its own SHA, and the
  `check:docs` count claims can only be re-derived once, so the flips and
  the four count-carrying documents move together in `8fdb51ed`.
  Revert-proof per finding: the fix's source hunk reverse-applied onto the
  committed tree, the test run RED, restored, run GREEN (lines below); then
  `.superpowers/verify-fixes.mjs` independently on the four untagged
  commits: `fb1afb8a`, `be37d7ee`, `85d86dc7` PASS at the branch head (red then green on server); `f7015809` PASS at its own tree (`git worktree add … f7015809`) — its reverse hunk no longer applies over `be37d7ee`, which edits the adjacent lines, so the script defers to a hand run there; both runs from a detached worktree so the script's reverse-applies never touched the working tree. The otel-tagged OC-0346 test is invisible to
  that script (it runs the untagged suite), so its proof is the hand run.
- **Gates**, before every commit, as one `set -e` script with no pipes
  (the first ledger flip of the day was made over a red `check:docs` hidden
  behind `| grep` — dropped before push, obs #110): the four build-tag
  variants, `go vet ./...` and `go vet -tags otel ./api/`,
  `go test -race ./...`, `go test -tags deadlock -count=1 ./ws/`,
  `golangci-lint run` (0 issues), `sqlc generate` and `genprotocol` drift
  (clean — OC-0376 adds no query), the otel-tagged test, the frozen
  characterization file, `check:docs`, `check:hygiene`,
  `render-ledger.mjs --check`.
  `go test -count=1 -run TestAuthCharacterization ./api/` green at every
  commit: `3b7716e2`, `775eba50`, `fb1afb8a`, `f7015809`, `be37d7ee`,
  `85d86dc7`, `4b304f6e`, `8fdb51ed`, `1be1eea4` (this block's
  own commit is docs-only).

  | Finding | Commit     | Test                                                                                                                                                                                      | RED line (fix reverted)                                                                                                                                                                                                                                                                    | GREEN                                                                                                            |
  | ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
  | OC-0346 | `775eba50` | `api/recoverer_otel_test.go` `TestRecoverer_PanicLogCarriesTraceID` — `go test -tags otel`                                                                                                | `recoverer_otel_test.go:73: panic record trace_id = "", want the span's 32-hex trace id` (req_id present, 500 returned)                                                                                                                                                                    | `ok api 1.918s`                                                                                                  |
  | OC-0345 | `fb1afb8a` | `admin/middleware_and_spawn_test.go` `TestOwnerOnlyMiddleware_RoleLookupFailureIs503`                                                                                                     | `middleware_and_spawn_test.go:564: status = 403, want 503`                                                                                                                                                                                                                                 | all 8 `TestOwnerOnlyMiddleware_*` `ok admin 1.360s`                                                              |
  | OC-0377 | `f7015809` | `VerifyTOTPFailurePaths/user lookup fails -> 500, challenge kept, attempt not counted`                                                                                                    | `auth_characterization_test.go:787: status = 401, want 500`                                                                                                                                                                                                                                | `ok api 3.281s`                                                                                                  |
  | OC-0378 | `be37d7ee` | `VerifyTOTPFailurePaths/session insert fails -> 500, the challenge and the code survive` + `auth/totp_test.go` `TestPartialAuthStore_Restore*`, `TestUsedTOTPCodeStore_UnmarkAllowsReuse` | `auth_characterization_test.go:843: retry status = 401, want 200` ("invalid or expired two-factor challenge")                                                                                                                                                                              | `ok auth 0.902s`, `ok api 1.522s`                                                                                |
  | OC-0376 | `85d86dc7` | `RegisterPolicyAndFailurePaths/session insert fails -> 500, nothing committed` + `db/coverage_boost_test.go` `TestCreateUserWithInvite_*`                                                 | ``auth_characterization_test.go:462: user row exists after the session insert failed` / `:465: invite use_count = 1, want 0 (transaction rolled back)` / `:467: body = {"INTERNAL_ERROR", "failed to create session"}, want {"INTERNAL_ERROR", "registration failed — please try again"}`` | ``ok db 0.578s` (4/4 `TestCreateUserWithInvite_*`, the happy path now asserts the session row), `ok api 1.487s`` |

- **Negative controls on the exact branch** (HP-2 obs #96): OC-0377 with the
  limiter reservation moved back ahead of the store read →
  `auth_characterization_test.go:799: status = 429, want 401` (the faulted
  attempt was counted); OC-0378 with `Restore` but no `Unmark` →
  `:843: retry status = 401 … "invalid two-factor code"` (the replay
  refusal). Both mutations reverted, rows green again.
- **What changed, per finding.**
  1. OC-0346 — `routerMiddleware`: `telemetry.HTTPMiddleware()` mounted
     ahead of `recoverer`; request-id binding, security headers and the body
     cap keep their relative positions (the file comment now names tracing
     before recovery as part of the ordering property). The test drives a
     panicking handler through the real stack with a real tracer provider
     (`Exporter: "prometheus"`, no network) and reads the slog record.
  2. OC-0345 — `ownerOnlyMiddleware`: `err != nil` → log + 503
     `SERVICE_UNAVAILABLE` "authorization service temporarily unavailable";
     `role == nil` stays 403 "role not found". Not switched to the context
     role: `_RoleNotFound` and `_OwnerPassesThrough` inject only
     `adminUserKey` and are untouched. The new test is whitebox because the
     perimeter reads the role first and would answer its own 503.
  3. OC-0377 — `service.ErrTOTPUnavailable` (`ErrInternal`, "two-factor
     verification temporarily unavailable"); `challengeSecret` splits the
     store error from nil-user/nil-secret; `limiter.Allow(totp_fail…)` moves
     after the store read (authenticate's rule) and still precedes the code
     compare. The row proves "not counted" with ten wrong codes → 401 and an
     eleventh → 429. `per-user failure cap spans challenges` unchanged.
  4. OC-0378 — claim stays atomic and first; on `issueSession` failure
     `usedCodes.Unmark(user, code)` then `partial.Restore(token, claimed)`
     (code first, so a concurrent retry never finds a live token with a dead
     code). `auth.PartialAuthStore.Restore` keeps expiry and failure count
     (an expired challenge stays gone — leaf test); `UsedTOTPCodeStore.Unmark`
     is per (user, code). The same token and the same code then answer 200.
  5. OC-0376 — option **B** (atomic). The client (`Client/src/main.ts`
     `onRegister`) passes `result.token` straight to `wirePostAuth` with no
     token-less branch, so option A (201 without a token) would have needed
     client work; B is one `Store` method: `CreateUserWithInvite` takes the
     session token hash, device and IP and inserts the first session inside
     its transaction through `db.insertSession(ctx, d.q.WithTx(tx), …)` — the
     helper `CreateSession` now shares — no query or migration change (sqlc
     drift clean). `Register` generates the token before the transaction;
     the H-6 cap needs no eviction for a user with no sessions. A session
     insert fault now answers 500 "registration failed — please try again"
     with no user row and `use_count` 0.
- **Codex round** (`1be1eea4`, two P2s on `VerifyTOTP`, both verified
  against the code and fixed test-first): (1) an exhausted `totp_fail`
  window is now refused by the read-only `Check` before the store read and
  the secret decrypt, so rotating IPs cannot drive that work past the cap;
  the atomic `Allow` still records after the read (OC-0377 intact) —
  `api/totp_cap_before_store_test.go`, RED `status = 500, want 429`. (2) A
  verify whose claim loses at `Consume` releases the code it marked, so a
  winner mid-recovery (`Restore`) is not left with a live token behind a
  dead code — `service/auth_lost_claim_test.go` forces the interleaving
  through the store's `GetUserByID`, RED `the losing claim left its code
marked as used`. Codex's security review was refused by its usage limit
  (re-requested once).
- **Frozen set.** `auth_characterization_test.go` changed at exactly the
  three `// known:` rows (OC-0376 ~:452, OC-0377 ~:780, OC-0378 ~:812); no
  fourth row moved. `auth_handler_test.go`, `totp_handler_test.go`,
  `auth_handler_delete_broadcast_test.go`: `git diff 75d64dd4 -- <file>`
  empty.
- **Ledger diff** (`8fdb51ed`): OC-0345, OC-0346, OC-0376, OC-0377,
  OC-0378 `open` → `fixed` with `fix.commit`, `fix.test`,
  `fix.revertProof: pass`; totals **315 fixed / 59 open** → **320 fixed /
  54 open** (3 declined, 1 duplicate, 378). The four count-carrying
  documents (`docs/plans/README.md`, `hp-0-scorecard`, `issue-register`,
  `b0-baseline`) re-derived around every number: 54 open = 1 high, 12
  medium, 41 low; hunts 27 / 26 / 1 (the three `b3-1` records closed);
  53 of the 54 resolve (OC-0323 still the exception); Client 33 / Server 21.
  Issue-register rows OC-0345 and OC-0346 marked fixed with this PR.
- **Coverage** (statements; cover-profile blocks merged per file by range
  with max count, then summed — the B3-2 method): `-coverpkg=./api/,./service/
./api/ ./service/` at `1be1eea4`:

  | File                  | B3-2 (`fe1d11b8`)   | B3-9 (`1be1eea4`)   |
  | --------------------- | ------------------- | ------------------- |
  | `api/auth_handler.go` | 98/114 = 86.0%      | 98/114 = 86.0%      |
  | `api/totp_handler.go` | 54/60 = 90.0%       | 54/60 = 90.0%       |
  | `service/auth.go`     | 240/253 = 94.9%     | 253/266 = 95.1%     |
  | **slice**             | **392/427 = 91.8%** | **405/440 = 92.0%** |

  At `85d86dc7` the slice measured 398/434 = 91.7%: OC-0376 gave `Register`
  its own `auth.GenerateToken` failure branch — unreachable (crypto/rand),
  and a duplicate of the one `issueSession` already carried — so one new
  statement was uncovered while covered statements rose 392 → 398. Commit
  `4b304f6e` folds token generation into one `newSessionToken`
  helper that both `issueSession` and `Register` persist through (behaviour
  identical: the characterization file green before and after), which is
  the row above. Measured again at `4b304f6e`: 402/437 = 92.0%, `service/auth.go` 250/263 = 95.1%; the Codex round's two branches (`Check`, the lost-claim `Unmark`) are covered by their own tests, giving the table's figures. The handler files are untouched by B3-9 and keep B3-2's numbers.

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
- **Ten deadlock passes overrun `go test`'s default 10-minute timeout** (B3-6
  items 2+3): write it as `go test -tags deadlock -count=10 -timeout 60m ./ws/`.
  A "test timed out after 10m0s" goroutine dump is the timeout, not a
  detector hit.
- **`check:docs` counts.** `docs/plans/README.md` is watched; the register's
  row count and the ledger's status counts must agree with it.
