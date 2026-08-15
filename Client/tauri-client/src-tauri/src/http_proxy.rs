// Local TCP-to-TLS proxy for REST/HTTP requests — closes audit A-2026-07-02.
//
// Problem: HTTP API calls previously used tauri-plugin-http with
// `danger.acceptInvalidCerts`, so the REST path (which carries the bearer
// token on every request) accepted ANY certificate while the WebSocket and
// LiveKit paths were TOFU-pinned in Rust.
//
// Solution: This module starts one plain TCP listener on localhost per remote
// host. The webview fetches http://127.0.0.1:{port}/api/v1/... and the proxy
// opens a TLS connection to the real server, enforcing the same TOFU
// (Trust On First Use) fingerprint pinning as ws_proxy:
// - Unknown host  → REJECT (502) and emit `cert-tofu` (status "first_use") so
//   the UI prompts the user to confirm the fingerprint. Nothing is pinned or
//   forwarded until the user explicitly accepts (accept_cert_fingerprint), so
//   no credential is ever sent to an unconfirmed host. HTTP is the FIRST TLS
//   contact with a server (login precedes the WS connect), so this proxy
//   usually surfaces the first-use prompt. (F4/F8)
// - Pinned host   → fingerprint must match or the connection is refused and a
//   `cert-tofu` mismatch event fires (CertMismatchModal flow).
//
// Design notes (docs/plans/http-tofu-proxy.md):
// - One request per tunnel connection: the proxy rewrites the first request's
//   Host header to the real host and injects `Connection: close`, so
//   keep-alive reuse (whose later requests would bypass the rewrite) never
//   happens. Per-request TLS overhead is acceptable for this app's REST
//   traffic; the hot path is the WebSocket.
// - Per-host tunnels: the Connect page polls health for every profile, so
//   multiple proxies can run concurrently (bounded by profile count).
// - The accept loop exits after 5 consecutive errors to prevent CPU spin.

use log::{debug, error, info, warn};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use rustls::pki_types::ServerName;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use crate::tofu::{self, TofuOutcome};

/// Tauri-managed state: one running tunnel per remote host.
pub struct HttpProxyState {
    inner: Mutex<HashMap<String, ProxyEntry>>,
}

struct ProxyEntry {
    port: u16,
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

impl HttpProxyState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Remove the `remote_host` entry, but only if it still points at `port`.
    /// Used by `run_proxy_loop`'s accept-error exit path to deregister a dead
    /// tunnel without racing a newer tunnel that may have already replaced it
    /// (e.g. `stop_http_proxy` + a fresh `start_http_proxy` while this loop
    /// was mid-shutdown).
    async fn remove_if_port_matches(&self, remote_host: &str, port: u16) {
        let mut inner = self.inner.lock().await;
        if inner.get(remote_host).is_some_and(|entry| entry.port == port) {
            inner.remove(remote_host);
        }
    }
}

/// Validate a remote host string before it is used in header rewriting and
/// dialing. Mirrors start_livekit_proxy's checks.
fn validate_remote_host(remote_host: &str) -> Result<(), String> {
    if remote_host.is_empty() || remote_host.len() > 260 {
        return Err("remote_host is empty or too long".into());
    }
    if remote_host.contains('\r') || remote_host.contains('\n') || remote_host.contains('\0') {
        return Err("remote_host contains invalid characters".into());
    }
    if !remote_host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err("remote_host contains unexpected characters".into());
    }
    Ok(())
}

