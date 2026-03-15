// WebSocket proxy — routes WSS through Rust to bypass self-signed cert rejection.
// JS sends/receives messages via Tauri events instead of native WebSocket.

use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

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

/// Build a rustls ClientConfig that accepts any certificate.
fn make_tls_config() -> rustls::ClientConfig {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerifier))
        .with_no_client_auth();
    config
}

/// Certificate verifier that skips chain validation (for self-signed certs)
/// but still verifies TLS handshake signatures cryptographically.
/// TODO: Replace with TOFU fingerprint verifier using store_cert_fingerprint/get_cert_fingerprint.
#[derive(Debug)]
struct NoVerifier;

impl rustls::client::danger::ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
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

/// Connect to a WSS server. Spawns a background task that:
/// - Emits `ws-message` events for incoming server messages
/// - Emits `ws-state` events for connection state changes
/// - Reads from an mpsc channel for outgoing messages
#[tauri::command]
pub async fn ws_connect<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, WsState>,
    url: String,
) -> Result<(), String> {
    // Drop any existing connection
    {
        let mut tx_lock = state.tx.lock().await;
        *tx_lock = None;
    }

    // Only allow secure WebSocket connections
    if !url.starts_with("wss://") {
        return Err("Only wss:// connections are permitted".into());
    }

    let _ = app.emit("ws-state", "connecting");

    let tls_config = make_tls_config();
    let connector =
        tokio_tungstenite::Connector::Rustls(Arc::new(tls_config));

    let (ws_stream, _response) = tokio_tungstenite::connect_async_tls_with_config(
        &url,
        None,
        false,
        Some(connector),
    )
    .await
    .map_err(|e| format!("ws connect failed: {e}"))?;

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
                Ok(Message::Close(_)) => break,
                Err(e) => {
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
            _ = &mut read_task => { write_task.abort(); }
            _ = &mut write_task => { read_task.abort(); }
        }
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
