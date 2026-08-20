# OwnCord — Test Audit

**Date:** 2026-08-19
**Branch:** fix/test-audit-2026-08-19 (baseline `4ff199e1`, 43 commits of churn since the 08-04 audit)
**Scope:** are the existing tests still correct, and what is missing — all three surfaces. Hybrid depth: mechanical sweep everywhere, deep read in auth / permissions / voice-E2EE / ws hub / rate limits / migrations / Rust proxies+TOFU. Every candidate finding was adversarially verified (refute-by-default) before it was fixed; 40 candidates → 35 confirmed (refuted ones listed in §5 so they are not re-raised), plus 2 manual timezone findings and 12 Stryker-survivor findings.
**Relationship to prior audits:** [audit-test-coverage-2026-07-25.md](audit-test-coverage-2026-07-25.md) (coverage; backlog items 1,2,3,4 closed since) and [audit-2026-08-04-docs-and-coverage.md](audit-2026-08-04-docs-and-coverage.md) (UI flow matrix). Nothing closed there is restated.

## 1. Method

- **Fact collection:** `go test -coverpkg=./... ./...` cross-package coverage + zero-coverage function list; `vitest run --coverage`; a changed-since-baseline table (187 changed source files since `4ff199e1`, 82 with no test change) that scoped the finders.
- **Find + verify workflow:** 7 opus finder agents (one per surface slice: server core, server ws/voice, server auth/permissions, client lib, client stores/UI, Rust, e2e/config), each returning structured findings; every candidate then went to an opus refuter with a refute-by-default prompt. 40 candidates → 35 confirmed, 5 refuted (§5). Two timezone-dependent tests found manually during Stryker dry runs (T-24, T-25).
- **Stryker (bonus signal):** mutation testing over 13 risky client modules — score 67.04%, 595 survived / 108 no-coverage. Each module's survivors became one round-2 finding (T-38..T-49), fixed by a second 12-agent wave (opus on dispatcher/e2eeCrypto/ws/identity/livekitE2EE, sonnet otherwise).
- **Proving tests can fail:** every `missing`-kind fix carried an agent-run RED proof (break the source, watch the new test fail, restore byte-identical, watch green). Three re-proved by hand afterwards, one per surface: `TestSetAuthRateScale_ClampsMultiplier` (clamp ×2 → `scaledAuthLimit(9) = 36, want 18`), `validate_server_url_rejects_unsafe_urls` (https guard → `if false` → panic at update_commands.rs:240), `tests/unit/host-validation.test.ts` (IPv6 `&&` → `||` → 4 failed).
- **Gates:** full ci-check — 4 Go build-tag variants, vet, `-race` (all packages), `-tags deadlock ./ws/`, golangci-lint, sqlc + protocol drift verify, vitest, tsc, eslint, prettier, `cargo test`, clippy `-D warnings` — all green at the end of the branch.

## 2. Findings

49 findings, all **RESOLVED** (0 declined, 0 open). 14 high / 32 medium / 3 low; 19 stale / 30 missing. T-01..23 + T-26..37 from the verified sweep, T-24/25 manual (timezone), T-38..49 Stryker survivors per module.

