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

use log::{debug, info, warn};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::Duration;

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
    /// Used by `run_accept_loop`'s accept-error exit path to deregister a dead
    /// tunnel without racing a newer tunnel that may have already replaced it
    /// (e.g. `stop_http_proxy` + a fresh `start_http_proxy` while this loop
    /// was mid-shutdown).
    async fn remove_if_port_matches(&self, remote_host: &str, port: u16) {
        let mut inner = self.inner.lock().await;
        if inner
            .get(remote_host)
            .is_some_and(|entry| entry.port == port)
        {
            inner.remove(remote_host);
        }
    }
}

use crate::proxy_common::{
    connect_tls, content_length, copy_with_deadline, header_value, read_request_headers,
    resolve_remote_target, rewrite_headers, run_accept_loop, spawn_watched, validate_remote_host,
    CountingStream,
};

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
    let conn_app = app.clone();
    let conn_host = remote_host.clone();
    let dead_host = remote_host.clone();
    spawn_watched(
        "http_proxy",
        tokio::spawn(run_accept_loop(
            listener,
            shutdown_rx,
            "http_proxy",
            move |stream| {
                let app = conn_app.clone();
                let host = conn_host.clone();
                async move {
                    if let Err(e) = handle_connection(app, stream, &host).await {
                        warn!("[http_proxy] connection to {} failed: {}", host, e);
                    }
                }
            },
            move || async move {
                if let Some(state) = app.try_state::<HttpProxyState>() {
                    state.remove_if_port_matches(&dead_host, port).await;
                } else {
                    warn!(
                        "[http_proxy] state unmanaged; cannot deregister dead tunnel for {}",
                        dead_host
                    );
                }
            },
        )),
    );

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

