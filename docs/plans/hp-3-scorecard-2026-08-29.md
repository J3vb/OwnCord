# HP-3 — First vertical-slice review scorecard

**Hold point:** HP-3, defined in
[b3-server-architecture-guardrails-2026-08-29.md](b3-server-architecture-guardrails-2026-08-29.md)
§HP-3 (roadmap
[repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md), B3)
**Commits reviewed:** the pre-squash commits of #1450 (B3-2; table below), on top of B3-0 (#1448 = `d383d8c7`) and B3-1 (#1449 = `71d867cb`)
**Measured at:** `fe1d11b8` (the handler-move commit) and `3f0d24ec` (the
after-state inventory), branch `feat/b3-2-auth-slice` off `dev` `71d867cb`
**Measured:** 2026-08-30
**Evidence base:** the plan's B3-0, B3-1 and B3-2 evidence blocks;
[server-boundaries.md](../architecture/server-boundaries.md) §"Auth slice";
[server.md](../architecture/server.md) §D4

**Decision: ACCEPTED — 2026-08-30 by J3vb (repository owner).**

HP-3 asks five questions. Each is answered below with the command that
produces the evidence and what it printed on the measured tree, not with an
assertion. It follows the shape of
[hp-2-scorecard-2026-08-29.md](hp-2-scorecard-2026-08-29.md). Acceptance
authorises B3-3 onward and B3-8's per-family repeats of the pattern; it
claims nothing about beta readiness.

## The commits under review are not on `dev`

`dev` is squash-merge only. The structure HP-3 reviews — one commit per
numbered item of §B3-2, characterization green after each — survives only on
the pull-request ref:

```bash
git fetch origin 'refs/pull/1450/head:pr-1450'
```

| Commit      | §B3-2 item                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `825b406f`  | — B3-1's merge SHA `71d867cb` recorded in the plan                                                                         |
| `448c50f6`  | 1 — `api/auth_deps.go`, the consumer-owned `AuthService` interface; its input/result types in `service/auth.go`            |
| `24ed138d`  | 2 — `service/auth.go`, the orchestration moved verbatim and the `Err*` set; `auth/ratescale.go`                            |
| `fe1d11b8`  | 3 — thin handlers, `MountAuthRoutes` takes the interface, `router.go` builds the service, two `DBImportAllow` rows deleted |
| `3f0d24ec`  | 4 — after-state inventory and graph rows in `server-boundaries.md`                                                         |
| `1077a992`  | 5 — the evidence block                                                                                                     |
| this commit | 6 — this scorecard and the pattern section in `server.md`                                                                  |

## Question 1 — did the slice move behaviour without changing it?

**The proof is the frozen set.** `Server/api/auth_characterization_test.go`
(12 tests, 44 rows) and the 85 tests in `auth_handler_test.go`,
`totp_handler_test.go` and `auth_handler_delete_broadcast_test.go` were
written before a line of the slice moved (B3-1) and did not change here.

```bash
# each pre-squash SHA, in a detached worktree of that exact tree
cd Server && go test -count=1 -run TestAuthCharacterization ./api/
git diff --stat 71d867cb <sha> -- Server/api/auth_characterization_test.go Server/api/totp_handler_test.go
```

| SHA        | Characterization | Frozen files vs `71d867cb` |
| ---------- | ---------------- | -------------------------- |
| `825b406f` | ok 1.860 s       | identical                  |
| `448c50f6` | ok 1.852 s       | identical                  |
| `24ed138d` | ok 1.854 s       | identical                  |
| `fe1d11b8` | ok 1.849 s       | identical                  |
| `3f0d24ec` | ok 1.832 s       | identical                  |

The 85 tests: `go test -count=1 -race ./api/` at `3f0d24ec` — `ok 51.447s`,
the whole package. Of the frozen files, `auth_handler_test.go` and
`auth_handler_delete_broadcast_test.go` changed only where they mount the
routes (one helper line, two direct mounts, one import each, one comment —
`git diff -U0 71d867cb fe1d11b8 -- Server/api/auth_handler_test.go Server/api/auth_handler_delete_broadcast_test.go`);
no assertion or expected value moved.

**The sentinel-mapping table is byte-identical.** Every refusal the handlers
wrote at `71d867cb` — thirty-one distinct (status, code, message) triples —
is now a named `service.Err*` value whose `Error()` is that message and whose
category the one `writeAuthError` switch maps back to that status and code.
The rows that pin them (`RegisterRejectionsAreIndistinguishable`,
`LoginRejectionsAreIndistinguishable`, `LoginFailurePaths`,
`DeleteAccountFailurePaths`, `VerifyTOTPFailurePaths`,
`TOTPManagementFailurePaths`, `RouteRateLimits`) assert status, code and
message with `wantErr` and are green above. The three `// known:` rows
(OC-0376, OC-0377, OC-0378) are still pinned as defects — the slice moved
them, it did not fix them; B3-9 flips each row in the commit that fixes it.

