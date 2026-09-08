# Reliability and support ideas

**Status:** 2026-09-08 — owner approved recording all eight ideas and starting
the first four. RI-01 through RI-04 are implemented on the branch below and
under validation; RI-05 through RI-08 are backlog ideas. Platform validation
and remaining limits are recorded below.

**Base:** `dev` at `c900953651088120c62ff05d67abc2ffc74c2701`.

This is an implementation supplement to the beta roadmap. Existing phase
exit criteria still apply. The support-bundle privacy contract belongs to
B4-8/B6/B9, client lifecycle work feeds B7/B9, and deployment qualification
remains B6/B10. Implementing one item does not close those phases.

## Priority and ownership

| ID    | Idea                                           | Value                                                               | Status      | Roadmap alignment                                |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| RI-01 | One owner for client session work              | Prevent obsolete requests and cleanup from affecting a new session  | In progress | B7 client lifecycle; B9 account/server switching |
| RI-02 | Previewed local support bundle                 | Make reports reproducible and safe to share                         | In progress | B6/B9; existing BG-15 contract                   |
| RI-03 | Guided connection and voice test               | Identify the failed connection stage with useful next steps         | In progress | B6 connectivity; B9 diagnostics                  |
| RI-04 | Retry-safe messaging and pending-send recovery | Preserve user intent across lost acknowledgments and restarts       | In progress | Protocol/persistence contracts; B9 messaging     |
| RI-05 | Spread reconnect attempts                      | Reduce synchronized retry pressure after a shared outage            | Backlog     | B6 capacity; B7 reconnect behavior               |
| RI-06 | Explain permissions and preview access changes | Help admins understand and safely change effective access           | Backlog     | B9 administration                                |
| RI-07 | Admin attention panel                          | Surface failed maintenance and capacity pressure early              | Backlog     | B6 operations; B9 administration                 |
| RI-08 | Preview destructive policy changes             | Show the impact of proposed retention settings before applying them | Backlog     | B9; existing BPR-054 retention controls          |

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

### RI-06 — Permission explanations and impact preview

Let an authorized admin choose a member, channel and action and see the
effective decision and contributing rules. Use the canonical server
authorization predicates and include non-role restrictions. Preview proposed
changes against the same rules before saving and show whose access changes.
Do not build a second permission engine in the client or use preview to
impersonate another user's session.

### RI-07 — Admin attention panel

Reuse disk, writer-wait, reconnect and delivery-pressure metrics. Add last
successful backup and per-maintenance-job health. Show persistent,
deduplicated warnings with observed time, recovery state and a useful action;
distinguish an unknown measurement from a healthy one. Establish thresholds
from configuration and measured baselines, with hysteresis to avoid noisy
alerts. Keep diagnostics local unless the operator explicitly configures
otherwise.

### RI-08 — Destructive policy preview

Calculate the effect of a proposed retention policy before saving it. Show
the currently affected count/channel summary and protected exclusions,
including removal of an indefinite channel override. Bind the preview to
the proposed policy and record its observation time. Revalidate permissions
and policy revision on apply; concurrent changes must not silently overwrite
another admin's work. Existing confirmation and current-policy previews
remain useful parts of this workflow.

## Delivery evidence

The first batch is implemented on `feat/reliability-foundations`, targeting
`dev`. The first four rows remain in progress until the pending validation
below is resolved. This does not close a broader roadmap phase.

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
  and remain CI checks. No shell scripts or workflows were changed.

Still being validated:

- The complete server race pass remains unresolved: database, service and
  WebSocket packages exhausted their ten-minute package budgets while making
  progress through ordinary tests/migrations. These are explicit failed local
  checks; focused race passes do not replace the missing complete pass.
  Dedicated CI must also run the complete client/browser suites with the two
  test-only synchronization corrections above.
- Real-media diagnostic assertions need CI: the verified LiveKit binary cannot
  enumerate network interfaces in this environment (`netlinkrib: operation
not permitted`). No successful media-path claim follows from the ordinary
  connection tests.
- Windows native execution needs CI. The required native suite now saves a
  value larger than the Windows keyring entry limit, restarts the real app,
  verifies owner isolation, deletes it, and restarts again to verify deletion.
  The browser test store does not substitute for this check.

The initial support bundle covers the server only. A combined desktop bundle
remains a separate extension of the existing privacy contract. Pending-send
recovery limits are described above and in
[credential-storage.md](../credential-storage.md).

The owner authorized publishing this implementation to `J3vb/OwnCord` and
opening a draft PR against `dev`. The platform checks above remain required
before the work is ready to merge.
