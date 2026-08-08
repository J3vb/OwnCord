// Local TCP-to-TLS proxy for LiveKit signal connections.
//
// Problem: The LiveKit JS SDK opens its own WebSocket from WebView2 directly.
// WebView2's native fetch/WS rejects self-signed TLS certificates, so remote
// connections to an OwnCord server using self-signed TLS fail with
// "could not establish signal connection: Failed to fetch".
//
// Solution: This module starts a plain TCP listener on localhost. The LiveKit
// SDK connects to ws://127.0.0.1:{port}/livekit/... (trusted, no TLS issues).
// The proxy opens a TLS connection to the remote server (accepting self-signed
// certs) and shovels bytes bidirectionally — transparently tunneling the HTTP
// upgrade and subsequent WebSocket frames.
//
// KNOWN LIMITATIONS / POTENTIAL ISSUES:
// - The proxy rewrites Host and Origin headers so the remote server's
//   WebSocket origin check accepts the connection. If the server adds
//   stricter origin validation this may need updating.
// - Certificate validation uses the TOFU-pinned fingerprint from ws_proxy.
//   The WebSocket proxy must connect first to establish trust; the LiveKit
//   proxy then pins to that same certificate. If the cert changes between
//   WS and LiveKit connections, the LiveKit handshake will fail (fail
//   closed) until the user accepts the new cert — each start call reloads
//   the stored pin and restarts the listener when it changed.
// - Only one proxy instance runs at a time (per remote host). Connecting to
//   a different server replaces the proxy. Stale proxy ports are not reused.
// - If the TcpListener errors (extremely unlikely on loopback), the cached
//   port in JS becomes stale until the next voice join resets it.
// - The accept loop exits after 5 consecutive errors to prevent CPU spin.

use log::{debug, error, info, warn};
use std::net::IpAddr;
use std::sync::Arc;
use rustls::pki_types::ServerName;
use tauri::{Manager, Runtime};
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// Tauri-managed state for the LiveKit TLS proxy.
pub struct LiveKitProxyState {
    inner: Mutex<ProxyInner>,
}

struct ProxyInner {
    /// Port the proxy is listening on (None if not running).
    port: Option<u16>,
    /// The remote host:port we're proxying to.
    remote_host: String,
    /// The TOFU fingerprint the running listener pins. Baked into the proxy
    /// loop at spawn, so a re-pin in the cert store requires a restart.
    pinned_fingerprint: String,
    /// Shutdown signal sender.
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl LiveKitProxyState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ProxyInner {
                port: None,
                remote_host: String::new(),
                pinned_fingerprint: String::new(),
                shutdown_tx: None,
            }),
        }
    }

    /// Clear the running-proxy state, but only if it still points at `port`.
    /// Mirrors HttpProxyState::remove_if_port_matches; used by run_proxy_loop's
    /// accept-error exit path so a dead listener doesn't keep being handed
    /// back by start_livekit_proxy's reuse branch, and doesn't race a newer
    /// proxy that may have already replaced it.
    async fn clear_if_port_matches(&self, port: u16) {
        let mut inner = self.inner.lock().await;
        if inner.port == Some(port) {
            inner.port = None;
            inner.remote_host.clear();
            inner.pinned_fingerprint.clear();
            inner.shutdown_tx = None;
        }
    }
}

// ---------------------------------------------------------------------------
// TLS verification & cert-store helpers live in the shared `tofu` module
// (crate::tofu): PinnedVerifier, cert_store_key, load_stored_fingerprint.
// ---------------------------------------------------------------------------

use crate::tofu;

// ---------------------------------------------------------------------------
// Pure helpers
//
// Split out of the command / connection-handling functions so the parts that
// decide what reaches the remote server — host validation, header rewriting and
// TLS server-name selection — are reachable from unit tests without a Tauri
// runtime or a live socket.
// ---------------------------------------------------------------------------

/// Reject `remote_host` values that could inject headers or are not plausible
/// host:port strings.
pub(crate) fn validate_remote_host(remote_host: &str) -> Result<(), String> {
    // CRLF or NUL would let a caller append arbitrary headers in the rewriting
    // logic below.
    if remote_host.contains('\r') || remote_host.contains('\n') || remote_host.contains('\0') {
        return Err("remote_host contains invalid characters".into());
    }
    // Basic hostname format: alphanumeric, dots, hyphens, colons (port), brackets (IPv6)
    if !remote_host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err("remote_host contains unexpected characters".into());
    }
    Ok(())
}

