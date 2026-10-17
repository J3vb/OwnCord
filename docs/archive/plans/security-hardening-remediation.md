# Plan: Remediate security-hardening review regressions

**Status:** COMPLETE — verified 2026-07-23, re-confirmed 2026-08-04 (branch `feat/e2ee-identity-tofu`): every item
has been implemented or superseded. W2-4 and both halves of W3-3 are the last to land.
**W2-4:** DONE 2026-07-23 — `Server/db/attachment_queries.go:111`
`LinkAttachmentsToMessage` links atomically and skips (not fails) already-linked,
non-owned, and missing ids; legacy `uploader_id IS NULL` rows claimable. Locked by
`TestLinkAttachmentsToMessage_SkipsAlreadyLinked` and
`TestLinkAttachmentsToMessage_OwnershipGuard` (`Server/db/attachment_queries_test.go`).
**W3-3:** DONE 2026-07-23 — two halves. (a) **XFF CIDR pre-parse:** `trustedCIDRs` parsed
once at middleware construction into `[]*net.IPNet`; `clientIPWithProxies` takes the parsed
form, `isTrustedProxy` deleted (callers use `ipInNets`), invalid entries warn at startup not
per request. Locked by `TestRateLimitMiddleware_InvalidCIDRWarnsAtConstructionNotPerRequest`;
leftmost-valid XFF fallback + `AdminIPRestrict` fail-closed unchanged. (b) **Update TOCTOU:**
`DownloadAndVerify` returns the trusted hash; new `updater.OpenVerifiedBinary`/`Commit`
verify through one open handle and confirm via `os.SameFile` that the renamed file is the one
verified; O_EXCL 0600 staging refuses pre-planted paths. Locked by
`TestOpenVerifiedBinary_SwapAfterVerifyDetectedAtCommit` + `TestDownloadFile_RefusesPreExistingDest`
(Linux fd/tarball path is CI-verified). Server `-race` + `-tags deadlock` green.
**Owner:** TBD
**Tracks:** code review of branch `fix/security-hardening-review` (2026-07-17)
**Estimated effort:** 2–4 focused days

> **Staleness note (2026-07-23, closes audit A-2026-07-15):** item bodies below
> predate two structural changes — the Postgres backend was deleted outright
> (P1, 2026-07-20) and the `Server/store/` seam was removed in favor of direct
> narrow interfaces on `db` (D3, 2026-07-19). Read `Server/store/postgres.go`
> / `sqlite.go` references as historical; the Postgres halves of W1-3 are moot,
> and its atomic-link half is what W2-4 still needs.

## Why

The `fix/security-hardening-review` branch lands a broad, well-intentioned
security pass (login timing fix, TOTP TOCTOU, X-Forwarded-For spoofing,
LiveKit webhook signature binding, plugin SSRF/DNS-rebinding, WASM CPU
budgets, attachment IDOR, ban authorization, WAF chunked-body inspection,
update-binary re-verification, and several rate limits). A recall-oriented
code review confirmed that most of it is sound, but that several of the
hardening changes introduced new correctness/availability regressions —
verified against the source, not just the diff.

This plan sequences the fixes. It is ordered by severity: availability- and
backend-breaking bugs first, then behavioral regressions, then cleanup. Each
item names the root cause, the fix at the right altitude, the files, and the
verification that must pass. Every new fix ships with tests — several of the
regressions below slipped through precisely because the new security code had
no coverage (repo rule: "Target 80%+ coverage; TDD is the expected workflow").

## Non-goals

- Not a redesign of the plugin runtime, the rate limiter, or the permission
  model — each fix stays local and generalizes only where a bandaid would
  otherwise recur.
- Not reverting the hardening. The security intent of every change is kept;
  only the regressions are corrected.
- Not implementing the Postgres backend beyond what is needed to stop the
  attachment path from hard-erroring (see W1-3).

## Wave 1 — Availability & backend-breaking (HIGH)

### W1-1. Plugin CPU budget must not permanently brick the module

