# Diagnostics, egress and the support-bundle contract

B4-8 (BPR-055, the server half of BG-15). This page answers three questions
an operator or a reviewer has about a self-hosted OwnCord server: **what can
I look at when something is wrong**, **what does the server ever send off
this machine**, and **what a support bundle contains**. The server-side support bundle is
implemented in the admin panel; all three are checked by tests on every CI run.
Desktop-local bundles and broader B6/B9 recovery qualification remain separate work.

The short version: OwnCord sends no automatic product or usage telemetry.
Every outbound network path in the server is one of three things — an
action an admin or user took, a feature an operator switched on by
configuration, or a connection to this machine itself — and each is listed
below with its trigger and its gate. The list is enforced by the
`egress-sites` invariant, and a runtime capture proves the compiled defaults
open nothing beyond loopback across startup, registration, sign-in,
messaging, upload, idle and shutdown.

## Diagnostic surfaces (all local)

| Surface                      | Where                                                                    | Who can read it                                                                 | Leaves the machine?                                                                        |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Health probe                 | `GET /health`                                                            | anyone who can reach the port (no body detail beyond the subsystem reason)      | no                                                                                         |
| Connectivity diagnostics     | `GET /api/v1/diagnostics/connectivity`                                   | `ADMINISTRATOR`, 5/min                                                          | no                                                                                         |
| JSON metrics                 | `GET /api/v1/metrics`                                                    | addresses in `server.metrics_allowed_cidrs` (else `admin_allowed_cidrs`)        | no — a scraper the operator admits pulls it                                                |
| Prometheus exporter          | `GET /metrics` (`-tags otel`, `telemetry.exporter: prometheus`)          | same allowlist                                                                  | no — pulled, never pushed                                                                  |
| OpenTelemetry traces/metrics | OTLP (`-tags otel`, `telemetry.enabled`, `telemetry.exporter: otlp`)     | the collector at `telemetry.otlp_endpoint`                                      | **only** when an operator builds with the tag and configures an endpoint; absent otherwise |
| Server log                   | stdout, and the in-memory ring buffer behind the admin panel's live view | the process owner; `ADMINISTRATOR` via the SSE stream (single-use tickets)      | no                                                                                         |
| Support bundle               | Admin panel **Diagnostics**, `/admin/api/support-bundles/*`              | `ADMINISTRATOR` with a current login session; explicit preview and confirmation | local download only, never uploaded                                                        |
| Audit log                    | `audit_log` table, admin panel                                           | `VIEW_AUDIT_LOG`                                                                | no                                                                                         |
| Backups                      | `backup.dir` (scheduled and on demand)                                   | the process owner; `MANAGE_SERVER` via the admin API                            | no                                                                                         |
| Healthcheck CLI              | `owncord --healthcheck` probes this server's `/health`                   | the orchestrator                                                                | loopback only                                                                              |

Log content is governed by `logging.level`; usernames, ids and client
addresses appear at `info` (data-lifecycle class 22), which is why the
support-bundle contract below treats log excerpts as sensitive.

## Egress inventory

Every site that can open an outbound connection — every production one, and
the two `cmd/smoke` rows below that are not — as the
`egress-sites` invariant (`Server/invariants/egress_sites.go`) enforces:
a function that constructs an HTTP client, request or dial and is not an
inventoried site of its file fails CI — a listed file exempts only the
functions its row names, so a dial added elsewhere in that file is a new
path — and a row whose site stops reaching out fails `TestEgressAllowIsLive`.
The invariant is syntactic, so it also catches code behind build tags.
`loopback` in the trigger column means the destination is this machine by
construction; the two LiveKit rows are `config` because `voice.livekit_url`
may name a remote LiveKit, and then the health probes and each voice
session's signalling leave the machine — an operator's choice, never the
default. The two `cmd/smoke` rows are the exception to "production": that
binary is the B6-8 upgrade-and-rollback rehearsal harness, run in CI and
shipped in no release, and it is inventoried because the invariant is
syntactic and correctly refuses to make an exception it cannot see.