/// Start (or reuse) a local HTTP→TLS tunnel for `remote_host` and return the
/// loopback port. The webview should send its REST traffic to
/// `http://127.0.0.1:{port}`.
#[tauri::command]
pub async fn start_http_proxy<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, HttpProxyState>,
    remote_host: String,
) -> Result<u16, String> {
    validate_remote_host(&remote_host)?;

    let mut inner = state.inner.lock().await;

    if let Some(entry) = inner.get(&remote_host) {
        debug!(
            "[http_proxy] reusing tunnel on port {} for {}",
            entry.port, remote_host
        );
        return Ok(entry.port);
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("http proxy bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("http proxy local_addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let loop_handle = tokio::spawn(run_proxy_loop(
        app.clone(),
        listener,
        remote_host.clone(),
        port,
        shutdown_rx,
    ));
    // Watch the loop so a panic is logged instead of vanishing silently (which
    // would leave JS with a stale cached port and no error).
    tokio::spawn(async move {
        match loop_handle.await {
            Ok(()) => info!("[http_proxy] proxy loop exited"),
            Err(e) if e.is_panic() => error!("[http_proxy] proxy loop panicked: {e:?}"),
            Err(e) => warn!("[http_proxy] proxy loop join error: {e:?}"),
        }
    });

    info!(
        "[http_proxy] tunnel started on 127.0.0.1:{} → {}",
        port, remote_host
    );
    inner.insert(remote_host, ProxyEntry { port, shutdown_tx });
    Ok(port)
}

/// Stop the tunnel for `remote_host` (no-op if none is running).
#[tauri::command]
pub async fn stop_http_proxy(
    state: tauri::State<'_, HttpProxyState>,
    remote_host: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if let Some(entry) = inner.remove(&remote_host) {
        let _ = entry.shutdown_tx.send(());
        info!("[http_proxy] tunnel stopped for {}", remote_host);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// TOFU verification lives in the shared `tofu` module (crate::tofu):
// CaptureVerifier, cert_store_key, evaluate/decide, and the mismatch message.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Proxy internals
// ---------------------------------------------------------------------------

/// Maximum consecutive accept errors before the proxy loop exits.
const MAX_CONSECUTIVE_ACCEPT_ERRORS: u32 = 5;

async fn run_proxy_loop<R: Runtime>(
    app: AppHandle<R>,
    listener: TcpListener,
    remote_host: String,
    port: u16,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let mut consecutive_errors: u32 = 0;

    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, addr)) => {
                        consecutive_errors = 0;
                        let host = remote_host.clone();
                        let app = app.clone();
                        debug!("[http_proxy] accepted connection from {}", addr);
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(app, stream, &host).await {
                                warn!("[http_proxy] connection to {} failed: {}", host, e);
                            }
                        });
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        error!(
                            "[http_proxy] accept error ({}/{}): {}",
                            consecutive_errors, MAX_CONSECUTIVE_ACCEPT_ERRORS, e
                        );
                        if consecutive_errors >= MAX_CONSECUTIVE_ACCEPT_ERRORS {
                            error!(
                                "[http_proxy] {} consecutive accept errors, stopping proxy loop",
                                MAX_CONSECUTIVE_ACCEPT_ERRORS
                            );
                            // Deregister the dead tunnel BEFORE the break drops
                            // `listener`, so a future start_http_proxy rebinds a
                            // fresh port instead of handing back this closed one
                            // forever. Doing it here rather than after the loop
                            // returns matters: the listener still holds the port,
                            // so no newer tunnel can have been handed the same
                            // number and the port guard cannot misfire.
                            if let Some(state) = app.try_state::<HttpProxyState>() {
                                state.remove_if_port_matches(&remote_host, port).await;
                            } else {
                                warn!(
                                    "[http_proxy] state unmanaged; cannot deregister dead tunnel for {}",
                                    remote_host
                                );
                            }
                            break;
                        }
                    }
                }
            }
            _ = &mut shutdown_rx => break,
        }
    }
}