/// Rewrite the first request's headers: replace Host with the real remote
/// host and force `Connection: close` so exactly one request rides each
/// tunnel connection (later keep-alive requests would bypass this rewrite).
/// `raw` must end with the "\r\n\r\n" header terminator.
fn rewrite_request_headers(raw: &[u8], remote_host: &str) -> String {
    let mut modified = rewrite_headers(&String::from_utf8_lossy(raw), |line| {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            Some(format!("Host: {remote_host}"))
        } else if lower.starts_with("connection:") {
            Some("Connection: close".to_string())
        } else {
            None
        }
    });
    // `read_request_headers` only returns once it has seen the terminator, so
    // it survives the line split; the `insert_at` below depends on it.
    debug_assert!(modified.ends_with("\r\n\r\n"));
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
    let buf = read_request_headers(&mut local).await?;

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
    let mut tls = connect_tls(
        &connector,
        server_name,
        &dial_target,
        Duration::from_secs(10),
    )
    .await?;

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
            info!(
                "[http_proxy] first-use cert for {} — awaiting user confirmation",
                store_key
            );
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
            return Err(crate::text::cert_not_trusted(&store_key).into());
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
    let result = run_data_phase(&app, &buf, &mut local, &mut tls).await;
    match result {
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

/// The upload an in-flight request belongs to: the webview-generated
/// correlation id plus the request's declared body length. Both must be
/// present for the proxy to report progress; every other request takes the
/// plain copy path with no extra work.
struct UploadTarget {
    id: String,
    total: u64,
}

/// Bound on the correlation id the webview sends, so a malformed request head
/// cannot make the proxy hold or re-emit an unbounded value.
const MAX_UPLOAD_PROGRESS_ID_LEN: usize = 128;

fn upload_progress_target(raw: &[u8]) -> Option<UploadTarget> {
    let id = header_value(raw, "x-upload-id")?;
    if id.is_empty() || id.len() > MAX_UPLOAD_PROGRESS_ID_LEN {
        return None;
    }
    let total = content_length(raw)?;
    if total == 0 {
        return None;
    }
    Some(UploadTarget { id, total })
}

/// Emit one `upload-progress` event. The payload shape is the webview's
/// `UploadProgress` (`src/platform/contracts/http.ts`); keep the two in step.
fn emit_upload_progress<R: Runtime>(app: &AppHandle<R>, id: &str, sent: u64, total: u64) {
    let _ = app.emit(
        "upload-progress",
        serde_json::json!({ "id": id, "sent": sent, "total": total }),
    );
}

/// Emit interval for upload progress. A UI progress bar does not need a tick
/// per socket chunk, and `copy_bidirectional` can move many small reads.
const UPLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

/// Copy the request/response data phase, reporting bytes read from the
/// loopback side to `upload-progress` while an upload is in flight. An upload
/// is any request carrying both `X-Upload-Id` and `Content-Length`; every
/// other request is copied exactly as before.
async fn run_data_phase<R: Runtime>(
    app: &AppHandle<R>,
    request_head: &[u8],
    local: &mut TcpStream,
    tls: &mut tokio_rustls::client::TlsStream<TcpStream>,
) -> std::io::Result<(u64, u64)> {
    let Some(target) = upload_progress_target(request_head) else {
        return copy_with_deadline(local, tls, DATA_PHASE_TIMEOUT).await;
    };
    let counter = Arc::new(AtomicU64::new(0));
    let mut counted = CountingStream::new(&mut *local, Arc::clone(&counter));
    let ticker = tokio::spawn({
        let app = app.clone();
        let counter = Arc::clone(&counter);
        async move {
            loop {
                tokio::time::sleep(UPLOAD_PROGRESS_INTERVAL).await;
                emit_upload_progress(
                    &app,
                    &target.id,
                    counter.load(Ordering::Relaxed),
                    target.total,
                );
            }
        }
    });
    let result = copy_with_deadline(&mut counted, tls, DATA_PHASE_TIMEOUT).await;
    ticker.abort();
    result
}

/// Bound for the data-copy phase of a tunneled connection (step 3 above).
/// The header read, TCP connect, and TLS handshake phases all use a tight
/// 10s guard, but this phase carries the actual REST body — including
/// attachment/avatar uploads — so it needs a much more generous bound. 600s
/// only reclaims a connection that is genuinely stuck (e.g. a remote that
/// completes the TLS handshake and then neither responds nor closes), not
/// one that is merely slow.
const DATA_PHASE_TIMEOUT: Duration = Duration::from_secs(600);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: the accept-error exit path in run_accept_loop must be able to
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
        state.remove_if_port_matches("example.com:8443", 9999).await;
        assert_eq!(
            state
                .inner
                .lock()
                .await
                .get("example.com:8443")
                .map(|e| e.port),
            Some(4242),
            "mismatched port must not remove a newer tunnel's entry"
        );

        // A loop reporting its own still-current port must remove it.
        state.remove_if_port_matches("example.com:8443", 4242).await;
        assert!(
            state.inner.lock().await.get("example.com:8443").is_none(),
            "matching port must deregister the dead tunnel"
        );
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
        let raw = b"POST /x HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nConnection: keep-alive\r\n\r\n";
        let out = rewrite_request_headers(raw, "example.com:8443");
        assert!(out.contains("Connection: close\r\n"));
        assert!(!out.to_ascii_lowercase().contains("keep-alive"));
        // Exactly one Connection header.
        assert_eq!(
            out.to_ascii_lowercase().matches("\r\nconnection:").count(),
            1
        );
    }

    #[test]
    fn rewrite_preserves_other_headers_and_body_boundary() {
        let raw = b"POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1:9\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n";
        let out = rewrite_request_headers(raw, "myserver.lan:8443");
        assert!(out.contains("Content-Type: application/json\r\n"));
        assert!(out.contains("Content-Length: 2\r\n"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn upload_target_requires_both_id_and_length() {
        let with_both =
            b"POST /api/v1/uploads HTTP/1.1\r\nX-Upload-Id: u-1\r\nContent-Length: 2048\r\n\r\n";
        let target = upload_progress_target(with_both).expect("id + length is an upload");
        assert_eq!(target.id, "u-1");
        assert_eq!(target.total, 2048);

        let no_id = b"POST /api/v1/uploads HTTP/1.1\r\nContent-Length: 2048\r\n\r\n";
        assert!(
            upload_progress_target(no_id).is_none(),
            "a request without the correlation header is not reported"
        );

        let no_length = b"POST /api/v1/uploads HTTP/1.1\r\nX-Upload-Id: u-1\r\n\r\n";
        assert!(
            upload_progress_target(no_length).is_none(),
            "a chunked or bodyless request has no total to report against"
        );

        let empty_length =
            b"POST /api/v1/uploads HTTP/1.1\r\nX-Upload-Id: u-1\r\nContent-Length: 0\r\n\r\n";
        assert!(upload_progress_target(empty_length).is_none());
    }

    #[test]
    fn upload_target_rejects_an_overlong_id() {
        let mut raw = b"POST /api/v1/uploads HTTP/1.1\r\nX-Upload-Id: ".to_vec();
        raw.extend(std::iter::repeat_n(b'x', MAX_UPLOAD_PROGRESS_ID_LEN + 1));
        raw.extend_from_slice(b"\r\nContent-Length: 10\r\n\r\n");
        assert!(
            upload_progress_target(&raw).is_none(),
            "an unbounded id must not be echoed back in an event"
        );
    }

    // OC-0218 note: the copy_with_deadline stall test lives in
    // proxy_common.rs now, next to the shared helper.
}
