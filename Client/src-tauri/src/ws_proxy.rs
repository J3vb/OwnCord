// WebSocket proxy — routes WSS through Rust to bypass self-signed cert rejection.
// JS sends/receives messages via Tauri events instead of native WebSocket.
//
// Implements TOFU (Trust On First Use) certificate pinning via the shared
// `tofu` module:
// - The cert SHA-256 fingerprint is captured during the handshake.
// - On a known host it must match the stored pin, or the connection is rejected.
// - On first use (no pin yet) the connection is rejected and a `cert-tofu`
//   "first_use" event is emitted so the user can confirm the fingerprint. F4/F8:
//   the proxy never silently pins or forwards to an unconfirmed host — the only
//   user-confirmed writer of a pin is the explicit `accept_cert_fingerprint` command.

use futures_util::{SinkExt, StreamExt};
use log::{debug, error, info, warn};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;

/// Maximum time to wait for the WebSocket handshake to complete.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How often the proxy sends a protocol Ping. Every server version answers it
/// with a Pong from its read loop, so the proxy hears the server at least this
/// often without relying on the webview's JS heartbeat timer, which the OS may
/// throttle while the window is minimised.
const PING_INTERVAL: Duration = Duration::from_secs(25);

/// Close the socket when no frame at all (text, ping, pong, ...) has arrived
/// for this long: 2.5 ping intervals, so one lost Pong never closes a live
/// connection. A half-open socket would otherwise stay "connected" forever.
const LIVENESS_TIMEOUT: Duration = Duration::from_millis(62_500);

use crate::constants::CERTS_STORE;
use crate::tofu::{self, TofuOutcome};

/// Sender half kept in Tauri state so `ws_send` can push messages.
/// `tx` is wrapped in `Arc` so the monitoring task can clone a reference
/// into its closure and clear the sender even after a worker task panic.
pub struct WsState {
    tx: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    /// Bumped once per `ws_connect` attempt. The handshake can pend for up to
    /// CONNECT_TIMEOUT, and callers (profile switch) start a second connect
    /// without awaiting the first, so an attempt must prove it is still the
    /// current generation before it may touch the shared sender slot.
    generation: Arc<AtomicU64>,
}