**What did change, recorded rather than hidden** (the plan's B3-2 evidence
block, "Behaviour notes"): five routes that ran a gate before decoding the
body now decode first and let the service run the same gates in the same
order. The only observable difference is a _malformed_ body arriving behind
a gate (locked-out, already-enrolled, unknown challenge): it is refused as
400 where it was refused as the gate's 429/409/401. No row exercises that
input; every well-formed request is byte-identical. `/register` kept its
gate first because two rows pin "403 before any credential is read" — that
is why the interface has a ninth method, `RegistrationPolicy`. The six
authenticated auth routes share one `AuthMiddleware` instance (one
`last_used` throttle instead of six).

**Verdict: PASS** — the frozen behaviour set is unchanged and green at every
commit; the one ordering change is confined to malformed input behind a gate
and is written down.

## Question 2 — did it reduce coupling?

```bash
cd Server && go run ./cmd/dbinventory | tail -2
# before (ad4defc2, B3-0):  51 files import db ... api 12 ...; Dispositions: adapter 17, boundary 6, move 28
# after  (fe1d11b8):        49 files import db ... api 10 ...; Dispositions: adapter 17, boundary 6, move 26
go test -count=1 ./invariants/    # ok — db-import-boundary and TestDBImportAllowIsLive at the new list
```

| Measure                                     | Before (`ad4defc2`)                                                             | After (`fe1d11b8`)                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `db` importers in `api`                     | 12                                                                              | **10**                                                                              |
| `DBImportAllow` `move` rows                 | 28                                                                              | 26                                                                                  |
| `db` symbols the two handlers touched       | 3 types, 2 funcs, 2 sentinels, **10 distinct `*db.DB` methods** (11 call sites) | **none** — `auth_handler.go` and `totp_handler.go` import `auth` and `service` only |
| Interface the handlers call                 | —                                                                               | `api.AuthService`, **9 methods** (`api/auth_deps.go`)                               |
| Where the ten `db` methods live             | the handlers                                                                    | `service/auth.go`, through `service.Store`                                          |
| Handler size (statements, `go test -cover`) | `auth_handler.go` 254, `totp_handler.go` 179                                    | 114 and 60; `service/auth.go` 253                                                   |
| Direction                                   | `api → db` (handlers) beside `api → service → db` (the rest)                    | `api → service → db` for the whole slice                                            |

The full before/after tables are `server-boundaries.md` §"Auth slice —
before-state dependency graph" and §"after-state dependency graph". The
after-state also records what is _not_ met: the plan hoped the handlers would
import neither `db` nor `service`; they import `service` for the interface's
input/result types, the `Err*` categories and `SanitizeText`. The
alternative — an `api`-side copy of every type — would be a second definition
of the same shapes, so the dependency is kept and named.

**Verdict: PASS** — nine methods replace ten database methods plus four
symbols; two importers gone; the rule that proves it (`db-import-boundary`)
is green with the rows deleted in the same commit as the imports.

## Question 3 — did it weaken a B2 contract?

Nothing under `ws/`, `protocol/`, `permissions/` or the fixtures changed on
the branch (`git diff --stat 71d867cb 3f0d24ec -- Server/ws Server/permissions protocol` is empty). The
tests HP-2 accepted, run at `3f0d24ec`:

```bash
cd Server && go test -count=1 -run 'TestEpoch1Fixtures|TestAuth_ProtocolEpoch|TestAbsenceContract_|Parity' -v ./ws/ ./api/ ./service/
```

| Contract                                   | Test                                                                                                                                                                                                                                                                                                              | Result   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Epoch-1 fixtures replay, `auth-failure`    | `TestEpoch1Fixtures/auth-failure`                                                                                                                                                                                                                                                                                 | PASS     |
| Epoch-1 fixtures replay, `fresh-connect`   | `TestEpoch1Fixtures/fresh-connect` (and the other nine: ping, chat-send-fanout, chat-edit-delete, reaction-add-remove, typing, mark-read, dm-send, resume-replay, voice-join-e2ee-leave)                                                                                                                          | PASS ×11 |
| Epoch negotiation matrix                   | `TestAuth_ProtocolEpoch`                                                                                                                                                                                                                                                                                          | PASS     |
| Absence (federation / directory / listing) | `TestAbsenceContract_NoFederationDirectoryOrListingRoutes`, `…WireTypes`, `…ConfigKeys`                                                                                                                                                                                                                           | PASS ×3  |
| Predicate parity                           | `TestSendPolicyParity`, `TestViewPolicyParity` (service); `TestRefreshChannelVisibilityCanSend_Parity`, `TestApplySetChannelID_Parity`, `TestChannelReadAudience_Parity`, `TestChannelSubject_Parity`, `TestVoiceJoinPrecheck_Parity`, `TestVoiceStillAllowed_Parity`, `TestRefreshChannelVisibility_Parity` (ws) | PASS ×9  |