/// Rewrite the first request's headers: replace Host with the real remote
/// host and force `Connection: close` so exactly one request rides each
/// tunnel connection (later keep-alive requests would bypass this rewrite).
/// `raw` must end with the "\r\n\r\n" header terminator.
fn rewrite_request_headers(raw: &[u8], remote_host: &str) -> String {
    let request = String::from_utf8_lossy(raw);
    let mut modified = String::with_capacity(raw.len() + 128);
    let mut lines = request.split("\r\n").peekable();
    let mut first = true;
    while let Some(line) = lines.next() {
        if !first {
            modified.push_str("\r\n");
        }
        first = false;
        // The terminator produces two trailing empty strings; emit them as-is.
        if line.is_empty() && lines.peek().is_none() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            modified.push_str("Host: ");
            modified.push_str(remote_host);
        } else if lower.starts_with("connection:") {
            modified.push_str("Connection: close");
        } else {
            modified.push_str(line);
        }
    }
    // `break` above consumed one empty segment; restore the full terminator.
    if !modified.ends_with("\r\n\r\n") {
        while !modified.ends_with("\r\n\r\n") {
            modified.push_str("\r\n");
        }
    }
    // If the client never sent a Connection header, inject one.
    if !modified.to_ascii_lowercase().contains("\r\nconnection:") {
        let insert_at = modified.len() - 2; // before final CRLF
        modified.insert_str(insert_at, "Connection: close\r\n");
    }
    modified
}

/// Bracket-aware split of a `remote_host` string into (hostname, port).
/// Defaults to port 443 (standard HTTPS) when none is specified.
///
/// A leading `[` consumes up to the matching `]` as the hostname, so a
/// bracketed IPv6 literal parses correctly whether or not it carries an
/// explicit port (`[::1]`, `[::1]:8443`). Without brackets, a single
/// trailing colon is a `host:port` split — but a *bare* (unbracketed) IPv6
/// literal contains more than one colon, and RFC 3986 gives it no way to
/// carry a port without brackets, so that case is returned whole with the
/// default port instead of being mis-split on its last colon.
fn split_host_port(remote_host: &str) -> Result<(&str, &str), String> {
    if let Some(rest) = remote_host.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| format!("unterminated '[' in remote_host '{remote_host}'"))?;
        let port = tail.strip_prefix(':').unwrap_or("443");
        Ok((host, port))
    } else {
        match remote_host.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => Ok((host, port)),
            _ => Ok((remote_host, "443")),
        }
    }
}

/// Derive the TLS `ServerName` (SNI) and the TCP dial target from a
/// `remote_host` string. Mirrors `livekit_proxy::parse_server_name`'s
/// bracket handling.
fn resolve_remote_target(remote_host: &str) -> Result<(ServerName<'static>, String), String> {
    let (hostname, port) = split_host_port(remote_host)?;
    let server_name = if let Ok(ip) = hostname.parse::<IpAddr>() {
        ServerName::IpAddress(ip.into())
    } else {
        ServerName::try_from(hostname.to_string())
            .map_err(|e| format!("invalid server name '{hostname}': {e}"))?
    };

    let dial_target = if hostname.contains(':') {
        format!("[{hostname}]:{port}")
    } else {
        format!("{hostname}:{port}")
    };
    Ok((server_name, dial_target))
}