| File                                                                           | Trigger  | Destination                                                                                                | Gate                                                                                                                         | What is sent                                                                                                                                               |
| ------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updater/updater.go` — `NewUpdater`, `(*Updater).fetchLatestRelease`           | manual   | `api.github.com` (`github.owner`/`github.repo`)                                                            | an admin's update check, or a client asking `/api/v1/client-update`                                                          | a release-metadata GET; the optional `github.token` for rate limits                                                                                        |
| `updater/assets.go` — `(*Updater).fetchBody`                                   | manual   | `api.github.com`, `github.com` release assets                                                              | the same two actions                                                                                                         | release metadata and the asset itself; any other host is refused                                                                                           |
| `updater/download.go` — `(*Updater).downloadFile`                              | manual   | `github.com` release assets                                                                                | an admin applying an update                                                                                                  | the pinned, checksum-verified server binary                                                                                                                |
| `ws/livekit_download.go` — `fetchLimited`, `downloadTo`                        | config   | `github.com/livekit/livekit` release assets                                                                | `voice.auto_download_livekit` (compiled default `false`; the generated config sets `true`) with `voice.livekit_binary` unset | the pinned, checksum-verified `livekit-server` binary, once                                                                                                |
| `ws/livekit_process.go` — `NewLiveKitProcess`, `(*LiveKitProcess).HealthCheck` | config   | `voice.livekit_url` (`ws://localhost:7880` by default; a remote LiveKit when the operator points it there) | `voice.livekit_url`                                                                                                          | health probes of the LiveKit process — loopback under the default, the operator's host otherwise                                                           |
| `ws/livekit.go` — `NewLiveKitClient`                                           | config   | `voice.livekit_url` (`ws://localhost:7880` by default; a remote LiveKit when the operator points it there) | `voice.livekit_url`                                                                                                          | the room-service client's calls (remove/get/mute a participant, list participants, list rooms) — loopback under the default, the operator's host otherwise |
| `api/livekit_proxy.go` — `proxyWebSocket`                                      | config   | `voice.livekit_url` (`ws://localhost:7880` by default; a remote LiveKit when the operator points it there) | `voice.livekit_url`, and only while a signed-in client holds a voice session                                                 | that client's LiveKit signalling, proxied — it leaves the machine when the URL is remote                                                                   |
| `safefetch/policy.go` — `New`, `defaultDial`                                   | config   | only a destination a caller passed in, and only an address `ClassifyAddr` accepted                         | the caller's gate: `gif.api_key`, or `plugins.http_allowlist`                                                                | nothing of its own — the shared client, transport and dialer; `Fetcher.dial` connects to the vetted addresses and to nothing else                          |
| `safefetch/fetch.go` — `(*Fetcher).roundTrip`                                  | config   | the same, one redirect hop at a time                                                                       | the caller's gate: `gif.api_key`, or `plugins.http_allowlist`                                                                | the GIF proxy's search terms, or whatever a plugin asks — bounded by the C-09 ceilings below                                                               |
| `service/push_dispatch.go` — `(*PushDispatcher).sendOne`                       | config   | the push service named in each stored subscription's `endpoint`                                            | `push.dispatch_enabled` **and** `push.enabled` (both false by default)                                                       | a Web Push message: an encrypted `{"t":"activity"}` payload (RFC 8291) and a VAPID `Authorization` header — no message text, channel name or sender        |
| `internal/app/healthcheck.go` — `RunHealthcheckCLI`                            | loopback | this server's `/health`                                                                                    | the `--healthcheck` flag                                                                                                     | nothing                                                                                                                                                    |
| `cmd/smoke/fixture.go` — file scope, `request`, `fetchAttachment`              | loopback | this harness's own server (`defaultBaseURL`, `https://127.0.0.1:8443`)                                     | someone invoking `cmd/smoke`                                                                                                 | the rehearsal fixture's own setup, upload, backup and re-download calls, to a server this harness launched moments earlier                                 |
| `cmd/smoke/docker.go` — `serving`                                              | loopback | the same address, published on `127.0.0.1` by the container under test                                     | someone invoking `cmd/smoke`                                                                                                 | one `/health` probe confirming the drained container stopped answering                                                                                     |
| `telemetry/telemetry_otel.go` — the OTLP exporter import                       | config   | `telemetry.otlp_endpoint`                                                                                  | `-tags otel` + `telemetry.enabled` + `exporter: otlp`                                                                        | traces and metrics, to the operator's own collector                                                                                                        |

