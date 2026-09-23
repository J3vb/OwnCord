# Reliability and support ideas

**Status:** 2026-09-08 — owner approved recording all eight ideas and starting
the first four. RI-01 through RI-04 are implemented and merged into `dev` in
PR #1573 (commit `3221fe9e`). RI-05, RI-06, RI-07 and RI-08 are implemented
on 2026-09-23. The validation record and remaining limits are below.

**Base:** `dev` at `c900953651088120c62ff05d67abc2ffc74c2701`.

This is an implementation supplement to the beta roadmap. Existing phase
exit criteria still apply. The support-bundle privacy contract belongs to
B4-8/B6/B9, client lifecycle work feeds B7/B9, and deployment qualification
remains B6/B10. Implementing one item does not close those phases.

## Priority and ownership

| ID    | Idea                                           | Value                                                               | Status      | Roadmap alignment                                |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| RI-01 | One owner for client session work              | Prevent obsolete requests and cleanup from affecting a new session  | Merged      | B7 client lifecycle; B9 account/server switching |
| RI-02 | Previewed local support bundle                 | Make reports reproducible and safe to share                         | Merged      | B6/B9; existing BG-15 contract                   |
| RI-03 | Guided connection and voice test               | Identify the failed connection stage with useful next steps         | Merged      | B6 connectivity; B9 diagnostics                  |
| RI-04 | Retry-safe messaging and pending-send recovery | Preserve user intent across lost acknowledgments and restarts       | Merged      | Protocol/persistence contracts; B9 messaging     |
| RI-05 | Spread reconnect attempts                      | Reduce synchronized retry pressure after a shared outage            | Implemented | B6 capacity; B7 reconnect behavior               |
| RI-06 | Explain permissions and preview access changes | Help admins understand and safely change effective access           | Implemented | B9 administration                                |
| RI-07 | Admin attention panel                          | Surface failed maintenance and capacity pressure early              | Implemented | B6 operations; B9 administration                 |
| RI-08 | Preview destructive policy changes             | Show the impact of proposed retention settings before applying them | Implemented | B9; existing BPR-054 retention controls          |

## First implementation batch

### RI-01 — Client session ownership

Give requests an immutable originating host and authentication snapshot,
a cancellation signal, and an ownership check after asynchronous boundaries.
Provide a shared cleanup owner for subscriptions and timers. End ownership
when authentication clears or the account/server changes. Reuse the existing
WebSocket generation and LiveKit attempt rules.

Acceptance:

- A delayed proxy setup cannot combine one host with another session's token.
- A late response, including a 401 or delayed JSON parsing, cannot change or
  sign out the replacement session.
- Logout invalidates ownership synchronously and cleanup is idempotent.
- Diagnostic and pending-send work use the same session boundary.
- Regression tests cover same-host account changes, server changes, canceled
  work, and responses that complete after cancellation.

### RI-02 — Support bundles