`ok ws 7.658s`, `ok api 1.423s`, `ok service 0.717s`. The auth rate
multiplier moved packages (`auth.SetRateScale`/`ScaledLimit`), and
`api/constants_test.go`'s clamp and floor tests still run through `api`'s
wrappers — `TestSetAuthRateScale_ClampsMultiplier`,
`TestScaledAuthLimit_NeverBelowOne`, `TestPerUserFailureCapsStayUnscaled`
green in the `-race` run above.

**Verdict: PASS** — every B2 contract test is unchanged and green.

## Question 4 — is the pattern repeatable?

Written down as the rule for B3-8 in
[server.md](../architecture/server.md) §"D4 — The vertical-slice pattern":
interface beside the consumer → service owns every decision → handler is
decode, one call, encode → the allowlist row leaves with the import → the
limits and converters move with the code that reads them → the composition
root builds the service after the collaborators it needs.

**The one thing that was awkward, named honestly:** _gate-before-decode._
Six of the nine routes checked something before reading the body — a policy,
a per-user lockout, "already enrolled", a challenge lookup. A thin handler
cannot keep that order without a second interface method per route, and the
interface had a method-count cap. The characterization file settled it
route by route: `/register` had two rows pinning the gate ahead of the body
(a malformed body still gets the policy's 403), so its gate became the ninth
method; the other five had none, decode first, and the corner cases are in
the evidence block. The general rule (D4, step 2): _before writing the
interface, list every statement that precedes the body decode and grep the
characterization file for malformed-body rows per route._ B3-8's families
will meet the same shape (every "confirm your password" route has it).

A smaller cost worth knowing before the next family: thirty-one named error
values, because the pre-slice handlers had thirty-one distinct public
messages and the rows pin them byte for byte. That is the price of
"verbatim"; it is also a list a later phase can consolidate on purpose.

**Verdict: PASS** — the shape is written as steps with the awkward step
named, and every step was exercised once on this slice.

## Question 5 — are the B3-6 guardrails green on the slice's SHA?

B3-6 did not land in parallel: no guardrail PR merged to `dev` between
`71d867cb` and this branch. What exists today, run at `fe1d11b8`:

| Guardrail                                         | State                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-import-boundary` (B3-0, `Server/invariants/`) | **green** — `go test -count=1 ./invariants/` ok with the two rows deleted; `go run ./cmd/dbinventory` exits 0, "0 unlisted"                                                                       |
| Coverage floor (S-06, B3-6 item 1)                | **not yet a gate** — measured by hand instead: slice 392/433 = 90.5% → 392/427 = 91.8% (B3-2 evidence block); the same 392 statements exercised. B3-6 turns the measurement into a check          |
| Hub simulation / fault transport / fuzz seeds     | **not landed** — nothing to run; the slice touches no `ws/` file, so no new surface for them either                                                                                               |
| The full server gate                              | **green** before every commit: four build-tag variants, vet, `-race` (18 packages), `-tags deadlock ./ws/`, `golangci-lint` 0 issues, sqlc/genprotocol drift clean, `check:docs`, `check:hygiene` |

**Verdict: PASS for the guardrail that exists; the rest is B3-6's own exit,
not this slice's.** Recorded so the exit gate's condition 5 can point at
this table and at B3-6's later run on the same SHA.

## Open items carried past HP-3

Recorded, not fixed. None blocks B3-3.

| Item                                                           | State                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC-0376, OC-0377, OC-0378 (B3-1's `// known:` rows)            | **B3-9, now unblocked** — the orchestration they live in is `service.AuthService`; each fix flips its row in the same commit                                     |
| Decode-before-gate corner cases (malformed body behind a gate) | **recorded** in the B3-2 evidence block; not a defect, a shape. If a later phase wants the gate's status back for garbage input, it is one more interface method |
| Handlers import `service`                                      | **accepted** — types and error categories, not persistence; `server-boundaries.md` says so                                                                       |
| B3-1's not-injectable set (crypto failures, post-commit fetch) | **still not injectable** — they sit inside the service now; a `Store` double would reach the post-commit `GetUserByID`, `auth.GenerateToken` still has no seam   |
| Thirty-one auth `Err*` values                                  | **by design** (verbatim); consolidation would be a behaviour change and a later phase's decision                                                                 |
| Coverage floor as a gate                                       | **B3-6** — the per-file block-merge measurement in the evidence block is the method to encode                                                                    |

## What acceptance does and does not authorise

Accepting HP-3 authorises B3-3 (lifecycle extraction), B3-4, B3-5 and the
per-family repeats in B3-8 to proceed with the D4 pattern. It does **not**
claim:

- that the auth slice is bug-free — three known defects are pinned and
  scheduled (B3-9);
- that every handler is thin — ten `api` files still import `db`, each with
  a disposition in `server-boundaries.md`;
- that the coverage floor is enforced — it is measured, B3-6 makes it a
  gate;
- that the error set is final — it is verbatim.

**Signed:** J3vb (repository owner), 2026-08-30 — accepted as drafted. Since
the measurement, B3-9 (PR #1454 = `123c0899`) closed the three pinned defects
(OC-0376, OC-0377, OC-0378) and held the coverage floor (slice 405/440 =
92.0%); nothing above changes. B3-3 may start.
