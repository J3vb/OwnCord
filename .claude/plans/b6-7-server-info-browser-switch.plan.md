# Plan: B6-7 — `GET /api/v1/server-info` and the browser-hosting switch

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-7 — `GET /api/v1/server-info` and the browser-hosting switch (roadmap workstreams 6, 16)
**Complexity**: Small
**Drafted**: 2026-09-11 at `dev` `bbda5487`

## Summary

B5-3 already shipped the hard half of this milestone: `browser_client_enabled`
exists, defaults to false, and `Server/api/browser_hosting_posture_test.go`
proves by route-walk **and** wire probe that nothing is mounted and no asset is
served when it is off. What is missing is the other half — **one public endpoint
that answers "what is this server, and is the browser client on"**, which B2-2
deliberately dropped with the note that "B6/B8 add it when they need it".

So this milestone is: add `GET /api/v1/server-info`, returning the server name,
the protocol epoch, and the browser-hosting flag — and nothing else. It is a
REST endpoint only; `protocol/schema.json` carries wire-message constants and
has no notion of HTTP routes, so the `protocol-change` skill does not apply.

## Verify before you implement

Facts established from source at `bbda5487`; re-check any a parallel branch may
have moved.

| Claim                                                             | Status        | Evidence                                                                                                                                    |
| ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No `server-info` endpoint exists                                  | **Confirmed** | Only planning text mentions it; `docs/plans/b2-protocol-trust-compat-2026-08-28.md:297` records it as **dropped** from B2, for B6/B8 to add |
| `/api/v1/info` exists and returns only `{"name"}`                 | **Confirmed** | `Server/api/router.go:591-593` (`infoResponse`), handler `:659-666`, route `:117`                                                           |
| **C-2 forbids a version on unauthenticated endpoints**            | **Confirmed** | `Server/api/router.go:660` comment; locked by `TestAPIV1InfoOmitsVersion`, `Server/api/router_test.go:145-162`                              |
| Version is exposed only behind admin auth                         | **Confirmed** | `Server/api/diagnostics_handler.go:21` via the admin-gated route at `router.go:209-214`                                                     |
| `browser_client_enabled` already exists and defaults to false     | **Confirmed** | `Server/config/config.go:238`; zero value, no `defaults()` entry; pinned by `Server/config/config_test.go:558-580`                          |
| Enabling it currently does nothing but warn                       | **Confirmed** | `Server/api/router.go:66-73` — logs that no route is mounted and no asset served                                                            |
| No browser-serving infrastructure exists                          | **Confirmed** | The only `http.FileServer` in `Server/` is the admin panel, `Server/admin/admin.go:16-17,60`                                                |
| The public-surface allowlist **already claims** epoch is returned | **Confirmed** | `Server/api/auth_posture_test.go:35` says "server name and protocol epoch for the client's handshake (B2-2)" — **false today**, only `name` |
| `ws.ProtocolEpoch` is generated, not hand-written                 | **Confirmed** | `Server/ws/message_types.go:9-11`, from `protocol/schema.json:4` via `Server/cmd/genprotocol/main.go:112-114`                               |
| The endpoint is REST-only, outside the protocol skill             | **Confirmed** | `protocol/schema.json` is 137 lines of wire-message constants; no HTTP routes, no `server_info`                                             |
| The route index in `docs/api.md` is generated                     | **Confirmed** | `chi.Walk` in `Server/cmd/gendocs/main.go:272-284`, written between markers at `docs/api.md:37` and `:212`; **prose is hand-written**       |
| Public routes need an allowlist entry or the posture test fails   | **Confirmed** | `publicSurface`, `Server/api/auth_posture_test.go:32-55` — shrink-only; fails on a stale entry **and** on an undeclared public route        |
| `/api/v1/info` has no rate limiting                               | **Confirmed** | Registered bare at `router.go:117`; contrast `router.go:211,248` which wrap `RateLimitMiddleware`                                           |
| The "chi mount-order" claim is false                              | **Refuted**   | Measured in `docs/plans/b5-community-content-moderation-2026-09-04.md:1188-1202` — chi's radix trie puts `ntStatic` before `ntCatchAll`     |

## Owner decision (2026-09-11)

**The endpoint returns `name`, `protocol_epoch` and `browser_client_enabled`,
and no version or build metadata.**

The milestone's "what is this server" collides with C-2, so the two halves were
separated deliberately:

- **`protocol_epoch` is a compatibility contract.** A browser client must know
  whether it can speak to the server _before_ opening a WebSocket; without it
  the only way to find out is a rejected connection, which is exactly the
  confusing failure B2-2 set out to remove.
- **`version` is a fingerprint.** An exact build lets an attacker match the
  server against a CVE list. An epoch does not: every 1.2.x server reports
  epoch 1.

This also makes `auth_posture_test.go:35` true for the first time — it has
claimed "server name and protocol epoch" since B2-2 while the handler returned
only `name`.

## Patterns to Mirror

| Category         | Source                                              | Pattern                                                                               |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Public route     | `Server/api/router.go:115-118`                      | Register inside the `r.Route("/api/v1", …)` block with no middleware                  |
| Response struct  | `Server/api/router.go:591-593`                      | A named `…Response` struct with explicit json tags, next to its handler               |
| Handler shape    | `Server/api/router.go:659-666`                      | `func handleX(cfg *config.Config) http.HandlerFunc`, `writeJSON(w, http.StatusOK, …)` |
| C-2 annotation   | `Server/api/router.go:660`                          | State the omission and why, at the point where a future edit would undo it            |
| Test helper      | `Server/api/router_test.go:17-42`                   | `setupRouter(t)` — in-memory DB, migrate, `api.NewRouter`, `t.Cleanup`                |
| Public GET test  | `Server/api/router_test.go:124-140`                 | `httptest.NewRequest` + `NewRecorder` + `ServeHTTP` + decode into `map[string]any`    |
| Negative lock    | `Server/api/router_test.go:145-162`                 | Assert the field is **absent**, not merely that the present ones are right            |
| Public allowlist | `Server/api/auth_posture_test.go:32-55`             | One line per public route, naming the guarding test                                   |
| Posture proof    | `Server/api/browser_hosting_posture_test.go:57,103` | Route-walk + mounted-subtree + wire probe, with negative controls                     |
| Config toggle    | `Server/config/config.go:228` (`WAFEnabled`)        | koanf snake_case tag; env var derives mechanically from `OWNCORD_` + path             |

## Files to Change

| File                                         | Action | Why                                                                       |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `Server/api/router.go`                       | UPDATE | `serverInfoResponse` struct, `handleServerInfo`, route registration       |
| `Server/api/router_test.go`                  | UPDATE | Field-shape test, and the C-2 negative lock for the new route             |
| `Server/api/auth_posture_test.go`            | UPDATE | Declare the new public route; fix the stale `/api/v1/info` description    |
| `Server/api/browser_hosting_posture_test.go` | UPDATE | Assert the flag is **reported** while still nothing is **mounted**        |
| `docs/api.md`                                | UPDATE | Hand-written prose block; the route-index row regenerates itself          |
| `docs/server-configuration.md`               | UPDATE | Only if the gendocs block does not already carry `browser_client_enabled` |
| `CHANGELOG.md`                               | UPDATE | Unreleased entry                                                          |
| `docs/plans/b6-*.prd.md`                     | UPDATE | B6-7 row → `in-progress`, then `complete`; Plan cell → this file          |

## Tasks

### Task 1: The endpoint (test first)

- **Action**: Add `serverInfoResponse{Name string; ProtocolEpoch int; BrowserClientEnabled bool}`
  with json tags `name`, `protocol_epoch`, `browser_client_enabled`. Handler reads
  `cfg.Server.Name`, `ws.ProtocolEpoch` and `cfg.Server.BrowserClientEnabled`.
  Register at `/server-info` inside the existing public `/api/v1` block.
- **Test first**: write the field-shape test and the version-absence test before
  the handler, so both go red first.
- **Watch**: `ws.ProtocolEpoch` is **generated**. Read the constant; never
  hard-code `1`, or the next epoch bump silently lies to every client.
- **Validate**: `cd Server && go test ./api/...`

### Task 2: Lock C-2 on the new route

- **Action**: A sibling of `TestAPIV1InfoOmitsVersion` asserting `version` is
  absent from `/api/v1/server-info`, plus the same for any build/commit field.
  Carry the C-2 comment onto the new handler.
- **Why a second test rather than trusting the first**: C-2 is a property of
  _every_ unauthenticated endpoint, not of one handler. A new public route that
  nobody thought to lock is exactly how the invariant erodes.
- **Validate**: temporarily add a `version` field and confirm the test fails.

### Task 3: Declare the public surface honestly

- **Action**: Add the `GET /api/v1/server-info` entry to `publicSurface`, and
  **correct** the `/api/v1/info` entry, which has claimed "server name and
  protocol epoch" since B2-2 while the handler returned only `name`.