/// Rewrite the `Host` and `Origin` headers of a proxied HTTP request so the
/// remote server's WebSocket origin check accepts a connection that the
/// LiveKit SDK opened against `127.0.0.1`.
///
/// Every other line is passed through byte-for-byte, including the request
/// line and the trailing blank line that terminates the header block.
pub(crate) fn rewrite_proxy_headers(request: &str, remote_host: &str) -> String {
    let mut modified = String::with_capacity(request.len() + 128);
    for (i, line) in request.split("\r\n").enumerate() {
        if i > 0 {
            modified.push_str("\r\n");
        }
        let lower = line.to_lowercase();
        if lower.starts_with("host:") {
            modified.push_str("Host: ");
            modified.push_str(remote_host);
        } else if lower.starts_with("origin:") {
            modified.push_str("Origin: https://");
            modified.push_str(remote_host);
        } else {
            modified.push_str(line);
        }
    }
    modified
}

/// Decide whether an already-running proxy can serve a new start request:
/// only when both the remote host AND the TOFU-pinned fingerprint are
/// unchanged. The listener bakes its fingerprint in at spawn, so after the
/// user accepts a rotated cert (which rewrites the store), reusing the old
/// listener would fail every TLS handshake against the stale pin until
/// logout — the caller must tear down and restart instead.
pub(crate) fn can_reuse_proxy(
    running_host: &str,
    running_fingerprint: &str,
    requested_host: &str,
    stored_fingerprint: &str,
) -> bool {
    running_host == requested_host && running_fingerprint == stored_fingerprint
}

