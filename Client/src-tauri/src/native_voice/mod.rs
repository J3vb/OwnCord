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
//! payload carries the session id. Video frames do not cross IPC: each
//! session serves them on its own token-authenticated loopback socket
//! (`video.rs`), whose URL the connect result carries. Screen share captures
//! natively (`screen.rs`): the webview picks a source, or leaves the pick to
//! the desktop portal on Wayland, and sees the capture only as a preview on
//! the frame socket. Key material and the frame-socket token are never
//! logged.
pub mod screen;
pub mod session;
pub mod video;

use serde::Serialize;
use session::{AudioOptions, CameraOptions, Event, NativeSession, Resources, ScreenOptions};
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
    /// After an unlocked connect of session `id` with `connected_key`: the
    /// key it must switch to (`Some` when a rotation landed meanwhile), or
    /// an error when a newer connect or a leave (cleared key) superseded it.
    fn key_after_connect(&self, id: u64, connected_key: &[u8]) -> Result<Option<Vec<u8>>, String> {
        match &self.key {
            Some(k) if self.next_id == id => Ok((k.as_slice() != connected_key).then(|| k.clone())),
            _ => Err(format!(
                "native voice session {id} superseded during connect"
            )),
        }
    }
    fn resources(&self) -> Resources {
        match &self.session {
            Some((_, s)) => s.resources(),
            None => Resources {
                threads: session::process_threads(),
                screen_captures: screen::active_captures(),
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
    /// The session's frame-socket base URL, token included.
    frames: String,
}

/// Connect a new session, superseding any live one.
///
/// The state lock is held only to take the key, retire the old session and
/// allocate the id — never across the network connect — so a leave, a key
/// rotation or a device switch during a slow join is not blocked behind it.
/// A connect that loses the race to a newer one closes its own room and
/// reports it, the same supersession outcome the facade's checkpoints expect.
#[tauri::command]
pub async fn native_voice_connect<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, NativeVoiceState>,
    url: String,
    token: String,
    audio: AudioOptions,
) -> Result<Connected, String> {
    let (id, key) = {
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
        (inner.next_id, key)
    };
    let sink_app = app.clone();
    let on_event = std::sync::Arc::new(move |event: Event| {
        if let Err(e) = sink_app.emit(EVENT_NAME, Envelope { session: id, event }) {
            log::warn!("[native_voice] event emit failed: {e}");
        }
    });
    let mut connected_key = Some(key.clone());
    let mut session = NativeSession::connect(&url, &token, key, on_event).await?;
    // Playout needs the ADM even for a listen-only join. A headless box has
    // no sound server: log and carry on, the mic publish reports it again.
    if let Err(e) = session.enable_platform_audio(audio) {
        log::warn!("[native_voice] platform audio unavailable: {e}");
    }
    let identity = session.local_identity();
    let mut inner = state.inner.lock().await;
    let rotated = inner.key_after_connect(id, connected_key.as_deref().unwrap_or_default());
    wipe(&mut connected_key);
    match rotated {
        Err(e) => {
            log::info!("[native_voice] {e}");
            session.close().await;
            return Err(e);
        }
        Ok(Some(k)) => session.set_key(k),
        Ok(None) => {}
    }
    log::info!("[native_voice] session {id} connected as {identity}");
    let frames = session.frames_url().to_string();
    inner.session = Some((id, session));
    Ok(Connected {
        session: id,
        identity,
        frames,
    })
}

/// Enumerate the platform audio devices. Uses the live session's device
/// module when there is one, otherwise a transient one (the settings tab
/// lists devices outside a call).
#[tauri::command]
pub async fn native_voice_list_devices(
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<session::Devices, String> {
    let inner = state.inner.lock().await;
    match &inner.session {
        Some((_, s)) => s.devices(),
        None => session::list_devices_transient(),
    }
}

/// Select the capture (`kind == "audioinput"`) or playout (`"audiooutput"`)
/// device by the id `native_voice_list_devices` reported; an empty id means
/// the platform default.
#[tauri::command]
pub async fn native_voice_set_device(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    kind: String,
    device_id: String,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .set_device(&kind, &device_id)
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

/// Publish (or replace) the camera; its frames then arrive on the session's
/// frame socket. Returns the publication sid `native_voice_unpublish_camera`
/// takes.
#[tauri::command]
pub async fn native_voice_publish_camera(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    options: CameraOptions,
) -> Result<String, String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .publish_camera(options)
        .await
}

/// Unpublish camera `sid` if it is still the published one; a stale sid is a
/// no-op.
#[tauri::command]
pub async fn native_voice_unpublish_camera(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    sid: String,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .unpublish_camera(&sid)
        .await;
    Ok(())
}

/// What can be shared: screens and windows with thumbnails on X11, or
/// `portal: true` on Wayland, where the desktop portal's dialog picks.
#[tauri::command]
pub async fn native_voice_screen_sources() -> Result<screen::Sources, String> {
    tauri::async_runtime::spawn_blocking(screen::list_sources)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStarted {
    /// The id `native_voice_publish_screen`, `native_voice_stop_screen` and
    /// the `screenCaptureEnded` event carry.
    capture: u64,
    width: u32,
    height: u32,
}

/// Start capturing `source` (a `native_voice_screen_sources` id, or
/// `portal`), replacing any running capture, and resolve once the first
/// frame arrives: on Wayland that is after the user completed the portal's
/// dialog, and a cancelled dialog rejects with [`screen::CANCELLED`]. The
/// session is released while waiting, so a leave or stop meanwhile ends the
/// wait instead of queueing behind it. Frames then preview on the frame
/// socket's `screen` route.
#[tauri::command]
pub async fn native_voice_start_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    source: String,
    capture: screen::CaptureOptions,
) -> Result<ScreenStarted, String> {
    let target = screen::Target::parse(&source)?;
    let (id, started) = state
        .inner
        .lock()
        .await
        .current(session)?
        .start_screen(target, capture)
        .await?;
    let (width, height) = started
        .await
        .map_err(|_| "screen capture stopped before it started".to_string())??;
    Ok(ScreenStarted {
        capture: id,
        width,
        height,
    })
}

/// Publish running capture `capture` as the screen share; returns its sid.
#[tauri::command]
pub async fn native_voice_publish_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
    options: ScreenOptions,
) -> Result<String, String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .publish_screen(capture, options)
        .await
}

/// Unpublish and stop capture `capture`, releasing the capturer and any
/// portal session; a stale id is a no-op.
#[tauri::command]
pub async fn native_voice_stop_screen(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    capture: u64,
) -> Result<(), String> {
    state
        .inner
        .lock()
        .await
        .current(session)?
        .stop_screen(capture)
        .await;
    Ok(())
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
    fn key_after_connect_applies_a_rotation_and_rejects_supersession() {
        let mut inner = Inner {
            key: Some(vec![1]),
            session: None,
            next_id: 3,
        };
        assert_eq!(inner.key_after_connect(3, &[1]), Ok(None));
        inner.key = Some(vec![2]);
        assert_eq!(inner.key_after_connect(3, &[1]), Ok(Some(vec![2])));
        assert!(inner.key_after_connect(2, &[1]).is_err());
        inner.key = None;
        assert!(inner.key_after_connect(3, &[1]).is_err());
    }

    #[test]
    fn stale_session_ids_are_rejected() {
        let mut inner = Inner::default();
        assert!(inner.current(1).is_err());
        assert_eq!(inner.resources().rooms, 0);
    }
}