impl WsState {
    pub fn new() -> Self {
        Self {
            tx: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Claim a generation for a new connection attempt, dropping any existing
    /// sender. Every later step of that attempt is conditional on this value
    /// still being current.
    async fn begin_connection(&self) -> u64 {
        let mut tx_lock = self.tx.lock().await;
        if tx_lock.is_some() {
            debug!("[ws_proxy] dropping existing connection");
        }
        *tx_lock = None;
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Install `tx` as the live sender if `generation` is still current.
    /// Returns false when a newer `ws_connect` superseded this attempt.
    async fn install_sender(&self, generation: u64, tx: mpsc::Sender<String>) -> bool {
        // Checked under the slot lock so the decision and the write cannot be
        // split by a concurrent attempt.
        let mut tx_lock = self.tx.lock().await;
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        *tx_lock = Some(tx);
        true
    }
}

/// Clear the live sender slot, but only if `my_generation` is still the
/// current connection generation. Returns false when a newer `ws_connect`
/// superseded this connection — that teardown must not clear the slot or
/// announce a close. Ownership is proven by generation, NOT by holding a
/// Sender clone: a clone kept alive in the monitor task would keep the
/// outbound channel open, so the write task could never observe closure
/// after `ws_disconnect` (circular wait — task, socket, and TLS session
/// would all leak). `generation` only advances inside `begin_connection`
/// while the slot lock is held, so checking it under the same lock makes
/// the check-and-clear atomic with respect to new attempts.
async fn clear_sender_if_current(
    slot: &Mutex<Option<mpsc::Sender<String>>>,
    generation: &AtomicU64,
    my_generation: u64,
) -> bool {
    let mut tx_lock = slot.lock().await;
    if generation.load(Ordering::SeqCst) != my_generation {
        return false;
    }
    *tx_lock = None;
    true
}

/// Single call site for ws-state events — keeps tauri-typegen from generating duplicates.
fn emit_ws_state<R: Runtime>(app: &AppHandle<R>, state: &str) {
    let _ = app.emit("ws-state", state);
}

/// The one and only call site for cert-tofu events, crate-wide: tauri-typegen
/// emits an `onCertTofu` binding per `emit("cert-tofu", ..)` it finds, and more
/// than one makes the generated events.ts redeclare it (TS2323/TS2393), which
/// breaks `tauri build`. http_proxy routes its three TOFU outcomes through here
/// for that reason — do not call `emit("cert-tofu", ..)` anywhere else.
pub(crate) fn emit_cert_tofu<R: Runtime>(app: &AppHandle<R>, payload: serde_json::Value) {
    let _ = app.emit("cert-tofu", payload);
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

    // Drop any existing connection and claim this attempt's generation.
    let my_generation = state.begin_connection().await;
    // The superseded connection's teardown sees a stale generation and skips
    // clearing the active host, so clear it here: if this attempt fails, no
    // host may stay active without a live socket.
    if let Some(session) = app.try_state::<crate::active_session::ActiveSession>() {
        session.clear_active();
    }

    // Only allow secure WebSocket connections
    if !url.starts_with("wss://") {
        warn!("[ws_proxy] rejected non-wss URL: {}", url);
        return Err("Only wss:// connections are permitted".into());
    }

    emit_ws_state(&app, "connecting");

    // Capture the cert fingerprint during the handshake; the TOFU decision runs
    // afterward, before the socket is used.
    let (verifier, captured_fp) = tofu::CaptureVerifier::new();

    let tls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();

    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(tls_config));

    let connect_future =
        tokio_tungstenite::connect_async_tls_with_config(&url, None, false, Some(connector));

    let (ws_stream, _response) = tokio::time::timeout(CONNECT_TIMEOUT, connect_future)
        .await
        .map_err(|_| {
            error!(
                "[ws_proxy] connect timed out after {}s to {}",
                CONNECT_TIMEOUT.as_secs(),
                url
            );
            format!("ws connect timed out after {}s", CONNECT_TIMEOUT.as_secs())
        })?
        .map_err(|e| {
            error!("[ws_proxy] connect failed to {}: {}", url, e);
            // A TLS handshake failure (as opposed to an unreachable host) is
            // reported with the distinct certificate code so the webview can
            // show the certificate copy instead of the generic unreachable one
            // (DP-54 follow-up). The TOFU decision flow itself is unchanged.
            if is_tls_failure(&e) {
                return tofu::cert_connect_error(&format!("ws connect failed: {e}"));
            }
            format!("ws connect failed: {e}")
        })?;

    debug!("[ws_proxy] WebSocket handshake complete");

    // ── TOFU check ───────────────────────────────────────────────────────
    let host = tofu::extract_host(&url);
    let observed = captured_fp
        .lock()
        .map_err(|e| format!("failed to read captured fingerprint: {e}"))?
        .clone()
        .filter(|o| !o.fingerprint.is_empty())
        .ok_or("TLS handshake completed but no certificate fingerprint was captured")?;
    let fingerprint = observed.fingerprint.clone();

    match tofu::evaluate(&app, &host, &observed)? {
        // A routine public-CA renewal was re-pinned by evaluate: as trusted.
        TofuOutcome::Trusted | TofuOutcome::Renewed { .. } => {
            info!("[ws_proxy] TOFU check passed for {}", host);
            emit_cert_tofu(
                &app,
                serde_json::json!({
                    "host": host,
                    "fingerprint": fingerprint,
                    "status": "trusted",
                }),
            );
        }
        TofuOutcome::FirstUse => {
            info!(
                "[ws_proxy] first-use cert for {} — awaiting user confirmation",
                host
            );
            emit_cert_tofu(
                &app,
                serde_json::json!({
                    "host": host,
                    "fingerprint": fingerprint,
                    "status": "first_use",
                }),
            );
            // Do not open the socket: the user must confirm the fingerprint
            // (accept_cert_fingerprint) before anything is sent over it. The
            // refusal carries the distinct certificate code so the webview can
            // tell it apart from an unreachable server.
            return Err(tofu::cert_connect_error(&crate::text::cert_not_trusted(
                &host,
            )));
        }
        TofuOutcome::Mismatch { stored } => {
            let msg = tofu::mismatch_message(&host, &stored, &fingerprint);
            warn!(
                "[ws_proxy] TOFU check FAILED for {} — certificate fingerprint mismatch",
                host
            );
            debug!("[ws_proxy] TOFU detail: {}", msg);
            emit_cert_tofu(
                &app,
                serde_json::json!({
                    "host": host,
                    "fingerprint": fingerprint,
                    "status": "mismatch",
                    "message": msg,
                    "storedFingerprint": stored,
                }),
            );
            // Reject the connection — do not proceed. The refusal carries the
            // distinct certificate code so the webview can tell it apart from
            // an unreachable server.
            return Err(tofu::cert_connect_error(&msg));
        }
    }
    // ── End TOFU check ───────────────────────────────────────────────────

    let (sink, stream) = ws_stream.split();

    // Channel for JS → server messages (bounded for backpressure). The slot
    // gets the ONLY Sender: teardown ownership is proven by generation, so no
    // clone may outlive the slot — one would keep rx.recv() pending forever.
    let (tx, rx) = mpsc::channel::<String>(256);
    if !state.install_sender(my_generation, tx).await {
        info!("[ws_proxy] handshake superseded by a newer connect; dropping stale socket");
        return Err("superseded by a newer connection".into());
    }

    info!("[ws_proxy] connected to {}", host);
    emit_ws_state(&app, "open");
    // The socket being open proves nothing: the active session host is set
    // only when the server answers with `auth_ok` (see the read task below).

    let app_read = app.clone();
    let app_state = app.clone();
    // Clone the Arcs so the monitoring closure can clear tx on any exit path,
    // including worker task panics, without needing tauri::State.
    let tx_arc = Arc::clone(&state.tx);
    let generation_arc = Arc::clone(&state.generation);
    let host_read = host.clone();
    let generation_read = Arc::clone(&state.generation);

    // Single outer task owns a JoinSet containing read and write workers.
    // join_next() blocks until the first worker finishes (normally or via panic),
    // then abort_all() + drain guarantees both workers and their sockets are
    // cleaned up before the closed event is emitted.
    tokio::spawn(async move {
        let mut set = JoinSet::new();

        // Task: forward server → JS
        set.spawn(async move {
            read_frames(
                stream,
                LIVENESS_TIMEOUT,
                |text| {
                    // Native-side authenticated event: the server answered the
                    // auth message over this pinned socket. Set the host before
                    // relaying so it is active by the time the page sees it.
                    if is_auth_ok(&text) && generation_read.load(Ordering::SeqCst) == my_generation
                    {
                        app_read
                            .state::<crate::active_session::ActiveSession>()
                            .set(&host_read);
                    }
                    let _ = app_read.emit("ws-message", text);
                },
                |err| {
                    let _ = app_read.emit("ws-error", err);
                },
            )
            .await;
        });

        // Task: forward JS → server, plus the liveness pings
        set.spawn(write_frames(sink, rx, PING_INTERVAL));

        // Block until the first worker finishes (normal exit or panic).
        let first = set.join_next().await;

        // Cancel the sibling and drain it so sockets close cleanly before
        // emitting state. abort_all() is a no-op if only one task remains.
        set.abort_all();
        while set.join_next().await.is_some() {}

        match first {
            Some(Err(ref e)) if e.is_panic() => {
                error!("[ws_proxy] worker task panicked: {:?}", e);
            }
            _ => {
                info!("[ws_proxy] connection closed");
            }
        }

        // Clear the sender so ws_send returns "not connected". This runs on
        // every exit path — normal close, graceful disconnect, and panic — but
        // only when this connection still owns the slot. Clearing
        // unconditionally would kill a newer connection's sender and tell JS
        // that the live connection had closed.
        if clear_sender_if_current(&tx_arc, &generation_arc, my_generation).await {
            // The authenticated session ended on the wire: no host is active.
            deactivate_if_current(
                &app_state.state::<crate::active_session::ActiveSession>(),
                &generation_arc,
                my_generation,
            );
            // Always emit closed, even after a panic.
            emit_ws_state(&app_state, "closed");
        } else {
            debug!("[ws_proxy] superseded connection torn down; leaving live sender in place");
        }
    });

    Ok(())
}

/// Whether a relayed server frame is the `auth_ok` envelope that completes the
/// WebSocket login. Only the top-level `type` counts; a chat message whose
/// content says "auth_ok" does not.
fn is_auth_ok(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("type")
                .and_then(Value::as_str)
                .map(|t| t == "auth_ok")
        })
        .unwrap_or(false)
}

