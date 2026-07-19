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
// - Unknown host  → accept, persist the fingerprint, emit `cert-tofu`
//   (status "trusted_first_use") so the UI can show the banner. HTTP is the
//   FIRST TLS contact with a server (login precedes the WS connect), so this
//   proxy — not ws_proxy — usually establishes the pin.
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
use ring::digest::{digest, SHA256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use rustls::pki_types::ServerName;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use crate::constants::CERTS_STORE;
use crate::livekit_proxy::cert_store_key;

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
    tokio::spawn(run_proxy_loop(
        app.clone(),
        listener,
        remote_host.clone(),
        shutdown_rx,
    ));

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
// TOFU verification (mirrors ws_proxy semantics; shared cert store)
// ---------------------------------------------------------------------------

/// Fingerprint captured during the TLS handshake.
type CapturedFingerprint = Arc<std::sync::Mutex<Option<String>>>;

/// Accepts the handshake while recording the leaf certificate's SHA-256
/// fingerprint; the TOFU decision happens immediately after the handshake,
/// before any request bytes are forwarded.
#[derive(Debug)]
struct CaptureVerifier {
    captured: CapturedFingerprint,
}

impl CaptureVerifier {
    fn new() -> (Self, CapturedFingerprint) {
        let fp = Arc::new(std::sync::Mutex::new(None));
        (Self { captured: fp.clone() }, fp)
    }
}

impl rustls::client::danger::ServerCertVerifier for CaptureVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let hash = digest(&SHA256, end_entity.as_ref());
        let hex = hash
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(":");
        if let Ok(mut guard) = self.captured.lock() {
            *guard = Some(hex);
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// TOFU decision for `host` (cert-store key, i.e. without a default :443):
/// first use stores the pin, match passes, mismatch fails. Same store, same
/// save-rollback behavior, and same event payloads as ws_proxy::tofu_check.
fn tofu_check<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    fingerprint: &str,
) -> Result<String, String> {
    let store = app
        .store(CERTS_STORE)
        .map_err(|e| format!("failed to open certs store: {e}"))?;

    let stored = store.get(host).and_then(|v| {
        if let Value::String(s) = v {
            Some(s)
        } else {
            None
        }
    });

    match stored {
        None => {
            let old_value = store.get(host);
            store.set(host, Value::String(fingerprint.to_string()));
            if let Err(e) = store.save() {
                match old_value {
                    Some(v) => {
                        store.set(host, v);
                    }
                    None => {
                        let _ = store.delete(host);
                    }
                }
                return Err(format!("failed to persist cert fingerprint: {e}"));
            }
            Ok("trusted_first_use".to_string())
        }
        Some(ref stored_fp) if stored_fp == fingerprint => Ok("trusted".to_string()),
        Some(stored_fp) => Err(format!(
            "Certificate fingerprint changed for {host}.\n\
             Stored:  {stored_fp}\n\
             Current: {fingerprint}\n\
             This may indicate a man-in-the-middle attack or a server certificate rotation.\n\
             Use accept_cert_fingerprint to trust the new certificate."
        )),
    }
}

// ---------------------------------------------------------------------------
// Proxy internals
// ---------------------------------------------------------------------------

/// Maximum consecutive accept errors before the proxy loop exits.
const MAX_CONSECUTIVE_ACCEPT_ERRORS: u32 = 5;

async fn run_proxy_loop<R: Runtime>(
    app: AppHandle<R>,
    listener: TcpListener,
    remote_host: String,
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
    let (verifier, captured_fp) = CaptureVerifier::new();
    let tls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));

    let (raw_hostname, _port) = remote_host.rsplit_once(':').unwrap_or((remote_host, "443"));
    let hostname = raw_hostname.trim_start_matches('[').trim_end_matches(']');
    let server_name = if let Ok(ip) = hostname.parse::<IpAddr>() {
        ServerName::IpAddress(ip.into())
    } else {
        ServerName::try_from(hostname.to_string())
            .map_err(|e| format!("invalid server name '{hostname}': {e}"))?
    };

    let dial_target = if remote_host.contains(':') {
        remote_host.to_string()
    } else {
        format!("{remote_host}:443")
    };
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

    let store_key = cert_store_key(remote_host);
    match tofu_check(&app, &store_key, &fingerprint) {
        Ok(status) => {
            if status == "trusted_first_use" {
                info!("[http_proxy] TOFU first-use pin for {}", store_key);
            }
            let _ = app.emit(
                "cert-tofu",
                serde_json::json!({
                    "host": store_key,
                    "fingerprint": fingerprint,
                    "status": status,
                }),
            );
        }
        Err(mismatch_msg) => {
            warn!(
                "[http_proxy] TOFU check FAILED for {} — certificate fingerprint mismatch",
                store_key
            );
            let _ = app.emit(
                "cert-tofu",
                serde_json::json!({
                    "host": store_key,
                    "fingerprint": fingerprint,
                    "status": "mismatch",
                    "message": mismatch_msg,
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
