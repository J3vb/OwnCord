//! The music share's Tauri commands (Linux): list the applications with
//! sound, start and stop sharing one, and the listener's music volume.
use super::{share_audio, NativeVoiceState};

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
        .inner
        .lock()
        .await
        .current(session)?
        .set_music_volume(&identity, volume);
    Ok(())
}

/// The applications with sound on the default output, for the music picker,
/// as `list_audio_apps` answers on Windows. Rejects `unavailable` when no
/// sound server answers.
#[tauri::command]
pub async fn native_voice_list_audio_apps() -> Result<Vec<share_audio::AudioApp>, String> {
    list_audio_apps_blocking().await
}

async fn list_audio_apps_blocking() -> Result<Vec<share_audio::AudioApp>, String> {
    tokio::task::spawn_blocking(share_audio::list_apps)
        .await
        .map_err(|e| {
            log::warn!("[native_voice] list audio apps: {e}");
            "internal".to_string()
        })?
}

/// Share one application's sound as music: publish a stereo `music` track
/// fed by the application `app_id` (an id from `native_voice_list_audio_apps`)
/// and return its sid. A running music share is replaced; a running screen
/// share's audio is untouched. Rejects with a code: `unavailable`,
/// `not_found` (the id is not on the output any more), `activation_failed`,
/// `superseded` (a newer start or a stop came first) or `internal`.
#[tauri::command]
pub async fn native_voice_start_music(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
    app_id: String,
) -> Result<String, String> {
    use std::sync::atomic::Ordering;
    if !share_audio::valid_app_id(&app_id) {
        return Err("not_found".into());
    }
    let ticket = state.music_ticket.fetch_add(1, Ordering::SeqCst) + 1;
    let apps = list_audio_apps_blocking().await?;
    if !apps.iter().any(|a| a.id == app_id) {
        return Err("not_found".into());
    }
    let (retired, published) = {
        let mut inner = state.inner.lock().await;
        if state.music_ticket.load(Ordering::SeqCst) != ticket {
            return Err("superseded".into());
        }
        inner.current(session)?.publish_music(app_id).await
    };
    retired.release().await;
    published.map_err(|e| {
        log::warn!("[native_voice] music publish: {e}");
        "activation_failed".to_string()
    })
}

/// Stop the music share: unpublish its track and end its capture. Nothing
/// running is a no-op, and a start still in flight is superseded.
#[tauri::command]
pub async fn native_voice_stop_music(
    state: tauri::State<'_, NativeVoiceState>,
    session: u64,
) -> Result<(), String> {
    state
        .music_ticket
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let retired = state
        .inner
        .lock()
        .await
        .current(session)?
        .release_music()
        .await;
    retired.release().await;
    Ok(())
}