/// Clear the active session host when the connection that authenticated it
/// ends, but only while `my_generation` is still current: a superseded
/// connection's teardown must not drop a newer session's host.
fn deactivate_if_current(
    session: &crate::active_session::ActiveSession,
    generation: &AtomicU64,
    my_generation: u64,
) {
    if generation.load(Ordering::SeqCst) == my_generation {
        session.clear_active();
    }
}

/// Whether a tungstenite connect error is a TLS/certificate rejection rather
/// than an unreachable host. Drives the distinct `TLS_CERT_UNVERIFIED` code the
/// webview maps to its certificate copy (DP-54 follow-up). `Error::Tls` is the
/// direct case; when tokio-rustls rejects the handshake it wraps the rustls
/// error in an `Error::Io` of kind `InvalidData` (a clean EOF is
/// `UnexpectedEof`, and a dead socket keeps its own kind), so that kind is the
/// precise signal — a plain network error is never mistaken for a certificate
/// one.
pub(crate) fn is_tls_failure(error: &tokio_tungstenite::tungstenite::Error) -> bool {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Tls(_) => true,
        Error::Io(e) => e.kind() == std::io::ErrorKind::InvalidData,
        _ => false,
    }
}

/// Why [`read_frames`] stopped.
#[derive(Debug, PartialEq, Eq)]
enum ReadEnd {
    /// The server closed the socket (Close frame or end of stream).
    Closed,
    /// The socket failed with a read error.
    Failed,
    /// Nothing arrived for the liveness timeout: the connection is presumed
    /// half-open (a firewall or NAT dropped it without a FIN or RST).
    Silent,
}