- **File:** `Server/plugin/sandbox_wazero.go` (~line 224, `invokeCommand`)
- **Root cause:** the runtime is built `WithCloseOnContextDone(true)`
  (line 72). The new per-call `context.WithTimeout` wraps `allocate`,
  `command_dispatch`, and `deallocate`, so an expired deadline _closes the
  module_. `inst.module` is only cleared by `platformDeactivate`, so nothing
  re-instantiates it — one over-budget command bricks the plugin for all
  users until admin disable/enable or restart. The budget is wall-clock,
  floored at 100 ms, so any host HTTP call (`httpTimeout` = 10 s) trips it.
- **Fix:** after a `context.DeadlineExceeded` overrun, mark the instance so
  the next dispatch re-instantiates the module (re-run `activateWithRuntime`
  lazily), or reset `inst.module = nil` and re-activate on demand. Separately,
  scope the deadline to the guest CPU call only — do **not** count host-call
  time (host functions should run under the parent ctx, or the budget clock
  should pause during host calls). Reconsider the floor so legitimate work
  isn't killed.
- **Verify:** new test (build tag `wazero`) that (a) a command exceeding the
  budget returns the budget error _and_ a subsequent command on the same
  plugin still succeeds; (b) a command performing a host HTTP call within
  `httpTimeout` is not killed by the CPU budget.

### W1-2. E2EE key rotation drops peers in 7+ participant calls

- **Files:** `Server/ws/voice_e2ee.go` (~line 151);
  `Client/src/lib/livekitSession.ts` (~lines 1317-1349)
- **Root cause:** the `voice_e2ee_offer` limit is 5/sec, but the key holder
  loops over every peer sending one offer each, back-to-back, with no pacing
  and no retry on `RATE_LIMITED`. With 6+ peers, offers to the 6th+ peer are
  rejected and silently dropped — those peers never get the rotated key and
  their audio never decrypts. Fires on join/leave and the 5-minute periodic
  rotation.
- **Fix (choose one, prefer server-side):**
  - Server: exempt the fan-out relay from the tight per-message cap — rate
    limit the _rotation event_ (one budget per rotation) rather than each
    per-peer offer; or scale the limit to channel size.
  - Client: add bounded pacing + retry/backoff on `RATE_LIMITED` so all peers
    eventually receive the offer.
  - Preferred: server distinguishes "offer burst that belongs to one
    rotation" from spam, so a single user still can't spam unrelated offers.
- **Verify:** integration test with 8 voice participants confirming every peer
  receives the rotated key after a join/leave and after a periodic rotation.

### W1-3. Attachment-ownership check breaks Postgres and isn't atomic

- **Files:** `Server/service/message.go` (~line 183);
  `Server/db/queries/*attachment*.sql` + regenerate `dbgen`/`pgdbgen`;
  `Server/store/postgres.go`, `Server/store/sqlite.go`
- **Root cause:** the new per-attachment `GetAttachmentByID` loop (a) calls a
  method that returns `ErrPostgresNotImplemented` on `PostgresStore`
  (`postgres.go:498`), so every attachment-bearing `SendMessage` hard-errors
  on Postgres; (b) is a check-then-link TOCTOU (the race pattern this PR fixes
  elsewhere); (c) is an N+1 query on the hot send path; (d) rejects legacy
  `uploader_id IS NULL` rows and already-linked attachments on retry (W2-4).
- **Fix (right altitude):** delete the loop. Enforce ownership atomically in
  the shared link query — add `AND uploader_id = ?` (and keep
  `AND message_id IS NULL`) to `LinkAttachmentsToMessage`, and return
  `ErrForbidden` when `RowsAffected != len(AttachmentIDs)`. Edit the SQL in
  `Server/db/queries/` and run `make sqlc-generate` (never hand-edit `dbgen`/
  `pgdbgen`); update the SQLite + Postgres migrations as a pair. This makes
  the check atomic, one query, and backend-agnostic, and removes the need for
  the `MemStore.GetAttachmentByID` `(nil,nil)` contortion.