/// Extract the TLS server name from a `host[:port]` string.
///
/// IPv6 literals arrive bracketed (`[::1]:8443`); the brackets are stripped and
/// an IP literal becomes `ServerName::IpAddress` rather than a DNS name, since
/// rustls will not accept an address as a DNS name.
pub(crate) fn parse_server_name(remote_host: &str) -> Result<ServerName<'static>, String> {
    // Default to port 443 (standard HTTPS) when no port is specified — the
    // server is typically behind a reverse proxy (nginx) on the standard port.
    let (raw_hostname, _port) = remote_host.rsplit_once(':').unwrap_or((remote_host, "443"));
    let hostname = raw_hostname.trim_start_matches('[').trim_end_matches(']');

    if let Ok(ip) = hostname.parse::<IpAddr>() {
        Ok(ServerName::IpAddress(ip.into()))
    } else {
        ServerName::try_from(hostname.to_string())
            .map_err(|e| format!("invalid server name '{hostname}': {e}"))
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start a local TCP proxy that tunnels LiveKit signal connections to the
/// remote OwnCord server over TLS, pinning the certificate to the fingerprint
/// already trusted via ws_proxy's TOFU handshake.
///
/// If a proxy is already running for the same `remote_host`, returns the
/// existing port. If running for a different host, stops the old proxy first.
#[tauri::command]
pub async fn start_livekit_proxy<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, LiveKitProxyState>,
    remote_host: String,
) -> Result<u16, String> {
    validate_remote_host(&remote_host)?;

    let mut inner = state.inner.lock().await;

    info!("[livekit_proxy] start requested for {}", remote_host);

    // Load the TOFU-pinned fingerprint from the cert store BEFORE the reuse
    // check — a running listener bakes its pin in at spawn, so a re-pin
    // (user accepted a rotated cert) must force a restart, not a reuse. The
    // ws_proxy must have connected first (establishing the TOFU trust), so
    // the fingerprint should already be stored. If not, reject — we refuse
    // to connect without a pinned cert.
    let store_key = tofu::cert_store_key(&remote_host);
    let fingerprint = tofu::load_stored_fingerprint(&app, &store_key)?
        .ok_or_else(|| format!(
            "no trusted certificate fingerprint for {remote_host}. \
             Connect via WebSocket first to establish TOFU trust."
        ))?;

    // Reuse the existing proxy only when host AND pin are unchanged.
    if let Some(port) = inner.port {
        if can_reuse_proxy(&inner.remote_host, &inner.pinned_fingerprint, &remote_host, &fingerprint) {
            debug!("[livekit_proxy] reusing existing proxy on port {} for {}", port, remote_host);
            return Ok(port);
        }
        // Different host or re-pinned cert — tear down the old proxy.
        info!(
            "[livekit_proxy] stopping old proxy for {} (restarting for {})",
            inner.remote_host, remote_host
        );
        if let Some(tx) = inner.shutdown_tx.take() {
            let _ = tx.send(());
        }
        inner.port = None;
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("livekit proxy bind failed: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("livekit proxy local_addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let host = remote_host.clone();
    let loop_handle = tokio::spawn(run_proxy_loop(
        app.clone(),
        listener,
        host,
        port,
        fingerprint.clone(),
        shutdown_rx,
    ));
    // Watch the loop so a panic is logged instead of vanishing silently.
    tokio::spawn(async move {
        match loop_handle.await {
            Ok(()) => info!("[livekit_proxy] proxy loop exited"),
            Err(e) if e.is_panic() => error!("[livekit_proxy] proxy loop panicked: {e:?}"),
            Err(e) => warn!("[livekit_proxy] proxy loop join error: {e:?}"),
        }
    });

    info!("[livekit_proxy] proxy started on 127.0.0.1:{} → {}", port, remote_host);

    inner.port = Some(port);
    inner.remote_host = remote_host;
    inner.pinned_fingerprint = fingerprint;
    inner.shutdown_tx = Some(shutdown_tx);

    Ok(port)
}

/// Stop the LiveKit TLS proxy if running.
#[tauri::command]
pub async fn stop_livekit_proxy(
    state: tauri::State<'_, LiveKitProxyState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if let Some(tx) = inner.shutdown_tx.take() {
        let _ = tx.send(());
    }
    inner.port = None;
    inner.remote_host.clear();
    inner.pinned_fingerprint.clear();
    Ok(())
}

// ---------------------------------------------------------------------------
// Proxy internals
// ---------------------------------------------------------------------------

/// Maximum consecutive accept errors before the proxy loop exits.
const MAX_CONSECUTIVE_ACCEPT_ERRORS: u32 = 5;

async fn run_proxy_loop<R: Runtime>(
    app: tauri::AppHandle<R>,
    listener: TcpListener,
    remote_host: String,
    port: u16,
    pinned_fingerprint: String,
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
                        let fp = pinned_fingerprint.clone();
                        debug!("[livekit_proxy] accepted connection from {}", addr);
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream, &host, &fp).await {
                                warn!("[livekit_proxy] connection to {} failed: {}", host, e);
                            }
                        });
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        error!(
                            "[livekit_proxy] accept error ({}/{}): {}",
                            consecutive_errors, MAX_CONSECUTIVE_ACCEPT_ERRORS, e
                        );
                        if consecutive_errors >= MAX_CONSECUTIVE_ACCEPT_ERRORS {
                            error!(
                                "[livekit_proxy] {} consecutive accept errors, stopping proxy loop",
                                MAX_CONSECUTIVE_ACCEPT_ERRORS
                            );
                            // Deregister the dead proxy BEFORE the break drops
                            // `listener`, so a future start_livekit_proxy
                            // rebinds a fresh port instead of handing back
                            // this closed one forever (the reuse branch keys
                            // only on host+pin, not liveness). Mirrors
                            // http_proxy.rs's identical fix.
                            if let Some(state) = app.try_state::<LiveKitProxyState>() {
                                state.clear_if_port_matches(port).await;
                            } else {
                                warn!(
                                    "[livekit_proxy] state unmanaged; cannot deregister dead proxy for {}",
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

/// Bound on the outbound dial and TLS handshake, matching http_proxy.rs.
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Dial `remote_host` and complete the TLS handshake, bounding each step by
/// `limit`.
///
/// Both steps must be bounded. A peer that accepts the TCP connection and then
/// never answers the ClientHello blocks the handshake forever, and the calling
/// task holds `local` without polling it — so the LiveKit SDK closing its side
/// never cancels it. Those tasks and their sockets accumulate on every SDK
/// retry and survive stop_livekit_proxy, whose shutdown oneshot only stops the
/// accept loop; the per-connection tasks are detached.
async fn connect_tls(
    connector: &tokio_rustls::TlsConnector,
    server_name: ServerName<'static>,
    remote_host: &str,
    limit: Duration,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, Box<dyn std::error::Error + Send + Sync>> {
    debug!("[livekit_proxy] connecting TCP to {}", remote_host);
    let tcp = timeout(limit, TcpStream::connect(remote_host))
        .await
        .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from("TCP connect timed out"))??;
    debug!("[livekit_proxy] starting TLS handshake with {}", remote_host);
    let tls = timeout(limit, connector.connect(server_name, tcp))
        .await
        .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from("TLS handshake timed out"))??;
    Ok(tls)
}

/// Handle a single proxied connection:
/// 1. Read the HTTP request headers from the local (plain) side
/// 2. Rewrite Host/Origin so the remote server accepts the connection
/// 3. Open a TLS tunnel to the remote server
/// 4. Forward the rewritten request, then shovel bytes bidirectionally
async fn handle_connection(
    mut local: TcpStream,
    remote_host: &str,
    pinned_fingerprint: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // ── 1. Read HTTP request headers (up to \r\n\r\n) ────────────────────
    // Guarded by a 10-second timeout so a slow or stalled client cannot
    // hold the Tokio task open indefinitely (BUG-151).
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
    .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from(
        "upstream header read timed out",
    ))??;

    // Reject CRLF in remote_host before header insertion (defense-in-depth;
    // primary validation is in start_livekit_proxy).
    if remote_host.contains('\r') || remote_host.contains('\n') {
        return Err("remote_host contains CRLF — header injection rejected".into());
    }

    // ── 2. Rewrite Host and Origin headers ───────────────────────────────
    let request = String::from_utf8_lossy(&buf);
    let modified = rewrite_proxy_headers(&request, remote_host);

    // ── 3. Connect to remote over TLS ────────────────────────────────────
    let tls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(
            tofu::PinnedVerifier::new(pinned_fingerprint.to_string()),
        ))
        .with_no_client_auth();

    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));

    let server_name = parse_server_name(remote_host)?;

    let mut tls = connect_tls(&connector, server_name, remote_host, PROXY_CONNECT_TIMEOUT).await?;
    debug!("[livekit_proxy] TLS handshake complete, forwarding traffic");

    // ── 4. Forward request + bidirectional copy ──────────────────────────
    tls.write_all(modified.as_bytes()).await?;
    let result = io::copy_bidirectional(&mut local, &mut tls).await;
    match result {
        Ok((to_remote, from_remote)) => {
            debug!("[livekit_proxy] connection closed: {}B sent, {}B received", to_remote, from_remote);
        }
        Err(e) => {
            debug!("[livekit_proxy] bidirectional copy ended: {}", e);
        }
    }

    Ok(())
}

