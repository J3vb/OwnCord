//! The music share's Tauri commands (Linux): list the applications with
//! sound, and start and stop sharing one.
use super::{share_audio, NativeVoiceState};

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
        if is_superseded(state.music_ticket.load(Ordering::SeqCst), ticket) {
            return Err("superseded".into());
        }
        // A session that is not current (a leave, a newer join) ended this
        // start the same way a newer start would.
        let live = inner
            .current(session)
            .map_err(|_| "superseded".to_string())?;
        live.publish_music(app_id, state.quick.closing(session))
            .await
    };
    retired.release().await;
    // A stop or newer start queued behind this publish bumped the ticket: it
    // runs next on `inner` and releases the track, so only answer here.
    if is_superseded(state.music_ticket.load(Ordering::SeqCst), ticket) {
        return Err("superseded".into());
    }
    published.map_err(|e| {
        log::warn!("[native_voice] music publish: {e}");
        "activation_failed".to_string()
    })
}

/// Whether a start holding `ticket` was overtaken by a newer start or a stop.
fn is_superseded(current: u64, ticket: u64) -> bool {
    current != ticket
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
    // A session that is not current has nothing of ours published: quiet Ok.
    let retired = match state.inner.lock().await.current(session) {
        Ok(session) => session.release_music().await,
        Err(_) => return Ok(()),
    };
    retired.release().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_superseded;

    #[test]
    fn a_start_is_superseded_once_the_ticket_moved() {
        assert!(!is_superseded(5, 5));
        // A newer start or a stop bumped it.
        assert!(is_superseded(6, 5));
    }
}