- **Verify:** service tests (SQLite _and_ a Postgres path or a store fake that
  implements the link semantics) covering: own unlinked attachment links;
  another user's attachment is refused; nonexistent id is skipped; already
  linked id is refused; `RowsAffected` mismatch → no message persisted.

### W1-4. Ban authorization guards dead code

- **Files:** `Server/admin/handlers_users.go` (`handlePatchUser`, ~line 112);
  `Server/service/moderation.go`
- **Root cause:** `requireBanAuthority` (BAN_MEMBERS + role hierarchy) is
  wired only into `ModerationService.BanUser`/`UnbanUser`, which have no
  production callers. The live ban path is `handlePatchUser`, which runs
  `UPDATE users SET banned = 1 ...` directly with no BAN_MEMBERS/hierarchy
  check, so any admin-panel actor can ban an equal- or higher-ranked user
  (including the owner).
- **Fix:** route `handlePatchUser`'s ban/unban branch through
  `ModerationService.BanUser`/`UnbanUser` (so the new authorization actually
  runs), or lift `requireBanAuthority` into the handler. Keep the
  admin-IP/admin-auth perimeter; add the permission + hierarchy check on top.
  Move the target-existence check _after_ authorization so a caller without
  BAN_MEMBERS can't enumerate user ids via NotFound-vs-Forbidden.
- **Verify:** handler test — actor without BAN_MEMBERS is refused; actor of
  equal/lower rank than target is refused; owner-rank target can't be banned
  by a lower rank; authorized actor succeeds.

## Wave 2 — Behavioral regressions (MED-HIGH → MED)

### W2-1. Client-update rate limiter shares the auth bucket

- **File:** `Server/api/router.go` (~line 257)
- **Root cause:** it uses the empty-prefix `RateLimitMiddleware` on the shared
  `limiter`, colliding per-IP with `verifyTOTP`, the sensitive endpoints, and
  profile/password. A 30/min auto-poll drains the shared per-IP budget →
  spurious 429s on 2FA and password change.
- **Fix:** give the client-update route a dedicated key prefix via
  `rateLimitMiddlewareWithPrefix(limiter, "client_update:", ...)`, mirroring
  the LiveKit proxy's `"livekit_proxy:"` prefix (`router.go:192`).
- **Verify:** test that hammering `/client-update` to its limit does not 429 a
  subsequent `verify-totp`/password request from the same IP.

### W2-2. ChangePassword reports failure after the password is committed

- **Files:** `Server/service/user.go` (~line 60); caller
  `Server/api/profile_handler.go` (~line 231)
- **Root cause:** `UpdateUserPassword` commits first; if `DeleteOtherSessions`
  then errors, the function returns `ErrInternal`, the caller emits 500, and
  the `password_change` audit entry is skipped. The user is told it failed
  while the new password is live; retrying with the old password fails and can
  trip the password-confirm lockout.
- **Fix:** treat session-revocation failure as a partial success, not a total
  failure. Log + audit the password change, return success with a
  `sessions_revoked`/warning signal the client can surface, or perform a
  bounded compensating retry of `DeleteOtherSessions`. Do not report a 5xx for
  an already-committed change; always write the audit row.
- **Verify:** test that when `DeleteOtherSessions` errors, the audit row is
  still written and the handler does not return a 5xx that implies the
  password is unchanged.

### W2-3. Plugin activation via RegisterCommand breaks in-place upgrades

- **Files:** `Server/plugin/sandbox_wazero.go` (~line 140);
  `Server/plugin/host_commands.go` (~line 36);
  `Server/plugin/registry.go` (`installFromDisk`, `InstallFromZip`)
- **Root cause:** `RegisterCommand` refuses when `existing != inst` by
  _pointer_, but `installFromDisk` replaces `r.plugins[id]`/`r.byName` with a
  fresh `*Instance` without clearing the old command bindings. Re-installing an
  enabled plugin leaves stale bindings that block re-registration; dispatch
  keeps routing to the orphaned old module until restart. The old
  `r.commands[cmd] = inst` overwrote unconditionally.
