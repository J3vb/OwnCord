# Client HTTP TOFU Proxy (D5) — Design

**Status:** implemented 2026-07-19 — re-verified 2026-08-04
(`src-tauri/src/http_proxy.rs` + `src/lib/httpProxy.ts`; capability scope in
`capabilities/default.json`)
**Decision:** D5 in [audit-2026-07-19-decisions.md](audit-2026-07-19-decisions.md) — "next security work"
**Closes:** audit finding A-2026-07-02 (client HTTP path accepts any TLS certificate)

## Implementation summary (what shipped)

Chose **variant 1 (byte tunnel)** with a targeted header rewrite: the first
request's `Host` is rewritten to the real host and `Connection: close` is
injected so exactly one request rides each tunnel connection (no keep-alive
reuse that would bypass the rewrite).

- `src-tauri/src/http_proxy.rs` — per-host loopback TCP→TLS tunnels
  (`HttpProxyState` = `HashMap<host, ProxyEntry>`); per-connection TOFU
  (`CaptureVerifier` + `tofu_check`) sharing ws_proxy's cert store
  (`cert_store_key`) and emitting the same `cert-tofu` events (first-use
  banner / mismatch modal); commands `start_http_proxy` / `stop_http_proxy`;
  mismatch returns a clean `502` to the loopback fetch. Registered in
  `lib.rs`.
- `src/lib/httpProxy.ts` — `ensureHttpProxy(host)` (per-host cache +
  concurrent-start dedup) / `stopHttpProxy(host)`.
- `api.ts`, `profiles.ts` (health), `attachments.ts` (image + download) now
  resolve server URLs to `http://127.0.0.1:{port}`; **all `acceptInvalidCerts`
  usage and the `allowSelfSigned` config field are removed**, and the
  `dangerous-settings` feature is dropped from `Cargo.toml`.
- `capabilities/default.json` gains `http://127.0.0.1:*` fetch scope; CSP
  already allowed loopback.

External hosts (image CDNs, OG previews, YouTube) keep normal TLS validation.

## Problem

Every REST call from the client uses `tauri-plugin-http` with
`danger: { acceptInvalidCerts: true }` (`allowSelfSigned` hardcoded in
`src/main.ts`), and the bearer token rides on every request. The WS path
(`ws_proxy.rs`) and the LiveKit path (`livekit_proxy.rs`) pin a
trust-on-first-use SHA-256 certificate fingerprint per host; the HTTP path is
the only unpinned transport. An active MITM can capture session tokens without
ever triggering the cert-mismatch UI.

## Approach — loopback TCP→TLS tunnel (reuse the LiveKit proxy pattern)

Add `src-tauri/src/http_proxy.rs`, structurally a sibling of
`livekit_proxy.rs`: a plain TCP listener on `127.0.0.1:{ephemeral}` that
byte-shovels to `https://{host}:{port}` over rustls with a pinned-fingerprint
verifier. The webview then talks **plain HTTP to loopback**, and all TLS trust
decisions live in Rust:

- `livekit_proxy.rs` already contains the two building blocks to extract into
  a shared module (`tls_tunnel.rs`): the loopback `TcpListener` accept loop
  and the `PinnedCertVerifier` (SHA-256 colon-hex fingerprint check,
  `livekit_proxy.rs` ~line 79).
- HTTP/1.1 keep-alive works transparently over a byte tunnel. The `Host`
  header sent by the webview must be rewritten? **No** — configure the API
  client to send the real host in `Host` (tauri-plugin-http keeps the URL's
  host; since the URL is `http://127.0.0.1:{port}`, inject a `Host: {real}`
  header explicitly, or terminate HTTP in the proxy — see "Two variants").
  TLS SNI is handled by the tunnel (it dials by hostname).

### Two variants, pick at implementation time

1. **Pure byte tunnel** (smallest): identical to livekit_proxy. Requires the
   TS client to set `Host` explicitly per request (tauri-plugin-http allows
   custom headers; verify it doesn't override `Host` — if it does, fall back
   to variant 2).
2. **Minimal HTTP-aware proxy**: parse only the request line + headers,
   rewrite `Host`, then stream bodies both ways. More code, but removes the
   header caveat and allows per-request logging. Still no TLS termination in
   the webview.

## Measured per-request TLS cost (CLI-04(b), 2026-09-28)

`Connection: close` is injected per request, so every REST call and the first
image fetch opens a fresh TLS connection through the tunnel. CLI-04(b) asked
for that cost to be measured before deciding whether to add connection reuse.

**What one cold open costs.** Driving the real client against a real
self-signed server (the fullstack e2e harness, one login to first channel)
made **18 REST calls**, all through the tunnel:

```
GET  /api/v1/server-info            GET  /api/v1/blocks
POST /api/v1/auth/login             GET  /api/v1/appeals/mine
GET  /api/v1/emoji                  GET  /api/v1/users/me/moderation
GET  /api/v1/dm-requests            PATCH /api/v1/users/me
GET  /api/v1/users/me/sessions   x2 GET  /api/v1/auth/me
GET  /api/v1/users/me/recovery-kit  GET  /api/v1/channels/1/messages
GET  /api/v1/server-info ...
```

so a remote-server cold open pays 18 TLS handshakes instead of one. Each
handshake is one extra round trip beyond the request itself (TLS 1.3 sends the
ClientHello and Finished in one flight, so the handshake adds one RTT, not the
two of a full TLS 1.2 exchange).

**The handshake cost is one RTT.** Measured against a real server over a
loopback delay gate that adds a fixed one-way delay to every hop (so the
figure is the network's, not the machine's):

| Added one-way delay | RTT    | Fresh-connection request | Keep-alive request | Handshake overhead |
| ------------------- | ------ | ------------------------ | ------------------ | ------------------ |
| 5 ms                | 10 ms  | 63 ms                    | 10 ms              | **53 ms**          |
| 10 ms               | 20 ms  | 83 ms                    | 21 ms              | **62 ms**          |
| 25 ms               | 50 ms  | 143 ms                   | 51 ms              | **92 ms**          |
| 50 ms               | 100 ms | 253 ms                   | 100 ms             | **152 ms**         |

The overhead is roughly one RTT plus the record-layer work; the reused-request
column already includes the round trip, so the two columns differ by the
handshake. On loopback (sub-millisecond RTT) the handshake is **~0.9 ms**, which
is why the cost is invisible locally and why U7e is about remote servers.

**Decision: not worth a connection pool now, and the claim is published as
measured rather than asserted.** 18 handshakes at a LAN RTT (~1 ms) adds ~15 ms
to a cold open; at a 100 ms WAN RTT it adds ~2.5 s, but that open already pays
~2.5 s of request RTTs, so the handshake roughly doubles a slow cold open — the
user-visible pain the report records, and real. It is still not fixed here: the
tunnel's one-request-per-connection design is what makes the `Host` rewrite and
per-request TOFU safe (see the design notes in `http_proxy.rs`), and reuse is a
security-relevant change to that path, not a perf-only one. The right shape is
a pooled keep-alive tunnel that keeps the rewrite invariant, which is its own
change with its own review; the report keeps CLI-04(b) as a measurement. The
measured ceiling a future fix targets is the "Handshake overhead" column above.

- **Pin store:** the same per-host fingerprint store used by `ws_proxy.rs`
  (`certs.json` via `commands.rs`); one fingerprint per host covers all three
  transports.
- **First contact:** unlike today, the _first_ TLS contact with a server is
  the login HTTP request, not the WS connect. The HTTP proxy must therefore
  implement the same first-trust flow as `ws_proxy.rs`: unknown host →
  accept, store fingerprint, emit `cert-tofu` event (banner); known host +
  mismatch → refuse the connection and emit the mismatch event
  (`CertMismatchModal` flow, reusing `accept_cert_fingerprint`,
  `ws_proxy.rs` ~line 419).
- **Rotation:** accepting a new fingerprint in the modal must apply to all
  three transports at once (single store already guarantees this).

## Lifecycle & wiring

- Commands: `http_proxy_start(host, port) -> u16` (idempotent per host,
  returns loopback port), `http_proxy_stop(host)`. One tunnel per host —
  the Connect page's multi-profile health polling (15s) starts tunnels on
  demand for each profile it polls; quick-switch stops the old host's tunnel.
- TS changes: `createApiClient` gains a `baseUrl` of
  `http://127.0.0.1:{port}` resolved via the proxy; delete the
  `allowSelfSigned` flag and the `danger:` fetch options entirely. The
  `dangerous-settings` feature flag on tauri-plugin-http can then be dropped
  from `src-tauri/Cargo.toml` — build fails if any dangling
  `acceptInvalidCerts` remains, which is the desired ratchet.
- The self-hosted updater (`update_commands.rs`) already pins TLS itself —
  unchanged.
- CSP already allows localhost connections (`tauri.conf.json`).

## Testing

- Rust: unit tests for the verifier (match/mismatch/unknown-host TOFU), and
  an integration test dialing a local TLS listener with a self-signed cert
  (mirror `ws_proxy.rs`'s existing test style).
- TS: api tests swap to the loopback base URL; add a regression test that no
  code path passes `acceptInvalidCerts`.
- Manual: first connect (banner), cert rotation (modal), multi-profile health
  polling, large upload/download streaming through the tunnel.

## Non-goals

- No system-proxy support changes, no HTTP/2 (server is HTTP/1.1 via chi),
  no change to the WS or LiveKit proxies.
