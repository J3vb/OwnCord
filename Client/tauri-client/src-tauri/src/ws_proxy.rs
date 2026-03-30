// WebSocket proxy — routes WSS through Rust to bypass self-signed cert rejection.
// JS sends/receives messages via Tauri events instead of native WebSocket.
//
// Implements TOFU (Trust On First Use) certificate pinning:
// - On first connect to a host, the cert SHA-256 fingerprint is stored.
// - On subsequent connects, the fingerprint is compared with the stored value.
// - If the fingerprint changes, the connection is rejected (potential MitM).

use futures_util::{SinkExt, StreamExt};
use log::{debug, error, info, warn};
use ring::digest::{digest, SHA256};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// Maximum time to wait for the WebSocket handshake to complete.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Tauri store file for certificate fingerprints.
const CERTS_STORE: &str = "certs.json";

/// Sender half kept in Tauri state so `ws_send` can push messages.
pub struct WsState {
    tx: Mutex<Option<mpsc::Sender<String>>>,
}

impl WsState {
    pub fn new() -> Self {
        Self {
            tx: Mutex::new(None),
        }
    }
}

/// Shared fingerprint captured during TLS handshake.
type CapturedFingerprint = Arc<std::sync::Mutex<Option<String>>>;

/// TOFU certificate verifier that captures the server cert fingerprint
/// during the TLS handshake. Still accepts self-signed certs (required
/// for self-hosted servers), but records the fingerprint for comparison
/// with the stored value after the connection is established.
#[derive(Debug)]
struct TofuVerifier {
    captured: CapturedFingerprint,
}

impl TofuVerifier {
    fn new() -> (Self, CapturedFingerprint) {
        let fp = Arc::new(std::sync::Mutex::new(None));
        (Self { captured: fp.clone() }, fp)
    }
}

impl rustls::client::danger::ServerCertVerifier for TofuVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        // Compute SHA-256 fingerprint of the DER-encoded leaf certificate.
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

        // Accept the cert — TOFU check happens after the handshake completes.
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
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ECDSA_NISTP521_SHA512,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::ED448,
        ]
    }
}

/// Extract the host (with port) from a wss:// URL.
fn extract_host(url: &str) -> String {
    url.strip_prefix("wss://")
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

/// Perform TOFU fingerprint check against the Tauri cert store.
/// Returns Ok(()) if trusted, Err(message) if fingerprint mismatch.
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
            // First use — store the fingerprint.
            store.set(host, Value::String(fingerprint.to_string()));
            if let Err(e) = store.save() {
                return Err(format!("failed to persist cert fingerprint: {e}"));
            }
            Ok("trusted_first_use".to_string())
        }
        Some(ref stored_fp) if stored_fp == fingerprint => {
            Ok("trusted".to_string())
        }
        Some(stored_fp) => {
            Err(format!(
                "Certificate fingerprint changed for {host}.\n\
                 Stored:  {stored_fp}\n\
                 Current: {fingerprint}\n\
                 This may indicate a man-in-the-middle attack or a server certificate rotation.\n\
                 Use accept_cert_fingerprint to trust the new certificate."
            ))
        }
    }
}

