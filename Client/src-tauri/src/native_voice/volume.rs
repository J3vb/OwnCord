//! The per-user volume commands: microphone, screen-share audio and music.
//! They reach the live session's mixer through `quick`, so none queues behind
//! a session step that awaits the SFU.
use super::{playout, NativeVoiceState};

/// Per-user volume: `volume` is the gain for `identity`'s microphone (1.0 is
/// unity), the value the web path hands `RemoteParticipant.setVolume`.
#[tauri::command]
pub async fn native_voice_set_volume(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    volume: f32,
) -> Result<(), String> {
    state.quick.get(session)?.playout.mixer().set_gain(
        &identity,
        playout::Volume::Microphone,
        volume,
    );
    Ok(())
}

/// Screen-share audio volume: the gain for `identity`'s screen-share audio (1.0
/// is unity, 0 when muted), the value the web path gives its audio element.
#[tauri::command]
pub async fn native_voice_set_screenshare_volume(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    volume: f32,
) -> Result<(), String> {
    state.quick.get(session)?.playout.mixer().set_gain(
        &identity,
        playout::Volume::ScreenShare,
        volume,
    );
    Ok(())
}

/// Music share volume: the gain for `identity`'s music track (1.0 is unity,
/// 0 when muted), apart from their screen-share audio and microphone.
#[tauri::command]
pub async fn native_voice_set_music_volume(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    identity: String,
    volume: f32,
) -> Result<(), String> {
    state
        .quick
        .get(session)?
        .playout
        .mixer()
        .set_gain(&identity, playout::Volume::Music, volume);
    Ok(())
}
