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
//   WS and LiveKit connections, the LiveKit handshake will fail.
// - Only one proxy instance runs at a time (per remote host). Connecting to
//   a different server replaces the proxy. Stale proxy ports are not reused.
// - If the TcpListener errors (extremely unlikely on loopback), the cached
//   port in JS becomes stale until the next voice join resets it.
// - The accept loop exits after 5 consecutive errors to prevent CPU spin.

use log::{debug, error, info, warn};
use ring::digest::{digest, SHA256};
use std::net::IpAddr;
use std::sync::Arc;
use rustls::pki_types::ServerName;
use serde_json::Value;
use tauri::Runtime;
use tauri_plugin_store::StoreExt;
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// Tauri-managed state for the LiveKit TLS proxy.
pub struct LiveKitProxyState {
    inner: Mutex<ProxyInner>,
}

struct ProxyInner {
    /// Port the proxy is listening on (None if not running).
    port: Option<u16>,
    /// The remote host:port we're proxying to.
    remote_host: String,
    /// Shutdown signal sender.
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl LiveKitProxyState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ProxyInner {
                port: None,
                remote_host: String::new(),
                shutdown_tx: None,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// TLS certificate verifier — pinned fingerprint check
// ---------------------------------------------------------------------------

/// Tauri store file for certificate fingerprints (shared with ws_proxy).
const CERTS_STORE: &str = "certs.json";

/// Verifies the server certificate against a known SHA-256 fingerprint.
/// Reuses the fingerprint stored by ws_proxy's TOFU handshake for the same
/// host, so LiveKit connections are pinned to the same certificate the user
/// already trusted during WebSocket setup.
#[derive(Debug)]
struct PinnedVerifier {
    /// Expected SHA-256 colon-hex fingerprint (e.g. "aa:bb:cc:...").
    expected_fingerprint: String,
}

impl PinnedVerifier {
    fn new(expected_fingerprint: String) -> Self {
        Self { expected_fingerprint }
    }
}

impl rustls::client::danger::ServerCertVerifier for PinnedVerifier {
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

        if hex == self.expected_fingerprint {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!(
                "certificate fingerprint mismatch: expected {}, got {}",
                self.expected_fingerprint, hex
            )))
        }
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

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Produce the cert store key matching ws_proxy's format.
/// ws_proxy extracts the host from "wss://host/path" which omits port 443.
/// We normalise by stripping the default ":443" suffix so the keys match.
fn cert_store_key(remote_host: &str) -> String {
    remote_host.strip_suffix(":443").unwrap_or(remote_host).to_string()
}

/// Load the stored certificate fingerprint for a host from the Tauri cert store.
fn load_stored_fingerprint<R: Runtime>(
    app: &tauri::AppHandle<R>,
    host: &str,
) -> Result<Option<String>, String> {
    let store = app
        .store(CERTS_STORE)
        .map_err(|e| format!("failed to open certs store: {e}"))?;

    Ok(store.get(host).and_then(|v| {
        if let Value::String(s) = v {
            Some(s)
        } else {
            None
        }
    }))
}

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
    let mut inner = state.inner.lock().await;

    info!("[livekit_proxy] start requested for {}", remote_host);

    // Reuse existing proxy for same host.
    if let Some(port) = inner.port {
        if inner.remote_host == remote_host {
            debug!("[livekit_proxy] reusing existing proxy on port {} for {}", port, remote_host);
            return Ok(port);
        }
        // Different host — tear down old proxy.
        info!("[livekit_proxy] stopping old proxy for {} (switching to {})", inner.remote_host, remote_host);
        if let Some(tx) = inner.shutdown_tx.take() {
            let _ = tx.send(());
        }
        inner.port = None;
    }

    // Load the TOFU-pinned fingerprint from the cert store. The ws_proxy must
    // have connected first (establishing the TOFU trust), so the fingerprint
    // should already be stored. If not, reject — we refuse to connect without
    // a pinned cert.
    let store_key = cert_store_key(&remote_host);
    let fingerprint = load_stored_fingerprint(&app, &store_key)?
        .ok_or_else(|| format!(
            "no trusted certificate fingerprint for {remote_host}. \
             Connect via WebSocket first to establish TOFU trust."
        ))?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("livekit proxy bind failed: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("livekit proxy local_addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let host = remote_host.clone();
    tokio::spawn(run_proxy_loop(listener, host, fingerprint, shutdown_rx));

    info!("[livekit_proxy] proxy started on 127.0.0.1:{} → {}", port, remote_host);

    inner.port = Some(port);
    inner.remote_host = remote_host;
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
    Ok(())
}

// ---------------------------------------------------------------------------
// Proxy internals
// ---------------------------------------------------------------------------

/// Maximum consecutive accept errors before the proxy loop exits.
const MAX_CONSECUTIVE_ACCEPT_ERRORS: u32 = 5;

async fn run_proxy_loop(
    listener: TcpListener,
    remote_host: String,
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
                            break;
                        }
                    }
                }
            }
            _ = &mut shutdown_rx => break,
        }
    }
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
    let mut buf = Vec::with_capacity(4096);
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
            return Err("HTTP request headers too large".into());
        }
    }

    // ── 2. Rewrite Host and Origin headers ───────────────────────────────
    let request = String::from_utf8_lossy(&buf);
    let mut modified = String::with_capacity(buf.len() + 128);
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

    // ── 3. Connect to remote over TLS ────────────────────────────────────
    let tls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(
            PinnedVerifier::new(pinned_fingerprint.to_string()),
        ))
        .with_no_client_auth();

    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));

    // Parse hostname (strip brackets for IPv6, e.g. "[::1]:8443").
    // Default to port 443 (standard HTTPS) when no port is specified — the
    // server is typically behind a reverse proxy (nginx) on the standard port.
    let (raw_hostname, _port) = remote_host.rsplit_once(':').unwrap_or((remote_host, "443"));
    let hostname = raw_hostname
        .trim_start_matches('[')
        .trim_end_matches(']');

    let server_name = if let Ok(ip) = hostname.parse::<IpAddr>() {
        ServerName::IpAddress(ip.into())
    } else {
        ServerName::try_from(hostname.to_string())
            .map_err(|e| format!("invalid server name '{hostname}': {e}"))?
    };

    debug!("[livekit_proxy] connecting TCP to {}", remote_host);
    let tcp = TcpStream::connect(remote_host).await?;
    debug!("[livekit_proxy] starting TLS handshake with {}", remote_host);
    let mut tls = connector.connect(server_name, tcp).await?;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cert_store_key_strips_default_port() {
        assert_eq!(cert_store_key("example.com:443"), "example.com");
    }

    #[test]
    fn cert_store_key_keeps_non_default_port() {
        assert_eq!(cert_store_key("example.com:8443"), "example.com:8443");
    }

    #[test]
    fn cert_store_key_no_port() {
        assert_eq!(cert_store_key("example.com"), "example.com");
    }

    #[test]
    fn cert_store_key_ipv4_default_port() {
        assert_eq!(cert_store_key("192.168.1.1:443"), "192.168.1.1");
    }

    #[test]
    fn cert_store_key_ipv4_custom_port() {
        assert_eq!(cert_store_key("192.168.1.1:7880"), "192.168.1.1:7880");
    }
}