/// Forward server text frames to `on_text` until the server closes, the read
/// fails, or nothing arrives for `silence`. Every inbound frame, including a
/// Pong answering [`write_frames`]'s pings, proves the server is alive and
/// restarts the deadline.
async fn read_frames<S>(
    mut stream: S,
    silence: Duration,
    mut on_text: impl FnMut(String),
    on_error: impl Fn(String),
) -> ReadEnd
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let msg = match tokio::time::timeout(silence, stream.next()).await {
            Ok(Some(msg)) => msg,
            Ok(None) => return ReadEnd::Closed,
            Err(_) => {
                warn!(
                    "[ws_proxy] no frame from the server for {}s; closing the half-open socket",
                    silence.as_secs_f32()
                );
                on_error("liveness timeout: the server stopped answering".into());
                return ReadEnd::Silent;
            }
        };
        match msg {
            Ok(Message::Text(text)) => on_text(text.to_string()),
            Ok(Message::Close(frame)) => {
                debug!("[ws_proxy] server sent Close frame: {:?}", frame);
                return ReadEnd::Closed;
            }
            Err(e) => {
                warn!("[ws_proxy] read error: {}", e);
                on_error(format!("{e}"));
                return ReadEnd::Failed;
            }
            _ => {} // binary/ping/pong: liveness only
        }
    }
}

/// Forward JS messages from `rx` to the server, and send a protocol Ping every
/// `ping_every` so [`read_frames`] hears a Pong even while JS is quiet. Ends
/// when `rx` closes (disconnect) or a send fails.
async fn write_frames<S>(mut sink: S, mut rx: mpsc::Receiver<String>, ping_every: Duration)
where
    S: futures_util::Sink<Message> + Unpin,
{
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + ping_every, ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let frame = tokio::select! {
            msg = rx.recv() => match msg {
                Some(text) => Message::Text(text.into()),
                None => break,
            },
            _ = ping.tick() => Message::Ping(Vec::new().into()),
        };
        if sink.send(frame).await.is_err() {
            break;
        }
    }
}

/// Send a text message through the proxy WebSocket.
#[tauri::command]
pub async fn ws_send(state: tauri::State<'_, WsState>, message: String) -> Result<(), String> {
    let tx_lock = state.tx.lock().await;
    if let Some(tx) = tx_lock.as_ref() {
        match tx.try_send(message) {
            Ok(()) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                warn!("[ws_proxy] ws_send: outbound channel full, message dropped");
                Err("ws_send: channel full, message dropped".into())
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                Err("ws_send: channel closed".into())
            }
        }
    } else {
        Err("WebSocket not connected".into())
    }
}

/// Disconnect the proxy WebSocket.
#[tauri::command]
pub async fn ws_disconnect(
    state: tauri::State<'_, WsState>,
    session: tauri::State<'_, crate::active_session::ActiveSession>,
) -> Result<(), String> {
    // begin_connection() both clears the sender slot (dropping it closes the
    // channel so the write task ends) AND bumps the generation counter, so a
    // handshake still pending from before this disconnect fails install_sender
    // instead of installing itself afterward — reusing the same invalidation
    // path a superseding connect() already has. The returned generation is
    // unused: nothing will ever install under it.
    state.begin_connection().await;
    // Logout / server switch: no session is live, so the credential commands
    // fall back to their pre-session rule, which admits a read only for a host
    // whose login was verified this app run. That set is kept.
    session.clear_active();
    Ok(())
}