Implement the [support-bundle contract](../architecture/diagnostics.md#support-bundle-data-contract):
an administrator requests a preview, reviews its exact contents, size and
redaction report, then explicitly downloads the frozen bundle. The preview
and download are bound to the requesting authenticated session and expire.

Use bounded, structurally allowlisted metadata and sanitized diagnostic
events. Include build information, safe configuration, schema/migration
metadata, counts and health information where available. Any omitted surface
must be explicit. No credentials, message content, attachment bytes, raw
database files or automatic uploads belong in the artifact.

Acceptance:

- Download bytes match the preview's hash and item manifest.
- Another user/session cannot download the preview; expired previews fail.
- Memory, item sizes and preview lifetime are bounded.
- Planted secrets and forbidden content do not survive export; a negative
  control demonstrates that the redaction check can detect a planted value.
- Creation is recorded in a content-free audit event.
- The admin interface exposes preview and confirmation as separate actions.

### RI-03 — Connection and voice self-test

Provide a user-initiated test in client settings. Check the actual trusted
HTTP path, authenticated API, live WebSocket round trip and microphone
permission. Inspect the active call's signaling and media evidence. Identify
stages that require a call or a remote transmitting participant explicitly.

Acceptance:

- A server health response alone cannot mark the client media path healthy.
- No call is silently joined and microphone samples are never published by
  the diagnostic capture test.
- Every acquired track is stopped, including a permission prompt that
  resolves after cancellation; closing the pane or changing session cancels
  the run.
- Media success requires actual reception/decoding evidence appropriate to
  the track; identity badges or packet counts alone do not prove E2EE.
- Results provide concrete next actions and distinguish failed, canceled,
  untested and observed-working stages.
- Browser tests drive the real controls and relevant failure conditions.

### RI-04 — Retry-safe messaging

Keep a stable logical message identifier across retries. Store the delivery
receipt atomically with message persistence. The server advertises support,
returns the original acknowledgment for a duplicate, and does not duplicate
broadcasts, attachment links, mention effects or push work. Current access
rules still apply to retries.

Add a bounded encrypted native pending-send queue, isolated by server and
account. Recover pending text as an explicit user retry rather than silently
sending old drafts. Retain current in-memory behavior where secure durable
storage is unavailable, and disclose that limitation. Old servers must not
be assumed to support deduplication.

Acceptance:

- Lost acknowledgments and concurrent retries produce one persisted message
  and one set of side effects.
- The same identifier cannot be reused for a different request body/channel.
- The retry window and storage bounds are defined on both sides; expired
  requests cannot become newly duplicated sends after receipt cleanup.
- Message deletion, account erasure and retention do not cause retries to
  resurrect content.
- Restart preserves eligible native pending text without plaintext storage;
  a different account or server cannot recover or send it.
- Acknowledgment and explicit discard remove queued content. Logout and
  session switching have documented, tested cleanup behavior.
- Server support is checked before using retry guarantees. Legacy behavior
  remains compatible and does not claim duplicate protection.

Implementation boundaries for this batch:

- Delivery identifiers carry a creation time and UUID. The advertised retry
  window is 24 hours, with up to five minutes of client clock skew. A matching
  receipt returns the original message ID and timestamp; retrying a different
  payload under that identifier fails.
- Pending native text is isolated by host (including port) and account, with
  at most 64 entries and 128 KiB per owner. It uses the existing verified OS
  credential store and encrypted fallback. Replies and attachment references
  are not persisted in this first version. Browser recovery is memory-only.
- Recovered messages require an explicit retry. Expired or malformed entries
  are pruned when the queue loads or receives another draft; the age limit is
  retry eligibility, not a background deletion guarantee for inactive accounts.
- Admin backup restoration persists a monotonic retry cutoff outside the
  database after draining writers and before replacing the live file. A
  missing receipt below that cutoff is refused, including after a restart.
  Existing matching receipts remain valid within their retry window. Manual
  replacement of database and sidecar files can discard this protection and
  requires deliberate review of pending drafts, as documented in the protocol.

## Follow-up backlog

### RI-05 — Reconnect spreading

Add bounded randomized delay to the existing exponential reconnect policy.
Keep tests deterministic with an injected random source and clock. Measure a
group outage/recovery so the change spreads reconnect attempts and respects
the configured maximum delay; retain prompt cancellation on logout and
certificate mismatch. Server-requested retry delays should be honored where
the transport can expose them.

Implemented 2026-09-23 against `dev` at
`0beee8e4c50ca18823750e381d3a1d6e327029b8`:

- The WebSocket policy samples uniformly from half to all of the existing
  exponential ceiling (1s, 2s, 4s, ...), capped at `maxReconnectDelayMs` (30s
  by default). Jitter continues at the cap. Authentication and logout keep
  their existing exponent resets; session and transport lifecycle ownership
  are unchanged.
- Randomness and the reconnect timer/cancellation clock are injectable.
  `Client/tests/unit/ws-backoff.test.ts` drives 256 independent clients through
  a shared 20-second outage with a seeded random source and fake clock. It
  checks first-attempt distribution, spreading at the cap and on recovery,
  every attempt's delay bounds, and recovery within one configured maximum.
  Boundary tests cover the random endpoints, exponent growth/reset, and
  synchronous timer cancellation on logout and certificate mismatch. All 165
  focused socket/lifecycle tests pass. Running the 16 new cases against the
  original `ws.ts` fails all 16, including the outage distribution assertion.
- A transport may attach `retryAfterMs` to its disconnected state report.
  Valid hints form a minimum wait subject to the configured hard maximum;
  longer hints are capped, negative/nonfinite hints are ignored, and hints
  are not retained for the next failure. The current desktop IPC exposes
  neither handshake headers nor structured retry delays, so it supplies no
  hint. Native error strings are not interpreted as retry instructions.

### RI-06 — Permission explanations and impact preview

Let an authorized admin choose a member, channel and action and see the
effective decision and contributing rules. Use the canonical server
authorization predicates and include non-role restrictions. Preview proposed
changes against the same rules before saving and show whose access changes.
Do not build a second permission engine in the client or use preview to
impersonate another user's session.

Implemented 2026-09-23:

- `permissions.Explain` runs the named canonical predicate (`CanViewChannel`,
  `CanReadContent`, `CanSendMessage`, `CanAddReaction`, `CanJoinVoice`,
  `AuthorizeVoiceModerator`) and traces the bits it consulted through base
  role, role override and member override. A test pins that its verdict and
  reason equal the predicate's for every action over a table of subjects.
- `GET /admin/api/channels/{id}/access/explain` takes one required action and
  resolves the member's Subject live through `permissions.Checker.Subject`
  (role, both layers, active timeout) plus NSFW acknowledgement, and applies
  session admission (effective ban, unapproved registration) on top. No
  session is created or used.
- `POST /admin/api/channels/{id}/access/preview` substitutes the proposed role
  or member layer into each reachable member's live Subject, evaluates every
  action before and after, and lists only the members whose decision flips.
  It writes nothing; the save path keeps its own escalation and hierarchy
  checks. Both routes sit under `MANAGE_CHANNELS` beside the override editor
  and are audited (`permission_explain`, `permission_preview`). Both follow
  the editor's rank rules: below Administrator, a member ranked at or above
  the caller is refused, and a role-layer preview is refused for a role at or
  above the caller's rank, so no route reads a peer's or higher-ranked
  member's ban, timeout, registration or NSFW consent state.
- An Administrator's decision carries no bit trace, since the predicate
  consults no bit or override layer for it.
- The admin panel's channel-permissions modal gains "Explain access" and
  "Preview matrix change"; both only render the server's answer. The quick
  "Can access" toggles are not previewed, and role base-permission edits
  (server-wide) have no preview yet.

### RI-07 — Admin attention panel

Reuse disk, writer-wait, reconnect and delivery-pressure metrics. Add last
successful backup and per-maintenance-job health. Show persistent,
deduplicated warnings with observed time, recovery state and a useful action;
distinguish an unknown measurement from a healthy one. Establish thresholds
from configuration and measured baselines, with hysteresis to avoid noisy
alerts. Keep diagnostics local unless the operator explicitly configures
otherwise.

Implemented 2026-09-23 against `dev` at
`22f2c8841f4c7a526e73ccd8655055198e4bd4f6`:

- `service.AttentionService` samples once a minute, reusing counters the server
  already keeps: data-volume free space, the writer pool's cumulative
  `WaitDuration`, the reconnect-tier totals, and hub broadcast drops plus
  send-queue overflow disconnects; low-priority typing and presence drops
  are left out because they lose nothing. It adds the newest backup
  file as the last successful backup, since a failed backup leaves no file.
  Each maintenance step reports its outcome under a job name. The Dashboard
  shows the result to `ADMINISTRATOR` holders through
  `GET /admin/api/attention`.
- Each signal is `ok`, `warning`, `critical` or `unknown`. Unknown covers an
  unsupported platform, a failed read, a first rate sample, a job or backup
  that has not run yet, or disk space with both disk floors at `0`. It
  neither raises nor clears a warning.
- Thresholds come from the new `attention.*` config floors and
  `server.min_free_disk_mb`. Each rate learns a baseline over ten samples,
  skipping the first measured minute (the post-restart resume burst). During
  warm-up reconnects raise nothing, while writer wait and delivery raise at
  the floor and learn only samples at or below it, so pressure present at boot
  is raised, not learned. After that each rate raises at the floor or three
  times the baseline, and learns only from healthy samples. Hysteresis: the
  first disk level commits at once and a stopped dispatch loop as soon as it
  is seen, and every other
  change, including a rate's first warning, must hold for two samples; a rate
  clears below half its threshold, disk 10% above its floor. A job warns after
  two consecutive failures and clears on one success. Backups warn at 1.5× the
  schedule interval and go critical at 3×.
- Warnings are deduplicated per signal and record first and last observation,
  occurrences, an action and `recovered_at`. Recovered entries are listed for
  24 hours and reopen in place. The state is in memory and served only to the
  admin API; nothing is exported to telemetry. Limit: a restart forgets
  recovered history, though the next samples re-raise any active condition.
- Tests: `Server/service/attention_test.go` covers unknown handling, first
  samples, hysteresis, warm-up, boot pressure, baseline, deduplication,
  expiry, dispatch, jobs and backups. The route has `Server/admin/handlers_attention_test.go`,
  the maintenance recording has `TestMaintenance_TickRecordsJobHealth` and
  `TestMaintenance_StartupRunsRecordJobHealth`, and the
  panel has `Client/tests/contract/server-admin-static-attention.test.ts`.

### RI-08 — Destructive policy preview

Calculate the effect of a proposed retention policy before saving it. Show
the currently affected count/channel summary and protected exclusions,
including removal of an indefinite channel override. Bind the preview to
the proposed policy and record its observation time. Revalidate permissions
and policy revision on apply; concurrent changes must not silently overwrite
another admin's work. Existing confirmation and current-policy previews
remain useful parts of this workflow.

RI-08 implementation (2026-09-23), based on `dev` commit
`0beee8e4c50ca18823750e381d3a1d6e327029b8`:

- Proposed server windows, channel overrides and override removal receive a
  read-only snapshot with per-channel counts, protected exclusions and UTC
  observation time. The existing saved-policy preview stays available.
- A 15-minute signed preview binds the exact edit, actor and durable revision.
  Apply resolves the current bearer permissions again; a transaction rejects
  stale revisions with HTTP 409 and a reload/preview message. Server settings,
  override writes and cascade deletions invalidate outstanding previews, even
  when a value changes back within the same second.
- The panel requires preview followed by confirmation, discards canceled or
  failed previews and displays apply failures without silently retrying.
- Regression coverage: `Server/db/retention_preview_test.go`,
  `Server/service/retention_preview_test.go`,
  `Server/admin/retention_test.go` and the executable admin-panel contract in
  `Client/tests/contract/server-admin-static-panel.test.ts` cover preview/sweep
  maths, indefinite override removal, concurrent writes, stale edits, token
  binding, expiry, permission revocation and confirmation state.

## Delivery evidence

The first batch is implemented and merged into `dev` in
[PR #1573](https://github.com/J3vb/OwnCord/pull/1573) (commit `3221fe9e`).
RI-05, RI-06, RI-07 and RI-08 are implemented as described above; no follow-up
idea remains in the backlog. This does not close a broader roadmap phase.

Verified in the Linux development environment:

- Fresh API/session/main/route-contract run: 168 passing tests. The real
  diagnostic journey exposed an existing `GET /users/me` mismatch; the client
  now uses the server's canonical `GET /auth/me`, and the new contract compares
  the client request with the generated server route inventory.
- Connection diagnostics: 50 focused unit tests and all five real-server
  browser scenarios pass, including late microphone permission, cancellation,
  pane closure, HTTP failure and microphone denial.
- Support export: focused Go race/privacy/concurrency checks and executable
  panel contracts pass. The real admin Playwright journey verifies no download
  before confirmation, exact ZIP hash/size, and the audit entry.
- Message recovery: the real two-user Playwright journey drops acknowledgment
  and echo, reloads the sender, explicitly retries the original identifier,
  and verifies one database message, one recipient message and queue removal.
  Browser persistence here exercises the native IPC boundary using a test
  store; it is not evidence of native encryption or process persistence.
- Server retry regressions cover simultaneous requests, payload conflicts,
  current permissions, failed transactions, ordinary reopen, erasure, deletion,
  expiry and actual backup rollback across the durable retry cutoff.
- Four server build variants, `go vet`, global `golangci-lint`, client
  typechecks/lint/Knip, and Rust formatting pass. Windows database test
  compilation verifies the platform-specific cutoff replacement helper.
- The final stable-source unit run passed 5,496 of 5,497 tests across 209 files.
  Its sole failure was an existing PTT test's global import-settlement wait.
  That test now starts with a closed gate and waits for its own microphone
  operation. All 95 PTT tests pass after the correction; a negative control
  failed the gate-state assertion when ungating could not change the state.
  This is a full run plus a verified focused correction, not a claim that the
  complete suite was rerun after the correction.
- The production-browser run passed 284 of 285 scenarios. Its reconnection
  helper fabricated a handshake while the app's reconnect timer was still
  armed, causing duplicate READY/history reloads. The helper now follows the
  real reconnect attempt and history completion. All six reconnection cases
  pass across three repetitions (18 passes); production code was unchanged.
- Server deadlock-tagged behavior checks pass after updating and separately
  verifying the generated boundary inventory, migration lifecycle document
  and additive epoch-1 READY fixture. The untagged admin suite passes.
  Focused receipt/erasure/restore, service and WebSocket delivery tests also
  pass under the race detector. The telemetry capture test passes in isolation.
- Generated SQL/protocol/API/schema output is current. Repository hygiene
  and docs gates pass; shellcheck and actionlint were unavailable locally
  and were subsequently verified by CI.

CI follow-up on `b5c03673` in [run 34264647482](https://github.com/J3vb/OwnCord/actions/runs/34264647482):

- Both full Go race-and-coverage passes (Linux and Windows) pass. The initial
  local database/service/WebSocket race runs exhausted their ten-minute
  package budgets; the complete CI passes resolve that validation gap.
- Complete client unit, mocked-browser and production-browser suites pass,
  including the two synchronization corrections above. Static checks, Rust
  unit tests, admin E2E, hygiene, docs and all three CodeQL analyses pass.
- Fifteen of sixteen real-server/media cases pass, including message retry,
  ordinary connection diagnostics and signed server replacement. The active
  media diagnostic exposed LiveKit's single-peer-connection layout: incoming
  media lives on the publisher when there is no subscriber. The fallback fix
  has a regression that fails with the former subscriber-only implementation.
- The Windows native pending-message test passes encryption-backed storage,
  account isolation, persistence across real process restarts, and deletion
  persistence. Other native cases exposed completed HTTP requests being
  canceled during cleanup and a missing response-body cancellation permission.
- Separate dependency PRs exposed npm/Rust Tauri minor-version drift. The new
  fast lockfile check detects both original failures and accepts their paired
  corrections. Installer output is now forwarded live while remaining backed
  by a file, so a lost runner need not erase the last visible installer stage.

CI follow-up on `21d1112` in [run 34267311184](https://github.com/J3vb/OwnCord/actions/runs/34267311184):

- Every enabled nonnative CI job passes, including both full Go jobs and the
  complete real-server/media suite. The active-media diagnostic now passes
  against actual encrypted media in LiveKit's single-peer-connection mode.
- Native storage and reconnection pass without the completed-body cleanup
  errors. Voice passes only on retry: its 30-second assertion cuts short the
  application's three 15-second peer-connection attempts and two 2-second
  retry delays. A regression proves recovery at 49 seconds; the native test
  now allows 60 seconds and preserves server logs for future ICE failures.

The subsequent HTTP cancellation probe also reproduced an upstream SDK race:
a canceled body that later ends or fails can be released twice. The pinned
Tauri HTTP 2.5.9 patch removes finished listeners, owns cancellation once, and
rejects body responses returned after cancellation. Both published JavaScript
entry points pass 34 actual-SDK boundary regressions; unpatched negative
controls fail. Two native-collector tests ensure unexpected cleanup errors
still fail CI. Patch application, version drift, and removal criteria are
documented in [the patch notes](../../Client/patches/README.md).

Open at the time of writing:

- The latest native voice assertion and real HTTP cancellation probe need
  Windows validation. The probe cancels during delayed headers and body
  reads, then releases the upstream response and checks safe late completion.
  Transport cancellation remains best-effort; logical session cancellation
  must reject stale work promptly.
- The signed Windows installer journey remains unresolved. Test packages
  now reuse the installed WebView2 runtime already exercised by native core.
  That experiment passed native core and signed package builds, then exceeded
  both its process watchdog and Actions step timeout without returning logs
  or installer artifacts. Earlier runs lost their entire hosted runner; the
  experiment and diagnostic forwarding do not establish the cause.
- GitHub's additional managed security scanner failed before analysis with
  `The requested model is not supported`. This is separate from passing
  CodeQL checks; no repository gate has been disabled to conceal the failure.

The initial support bundle covers the server only. A combined desktop bundle
remains a separate extension of the existing privacy contract. Pending-send
recovery limits are described above and in
[credential-storage.md](../credential-storage.md).

Implementation is merged into `dev` in
[PR #1573](https://github.com/J3vb/OwnCord/pull/1573) (commit `3221fe9e`).