/// Handle one proxied connection:
/// 1. Read the request headers from the loopback side
/// 2. TLS-connect to the remote and run the TOFU check (store/emit/reject)
/// 3. Forward the rewritten request, then shovel bytes bidirectionally
async fn handle_connection<R: Runtime>(
    app: AppHandle<R>,
    mut local: TcpStream,
    remote_host: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // ── 1. Read HTTP request headers (up to \r\n\r\n), 10s guard ─────────
    let mut buf = Vec::with_capacity(4096);
    timeout(Duration::from_secs(10), async {
        let mut trailer = [0u8; 4];
        loop {
            let mut byte = [0u8; 1];
            local.read_exact(&mut byte).await?;
            buf.push(byte[0]);
            trailer[0] = trailer[1];
            trailer[1] = trailer[2];
            trailer[2] = trailer[3];
            trailer[3] = byte[0];
            if trailer == *b"\r\n\r\n" {
                break;
            }
            if buf.len() > 16_384 {
                return Err(Box::<dyn std::error::Error + Send + Sync>::from(
                    "HTTP request headers too large",
                ));
            }
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    })
    .await
    .map_err(|_| {
        Box::<dyn std::error::Error + Send + Sync>::from("request header read timed out")
    })??;

    // Defense-in-depth (primary validation is in start_http_proxy).
    validate_remote_host(remote_host)?;
    let modified = rewrite_request_headers(&buf, remote_host);

    // ── 2. TLS connect + TOFU check ──────────────────────────────────────
    let (verifier, captured_fp) = tofu::CaptureVerifier::new();
    let tls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));

    let (server_name, dial_target) = resolve_remote_target(remote_host)?;
    let tcp = timeout(Duration::from_secs(10), TcpStream::connect(&dial_target))
        .await
        .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from("TCP connect timed out"))??;
    let mut tls = timeout(Duration::from_secs(10), connector.connect(server_name, tcp))
        .await
        .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from("TLS handshake timed out"))??;

    let fingerprint = captured_fp
        .lock()
        .map_err(|e| format!("failed to read captured fingerprint: {e}"))?
        .clone()
        .unwrap_or_default();
    if fingerprint.is_empty() {
        return Err("TLS handshake completed but no certificate fingerprint was captured".into());
    }

    let store_key = tofu::cert_store_key(remote_host);
    match tofu::evaluate(&app, &store_key, &fingerprint)? {
        TofuOutcome::Trusted => {
            crate::ws_proxy::emit_cert_tofu(
                &app,
                serde_json::json!({
                    "host": store_key,
                    "fingerprint": fingerprint,
                    "status": "trusted",
                }),
            );
        }
        // F4/F8: a first-use cert is NOT silently pinned or forwarded to. Reject
        // the request (502) and surface the fingerprint so the user can confirm
        // it (accept_cert_fingerprint) before any credential-bearing request is
        // sent. The connect page's health check triggers this before login.
        TofuOutcome::FirstUse => {
            info!("[http_proxy] first-use cert for {} — awaiting user confirmation", store_key);
            crate::ws_proxy::emit_cert_tofu(
                &app,
                serde_json::json!({
                    "host": store_key,
                    "fingerprint": fingerprint,
                    "status": "first_use",
                }),
            );
            let _ = local
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                )
                .await;
            return Err(format!(
                "certificate for {store_key} is not yet trusted; confirm the fingerprint to continue"
            )
            .into());
        }
        TofuOutcome::Mismatch { stored } => {
            let mismatch_msg = tofu::mismatch_message(&store_key, &stored, &fingerprint);
            warn!(
                "[http_proxy] TOFU check FAILED for {} — certificate fingerprint mismatch",
                store_key
            );
            crate::ws_proxy::emit_cert_tofu(
                &app,
                serde_json::json!({
                    "host": store_key,
                    "fingerprint": fingerprint,
                    "status": "mismatch",
                    "message": mismatch_msg,
                    "storedFingerprint": stored,
                }),
            );
            // Give the local fetch a clean HTTP failure instead of a reset.
            let _ = local
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                )
                .await;
            return Err(mismatch_msg.into());
        }
    }

    // ── 3. Forward request + bidirectional copy ──────────────────────────
    tls.write_all(modified.as_bytes()).await?;
    match io::copy_bidirectional(&mut local, &mut tls).await {
        Ok((to_remote, from_remote)) => {
            debug!(
                "[http_proxy] connection closed: {}B sent, {}B received",
                to_remote, from_remote
            );
        }
        Err(e) => {
            debug!("[http_proxy] bidirectional copy ended: {}", e);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: the accept-error exit path in run_proxy_loop must be able to
    // deregister its own dead entry, but must NOT clobber a newer tunnel that
    // has since replaced it under the same remote_host key.
    #[tokio::test]
    async fn remove_if_port_matches_removes_only_matching_entry() {
        let state = HttpProxyState::new();
        {
            let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
            let mut inner = state.inner.lock().await;
            inner.insert(
                "example.com:8443".to_string(),
                ProxyEntry {
                    port: 4242,
                    shutdown_tx: tx,
                },
            );
        }

        // A stale loop reporting a port that no longer matches the live
        // entry must leave the current entry alone.
        state
            .remove_if_port_matches("example.com:8443", 9999)
            .await;
        assert_eq!(
            state.inner.lock().await.get("example.com:8443").map(|e| e.port),
            Some(4242),
            "mismatched port must not remove a newer tunnel's entry"
        );

        // A loop reporting its own still-current port must remove it.
        state
            .remove_if_port_matches("example.com:8443", 4242)
            .await;
        assert!(
            state.inner.lock().await.get("example.com:8443").is_none(),
            "matching port must deregister the dead tunnel"
        );
    }

    #[test]
    fn validate_rejects_crlf_and_null() {
        assert!(validate_remote_host("evil\r\nhost").is_err());
        assert!(validate_remote_host("evil\0host").is_err());
    }

    #[test]
    fn validate_rejects_empty_and_odd_chars() {
        assert!(validate_remote_host("").is_err());
        assert!(validate_remote_host("host name").is_err());
        assert!(validate_remote_host("host/path").is_err());
    }

    #[test]
    fn validate_accepts_typical_hosts() {
        assert!(validate_remote_host("example.com:8443").is_ok());
        assert!(validate_remote_host("192.168.1.10:8443").is_ok());
        assert!(validate_remote_host("[::1]:8443").is_ok());
    }

    // OC-0021: IPv6 hosts that are not in the exact `[addr]:port` shape must
    // still resolve to a valid ServerName and a dialable host:port target.

    #[test]
    fn resolve_remote_target_handles_bracketed_ipv6_without_port() {
        let (server_name, dial_target) = resolve_remote_target("[2001:db8::1]")
            .expect("bracketed IPv6 without a port must parse");
        assert!(matches!(server_name, ServerName::IpAddress(_)));
        assert_eq!(dial_target, "[2001:db8::1]:443");
    }

    #[test]
    fn resolve_remote_target_handles_bare_ipv6_without_port() {
        let (server_name, dial_target) =
            resolve_remote_target("2001:db8::1").expect("bare IPv6 without a port must parse");
        assert!(matches!(server_name, ServerName::IpAddress(_)));
        assert_eq!(dial_target, "[2001:db8::1]:443");
    }

    #[test]
    fn resolve_remote_target_still_handles_bracketed_ipv6_with_port() {
        let (server_name, dial_target) = resolve_remote_target("[2001:db8::1]:8443")
            .expect("bracketed IPv6 with a port must parse");
        assert!(matches!(server_name, ServerName::IpAddress(_)));
        assert_eq!(dial_target, "[2001:db8::1]:8443");
    }

    #[test]
    fn resolve_remote_target_still_handles_plain_hostname_and_port() {
        let (server_name, dial_target) =
            resolve_remote_target("example.com:8443").expect("hostname:port must parse");
        assert!(matches!(server_name, ServerName::DnsName(_)));
        assert_eq!(dial_target, "example.com:8443");
    }

    #[test]
    fn rewrite_replaces_host_and_forces_close() {
        let raw = b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nAccept: */*\r\n\r\n";
        let out = rewrite_request_headers(raw, "example.com:8443");
        assert!(out.contains("Host: example.com:8443\r\n"));
        assert!(!out.contains("127.0.0.1"));
        assert!(out.to_ascii_lowercase().contains("connection: close"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn rewrite_overrides_existing_keepalive() {
        let raw =
            b"POST /x HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nConnection: keep-alive\r\n\r\n";
        let out = rewrite_request_headers(raw, "example.com:8443");
        assert!(out.contains("Connection: close\r\n"));
        assert!(!out.to_ascii_lowercase().contains("keep-alive"));
        // Exactly one Connection header.
        assert_eq!(out.to_ascii_lowercase().matches("\r\nconnection:").count(), 1);
    }

    #[test]
    fn rewrite_preserves_other_headers_and_body_boundary() {
        let raw = b"POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1:9\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n";
        let out = rewrite_request_headers(raw, "myserver.lan:8443");
        assert!(out.contains("Content-Type: application/json\r\n"));
        assert!(out.contains("Content-Length: 2\r\n"));
        assert!(out.ends_with("\r\n\r\n"));
    }
}