- **Fix:** compare ownership by plugin identity (name/id), not instance
  pointer — allow the same plugin to re-bind its own command — and/or clear a
  plugin's stale command bindings during reinstall/deactivation before
  re-activation. Preserve the cross-plugin hijack protection (a _different_
  plugin still can't claim an owned command).
- **Verify:** test that upgrading an enabled plugin in place rebinds its
  commands and dispatch routes to the new module; a different plugin claiming
  an owned command is still refused.

### W2-4. Attachment check rejects legit retries and legacy uploads

- **File:** `Server/service/message.go` (~line 191)
- **Root cause:** `att.MessageID != nil → ErrForbidden` means a client retry of
  a send whose first attempt already linked the attachment can never succeed;
  the same branch rejects legacy `uploader_id IS NULL` rows.
- **Fix:** subsumed by W1-3 — the atomic link UPDATE skips already-linked/
  non-owned rows instead of failing the whole send. Decide explicit policy for
  legacy NULL-uploader rows (migrate/backfill vs. treat as unowned).
- **Verify:** covered by W1-3 tests (already-linked id → skipped, not fatal).

### W2-5. XFF right-to-left walk collapses/spoofs on broad trusted CIDRs

- **File:** `Server/api/middleware.go` (~line 227, `clientIPWithProxies`)
- **Root cause:** the walk skips every entry inside `trustedCIDRs`. With a
  broad config (e.g. `trusted_proxies: 10.0.0.0/8` covering LAN clients), the
  real client entry is skipped, the loop exhausts, and it falls back to the
  proxy's own `RemoteAddr` — collapsing all clients into one lockout bucket
  (one user's failed logins lock out everyone), or letting a client at a
  trusted IP forge the key.
- **Fix:** when the walk exhausts without a non-trusted candidate, return the
  left-most _valid_ XFF entry (the furthest-upstream client) rather than
  `RemoteAddr`, so distinct clients keep distinct keys. Document that
  `trusted_proxies` should list only proxy hops, and validate config on
  startup. Pre-parse `trustedCIDRs` into `[]*net.IPNet` once (see W3-3).
- **Verify:** test with `trusted_proxies=10.0.0.0/8`, proxy at `10.0.0.2`,
  two LAN clients `10.5.1.7` / `10.5.1.8` behind it → distinct keys; a spoofed
  leftmost entry from an untrusted RemoteAddr is ignored.

### W2-6. SSRF-hardened dialer loses multi-address fallback

- **File:** `Server/plugin/host_http.go` (~line 115)
- **Root cause:** after validating every resolved IP, it dials only `ips[0]`,
  dropping Happy-Eyeballs/next-record fallback. An allowlisted dual-stack or
  round-robin host whose first record is down now hard-fails.
- **Fix:** loop over the vetted IPs and try each until one connects, keeping
  the "dial only vetted concrete IPs" property. Also remove the redundant
  `rejectPrivateAddrs` pre-resolve at line 68 (keep the cheap `hostAllowed`
  allowlist) since the dial-time resolve+validate is authoritative — saves a
  second DNS round trip (W3-2).
- **Verify:** test that a host resolving to `[unreachable, reachable]` still
  connects via the reachable vetted address; a host resolving to a private IP
  is still refused.

### W2-7. Plugin-broadcast gate omits the block check

- **Files:** `Server/ws/handlers_command.go` (~line 107);
  `Server/permissions/checker.go` (~line 79)
- **Root cause:** `requireChannelBroadcastAccess` routes through
  `RequireChannelAccess`, whose DM branch checks only participant membership,
  while the real send path (`checkSendPermission`) also enforces
  `IsEitherBlocked`. A blocked user's plugin broadcast can reach the person who
  blocked them. It also issues a raw `GetRoleByID` per broadcast, bypassing the
  service-layer permission cache.
- **Fix:** route the broadcast gate through the shared service-layer send check
  (`MessageService.checkSendPermission` or an extracted equivalent) so DM
  block, slow-mode, and future policy apply uniformly and the perm cache is
  used. Avoids a fourth hand-rolled permission helper on `Hub`.
- **Verify:** test that a blocked user's plugin broadcast into a DM is refused.

## Wave 3 — Cleanup, efficiency, hardening depth (LOW-MED)

### W3-1. Updater text-asset cache: add coalescing + negative caching

- **File:** `Server/updater/updater.go` (~line 729, `FetchTextAssetCached`)
- **Fix:** guard refresh with `golang.org/x/sync/singleflight` so a TTL-expiry
  burst issues one outbound fetch; briefly cache errors so an upstream outage
  doesn't re-fetch on every request. Evict superseded keys.
- **Verify:** concurrent cold-cache test issues exactly one upstream fetch.

### W3-2. De-duplicate the update binary hashing

- **File:** `Server/admin/update_handlers.go` (~line 166, `fileSHA256`)
- **Fix:** `fileSHA256` duplicates `updater.VerifyChecksum`'s hashing body and
  re-reads the just-verified binary. Export one hashing helper from the updater
  package (or have `DownloadAndVerify` return the checksum it already computed)
  and reuse it for the TOCTOU snapshot.

### W3-3. Update TOCTOU guard depth + XFF CIDR pre-parsing

- **Files:** `Server/admin/update_handlers.go` (~line 117);
  `Server/api/middleware.go` (`isTrustedProxy`)
- **Fix:** the re-verify narrows but does not close the swap window (verify by
  path, then rename+spawn by path). Real closure needs fd-based verification or
  `O_EXCL` staging in the updater package. Separately, `isTrustedProxy`
  re-parses every CIDR string per call on the request hot path — pre-parse into
  `[]*net.IPNet` once at middleware construction.

### W3-4. Cache-Control header contradiction

- **File:** `Server/api/upload_handler.go` (~line 309) + test at
  `upload_handler_test.go` (~line 733)
- **Fix:** `private, max-age=31536000, no-cache` is self-contradictory —
  `no-cache` forces revalidation, so the year-long `max-age` is dead weight.
  Use `private, no-cache` and update the test assertion.

### W3-5. Restore test coverage lost to the MemStore change

- **File:** `Server/store/memstore.go` (~line 693)
- **Fix:** subsumed by W1-3 (atomic link removes the need for the `(nil,nil)`
  stub). If MemStore keeps attachment stubs, ensure the ownership behavior is
  covered by a store that actually tracks `uploader_id`/`message_id` so the
  IDOR guard cannot silently regress in tests.

## Sequencing

1. **W1** first (availability/backend-breaking). W1-3 unblocks W2-4 and W3-5.
2. **W2** next. W2-5 pairs with the CIDR pre-parse in W3-3. W2-6 pairs with the
   redundant-resolve removal.
3. **W3** last, or fold each item into the related Wave-1/2 change.

## Cross-cutting requirements

- **Tests:** every fix ships with tests (repo rule: 80%+ coverage, TDD). Add
  the missing coverage for the _existing_ new security code too:
  `requireBanAuthority`, `FetchTextAssetCached`, `requireChannelBroadcastAccess`,
  fail-closed `DecryptTOTPSecret`.
- **Build-tag matrix:** W1-1/W2-3 touch `//go:build wazero` code — verify the
  default, `otel`, `wazero`, and `otel,wazero` variants all still build.
- **Two backends:** W1-3 changes queries — edit `Server/db/queries/` + both
  migration trees and run `make sqlc-generate`; do not hand-edit `dbgen`/
  `pgdbgen`. CI runs `make sqlc-verify`.
- **CI gates:** `go test -race`, `-tags deadlock`, `golangci-lint run`,
  `govulncheck ./...` must pass before merge.
