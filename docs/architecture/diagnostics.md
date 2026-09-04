# Diagnostics, egress and the support-bundle contract

B4-8 (BPR-055, the server half of BG-15). This page answers three questions
an operator or a reviewer has about a self-hosted OwnCord server: **what can
I look at when something is wrong**, **what does the server ever send off
this machine**, and **what may a future support bundle contain**. The first
two are checked by tests on every CI run; the third is the contract the
B6/B9 bundle implementation must satisfy before it exists.

The short version: OwnCord sends no automatic product or usage telemetry.
Every outbound network path in the server is one of three things — an
action an admin or user took, a feature an operator switched on by
configuration, or a connection to this machine itself — and each is listed
below with its trigger and its gate. The list is enforced by the
`egress-sites` invariant, and a runtime capture proves the compiled defaults
open nothing beyond loopback across startup, registration, sign-in,
messaging, upload, idle and shutdown.

## Diagnostic surfaces (all local)

| Surface                      | Where                                                                    | Who can read it                                                            | Leaves the machine?                                                                        |
| ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Health probe                 | `GET /health`                                                            | anyone who can reach the port (no body detail beyond the subsystem reason) | no                                                                                         |
| Connectivity diagnostics     | `GET /api/v1/diagnostics/connectivity`                                   | `ADMINISTRATOR`, 5/min                                                     | no                                                                                         |
| JSON metrics                 | `GET /api/v1/metrics`                                                    | addresses in `server.metrics_allowed_cidrs` (else `admin_allowed_cidrs`)   | no — a scraper the operator admits pulls it                                                |
| Prometheus exporter          | `GET /metrics` (`-tags otel`, `telemetry.exporter: prometheus`)          | same allowlist                                                             | no — pulled, never pushed                                                                  |
| OpenTelemetry traces/metrics | OTLP (`-tags otel`, `telemetry.enabled`, `telemetry.exporter: otlp`)     | the collector at `telemetry.otlp_endpoint`                                 | **only** when an operator builds with the tag and configures an endpoint; absent otherwise |
| Server log                   | stdout, and the in-memory ring buffer behind the admin panel's live view | the process owner; `ADMINISTRATOR` via the SSE stream (single-use tickets) | no                                                                                         |
| Audit log                    | `audit_log` table, admin panel                                           | `VIEW_AUDIT_LOG`                                                           | no                                                                                         |
| Backups                      | `backup.dir` (scheduled and on demand)                                   | the process owner; `MANAGE_SERVER` via the admin API                       | no                                                                                         |
| Healthcheck CLI              | `owncord --healthcheck` probes this server's `/health`                   | the orchestrator                                                           | loopback only                                                                              |

Log content is governed by `logging.level`; usernames, ids and client
addresses appear at `info` (data-lifecycle class 22), which is why the
support-bundle contract below treats log excerpts as sensitive.

## Egress inventory

Every production site that can open an outbound connection, as the
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
default.

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
| `internal/app/healthcheck.go` — `RunHealthcheckCLI`                            | loopback | this server's `/health`                                                                                    | the `--healthcheck` flag                                                                                                     | nothing                                                                                                                                                    |
| `telemetry/telemetry_otel.go` — the OTLP exporter import                       | config   | `telemetry.otlp_endpoint`                                                                                  | `-tags otel` + `telemetry.enabled` + `exporter: otlp`                                                                        | traces and metrics, to the operator's own collector                                                                                                        |

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

BG-15's bundle lands in B6/B9. Whatever ships must satisfy this contract;
it is written against the data-class inventory in
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

Until that implementation exists, an operator who needs to share
diagnostics does so by hand, from the surfaces in the first table, and this
contract is the checklist for what to leave out.
