# Client HTTP TOFU Proxy (D5) — Design

**Status:** design only, not implemented
**Decision:** D5 in [audit-2026-07-19-decisions.md](audit-2026-07-19-decisions.md) — "next security work"
**Closes:** audit finding A-2026-07-02 (client HTTP path accepts any TLS certificate)

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

## TOFU semantics (must match ws_proxy)

- **Pin store:** the same per-host fingerprint store used by `ws_proxy.rs`
  (`certs.json` via `commands.rs`); one fingerprint per host covers all three
  transports.
- **First contact:** unlike today, the *first* TLS contact with a server is
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
