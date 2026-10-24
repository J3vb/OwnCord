//! The Windows reader: Global System Media Transport Controls (GSMTC).
//!
//! This is the list behind the volume flyout: one session per app that shows
//! media controls. The manager is asked for once and kept; each poll reads the
//! sessions' playback state, song properties and timeline. Anything that fails
//! (an app that closed mid-read, a session without properties) drops that one
//! session, not the answer.

use std::cell::Cell;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use super::{
    caught_up_position_ms, gsmtc_display_name, is_browser, is_own_app, Candidate, DetectedMedia,
};

/// 100 ns ticks in a millisecond (the unit of `TimeSpan` and `DateTime`).
const TICKS_PER_MS: i64 = 10_000;
/// 100 ns ticks between 1601-01-01 (a `DateTime`'s zero) and the Unix epoch.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

/// The session manager, requested on first use. A failed request is not kept,
/// so the next poll tries again.
static MANAGER: Mutex<Option<Manager>> = Mutex::new(None);

thread_local! {
    static COM_READY: Cell<bool> = const { Cell::new(false) };
}

/// Join the COM multithreaded apartment on this worker thread, once. A thread
/// that already joined another apartment answers an error, which is fine: the
/// WinRT classes used here work in either.
fn init_com() {
    COM_READY.with(|ready| {
        if !ready.get() {
            // SAFETY: no pointers; the call only registers this thread.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            ready.set(true);
        }
    });
}

/// The cached manager, or a new one. The lock is not held while the request
/// runs (`get()` can stall); `detect_media` allows one read at a time anyway.
fn manager() -> Option<Manager> {
    if let Some(cached) = MANAGER.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Some(cached);
    }
    let fresh = Manager::RequestAsync().and_then(|op| op.get()).ok()?;
    *MANAGER.lock().unwrap_or_else(|e| e.into_inner()) = Some(fresh.clone());
    Some(fresh)
}

/// Every playing session, the OS's current session first. `None` when the
/// manager or the session list cannot be read.
pub(super) fn candidates() -> Option<Vec<Candidate>> {
    init_com();
    let manager = manager()?;
    let sessions = match manager.GetSessions() {
        Ok(sessions) => sessions,
        Err(_) => {
            // The manager may have gone stale; ask for a new one next poll.
            *MANAGER.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return None;
        }
    };
    let current = manager
        .GetCurrentSession()
        .ok()
        .and_then(|s| s.SourceAppUserModelId().ok())
        .map(|id| id.to_string());
    let now_ticks = now_filetime_ticks();
    let mut out: Vec<Candidate> = sessions
        .into_iter()
        .filter_map(|session| read_session(&session, now_ticks))
        .collect();
    out.sort_by_key(|c| current.as_deref() != Some(c.media.player_id.as_str()));
    Some(out)
}

fn read_session(session: &Session, now_ticks: i64) -> Option<Candidate> {
    let player_id = session.SourceAppUserModelId().ok()?.to_string();
    // Cheap checks first: no further calls for a browser or ourselves.
    if is_browser(&player_id) || is_own_app(&player_id) {
        return None;
    }
    let status = session.GetPlaybackInfo().ok()?.PlaybackStatus().ok()?;
    if status != PlaybackStatus::Playing {
        return None;
    }
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().ok()?.to_string();
    let artist = {
        let artist = props.Artist().ok()?.to_string();
        if artist.trim().is_empty() {
            props.AlbumArtist().ok()?.to_string()
        } else {
            artist
        }
    };
    let timeline = session.GetTimelineProperties().ok()?;
    let ms = |ticks: i64| u64::try_from(ticks / TICKS_PER_MS).unwrap_or(0);
    let start = timeline.StartTime().ok()?.Duration;
    let end = timeline.EndTime().ok()?.Duration;
    let position_ms = ms(timeline.Position().ok()?.Duration.saturating_sub(start));
    let duration_ms = ms(end.saturating_sub(start));
    let last_updated = timeline.LastUpdatedTime().ok()?.UniversalTime;
    Some(Candidate {
        playing: true,
        media: DetectedMedia {
            title,
            artist,
            player: gsmtc_display_name(&player_id),
            player_id,
            position_ms: caught_up_position_ms(position_ms, duration_ms, last_updated, now_ticks),
            duration_ms,
        },
    })
}

/// Now as a `DateTime`: 100 ns ticks since 1601-01-01 UTC.
fn now_filetime_ticks() -> i64 {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_nanos() / 100).unwrap_or(i64::MAX));
    since_epoch.saturating_add(UNIX_EPOCH_TICKS)
}