/// Connect to a WSS server. Spawns a background task that:
/// - Emits `ws-message` events for incoming server messages
/// - Emits `ws-state` events for connection state changes
/// - Emits `cert-tofu` events for TOFU fingerprint status
/// - Reads from an mpsc channel for outgoing messages
#[tauri::command]
pub async fn ws_connect<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, WsState>,
    url: String,
) -> Result<(), String> {
    info!("[ws_proxy] connecting to {}", url);

    // Drop any existing connection
    {
        let mut tx_lock = state.tx.lock().await;
        if tx_lock.is_some() {
            debug!("[ws_proxy] dropping existing connection");
        }
        *tx_lock = None;
    }

    // Only allow secure WebSocket connections
    if !url.starts_with("wss://") {
        warn!("[ws_proxy] rejected non-wss URL: {}", url);
        return Err("Only wss:// connections are permitted".into());
    }

    let _ = app.emit("ws-state", "connecting");

    // Create TOFU verifier that captures the cert fingerprint during handshake.
    let (verifier, captured_fp) = TofuVerifier::new();

    let tls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();

    let connector =
        tokio_tungstenite::Connector::Rustls(Arc::new(tls_config));

    let connect_future = tokio_tungstenite::connect_async_tls_with_config(
        &url,
        None,
        false,
        Some(connector),
    );

    let (ws_stream, _response) = tokio::time::timeout(CONNECT_TIMEOUT, connect_future)
        .await
        .map_err(|_| {
            error!("[ws_proxy] connect timed out after {}s to {}", CONNECT_TIMEOUT.as_secs(), url);
            format!("ws connect timed out after {}s", CONNECT_TIMEOUT.as_secs())
        })?
        .map_err(|e| {
            error!("[ws_proxy] connect failed to {}: {}", url, e);
            format!("ws connect failed: {e}")
        })?;

    debug!("[ws_proxy] WebSocket handshake complete");

    // ── TOFU check ───────────────────────────────────────────────────────
    let host = extract_host(&url);
    let fingerprint = captured_fp
        .lock()
        .map_err(|e| format!("failed to read captured fingerprint: {e}"))?
        .clone()
        .unwrap_or_default();

    if fingerprint.is_empty() {
        return Err("TLS handshake completed but no certificate fingerprint was captured".into());
    }

    match tofu_check(&app, &host, &fingerprint) {
        Ok(status) => {
            info!("[ws_proxy] TOFU check passed for {}: {}", host, status);
            let _ = app.emit(
                "cert-tofu",
                serde_json::json!({
                    "host": host,
                    "fingerprint": fingerprint,
                    "status": status,
                }),
            );
        }
        Err(mismatch_msg) => {
            warn!("[ws_proxy] TOFU check FAILED for {} — certificate fingerprint mismatch", host);
            debug!("[ws_proxy] TOFU detail: {}", mismatch_msg);
            let _ = app.emit(
                "cert-tofu",
                serde_json::json!({
                    "host": host,
                    "fingerprint": fingerprint,
                    "status": "mismatch",
                    "message": mismatch_msg,
                }),
            );
            // Reject the connection — do not proceed.
            return Err(mismatch_msg);
        }
    }
    // ── End TOFU check ───────────────────────────────────────────────────

    info!("[ws_proxy] connected to {}", host);
    let _ = app.emit("ws-state", "open");

    let (mut sink, mut stream) = ws_stream.split();

    // Channel for JS → server messages (bounded for backpressure)
    let (tx, mut rx) = mpsc::channel::<String>(256);
    {
        let mut tx_lock = state.tx.lock().await;
        *tx_lock = Some(tx);
    }

    let app_read = app.clone();
    let app_state = app.clone();

    // Task: forward server → JS
    let mut read_task = tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let _ = app_read.emit("ws-message", text.to_string());
                }
                Ok(Message::Close(frame)) => {
                    debug!("[ws_proxy] server sent Close frame: {:?}", frame);
                    break;
                }
                Err(e) => {
                    warn!("[ws_proxy] read error: {}", e);
                    let _ = app_read.emit("ws-error", format!("{e}"));
                    break;
                }
                _ => {} // ignore binary/ping/pong
            }
        }
    });

    // Task: forward JS → server
    let mut write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // When either task ends, abort sibling and emit closed
    tokio::spawn(async move {
        tokio::select! {
            _ = &mut read_task => {
                debug!("[ws_proxy] read task ended, aborting write task");
                write_task.abort();
            }
            _ = &mut write_task => {
                debug!("[ws_proxy] write task ended, aborting read task");
                read_task.abort();
            }
        }
        info!("[ws_proxy] connection closed");
        let _ = app_state.emit("ws-state", "closed");
    });

    Ok(())
}

/// Send a text message through the proxy WebSocket.
#[tauri::command]
pub async fn ws_send(
    state: tauri::State<'_, WsState>,
    message: String,
) -> Result<(), String> {
    let tx_lock = state.tx.lock().await;
    if let Some(tx) = tx_lock.as_ref() {
        tx.try_send(message).map_err(|e| format!("ws send failed: {e}"))
    } else {
        Err("WebSocket not connected".into())
    }
}

/// Disconnect the proxy WebSocket.
#[tauri::command]
pub async fn ws_disconnect(state: tauri::State<'_, WsState>) -> Result<(), String> {
    let mut tx_lock = state.tx.lock().await;
    *tx_lock = None; // dropping the sender closes the channel → write task ends
    Ok(())
}

/// Accept a changed certificate fingerprint for a host.
/// Call this after the user acknowledges a cert-mismatch warning.
#[tauri::command]
pub fn accept_cert_fingerprint<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    fingerprint: String,
) -> Result<(), String> {
    if host.is_empty() || fingerprint.is_empty() {
        return Err("host and fingerprint must not be empty".into());
    }

    // Validate SHA-256 colon-hex format: XX:XX:XX:... (32 pairs = 95 chars)
    let valid = fingerprint.len() == 95
        && fingerprint.bytes().enumerate().all(|(i, b)| {
            if (i + 1) % 3 == 0 {
                b == b':'
            } else {
                b.is_ascii_hexdigit()
            }
        });
    if !valid {
        return Err("fingerprint must be SHA-256 colon-hex format (e.g. aa:bb:cc:...)".into());
    }

    let store = app
        .store(CERTS_STORE)
        .map_err(|e| format!("failed to open certs store: {e}"))?;

    store.set(&host, Value::String(fingerprint));
    store
        .save()
        .map_err(|e| format!("failed to persist cert fingerprint: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_host_basic_wss_url() {
        assert_eq!(extract_host("wss://example.com/chat"), "example.com");
    }

    #[test]
    fn extract_host_with_port() {
        assert_eq!(extract_host("wss://example.com:8443/chat"), "example.com:8443");
    }

    #[test]
    fn extract_host_no_path() {
        assert_eq!(extract_host("wss://example.com"), "example.com");
    }

    #[test]
    fn extract_host_no_scheme() {
        assert_eq!(extract_host("example.com/path"), "example.com");
    }

    #[test]
    fn extract_host_empty() {
        assert_eq!(extract_host(""), "");
    }

    #[test]
    fn extract_host_with_port_and_deep_path() {
        assert_eq!(extract_host("wss://myhost:9443/api/v1/ws"), "myhost:9443");
    }
}