| ID (T-2026-08-19-…) | Sev | Kind | Finding | Status |
|----|-----|------|---------|--------|
| T-01 | HIGH | stale | `Client/tauri-client/src-tauri/src/commands.rs:315` — The two `fingerprint_validation_*` tests never call `store_cert_fingerprint` (or any production function) — they re-implement the validation loop inside the test body and assert… | **RESOLVED** |
| T-02 | HIGH | missing | `Client/tauri-client/src-tauri/src/secret_store.rs:139` — `set_with`'s two read-back-failure arms — the keyring returning a *different* secret (which must purge the foreign entry) and the keyring returning *no* entry (the mock-store bu… | **RESOLVED** |
| T-03 | HIGH | missing | `Client/tauri-client/src-tauri/src/update_commands.rs:120` — `validate_server_url` — the only guard on the updater's server URL, on a path that downloads and executes an installer — has zero tests; the file's test module covers only endpo… | **RESOLVED** |
| T-04 | HIGH | missing | `Client/tauri-client/src/components/ChannelSidebar.ts:128` — The sidebar-layer TOCTOU guard on the E2EE identity re-pin — pin the key captured BEFORE the async fingerprint compute, never a fresh membersStore re-read — is stated as an inva… | **RESOLVED** |
| T-05 | HIGH | missing | `Client/tauri-client/src/lib/ws.ts:126` — The TS mirror of the Rust cert-TOFU store key, normalizeHostForCertCompare, was never updated (and has no test) for the bracketed-IPv6 collapse that the same bughunt commit adde… | **RESOLVED** **+ source bug fixed** |
| T-06 | HIGH | missing | `Server/api/constants.go:29` — setAuthRateScale / scaledAuthLimit — added since the baseline and the multiplier for every per-IP auth rate limit and the login failure/lockout threshold — have no test at all, … | **RESOLVED** |
| T-07 | HIGH | missing | `Server/auth/totp_encrypt.go:140` — DecryptTOTPSecret's real decryption path — hex decode through AES-GCM Open, including the explicitly documented "Fail CLOSED" branch on authentication failure — is never execute… | **RESOLVED** |
| T-08 | HIGH | stale | `Server/db/session_expiry_test.go:84` — TestMigration031_NormalizesLegacyFormats claims to verify migration 031's one-time normalization pass but executes a hand-copied duplicate of the migration's SQL instead of runn… | **RESOLVED** |
| T-09 | HIGH | missing | `Server/migrations/030_attachments_unlink_on_message_delete.sql:36` — Migration 030 is the only migration in the chain that destroys and recreates a table holding user data, and no test ever runs it with rows present, so its data-copy fidelity is … | **RESOLVED** |
| T-10 | HIGH | missing | `Server/ws/handlers_command.go:83` — The entire success path of the plugin chat_command handler — ephemeral reply, the MessageService.CanPost broadcast gate, and the plugin_broadcast fan-out — has zero coverage, so… | **RESOLVED** |
| T-11 | HIGH | missing | `Server/ws/livekit_webhook.go:50` — No test ever feeds the LiveKit webhook endpoint a validly-signed request, so neither the SDK's signature/body-hash verification nor the participant_joined/participant_left dispa… | **RESOLVED** |
| T-12 | HIGH | missing | `Server/ws/livekit_webhook.go:111` — The OC-0018 "detach from the request context" fix landed on both webhook handlers but only the participant_left sibling got a regression test; the participant_joined side is unt… | **RESOLVED** |
| T-13 | HIGH | missing | `Server/ws/voice_controls.go:148` — The permission gate that blocks enabling a camera without USE_VIDEO or a screenshare without SHARE_SCREEN has no test — its refusal branch never executes in the suite. | **RESOLVED** |
| T-14 | HIGH | missing | `Server/ws/voice_moderation.go:385` — No test asserts that voice_mod_move refuses when the TARGET lacks CONNECT_VOICE on the destination channel — the guard that stops a moderator move from placing someone into a ch… | **RESOLVED** |
| T-15 | MEDIUM | missing | `Client/tauri-client/src-tauri/src/credentials.rs:88` — `with_credential_lock`'s stated poison-recovery invariant — a panic inside one credential command must not permanently wedge every later credential operation — has no test, thou… | **RESOLVED** |
| T-16 | MEDIUM | missing | `Client/tauri-client/src-tauri/src/tofu.rs:87` — `CaptureVerifier` — the seam that records the leaf certificate fingerprint for both the ws and http proxies' TOFU decision — has no test, while its sibling `PinnedVerifier`/`Hos… | **RESOLVED** |
| T-17 | MEDIUM | missing | `Client/tauri-client/src/lib/hostValidation.ts:24` — hostValidation.ts — extracted in the last bughunt commit as the single gate for every user-supplied server address — has no test file of its own, and nothing asserts the two gua… | **RESOLVED** |
| T-18 | MEDIUM | missing | `Client/tauri-client/src/lib/rate-limiter.ts:163` — No test ties the client's pre-configured voice limiter to the server budget its own header comment claims to mirror; createVoiceLimiter allows 20 sends/second while the server c… | **RESOLVED** **+ source bug fixed** |
| T-19 | MEDIUM | missing | `Client/tauri-client/src/pages/connect-page/LoginForm.ts:643` — The login form's anti-phishing cap on server-controlled error text — truncate any auth error over 200 characters — is a stated security guard that no test asserts. | **RESOLVED** |
| T-20 | MEDIUM | missing | `Client/tauri-client/src/pages/main-page/SidebarArea.ts:475` — The OC-0174 fix (announcement channels count as text-like for every automatic channel fallback) was applied to five call sites, but only the three in dispatcher.ts got regressio… | **RESOLVED** |
| T-21 | MEDIUM | missing | `Client/tauri-client/src/stores/voice.store.ts:412` — The module-level `pttPollingLive` capability flag and its stated invariant that `resetVoiceStore()` must not clear it are asserted by no test — both accessor bodies are never ex… | **RESOLVED** |
| T-22 | MEDIUM | stale | `Client/tauri-client/tests/browser/smoke.test.ts:3` — The entire tests/browser suite is this one file, which imports no application module and asserts only that the browser environment exists, so it cannot fail on any product chang… | **RESOLVED** |
| T-23 | MEDIUM | stale | `Client/tauri-client/tests/unit/media.test.ts:1173` — The lightbox test named "cleans up document-level listeners on close" contains no assertion whatsoever — it dispatches three events after closing and asserts nothing, so it pass… | **RESOLVED** |
| T-24 | MEDIUM | stale | `Client/tauri-client/tests/unit/renderers.test.ts:551` — `formats full date correctly for bare SQLite timestamp` formats UTC midnight ("2026-03-19 00:00:00" is treated as UTC) in the machine's local zone and asserts the day is 19 — it… | **RESOLVED** |
| T-25 | MEDIUM | stale | `Client/tauri-client/tests/unit/renderers.test.ts:1228` — The formatMessageTimestamp DST tests set process.env.TZ inside beforeEach, which Node only honours in the main thread / a forked process; under a worker-thread pool (Stryker's v… | **RESOLVED** |
| T-26 | MEDIUM | missing | `Server/admin/handlers_channels.go:123` — OC-0158's post-commit-cancellation fix and test were applied to the PATCH and DELETE channel handlers but not to the sibling CREATE handler, which still re-reads on the cancelab… | **RESOLVED** **+ source bug fixed** |
| T-27 | MEDIUM | missing | `Server/api/middleware.go:185` — RequirePermission's fail-closed branch — the 403 taken when the request context carries no *db.Role — has zero coverage, so nothing pins that the server-wide authz chokepoint de… | **RESOLVED** |
| T-28 | MEDIUM | missing | `Server/api/middleware.go:301` — The skip-invalid-entry guard in the X-Forwarded-For right-to-left walk (the BUG-112 anti-spoofing logic that derives every rate-limit and lockout key) is never exercised: no tes… | **RESOLVED** |
| T-29 | MEDIUM | missing | `Server/api/waf.go:468` — The inline WAF engine's four phase-2 request-body attack rules (SQLi 942100, XSS 941100, path traversal 930100, command injection 932100 — all `deny,status:403` under an always-… | **RESOLVED** |
| T-30 | MEDIUM | missing | `Server/auth/totp_encrypt.go:45` — LoadOrGenerateTOTPKey's "read the existing totp.key from disk" branch has zero coverage, so nothing asserts the TOTP encryption key is stable across restarts. | **RESOLVED** |
| T-31 | MEDIUM | missing | `Server/updater/download.go:227` — The updater's tar extraction has a documented O_EXCL anti-TOCTOU guard and three tar-entry filters that no test exercises — the only test hits the happy path into a path that ne… | **RESOLVED** |
| T-32 | MEDIUM | missing | `Server/ws/hub_broadcast.go:230` — Both "fail closed" DB-error branches of the broadcast audience resolver are the only uncovered blocks in channelReadAudience — nothing asserts that an unreadable channel row or … | **RESOLVED** |
| T-33 | MEDIUM | missing | `Server/ws/hub_events.go:106` — No test ever broadcasts through a hub that has an EventPersister attached, so the invariant that the persisted row's seq matches the seq embedded in the wrapped payload — the ba… | **RESOLVED** |
| T-34 | MEDIUM | missing | `Server/ws/voice_join.go:91` — The rate-limit refusal branch is never executed for voice_join, for the shared voice_mute/voice_deafen self-toggle, or for voice_e2ee_announce, even though the sibling handlers'… | **RESOLVED** |
| T-35 | LOW | missing | `Client/tauri-client/src/components/UserProfilePopup.ts:125` — `position()`'s viewport flip-and-clamp — written specifically to fix a card that ran off the bottom of the window — has no test; every one of its four branches is unexercised. | **RESOLVED** |
| T-36 | LOW | missing | `Client/tauri-client/src/lib/e2eeCrypto.ts:293` — The epoch-range reject path added by the OC-0001 room-key epoch fix is the one guard in unwrapRoomKey's v1 header parse that no test reaches, even though its sibling guards (edi… | **RESOLVED** |
| T-37 | LOW | stale | `Client/tauri-client/tests/unit/log-persistence.test.ts:478` — A test for clearPendingPersistedLogs's no-op path contains no assertion at all, so it passes for any implementation that does not hang. | **RESOLVED** |
| T-38 | MEDIUM | stale | `Client/tauri-client/src/lib/credentials.ts:9` — Stryker (2026-08-19, pre-round-1 tree): 13 of 33 mutants in Client/tauri-client/src/lib/credentials.ts survived (score 60.6%) — the unit tests covering this module do not pin th… | **RESOLVED** |
| T-39 | MEDIUM | stale | `Client/tauri-client/src/lib/dispatcher.ts:87` — Stryker (2026-08-19, pre-round-1 tree): 125 of 453 mutants in Client/tauri-client/src/lib/dispatcher.ts survived (score 72.4%) — the unit tests covering this module do not pin t… | **RESOLVED** |
| T-40 | MEDIUM | stale | `Client/tauri-client/src/lib/permissions.ts:107` — Stryker (2026-08-19, pre-round-1 tree): 3 of 54 mutants in Client/tauri-client/src/lib/permissions.ts survived (score 94.4%) — the unit tests covering this module do not pin the… | **RESOLVED** |
| T-41 | MEDIUM | stale | `Client/tauri-client/src/lib/rate-limiter.ts:41` — Stryker (2026-08-19, pre-round-1 tree): 5 of 42 mutants in Client/tauri-client/src/lib/rate-limiter.ts survived (score 88.1%) — the unit tests covering this module do not pin th… | **RESOLVED** |
| T-42 | MEDIUM | stale | `Client/tauri-client/src/lib/hostValidation.ts:25` — Stryker (2026-08-19, pre-round-1 tree): 11 of 35 mutants in Client/tauri-client/src/lib/hostValidation.ts survived (score 68.6%) — the unit tests covering this module do not pin… | **RESOLVED** |
| T-43 | MEDIUM | stale | `Client/tauri-client/src/stores/messages.store.ts:197` — Stryker (2026-08-19, pre-round-1 tree): 52 of 338 mutants in Client/tauri-client/src/stores/messages.store.ts survived (score 84.6%) — the unit tests covering this module do not… | **RESOLVED** |
| T-44 | MEDIUM | stale | `Client/tauri-client/src/lib/e2eeCrypto.ts:19` — Stryker (2026-08-19, pre-round-1 tree): 30 of 99 mutants in Client/tauri-client/src/lib/e2eeCrypto.ts survived (score 69.7%) — the unit tests covering this module do not pin the… | **RESOLVED** |
| T-45 | MEDIUM | stale | `Client/tauri-client/src/lib/ws.ts:8` — Stryker (2026-08-19, pre-round-1 tree): 150 of 352 mutants in Client/tauri-client/src/lib/ws.ts survived (score 57.4%) — the unit tests covering this module do not pin these bra… | **RESOLVED** |
| T-46 | MEDIUM | stale | `Client/tauri-client/src/lib/identity.ts:24` — Stryker (2026-08-19, pre-round-1 tree): 25 of 75 mutants in Client/tauri-client/src/lib/identity.ts survived (score 66.7%) — the unit tests covering this module do not pin these… | **RESOLVED** |
| T-47 | MEDIUM | stale | `Client/tauri-client/src/lib/livekitE2EE.ts:33` — Stryker (2026-08-19, pre-round-1 tree): 234 of 484 mutants in Client/tauri-client/src/lib/livekitE2EE.ts survived (score 51.7%) — the unit tests covering this module do not pin … | **RESOLVED** |
| T-48 | MEDIUM | stale | `Client/tauri-client/src/stores/auth.store.ts:16` — Stryker (2026-08-19, pre-round-1 tree): 6 of 21 mutants in Client/tauri-client/src/stores/auth.store.ts survived (score 71.4%) — the unit tests covering this module do not pin t… | **RESOLVED** |
| T-49 | MEDIUM | stale | `Client/tauri-client/src/stores/voice.store.ts:124` — Stryker (2026-08-19, pre-round-1 tree): 49 of 134 mutants in Client/tauri-client/src/stores/voice.store.ts survived (score 63.4%) — the unit tests covering this module do not pi… | **RESOLVED** |

## 3. Measured baselines (diff against these next time)

### Go — cross-package (`go test -coverpkg=./... ./...`)

| | Before | After |
|---|---|---|
| Total statements | 80.1% | **80.8%** |
| Zero-coverage functions (excl. dbgen/scripts/main) | 62 | **54** |

Per-package before→after (mean per-function statement coverage):

| Package | Before | After |
|---|---|---|
| admin | 86.6% | 86.6% |
| api | 84.4% | 84.8% |
| auth | 91.5% | 93.5% |
| config | 80.6% | 80.6% |
| db | 84.1% | 84.2% |
| diskutil | 87.5% | 87.5% |
| invariants | 81.8% | 81.8% |
| logctx | 96.0% | 96.0% |
| permissions | 100.0% | 100.0% |
| plugin | 77.0% | 77.3% |
| service | 91.5% | 91.5% |
| stackutil | 94.1% | 94.1% |
| storage | 89.6% | 89.6% |
| syncutil | n/a | n/a |
| telemetry | 74.4% | 74.4% |
| updater | 87.3% | 87.8% |
| ws | 88.2% | 89.5% |

Zero-coverage note: both counts come from the identical filter over the before/after profiles (an earlier scratch note said 51 — that used a narrower scope). The −8 is nine functions gaining coverage (`handleGetAuditLog`, ws `ChannelID`/`Payload`, `buildCommandReply`/`buildCommandBroadcast`, hub `Register`/`Unregister`, `maxColdReplayLimit`, `rejectIfRunning`) while `EventPersisterStats` merely moved lines. The remaining 54 are dominated by the root-package CLI (`token_cli.go`, `restart.go Mode`) and similar wiring.

### Client (`vitest run --coverage`)

| | Before | After |
|---|---|---|
| Test files | 185 | 185 |
| Tests | 5045 | 5164 |
| Statements | 96.17% | **96.41%** |
| Branches | 92.52% | **92.93%** |
| Functions | 94.70% | **95.02%** |

### Rust (`cargo test --lib`)

108 → 114 tests.

### Stryker (risky client modules, before round 2)

| Module | Killed | Survived | Score |
|---|---|---|---|
| `src/lib/credentials.ts` | 20 | 13 | 60.6% |
| `src/lib/dispatcher.ts` | 328 | 125 | 72.4% |
| `src/lib/permissions.ts` | 51 | 3 | 94.4% |
| `src/lib/rate-limiter.ts` | 37 | 5 | 88.1% |
| `src/lib/cert-reconnect.ts` | 13 | 0 | 100% |
| `src/lib/hostValidation.ts` | 24 | 11 | 68.6% |
| `src/stores/messages.store.ts` | 286 | 52 | 84.6% |
| `src/lib/e2eeCrypto.ts` | 69 | 30 | 69.7% |
| `src/lib/ws.ts` | 202 | 150 | 57.4% |
| `src/lib/identity.ts` | 50 | 25 | 66.7% |
| `src/lib/livekitE2EE.ts` | 250 | 234 | 51.7% |
| `src/stores/auth.store.ts` | 15 | 6 | 71.4% |
| `src/stores/voice.store.ts` | 85 | 49 | 63.4% |

Overall: **67.04%**, 595 survived / 108 no-coverage before round 2.

Round 2 (T-38..49) then killed the actionable survivors per module with strengthened assertions; mutants proven genuinely equivalent (unobservable behaviour) were documented in the fix notes and left. Stryker was not re-run after round 2 (≈40 min a pass); the next audit's run diffs against the table above.

## 4. Bugs surfaced by the tests

All non-security; each fixed test-first inside its finding's commit:

- `Client/tauri-client/src/lib/ws.ts:127` — `normalizeHostForCertCompare` never gained the portless bracketed-IPv6 unwrap its Rust twin `cert_store_key` (`src-tauri/src/tofu.rs:302`) got in the same OC-series fix — cert-pin comparison could mismatch on bracketed IPv6 hosts.
- `Client/tauri-client/src/lib/rate-limiter.ts` — `createVoiceLimiter()` allowed 20 ops/s where the server budget is 2/s; client now matches `Server/ws/voice_broadcast.go`.
- `Server/admin/handlers_channels.go` — `handleCreateChannel` re-read the committed row with the request context, so a caller cancellation landing after commit 500ed the request after the channel was created (OC-0158 sibling).

Also: `ws.CommandDispatcher` gained a small test seam (`deps.go`/`hub.go`) so command dispatch is unit-testable without a live hub.

## 5. Refuted candidates (do not re-raise)

- `Client/tauri-client/src/lib/api.ts:300` — The OC-0161 invariant — a 401 that is a per-call verdict rather than a session verdict must not fire the global onUnauthorized sink — was fixed and tested fo… — refuted: The verifyTotp 401 path is already covered by a test that pins deliberate behavior (tests/unit/api.test.ts:541), and the OC-0161 harm cannot occur there: the credential-deleting/logout logic hangs off authStore.subscribe
- `Client/tauri-client/src/pages/main-page/VoiceCallbacks.ts:146` — `createVoiceModerationCallbacks` — the client's four moderator voice commands (voice_mod_mute / voice_mod_deafen / voice_mod_move / voice_mod_kick) and their… — refuted: createVoiceModerationCallbacks is not untested: the mocked E2E spec drives the real factory through the voice context menu and asserts the exact wire type and payload for voice_mod_mute ({channel_id:10,user_id:2,muted:tr
- `Client/tauri-client/src/pages/main-page/SidebarDmHelpers.ts:186` — `handleCreateGroupDm` and the `dmChannelFromPayload` mapper it depends on are the only two exported functions in SidebarDmHelpers.ts with no unit test at all… — refuted: handleCreateGroupDm and dmChannelFromPayload are covered indirectly by the mocked E2E social-parity spec, which clicks through the member picker, asserts the POST /api/v1/dms/group body, and then asserts the app switched
- `Client/tauri-client/src/stores/voice.store.ts:508` — The four E2EE peer-verification writers in voice.store.ts (setPeerVerification, clearPeerVerification, setLocalSessionFingerprint, clearPeerVerifications) ar… — refuted: The claim "never executed by any test" is false: tests/e2e/voice-e2ee-verify.spec.ts drives the real app (real livekitE2EE + real voice.store, CI job client-e2e runs `npx playwright test --config=playwright.config.ts`), 
- `Client/tauri-client/src-tauri/src/tofu.rs:371` — `mismatch_message`'s doc states the frontend parses `Stored:` out of it and the shape must stay stable, but no Rust test asserts that shape and the TypeScrip… — refuted: Both emitters send `storedFingerprint` as an explicit JSON field (ws_proxy.rs:212, http_proxy.rs:434) and ws.ts prefers it (`raw.storedFingerprint ?? parseStoredFingerprint(raw.message)`), so a change to `mismatch_messag

## 6. Backlog

| # | Item | Finding | Sev |
|---|------|---------|-----|
| 1 | Re-run Stryker on the 13 risky modules to measure the round-2 kill rate; chase any remaining non-equivalent survivors (worst pre-round-2: `livekitE2EE.ts` 51.7%, `ws.ts` 57.4%) | T-38..49 follow-up | low |
