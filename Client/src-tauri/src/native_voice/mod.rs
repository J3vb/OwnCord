//! Native LiveKit backend for Linux voice — the Tauri command surface.
//!
//! No mainstream WebKitGTK build ships WebRTC, so the system webview on Linux
//! has no `RTCPeerConnection` and the browser LiveKit path cannot work there.
//! The approved design (`docs/architecture/voice-e2ee.md`) runs the LiveKit
//! Rust SDK in this backend on Linux only, with the webview kept as the UI:
//! `Client/src/features/voice/native/` drives these commands from behind the
//! `livekitSession` facade. The TS E2EE key exchange is unchanged; only the
//! final room key crosses IPC (`native_voice_set_key`), so encryption stays
//! byte-compatible with Windows clients.
//!
//! Sessions are numbered so a superseded join can tear down exactly its own
//! room (`native_voice_disconnect` is a no-op for any other id), mirroring
//! the facade's "cleanup is scoped to the attempt's own room" rule.
//! Room events reach the webview as one Tauri event, `native-voice`, whose
//! payload carries the session id. Key material is never logged.
pub mod session;

use serde::Serialize;
use session::{AudioOptions, Event, NativeSession, Resources};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex;

/// The Tauri event every room event is delivered on.
pub const EVENT_NAME: &str = "native-voice";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    session: u64,
    event: Event,
}

#[derive(Default)]
struct Inner {
    /// Key material for the next/current room. Set before connect by the TS
    /// key exchange, rotated in place, cleared on leave.
    key: Option<Vec<u8>>,
    session: Option<(u64, NativeSession)>,
    next_id: u64,
}

impl Inner {
    fn current(&mut self, id: u64) -> Result<&mut NativeSession, String> {
        match &mut self.session {
            Some((sid, s)) if *sid == id => Ok(s),
            _ => Err(format!("native voice session {id} is not current")),
        }
    }
    fn resources(&self) -> Resources {
        match &self.session {
            Some((_, s)) => s.resources(),
            None => Resources {
                threads: session::process_threads(),
                ..Default::default()
            },
        }
    }
}

#[derive(Default)]
pub struct NativeVoiceState {
    inner: Mutex<Inner>,
}

impl NativeVoiceState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn wipe(key: &mut Option<Vec<u8>>) {
    if let Some(mut k) = key.take() {
        k.iter_mut().for_each(|b| *b = 0);
    }
}

/// Report the native LiveKit SDK version and confirm libwebrtc is linked
/// (phase 0's proof that the prebuilt archive matched the toolchain).
#[tauri::command]
pub fn native_voice_build_info() -> String {
    let probe = livekit::webrtc::native::create_random_uuid();
    format!("livekit {} libwebrtc-ok {probe}", livekit::SDK_VERSION)
}

/// Install or rotate the room key. `key` is the base64 text livekit-client
/// would receive in `ExternalE2EEKeyProvider.setKey`; see
/// `session::shared_key_material` for why it is used as text.
#[tauri::command]
pub async fn native_voice_set_key(
    state: tauri::State<'_, NativeVoiceState>,
    key: String,
) -> Result<(), String> {
    let material = session::shared_key_material(&key);
    let mut inner = state.inner.lock().await;
    if let Some((_, s)) = &inner.session {
        s.set_key(material.clone());
    }
    wipe(&mut inner.key);
    inner.key = Some(material);
    log::debug!("[native_voice] room key installed");
    Ok(())
}

/// Forget the room key (leave). The live room, if any, keeps the key it has
/// until it is closed — the facade closes it in the same teardown.
#[tauri::command]
pub async fn native_voice_clear_key(
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<(), String> {
    wipe(&mut state.inner.lock().await.key);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    /// The id the other commands and every `native-voice` event carry.
    session: u64,
    /// Our LiveKit identity (`user-<id>...`), for the participant model.
    identity: String,
}

/// Connect a new session, superseding any live one.
#[tauri::command]
pub async fn native_voice_connect<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, NativeVoiceState>,
    url: String,
    token: String,
    audio: AudioOptions,
) -> Result<Connected, String> {
    let mut inner = state.inner.lock().await;
    let key = inner
        .key
        .clone()
        .ok_or("no E2EE room key installed before connect")?;
    if let Some((old, s)) = inner.session.take() {
        log::info!("[native_voice] superseding session {old}");
        s.close().await;
    }
    inner.next_id += 1;
    let id = inner.next_id;
    let sink_app = app.clone();
    let on_event = std::sync::Arc::new(move |event: Event| {
        if let Err(e) = sink_app.emit(EVENT_NAME, Envelope { session: id, event }) {
            log::warn!("[native_voice] event emit failed: {e}");
        }
    });
    let mut session = NativeSession::connect(&url, &token, key, on_event).await?;
    // Playout needs the ADM even for a listen-only join. A headless box has
    // no sound server: log and carry on, the mic publish reports it again.
    if let Err(e) = session.enable_platform_audio(audio) {
        log::warn!("[native_voice] platform audio unavailable: {e}");
    }
    let identity = session.local_identity();
    log::info!("[native_voice] session {id} connected as {identity}");
    inner.session = Some((id, session));
    Ok(Connected {
        session: id,
        identity,
    })
}

/// Close session `session` if it is still the live one.
#[tauri::command]
pub async fn native_voice_disconnect(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
) -> Result<Resources, String> {
    let mut inner = state.inner.lock().await;
    if matches!(&inner.session, Some((id, _)) if *id == session) {
        if let Some((_, s)) = inner.session.take() {
            s.close().await;
            log::info!("[native_voice] session {session} closed");
        }
    }
    Ok(inner.resources())
}

#[tauri::command]
pub async fn native_voice_set_microphone(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    enabled: bool,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_microphone(enabled)
        .await
}

#[tauri::command]
pub async fn native_voice_set_subscribed(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    sid: String,
    subscribed: bool,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_subscribed(&identity, &sid, subscribed)
}

/// Native resource counts for `getSessionDebugInfo` (B7-11).
#[tauri::command]
pub async fn native_voice_debug_info(
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<Resources, String> {
    Ok(state.inner.lock().await.resources())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Proves both that the SDK version is readable and that a libwebrtc symbol
    /// links and runs. If the prebuilt archive were missing or ABI-mismatched,
    /// this binary would not link at all.
    #[test]
    fn build_info_reports_sdk_and_libwebrtc() {
        let info = native_voice_build_info();
        assert!(info.contains("livekit 0.9.1"), "unexpected: {info}");
        assert!(info.contains("libwebrtc-ok"), "unexpected: {info}");
    }

    #[test]
    fn wipe_zeroes_before_dropping() {
        let mut key = Some(vec![7u8; 4]);
        wipe(&mut key);
        assert!(key.is_none());
    }

    #[test]
    fn stale_session_ids_are_rejected() {
        let mut inner = Inner::default();
        assert!(inner.current(1).is_err());
        assert_eq!(inner.resources().rooms, 0);
    }
}