// cert_store_key is covered by unit tests in the shared `tofu` module.

// ---------------------------------------------------------------------------
// Tests (pure logic only — no Tauri runtime or live socket required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_remote_host ────────────────────────────────────────────────

    #[test]
    fn accepts_plain_hostnames_and_ports() {
        for host in [
            "example.com",
            "example.com:8443",
            "sub.domain.example.com",
            "my-server.example.com:443",
            "127.0.0.1:8443",
            "[::1]:8443",
            "localhost",
        ] {
            assert!(validate_remote_host(host).is_ok(), "should accept {host}");
        }
    }

    #[test]
    fn rejects_crlf_injection() {
        // The classic header-injection payload: everything after the CRLF
        // would land in the rewritten request as attacker-chosen headers.
        for host in [
            "example.com\r\nX-Injected: 1",
            "example.com\nX-Injected: 1",
            "example.com\r",
        ] {
            assert!(validate_remote_host(host).is_err(), "should reject {host:?}");
        }
    }

    #[test]
    fn rejects_nul_bytes() {
        assert!(validate_remote_host("example.com\0").is_err());
    }

    #[test]
    fn rejects_unexpected_characters() {
        for host in [
            "example.com/path",
            "user@example.com",
            "example.com?q=1",
            "example com",
            "exa mple.com:443",
            "example.com;evil",
        ] {
            assert!(validate_remote_host(host).is_err(), "should reject {host:?}");
        }
    }

    #[test]
    fn accepts_empty_host() {
        // Empty passes the character checks; the subsequent TCP connect is what
        // fails. Pinned so a future tightening is a deliberate change.
        assert!(validate_remote_host("").is_ok());
    }

    // ── can_reuse_proxy ─────────────────────────────────────────────────────

    #[test]
    fn reuses_proxy_only_when_host_and_pin_are_unchanged() {
        assert!(can_reuse_proxy("example.com:443", "aa:bb", "example.com:443", "aa:bb"));
    }

    #[test]
    fn restarts_proxy_when_host_changes() {
        assert!(!can_reuse_proxy("old.example:443", "aa:bb", "new.example:443", "aa:bb"));
    }

    #[test]
    fn restarts_proxy_when_pin_changes() {
        // The user accepted a rotated cert (accept_cert_fingerprint rewrote the
        // store). The running listener still pins the old fingerprint, so every
        // connection through it would fail the TLS handshake — reuse must be
        // refused so the caller tears down and restarts with the new pin.
        assert!(!can_reuse_proxy("example.com:443", "aa:bb", "example.com:443", "cc:dd"));
    }

    // ── rewrite_proxy_headers ───────────────────────────────────────────────

    #[test]
    fn rewrites_host_and_origin() {
        let request = "GET /rtc HTTP/1.1\r\n\
                       Host: 127.0.0.1:54321\r\n\
                       Origin: http://127.0.0.1:54321\r\n\
                       Upgrade: websocket\r\n\r\n";

        let got = rewrite_proxy_headers(request, "chat.example.com:8443");

        assert!(got.contains("Host: chat.example.com:8443"));
        assert!(got.contains("Origin: https://chat.example.com:8443"));
        assert!(!got.contains("127.0.0.1:54321"));
    }

    #[test]
    fn preserves_the_request_line_and_other_headers() {
        let request = "GET /rtc?access_token=abc HTTP/1.1\r\n\
                       Host: 127.0.0.1:1\r\n\
                       Upgrade: websocket\r\n\
                       Connection: Upgrade\r\n\
                       Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\n\r\n";

        let got = rewrite_proxy_headers(request, "example.com");

        // The token lives in the query string; losing it turns every voice
        // join into an auth failure.
        assert!(got.starts_with("GET /rtc?access_token=abc HTTP/1.1\r\n"));
        assert!(got.contains("Upgrade: websocket"));
        assert!(got.contains("Connection: Upgrade"));
        assert!(got.contains("Sec-WebSocket-Key: dGhlIHNhbXBsZQ=="));
    }

    #[test]
    fn matches_header_names_case_insensitively() {
        let request = "GET / HTTP/1.1\r\nhOsT: 127.0.0.1\r\nORIGIN: http://x\r\n\r\n";

        let got = rewrite_proxy_headers(request, "example.com");

        assert!(got.contains("Host: example.com"));
        assert!(got.contains("Origin: https://example.com"));
        assert!(!got.contains("hOsT"));
        assert!(!got.contains("ORIGIN"));
    }

    #[test]
    fn preserves_the_terminating_blank_line() {
        let request = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";

        let got = rewrite_proxy_headers(request, "example.com");

        // Without the trailing CRLFCRLF the remote server keeps waiting for
        // more headers and the handshake hangs.
        assert!(got.ends_with("\r\n\r\n"), "got: {got:?}");
    }

    #[test]
    fn does_not_rewrite_headers_that_merely_contain_host_or_origin() {
        let request =
            "GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-Host: keep.me\r\nReferer: http://o\r\n\r\n";

        let got = rewrite_proxy_headers(request, "example.com");

        assert!(got.contains("X-Forwarded-Host: keep.me"));
        assert!(got.contains("Referer: http://o"));
    }

    #[test]
    fn adds_no_headers_when_none_are_present() {
        let request = "GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n";

        let got = rewrite_proxy_headers(request, "example.com");

        // The rewriter only replaces; it never synthesises a Host header.
        assert_eq!(got, request);
    }

    #[test]
    fn rewrites_every_occurrence() {
        let request = "GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n";

        let got = rewrite_proxy_headers(request, "example.com");

        assert_eq!(got.matches("Host: example.com").count(), 2);
    }

    // ── parse_server_name ───────────────────────────────────────────────────

    #[test]
    fn parses_a_dns_name_without_a_port() {
        let got = parse_server_name("example.com").expect("should parse");
        assert!(matches!(got, ServerName::DnsName(_)));
    }

    #[test]
    fn parses_a_dns_name_with_a_port() {
        let got = parse_server_name("example.com:8443").expect("should parse");
        match got {
            ServerName::DnsName(d) => assert_eq!(d.as_ref(), "example.com"),
            other => panic!("expected DnsName, got {other:?}"),
        }
    }

    #[test]
    fn parses_an_ipv4_literal_as_an_address() {
        // rustls rejects an IP supplied as a DNS name, so the branch matters.
        let got = parse_server_name("127.0.0.1:8443").expect("should parse");
        assert!(matches!(got, ServerName::IpAddress(_)));
    }

    #[test]
    fn parses_a_bracketed_ipv6_literal_as_an_address() {
        let got = parse_server_name("[::1]:8443").expect("should parse");
        assert!(matches!(got, ServerName::IpAddress(_)));
    }

    #[test]
    fn parses_a_bare_ipv4_literal() {
        let got = parse_server_name("10.0.0.5").expect("should parse");
        assert!(matches!(got, ServerName::IpAddress(_)));
    }

    #[test]
    fn rejects_an_invalid_dns_name() {
        assert!(parse_server_name("not a hostname").is_err());
    }

    // A peer that accepts the TCP connection and then answers nothing must not
    // hang the connection task forever — see connect_tls.
    #[tokio::test]
    async fn tls_handshake_is_bounded_by_its_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            let _accepted = listener.accept().await.expect("accept");
            // Hold the connection open, answering nothing.
            std::future::pending::<()>().await;
        });

        let tls_config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(tofu::PinnedVerifier::new(
                "aa:bb:cc".to_string(),
            )))
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));
        let server_name = ServerName::try_from("localhost").expect("server name");

        // The outer bound exists only so a regression fails fast instead of
        // hanging the suite; the assertion is that the inner limit fired.
        let outcome = timeout(
            Duration::from_secs(5),
            connect_tls(
                &connector,
                server_name,
                &addr.to_string(),
                Duration::from_millis(100),
            ),
        )
        .await;

        assert!(
            outcome.is_ok(),
            "connect_tls hung: the TLS handshake is not bounded by its own timeout"
        );
        assert!(
            outcome.expect("bounded").is_err(),
            "a silent peer must produce an error, not a usable TLS stream"
        );
    }

    // ── LiveKitProxyState::clear_if_port_matches ────────────────────────────
    //
    // B4_conn_ipc-7: run_proxy_loop's accept-error exit path drops the
    // listener without deregistering it, so ProxyInner.port stays set and
    // start_livekit_proxy's reuse branch (unchanged host+pin) hands the dead
    // port back forever. Mirrors http_proxy.rs's
    // remove_if_port_matches_removes_only_matching_entry test.

    #[tokio::test]
    async fn clear_if_port_matches_clears_only_a_matching_entry() {
        let state = LiveKitProxyState::new();
        {
            let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
            let mut inner = state.inner.lock().await;
            inner.port = Some(4242);
            inner.remote_host = "example.com:8443".to_string();
            inner.pinned_fingerprint = "aa:bb".to_string();
            inner.shutdown_tx = Some(tx);
        }

        // A stale loop reporting a port that no longer matches the live
        // listener must leave the current entry alone.
        state.clear_if_port_matches(9999).await;
        assert_eq!(
            state.inner.lock().await.port,
            Some(4242),
            "mismatched port must not clear a newer proxy's state"
        );

        // A loop reporting its own still-current port must clear it so the
        // next start_livekit_proxy rebinds instead of reusing the dead listener.
        state.clear_if_port_matches(4242).await;
        let inner = state.inner.lock().await;
        assert_eq!(inner.port, None, "matching port must deregister the dead proxy");
        assert!(inner.remote_host.is_empty());
        assert!(inner.pinned_fingerprint.is_empty());
    }
}