- **Validate**: `cd Server && go test ./api/ -run Posture`

### Task 4: Prove the switch still exposes nothing

- **Action**: Extend `browser_hosting_posture_test.go` so that with
  `browser_client_enabled: true` the endpoint **reports** `true` while the
  route-walk and wire probe still find **no** mounted route and **no** served
  asset. Keep the existing default-off tests untouched.
- **Why**: this is the milestone's actual claim — "hosting is off by default and
  exposes no route or asset when disabled". Reporting a flag is not hosting, and
  the test must say so rather than leave the two conflated.
- **Validate**: `cd Server && go test ./api/...`

### Task 5: Documentation

- **Action**: Add the hand-written `### GET /api/v1/server-info` prose block to
  `docs/api.md` beside the existing `/api/v1/info` block at `:2771`. Regenerate
  the route index with gendocs — do **not** hand-edit between the markers.
- **Validate**: `cd Server && go run -tags otel,wazero ./cmd/gendocs` then
  `git diff --exit-code` on the three generated docs; then the `ci-check` skill.

## Validation

```bash
cd Server && go test ./api/...
cd Server && go run -tags otel,wazero ./cmd/gendocs   # never hand-edit gendocs blocks
# Full gate — four build-tag variants plus the deadlock pass. Use the ci-check
# skill, and read the section list, not the exit code (run.mjs fails fast but
# still exits 0).
npm run format
```

## Risks

| Risk                                                                     | Likelihood | Impact | Mitigation                                                                                               |
| ------------------------------------------------------------------------ | ---------- | ------ | -------------------------------------------------------------------------------------------------------- |
| The new public endpoint erodes C-2 later by accretion                    | Medium     | High   | Task 2's absence test; the C-2 comment sits where an edit would add the field                            |
| Hard-coding the epoch instead of reading the generated constant          | Medium     | High   | Task 1 reads `ws.ProtocolEpoch`; a hard-coded `1` survives the next bump and lies silently               |
| Reporting the flag gets mistaken for hosting the client                  | Low        | Medium | Task 4 asserts reported-true **and** nothing-mounted in the same test                                    |
| A new unauthenticated, unrated route becomes a cheap amplification probe | Low        | Low    | Response is three small constant fields; matches `/info`, which is also unrated. Revisit if B6-6 says so |
| `publicSurface` is shrink-only and rejects the addition                  | Low        | Low    | It fails on _undeclared_ public routes; adding the entry is the intended path                            |

## Open questions for the owner

1. ~~**Does `server-info` expose the version?**~~ **Decided 2026-09-11: no.**
   Name, protocol epoch and the browser flag only; version stays behind admin
   auth per C-2.
2. **Should `/api/v1/info` be deprecated now that `server-info` supersedes it?**
   Not taken here — `/info` is public API that deployed clients may call, and
   removing it is a compatibility decision, not a B6-7 one. Left alone.

## Acceptance

- [x] `GET /api/v1/server-info` returns `name`, `protocol_epoch`, `browser_client_enabled` (`TestAPIV1ServerInfoReturnsNameEpochAndBrowserFlag`)
- [x] The epoch is read from the generated `ws.ProtocolEpoch`, not hard-coded (`TestAPIV1ServerInfoEpochTracksTheGeneratedConstant`)
- [x] A test asserts `version` is **absent**, mirroring the C-2 lock on `/info` (`TestAPIV1ServerInfoOmitsVersion`) — **negative-controlled**: injecting a `version` field made it fail with "server-info response must not contain \"version\"", then the injection was reverted
- [x] `publicSurface` declares the route, and the stale `/info` description is corrected
- [x] With hosting enabled, the flag reports `true` while no route is mounted and no asset served (`TestBrowserHostingPosture_EnabledReportsTrueButStillHostsNothing`)
- [x] The route index regenerates via gendocs with no hand-editing — 168 → 169 routes, prose added outside the markers
- [x] `ci-check` green across all four build-tag variants

`docs/server-configuration.md` needed no change: its `server.browser_client_enabled`
row already says the flag hosts nothing in this build.

## Status 2026-09-11

Implemented test-first on `feat/b6-7-server-info`. The three endpoint tests were
written and run red (404) before the handler existed. The C-2 lock was then
verified by injecting a `version` field, watching the test fail, and reverting —
a test that cannot fail would have proved nothing about the invariant it guards.