/// Whether `fingerprint` is a SHA-256 digest in colon-hex form:
/// `XX:XX:XX:...`, 32 hex pairs separated by colons (95 chars total).
///
/// Split out of `accept_cert_fingerprint` so the format check — the guard on
/// the only code path that writes a cert pin — is reachable from unit tests
/// without a Tauri runtime.
pub(crate) fn is_valid_cert_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 95
        && fingerprint.bytes().enumerate().all(|(i, b)| {
            if (i + 1) % 3 == 0 {
                b == b':'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// Whether writing `fingerprint` changes what `host` trusts: a first pin, or a
/// different one. Restating the stored pin asks nothing.
pub(crate) fn pin_needs_confirmation(stored: Option<&Value>, fingerprint: &str) -> bool {
    !matches!(stored, Some(Value::String(s)) if s == fingerprint)
}

/// Ask the user, in a native dialog, to confirm pinning `fingerprint` for
/// `host`. Runs from an async command, off Tauri's main thread, so
/// `blocking_show` (which dispatches onto the main thread) cannot deadlock.
#[cfg(not(feature = "e2e-auto-confirm"))]
fn confirm_pin_natively<R: Runtime>(app: &AppHandle<R>, host: &str, fingerprint: &str) -> bool {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .message(crate::text::cert_accept_prompt(host, fingerprint))
        .title(crate::text::CERT_ACCEPT_TITLE)
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::YesNo)
        .blocking_show()
}

/// The Playwright-driven native E2E builds (identity `com.owncord.e2e`, never a
/// release artifact) cannot see an OS dialog, so they answer yes. Shipped
/// builds never enable this feature; the artifact smoke drives those with a
/// pre-seeded pin instead (`tests/e2e/support/artifact-app.ts`).
#[cfg(feature = "e2e-auto-confirm")]
fn confirm_pin_natively<R: Runtime>(_: &AppHandle<R>, _: &str, _: &str) -> bool {
    true
}

/// Accept a certificate fingerprint for a host — the only path that writes a pin
/// on the user's word (`tofu::evaluate` re-pins only a publicly valid renewal).
/// Called after the user acknowledges a first-use or cert-mismatch prompt.
///
/// A pin that changes what is trusted is written only after a native dialog the
/// user answers: the renderer already showed its own prompt, but a compromised
/// renderer must not be able to pin an arbitrary host/fingerprint silently.
#[tauri::command(async)]
pub fn accept_cert_fingerprint<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    fingerprint: String,
) -> Result<(), String> {
    if host.is_empty() || fingerprint.is_empty() {
        return Err("host and fingerprint must not be empty".into());
    }

    if !is_valid_cert_fingerprint(&fingerprint) {
        return Err("fingerprint must be SHA-256 colon-hex format (e.g. aa:bb:cc:...)".into());
    }
    // Pins are read under the normalized key (tofu::cert_store_key) by
    // evaluate, the HTTP proxy and the LiveKit proxy; write them the same way.
    let host = crate::tofu::cert_store_key(&host);

    let store = crate::json_store::open(&app, CERTS_STORE).map_err(|e| {
        log::warn!("[ws_proxy] accept_cert_fingerprint: failed to open certs store: {e}");
        format!("failed to open certs store: {e}")
    })?;

    // Capture old value before mutating so we can restore it if save fails.
    let old_value = store.get(&host);
    if pin_needs_confirmation(old_value.as_ref(), &fingerprint)
        && !confirm_pin_natively(&app, &host, &fingerprint)
    {
        return Err("certificate not accepted".into());
    }
    // A pin that replaces a *different* existing fingerprint is security-
    // significant (cert rotation — or a MITM the user just accepted).
    let changed = matches!(&old_value, Some(Value::String(s)) if *s != fingerprint);
    store.set(&host, Value::String(fingerprint.clone()));
    if let Err(e) = store.save() {
        // Restore previous in-memory state: put back old fingerprint if one
        // existed, or delete if there was none. Without this, the new
        // fingerprint would be trusted in-process even though it was never
        // persisted to certs.json.
        match old_value {
            Some(v) => {
                store.set(&host, v);
            }
            None => {
                let _ = store.delete(&host);
            }
        }
        log::warn!("[ws_proxy] accept_cert_fingerprint: failed to persist pin for {host}: {e}");
        return Err(format!("failed to persist cert fingerprint: {e}"));
    }
    // The REST tunnel's idle connections were verified against the old pin (or
    // none): drop them so the next request re-runs the TOFU check.
    if let Some(http) = app.try_state::<crate::http_proxy::HttpProxyState>() {
        http.pool.invalidate(&crate::tofu::cert_store_key(&host));
    }
    // Fingerprints are public cert hashes — safe to log; this is the TOFU audit trail.
    if changed {
        log::warn!("[ws_proxy] cert pin CHANGED for {host} -> {fingerprint}");
    } else {
        log::info!("[ws_proxy] cert pin accepted for {host} -> {fingerprint}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (pure logic only — no Tauri runtime required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A well-formed SHA-256 colon-hex fingerprint (32 pairs, 95 chars).
    const VALID: &str = "e3:b0:c4:42:98:fc:1c:14:9a:fb:f4:c8:99:6f:b9:24:\
27:ae:41:e4:64:9b:93:4c:a4:95:99:1b:78:52:b8:55";

    // The native confirmation guards every pin write that changes what is
    // trusted; re-accepting the pin already stored asks nothing.
    #[test]
    fn a_pin_write_needs_confirmation_unless_it_restates_the_stored_pin() {
        assert!(pin_needs_confirmation(None, VALID));
        assert!(pin_needs_confirmation(
            Some(&Value::String("aa:bb".into())),
            VALID
        ));
        assert!(pin_needs_confirmation(Some(&Value::Null), VALID));
        assert!(!pin_needs_confirmation(
            Some(&Value::String(VALID.into())),
            VALID
        ));
    }

    // The active session host is set only from a server frame the proxy itself
    // relays, never from a renderer command.
    #[test]
    fn only_an_auth_ok_frame_activates_the_session() {
        assert!(is_auth_ok(
            r#"{"type":"auth_ok","payload":{"user":{"id":1}}}"#
        ));
        assert!(!is_auth_ok(r#"{"type":"auth_fail","payload":{}}"#));
        assert!(!is_auth_ok(
            r#"{"type":"chat_message","payload":{"content":"auth_ok"}}"#
        ));
        assert!(!is_auth_ok(r#"{"payload":{"type":"auth_ok"}}"#));
        assert!(!is_auth_ok("not json"));
        assert!(!is_auth_ok(""));
    }

    #[test]
    fn a_connection_that_ends_deactivates_only_its_own_session() {
        let session = crate::active_session::ActiveSession::new();
        session.set("chat.example.com");
        // Stale generation: a superseded connection must not clear the host.
        let generation = AtomicU64::new(2);
        deactivate_if_current(&session, &generation, 1);
        assert!(session.ensure("other.example", false).is_err());
        assert!(session.ensure("chat.example.com", false).is_ok());
        deactivate_if_current(&session, &generation, 2);
        assert!(session.ensure("chat.example.com", false).is_err());
    }

    // DP-54 follow-up: a failed TLS handshake or a refused certificate must be
    // distinguishable from an unreachable host by the webview. The connect
    // error and the refused-cert command error both carry the distinct code.
    #[test]
    fn a_certificate_connect_error_carries_the_distinct_code() {
        let raw = tofu::cert_connect_error("certificate for example.com is not yet trusted");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("JSON error body");
        assert_eq!(
            parsed.get("error").and_then(serde_json::Value::as_str),
            Some(tofu::TLS_CERT_ERROR_CODE),
        );
        assert!(parsed
            .get("message")
            .and_then(serde_json::Value::as_str)
            .is_some());
    }

    #[test]
    fn a_tls_handshake_error_is_classified_but_a_plain_io_error_is_not() {
        use tokio_tungstenite::tungstenite::{error::TlsError, Error};
        assert!(is_tls_failure(&Error::Tls(TlsError::InvalidDnsName)));
        // tokio-rustls wraps a rustls rejection inside Error::Io/InvalidData.
        assert!(is_tls_failure(&Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid peer certificate: UnknownIssuer",
        ))));
        // A dropped or dead host is not a certificate failure.
        assert!(!is_tls_failure(&Error::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "tls handshake eof",
        ))));
        assert!(!is_tls_failure(&Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "Connection refused",
        ))));
    }

    #[test]
    fn valid_fingerprint_is_accepted() {
        assert_eq!(VALID.len(), 95, "test constant must be 95 chars");
        assert!(is_valid_cert_fingerprint(VALID));
    }

    #[test]
    fn uppercase_hex_is_accepted() {
        assert!(is_valid_cert_fingerprint(&VALID.to_uppercase()));
    }

    #[test]
    fn empty_fingerprint_is_rejected() {
        assert!(!is_valid_cert_fingerprint(""));
    }

    #[test]
    fn wrong_length_is_rejected() {
        // One pair short, and one pair too many.
        assert!(!is_valid_cert_fingerprint(&VALID[..92]));
        assert!(!is_valid_cert_fingerprint(&format!("{VALID}:00")));
    }

    #[test]
    fn non_hex_characters_are_rejected() {
        // 'z' is not a hex digit; length still 95.
        let bad = VALID.replacen('e', "z", 1);
        assert_eq!(bad.len(), 95);
        assert!(!is_valid_cert_fingerprint(&bad));
    }

    #[test]
    fn wrong_separator_is_rejected() {
        // Dashes instead of colons — same length, same hex digits.
        let bad = VALID.replace(':', "-");
        assert_eq!(bad.len(), 95);
        assert!(!is_valid_cert_fingerprint(&bad));
    }

    #[test]
    fn misplaced_separator_is_rejected() {
        // Swap a colon with an adjacent hex digit so the colons land off-grid
        // while the length and character set stay legal.
        let mut bytes = VALID.as_bytes().to_vec();
        bytes.swap(2, 3);
        let bad = String::from_utf8(bytes).unwrap();
        assert_eq!(bad.len(), 95);
        assert!(!is_valid_cert_fingerprint(&bad));
    }

    #[test]
    fn whitespace_padding_is_rejected() {
        // A pasted fingerprint with surrounding whitespace must not slip
        // through — it would be stored verbatim and never match a real cert.
        assert!(!is_valid_cert_fingerprint(&format!(" {VALID}")));
        assert!(!is_valid_cert_fingerprint(&format!("{VALID} ")));
    }

    #[test]
    fn non_ascii_of_correct_byte_length_is_rejected() {
        // Guards the byte-indexed validator against multi-byte input.
        let bad = format!("é{}", &VALID[..93]);
        assert!(!is_valid_cert_fingerprint(&bad));
    }

    // ── Connection-generation ownership of the shared sender slot ───────────
    //
    // A handshake pends up to CONNECT_TIMEOUT, and a profile switch starts a
    // second ws_connect without awaiting or cancelling the first, so two
    // attempts can be in flight over one slot. Mirrors the ptt.rs
    // ATOMICRACE-001 guard.

    #[tokio::test]
    async fn superseded_connect_does_not_take_the_sender_slot() {
        let state = WsState::new();

        // Connection A starts its handshake, then a profile switch starts B
        // while A is still pending.
        let gen_a = state.begin_connection().await;
        let gen_b = state.begin_connection().await;
        assert_ne!(gen_a, gen_b);

        let (tx_b, _rx_b) = mpsc::channel::<String>(4);
        assert!(
            state.install_sender(gen_b, tx_b.clone()).await,
            "the current generation must be able to install"
        );

        // A's handshake finally completes. Installing now would route the next
        // auth send to the stale host and drop B's sender, ending B's write task.
        let (tx_a, _rx_a) = mpsc::channel::<String>(4);
        assert!(
            !state.install_sender(gen_a, tx_a).await,
            "a superseded attempt must not take the slot"
        );

        let slot = state.tx.lock().await;
        assert!(
            slot.as_ref().is_some_and(|t| t.same_channel(&tx_b)),
            "the live connection's sender must still be installed"
        );
    }

    // ── Generation-owned teardown ───────────────────────────────────────────
    //
    // Teardown ownership must be provable WITHOUT holding a Sender clone: any
    // clone kept alive by the monitor task keeps the outbound channel open, so
    // after ws_disconnect drops the slot's sender the write task never sees
    // rx.recv() == None — writer, reader, and TLS socket all leak in a
    // circular wait (monitor waits on writer, writer waits on the monitor's
    // clone dropping).

    #[tokio::test]
    async fn owning_teardown_clears_the_slot_by_generation() {
        let state = WsState::new();
        let my_generation = state.begin_connection().await;
        let (tx, _rx) = mpsc::channel::<String>(4);
        state.install_sender(my_generation, tx).await;

        assert!(
            clear_sender_if_current(&state.tx, &state.generation, my_generation).await,
            "the owning connection must clear its slot without a Sender clone"
        );
        assert!(
            state.tx.lock().await.is_none(),
            "ws_send must report not-connected after a real close"
        );
    }

    #[tokio::test]
    async fn superseded_teardown_by_generation_leaves_the_live_sender() {
        let state = WsState::new();
        let gen_a = state.begin_connection().await;
        let (tx_a, _rx_a) = mpsc::channel::<String>(4);
        state.install_sender(gen_a, tx_a).await;

        let gen_b = state.begin_connection().await;
        let (tx_b, _rx_b) = mpsc::channel::<String>(4);
        assert!(state.install_sender(gen_b, tx_b.clone()).await);

        // A's monitor task tears down after B is live. Clearing here would
        // kill B's sender and emit "closed" while JS believes B is connected.
        assert!(
            !clear_sender_if_current(&state.tx, &state.generation, gen_a).await,
            "a superseded teardown must not clear the slot or announce a close"
        );
        let slot = state.tx.lock().await;
        assert!(
            slot.as_ref().is_some_and(|t| t.same_channel(&tx_b)),
            "the live connection's sender must survive a superseded teardown"
        );
    }

    #[tokio::test]
    async fn disconnect_closes_the_outbound_channel() {
        // ws_disconnect's contract (the comment at its *tx_lock = None):
        // dropping the slot's sender closes the channel so the write task
        // ends. That holds only while install_sender receives the ONLY
        // Sender — no teardown-ownership clone may exist.
        let state = WsState::new();
        let generation = state.begin_connection().await;
        let (tx, mut rx) = mpsc::channel::<String>(4);
        state.install_sender(generation, tx).await;

        *state.tx.lock().await = None; // ws_disconnect

        let got = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("write task would hang forever: channel still open after disconnect");
        assert_eq!(
            got, None,
            "rx.recv() must yield None so the write task exits"
        );
    }

    // ── Liveness (CLI-01) ────────────────────────────────────────────────────
    //
    // A firewall or NAT that drops the connection without a FIN/RST leaves a
    // half-open socket that reads nothing forever. The proxy must close it so
    // JS sees "closed" and reconnects, but must never close a live connection
    // that is merely quiet.

    use tokio::io::DuplexStream;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use tokio_tungstenite::WebSocketStream;

    async fn socket_pair() -> (WebSocketStream<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (client, server) = tokio::io::duplex(64 * 1024);
        (
            WebSocketStream::from_raw_socket(client, Role::Client, None).await,
            WebSocketStream::from_raw_socket(server, Role::Server, None).await,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_server_is_closed_at_the_liveness_deadline() {
        // The server end stays open but never sends a byte: a half-open socket.
        let (client, _server) = socket_pair().await;
        let (_sink, stream) = client.split();
        let errors = std::sync::Mutex::new(Vec::new());

        let started = tokio::time::Instant::now();
        let end = read_frames(
            stream,
            LIVENESS_TIMEOUT,
            |_| {},
            |e| errors.lock().unwrap().push(e),
        )
        .await;

        assert_eq!(end, ReadEnd::Silent);
        assert_eq!(started.elapsed(), LIVENESS_TIMEOUT);
        assert_eq!(
            errors.lock().unwrap().len(),
            1,
            "the close must be logged to JS"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_that_only_answers_pings_is_kept_for_five_minutes() {
        // The server sends nothing of its own; its read loop auto-answers each
        // Ping with a Pong, as every OwnCord server version does. JS sends
        // nothing either (a minimised window with a throttled heartbeat).
        let (client, mut server) = socket_pair().await;
        tokio::spawn(async move { while let Some(Ok(_)) = server.next().await {} });
        let (sink, stream) = client.split();
        let (_tx, rx) = mpsc::channel::<String>(4);
        tokio::spawn(write_frames(sink, rx, PING_INTERVAL));

        let outcome = tokio::time::timeout(
            Duration::from_secs(300),
            read_frames(stream, LIVENESS_TIMEOUT, |_| {}, |_| {}),
        )
        .await;

        assert!(
            outcome.is_err(),
            "a live connection was closed: {:?}",
            outcome.ok()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn text_is_forwarded_and_a_close_frame_ends_the_read() {
        let (client, mut server) = socket_pair().await;
        let (_sink, stream) = client.split();
        server.send(Message::Text("hello".into())).await.unwrap();
        server.close(None).await.unwrap();
        let mut texts = Vec::new();

        let end = read_frames(stream, LIVENESS_TIMEOUT, |t| texts.push(t), |_| {}).await;

        assert_eq!(end, ReadEnd::Closed);
        assert_eq!(texts, ["hello"]);
    }

    // B4_conn_ipc-9: ws_disconnect must invalidate an in-flight ws_connect
    // attempt, not just null the sender slot. A handshake can pend for up to
    // CONNECT_TIMEOUT (10s) past a disconnect (JS calls connect fire-and-
    // forget — logout during "connecting" is a real interleaving), and
    // install_sender checks generation alone, so a manual `*tx_lock = None`
    // leaves a "cancelled" connection free to install itself afterward and
    // spawn its worker tasks against a socket JS believes closed.
    #[tokio::test]
    async fn disconnect_invalidates_an_in_flight_connect_attempt() {
        let state = WsState::new();
        // A's handshake is in flight: generation claimed, sender not yet
        // installed (mirrors the pending window before install_sender runs).
        let gen_a = state.begin_connection().await;

        // ws_disconnect fires while A is still mid-handshake — this is
        // ws_disconnect's real body (state.begin_connection().await).
        state.begin_connection().await;

        // A's handshake finally completes and tries to install its sender.
        // It must be rejected: JS already believes the connection is closed.
        let (tx_a, _rx_a) = mpsc::channel::<String>(4);
        assert!(
            !state.install_sender(gen_a, tx_a).await,
            "a handshake pending during disconnect must not be able to install after it"
        );
    }
}