B5-11's dispatcher row is deliberately **not** a code-level entry in
`Server/invariants/egress_sites.go`'s `EgressAllow` map. `service/push_dispatch.go`
never spells `net/http`, `net.Dial` or any of the other constructs
`egress-sites`' AST scan looks for — it builds a `safefetch.Request` and
calls the shared `pushFetcher.Fetch`, exactly as the GIF proxy does. The
actual outbound construct is the one the two `safefetch/*.go` rows above
already inventory; a code-level row naming a file with no matching AST hit
would fail `TestEgressAllowIsLive` ("but it no longer opens an outbound
path — drop the row"). The row above is this table's own — the
human-readable half of BPR-055 — recording the gate and the destination for
an operator reading this page, which the safefetch rows describe only
generically ("only a destination a caller passed in").

Since B5-1 the last two rows are the _only_ outbound content path in the
server. `api/gif_handler.go` and `plugin/host_http.go` used to dial for
themselves and had rows of their own; both now go through `Server/safefetch`,
which owns the whole per-fetch policy — scheme and port allowlists, no
embedded credentials, every A and AAAA answer classified before any connect,
a connect bound to those validated addresses with no second lookup, automatic
redirects off with each hop re-checked and scheme downgrades refused, a total
deadline, a streaming byte ceiling and a separate decompressed-size ceiling,
a content-type allowlist checked against the sniffed type as well as the
declared one, and a per-process concurrency cap. Their gates did not move:
with no `gif.api_key` the route is not mounted, and with an empty
`plugins.http_allowlist` every host is denied, so the compiled defaults still
reach nowhere. The policy is written out as a contract in
[trust-model.md](../trust-model.md#desktop-preview-destination-policy-c-09-—-contract-for-b7),
clauses 2 through 6.

Two things are deliberately **not** in the table. The startup banner used to
learn the machine's address by opening a UDP socket to a public DNS server
(no packet was sent, but a capture showed the connect at every start); it
now reads the interface table. And the desktop client's own update check
goes to the **server** it is connected to (`/api/v1/client-update`), which
answers from GitHub release metadata under the `updater` rows — the client
never talks to GitHub itself, and its Tauri updater has no endpoints
configured.

What the update rows send deserves stating plainly, since "update check" is
on BPR-055's capture list: a GET for the latest release of the configured
repository, with the optional `github.token` header. No installation
identifier, version, usage counter or hardware detail is attached; GitHub
sees the requesting address, as any HTTPS peer would.

## The no-automatic-telemetry proof

Two tests, both in the default `go test ./...` run:

- **Static — `TestServerInvariants` / `egress-sites`** (`Server/invariants`):
  every outbound construct in production code is in the inventory above.
  The rule is syntactic (`go/ast`, no type information), catches aliased and
  dot imports, composite `http.Client` / `http.Transport` / `net.Dialer`
  literals, the `http`, `net`, `tls`, `websocket` and `grpc` dial and request
  constructors, and any import of an OTLP exporter; files behind
  `-tags otel` / `wazero` / `deadlock` are parsed like any other.
  `TestEgressSites_Rule` is its negative control.
- **Dynamic — `TestNoAutomaticTelemetry_Capture`** (`Server/internal/app`):
  boots the real server the way `main` does, with the compiled defaults
  (TLS off, no LiveKit auto-download, no telemetry, no GIF key, no plugin
  allowlist), records every connection the process's default HTTP transport
  and name resolver open, then drives first-run setup, invite registration,
  sign-in, a WebSocket session with the ready payload and a channel read,
  an upload, an idle period and a graceful shutdown. The assertion is that
  nothing was dialled beyond loopback and no name was resolved. A positive
  control proves the recorder sees a loopback dial.

Coverage boundary, stated so B10 can extend it: the dynamic capture hooks
Go's default transport and resolver, so a client built on its own transport,
or a bare `net.Dial`, would evade it — the static rule is what closes that
gap, since every such construct is one the rule lists (the banner's UDP dial
was found that way, not by the capture). A packet-level capture (`strace -f -e
trace=connect`, or a pcap of the host) is the stronger form; the flows above
are the ones to drive when BG-15 reruns it at B10, and `voice.auto_download_livekit`
must be `false` for that run, as it is here.

## Support-bundle data contract

The admin panel's **Diagnostics** section implements the server half of
BG-15. Its contract is written against the data-class inventory in
[data-lifecycle.md](data-lifecycle.md) so every item names the classes it
touches.

1. **User-initiated, always.** A bundle exists only because a signed-in
   administrator asked for one, in that session, and confirmed a preview.
   No schedule, no crash hook, no "send diagnostics" default. Creating one
   writes an audit row (`support_bundle_create`, actor and item list — never
   contents).
2. **Nothing leaves by itself.** The bundle is written to a location the
   administrator chooses (a download from the admin panel, or a path on the
   server). OwnCord never uploads it. Any future crash reporting is a
   separate, explicit opt-in that defaults off and records the consent in
   the audit log.
3. **Enumerated contents.** Only the items below may appear, each marked
   with the data classes it can contain and the redaction it receives:

   | Item                        | Classes (data-lifecycle)                | Redaction                                                                                                  |
   | --------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
   | Version and build           | —                                       | none needed                                                                                                |
   | Configuration               | 26 (`OWNCORD_TOTP_KEY` if set), secrets | every key the config's log-value redactor already masks, plus `github.token`, LiveKit and OTLP credentials |
   | Migration and schema list   | —                                       | none needed                                                                                                |
   | Row counts per table        | 1–21 as counts only                     | counts, never rows                                                                                         |
   | Log excerpt                 | 22 (usernames, ids, client addresses)   | tokens and key material by pattern; client addresses masked unless the administrator opts in per bundle    |
   | Health and metrics snapshot | —                                       | none needed                                                                                                |

   Forbidden outright: credentials and second-factor material (classes 1
   passwords, 3, 4, 5, 26), sessions (2), message content and search index
   (8), attachments and avatars (12, 13), DM membership (14), invites (15),
   blocks (17), plugin storage (23), backups and free pages (24, 25). A
   bundle never carries another person's data as a side effect of a
   diagnostic.

4. **Review before write.** The preview shows the exact item list, the
   redaction report (what was masked, by which rule) and the byte size;
   the bundle is written only after the administrator confirms that
   preview. The manifest inside the bundle repeats the item list, hashes and
   redaction report so a reader can verify what they received.
5. **Tests the implementation must ship.** Planted secrets of every class
   above (a session token, an API token, a TOTP secret, a recovery code,
   `github.token`, the LiveKit secret) do not survive into any item; a
   negative control proves the scanner catches a planted token in a log
   line; the forbidden items cannot be selected; the audit row is written
   and content-free.

### Implemented server bundle

An administrator opens **Diagnostics**, selects **Create support bundle preview**,
reviews the item names, exact byte sizes, SHA-256 hashes and omission rules, then
selects **Confirm download**. Previewing or discarding does not download or upload
anything. No automatic collector or crash hook exists.

- `POST /admin/api/support-bundles/preview` accepts an empty JSON object. Unknown
  fields (including item selection and address opt-ins) are refused. It returns
  `preview_id`, `expires_at`, `byte_size`, `sha256`, `items` and `redactions`.
- `POST /admin/api/support-bundles/download` accepts `preview_id` and `sha256` and
  downloads the exact ZIP frozen at preview. It does not recollect live data.
  A successful confirmation consumes the preview once, including across concurrent
  requests. The response includes `X-Content-SHA256`; both endpoints use `no-store`.
- Both endpoints require a current login session with `ADMINISTRATOR`. Headless API
  tokens are refused. The preview is bound to that actor and exact session; current
  permissions, bans and session validity are checked again on confirmation.
- Previews expire after five minutes and are removed from memory by a timer. One
  preview per session and at most 16 per process are retained, each ZIP at most
  256 KiB. Only one collector and two downloads run at a time, so slow downloads cannot
  retain unbounded consumed archives. Collection has a three-second database deadline.
  Replacing a session's preview invalidates the old one. A failed audit write
  prevents download and requires a fresh preview.

The ZIP contains six fixed files:

| File                 | Contents and boundary                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build.json`         | Application/Go version, OS/architecture, available VCS revision and modified flag. No module replacement paths or environment.                                                                                                                                                                                                        |
| `configuration.json` | An explicit scalar allowlist from the running startup configuration. Numbers, booleans and normalized enums only. All names, paths, addresses, URLs, contacts and credentials are structurally omitted. Live database settings are not included.                                                                                      |
| `database.json`      | Applied migration names from the embedded catalog, known table names and counts from one read transaction, and aggregate writer wait counters. No rows, SQL definitions/defaults, unknown migration names, custom table names, plugin storage or search index.                                                                        |
| `health.json`        | Database readability, process memory/GC/goroutine counts, and available aggregate hub connection/replay/drop/backpressure counters. This snapshot does not test LiveKit or the client's media path.                                                                                                                                   |
| `events.json`        | At most 200 recent timestamp/level/event-code records. Exact known application messages map to fixed codes for voice, socket, storage, backup and maintenance failures. Unknown messages become `log_event`; all raw messages, attributes and source paths are omitted. Invalid timestamps are omitted and unknown levels normalized. |
| `manifest.json`      | Capture time, payload item sizes/hashes/data classes and the same omission report shown in preview. The manifest hashes the five payload files; preview additionally hashes the manifest itself and the complete ZIP, avoiding a self-referential manifest digest.                                                                    |

This implementation is intentionally stricter than the upper bound in clause 3:
there is no raw log excerpt and no per-bundle address opt-in. Structural omission
also covers unfamiliar secret formats, including secrets embedded in arbitrary
configuration strings or log attributes. Table counts do not expose their rows.
No archive or preview is written to disk on the server; only the required audit row is persisted. The browser initiates a
local download, and sharing that file remains the administrator's decision.

`support_bundle_create` is written synchronously at confirmation with the actor
and the fixed item list only, never contents, session hashes or preview IDs.

Verification: `Server/admin/support_bundle_test.go` exercises real database rows,
planted session/API/password/TOTP/recovery/GitHub/LiveKit/OTLP/environment secrets,
a scanner negative control, frozen archive/per-item hashes, content-free audit,
forbidden selections, authentication, session binding and permission revocation.
`support_store_test.go` covers expiry, bounded memory, replacement and concurrent
single-use confirmation; `Server/db/diagnostics_test.go` excludes custom schema
names and rows. The executable panel contract in
`Client/tests/contract/server-admin-support-bundle.test.ts` verifies preview,
separate confirmation, discard and sign-out during a pending preview.
