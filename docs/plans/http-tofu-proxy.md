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
reuse that would bypass the rewrite). Since 2026-09-30 a bodyless GET, HEAD or
OPTIONS may reuse an idle _upstream_ TLS connection; the loopback side still
carries one request per connection. See
[Upstream connection reuse](#upstream-connection-reuse-2026-09-30).

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

`Connection: close` is injected per request, so every REST call and every
uncached image fetch (`fetchServerFile` in `attachments.ts`) opens a fresh TCP
and TLS connection through the tunnel. CLI-04(b) asked for that cost to be
measured before deciding whether to add connection reuse.

**What one cold open costs.** Driving the real client against a real server
with the fullstack e2e harness (`login()` in
`Client/tests/e2e/fullstack/fixtures.ts`: a fresh profile, login to the first
channel, 20 s settle) made **14 REST calls**, all through the tunnel, the same
14 on each of three runs (the order varies):

```
GET   /api/v1/server-info           GET   /api/v1/users/me/moderation
POST  /api/v1/auth/login            GET   /api/v1/appeals/mine
GET   /api/v1/blocks                PATCH /api/v1/users/me
GET   /api/v1/emoji                 GET   /api/v1/auth/me
GET   /api/v1/dm-requests           GET   /api/v1/users/me/sessions   (x2)
GET   /api/v1/users/me/recovery-kit GET   /admin/api/users
GET   /api/v1/channels/1/messages
```

`GET /admin/api/users` is there because the harness logs in as the server
owner. The capture is the server's own `http request` log lines after the
fixture's four setup calls (`POST /admin/api/setup`, `POST
/api/v1/auth/register`, two `POST /admin/api/channels`). Those four are not
counted because the harness sends them straight to the server from Playwright's
request context (`startTestServer` in `Client/tests/e2e/support/server.ts`), not
through the client or its tunnel. The spec is a throwaway one in
`Client/tests/e2e/fullstack/`:

```ts
import { test } from "./fixtures";
test("capture", async ({ alice, server }) => {
  await alice.waitForTimeout(20_000);
  console.log(server.log());
});
```

run with `npx playwright test --config playwright.config.fullstack.ts capture`
after `npm run test:e2e:build-server && npm run build`. The cold open made **no
image fetches** (the seeded channel is empty and the users have no avatars);
each image attachment that comes into view later costs one fetch, and so one
fresh connection, the first time only (the attachment caches serve it after
that).

So a remote-server cold open pays 14 connection setups instead of one. Each
setup is a TCP handshake (one RTT, since the tunnel dials the remote per
request) plus a full TLS 1.3 handshake (one RTT; the tunnel builds a new rustls
config per connection, so there is no session resumption).

**The measured overhead is two RTTs plus ~3-5 ms.** Measured with
`Client/tests/e2e/scripts/measure-tunnel-tls.mjs` (run from `Client/` after
`npm run test:e2e:build-server`), which starts the e2e server binary with a
self-signed certificate, uploads a PNG, and times a REST call and that image
fetch through a loopback delay gate. The gate delays every chunk by the one-way
delay in each direction and holds each new connection for one RTT before
dialing, standing in for the remote TCP handshake. "Fresh" is one request per
TCP + TLS connection, as the tunnel does; "keep-alive" is the second request on
a reused connection. Medians of 15 samples:

| One-way delay | RTT    | Request | Fresh connection | Keep-alive | Handshake overhead |
| ------------- | ------ | ------- | ---------------- | ---------- | ------------------ |
| 0 ms          | 0 ms   | REST    | 7.6 ms           | 2.7 ms     | **4.9 ms**         |
| 0 ms          | 0 ms   | Image   | 8.5 ms           | 3.1 ms     | **5.4 ms**         |
| 5 ms          | 10 ms  | REST    | 33.6 ms          | 10.9 ms    | **22.6 ms**        |
| 5 ms          | 10 ms  | Image   | 34.0 ms          | 11.3 ms    | **22.7 ms**        |
| 10 ms         | 20 ms  | REST    | 63.6 ms          | 21.0 ms    | **42.6 ms**        |
| 10 ms         | 20 ms  | Image   | 64.4 ms          | 21.5 ms    | **42.9 ms**        |
| 25 ms         | 50 ms  | REST    | 153.6 ms         | 51.0 ms    | **102.6 ms**       |
| 25 ms         | 50 ms  | Image   | 154.2 ms         | 51.5 ms    | **102.8 ms**       |
| 50 ms         | 100 ms | REST    | 303.4 ms         | 101.0 ms   | **202.4 ms**       |
| 50 ms         | 100 ms | Image   | 304.2 ms         | 101.6 ms   | **202.6 ms**       |

REST is `GET /api/v1/server-info`; Image is `GET /api/v1/files/{id}` for the
uploaded PNG. Both rows go through the same gate on the same server, timed by
the same code, so the Image rows are measured, not derived from the REST ones.
The overhead is 2 × RTT (TCP + TLS 1.3) plus a fixed ~3-5 ms of handshake
crypto and gate timers, the same for both requests; the first image load pays
22.7 / 42.9 / 102.8 / 202.6 ms at 10 / 20 / 50 / 100 ms RTT. A cold open makes
zero image fetches, so this cost starts with the first image attachment in
view, once per image. With no added delay the whole overhead is that fixed
~5 ms, which is why the cost is invisible locally and why U7e is about remote
servers. An earlier unrecorded gate reported 53 / 62 / 92 / 152 ms at 10 / 20 /
50 / 100 ms RTT (one RTT plus a fixed ~40-50 ms); it did not reproduce with this script and is
not used.

**Decision (2026-09-28): connection reuse is deferred to a separate security
review, not judged not worth it.** It has since shipped; see
[Upstream connection reuse](#upstream-connection-reuse-2026-09-30). A pooled keep-alive tunnel would change the invariants
the `Host` rewrite and per-request TOFU rest on, so it is not done here. Summed
over the 14 calls, the handshakes add ~70 ms to a cold open at a LAN RTT
(~1 ms) and ~2.8 s at a 100 ms WAN RTT, against ~1.4 s of request round trips
on reused connections; each call takes three RTTs instead of one. Several of
the calls run concurrently, so the wall-clock cost is lower than those sums,
but on a slow link it is the user-visible pain the report records, and real.
The tunnel's one-request-per-connection design is what makes the `Host` rewrite
and per-request TOFU safe (see the design notes in `http_proxy.rs`), and reuse
is a security-relevant change to that path, not a perf-only one. The right
shape is a pooled keep-alive tunnel that keeps the rewrite invariant, which is
its own change with its own review; the report keeps CLI-04(b) as a
measurement. The measured ceiling a future fix targets is the "Handshake
overhead" column above.

## Upstream connection reuse (2026-09-30)

The tunnel now keeps idle upstream TLS connections in a small pool
(`src-tauri/src/http_pool.rs`) and sends later requests over them, so a
repeat request skips the TCP and TLS handshakes. The webview side does not
change: every loopback connection carries one request, the proxy reads and
rewrites that request's `Host`, and the response the webview gets says
`Connection: close`. Only the upstream side of the tunnel is reused.

**Which requests are pooled.** A GET, HEAD or OPTIONS with no body (no
`Content-Length` above 0, no `Transfer-Encoding`), no `Upgrade` and no
`Expect`. Everything else, including uploads and every POST, PATCH, PUT and
DELETE, keeps the one-shot path: its own TLS connection, its own TOFU check,
`Connection: close`, and the bidirectional copy with upload progress. PUT
and DELETE are idempotent but not safe: a replayed DELETE can answer 404
where the first one succeeded, so they are not retried and not pooled. On a
cold open that pools 12 of the 14 calls listed above; `POST /auth/login` and
`PATCH /users/me` stay one-shot.

**Invariants.**

- **Keyed by exact host and port.** The pool key is the tunnel's
  `remote_host` string, which also sets the dial target, SNI and the rewritten
  `Host`. A connection is never reused for a different host or port.
- **Tied to the pin it verified.** Each idle connection records the
  fingerprint its handshake verified. `checkout` reads the host's stored pin
  first and hands out a connection only if that fingerprint is still the pin;
  it drops every connection for the host that no longer matches, and all of
  them when no pin is stored (a forgotten host). The next request then dials
  fresh and runs the full TOFU check. `accept_cert_fingerprint` (re-pin or
  first accept), a mismatch, a first-use prompt, a public-CA renewal and
  `stop_http_proxy` also drop the host's connections outright. rustls does
  not implement TLS renegotiation, so a connection cannot change certificate
  after its handshake: the handshake-time check covers every request on it.
- **Host rewrite unchanged.** Each pooled request arrives on its own loopback
  connection and goes through the same rewrite as before, with
  `Connection: keep-alive` upstream instead of `close`. No request reaches the
  server without the rewrite.
- **Only clean response ends are reused.** The proxy reads the response head
  and relays the body exactly as far as its framing says (`Content-Length`,
  chunked, or no body for HEAD, 1xx, 204 and 304). A response with
  `Connection: close`, an HTTP/1.0 response, a body delimited by the
  connection closing, `Content-Length` and `Transfer-Encoding` together, or
  any byte left unread after the response ends the connection instead of
  pooling it. An idle connection the server closed, or wrote to while idle, is
  dropped at checkout. Bytes are relayed unchanged apart from the response's
  `Connection` field, which the webview gets as one `Connection: close`.
- **Bounded.** At most 4 idle connections per host, each closed 30 s after
  it went idle (the server's own idle timeout is 120 s). Idle age is also
  measured on the wall clock, so a connection that sat idle across a system
  suspend (which the monotonic clock does not count) is not handed out.
  Response heads are capped at 64 KiB and the data phase keeps its 600 s
  deadline.
- **One retry.** If a pooled connection fails before any response byte
  reaches the webview (the server closed it as the request arrived), or does
  not start answering within 10 s (the connect and handshake bound; its
  network path died while it sat idle, so no FIN or RST ever arrives), the
  request is sent once more on a fresh, fully verified connection, which
  keeps the full 600 s deadline. A failure after that, or after bytes reached
  the webview, is returned to the webview as before.

**TCP_NODELAY.** Measuring this showed a second, separate cost on the one-shot
path: with Nagle's algorithm on, the request waited behind the handshake's
last flight for the server's delayed ACK, about 40 ms per fresh connection at
low RTT (visible in the 0 ms and 5 ms rows; at 20 ms RTT and above the gate's
own delay hides it). `connect_verified` now sets TCP_NODELAY on the REST
tunnel's upstream socket. The WS and LiveKit proxies are unchanged.

**Measured.** `node tests/e2e/scripts/measure-tunnel-tls.mjs --tunnel` (from
`Client/`, after `npm run test:e2e:build-server`; on Linux with the webrtc
toolchain set up, since it runs `cargo test`) uses the same server, upload and
delay gate as the table above, and times one request through the tunnel's own
upstream code (the ignored `measure_tunnel_reuse` test in `http_proxy.rs`):
the one-shot path as it was, the one-shot path with TCP_NODELAY, and the second
request on a pooled connection. "Saved" is before minus pooled. Medians of 15
samples, debug build, 2026-09-30:

| One-way delay | RTT    | Request | Before (one-shot) | One-shot, no Nagle | Pooled   | Saved    |
| ------------- | ------ | ------- | ----------------- | ------------------ | -------- | -------- |
| 0 ms          | 0 ms   | REST    | 49.1 ms           | 8.3 ms             | 2.7 ms   | 46.4 ms  |
| 0 ms          | 0 ms   | Image   | 48.3 ms           | 7.2 ms             | 3.0 ms   | 45.3 ms  |
| 5 ms          | 10 ms  | REST    | 73.6 ms           | 33.6 ms            | 10.9 ms  | 62.7 ms  |
| 5 ms          | 10 ms  | Image   | 73.8 ms           | 33.1 ms            | 11.4 ms  | 62.4 ms  |
| 10 ms         | 20 ms  | REST    | 63.2 ms           | 62.9 ms            | 21.0 ms  | 42.2 ms  |
| 10 ms         | 20 ms  | Image   | 63.6 ms           | 63.6 ms            | 21.4 ms  | 42.2 ms  |
| 25 ms         | 50 ms  | REST    | 153.1 ms          | 152.9 ms           | 51.0 ms  | 102.1 ms |
| 25 ms         | 50 ms  | Image   | 153.5 ms          | 153.9 ms           | 51.4 ms  | 102.1 ms |
| 50 ms         | 100 ms | REST    | 303.0 ms          | 302.8 ms           | 101.0 ms | 202.1 ms |
| 50 ms         | 100 ms | Image   | 303.3 ms          | 303.1 ms           | 101.4 ms | 201.9 ms |

A pooled request costs one RTT plus ~1-3 ms, the same as the keep-alive
column above. At 100 ms RTT that is ~101 ms instead of ~303 ms per repeat
request, and on a cold open the 12 pooled calls pay the handshakes only for
the connections the webview opens concurrently, not once per call.

## TOFU semantics (must match ws_proxy)

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
