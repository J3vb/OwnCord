//! The song being played, for the "Listening to <song>" status.
//!
//! The OS already knows what is playing: Windows keeps it in the Global System
//! Media Transport Controls (the source of the volume flyout) and Linux players
//! publish it on the session bus as MPRIS. This module reads that and answers
//! with a [`MediaReading`]: a song, nothing playing, or "unknown" when the read
//! failed or an earlier read is still running (so the caller does not mistake
//! a stall for a stop). Only a [`DetectedMedia`] (title, artist, player name
//! and id, position, length) crosses IPC.
//!
//! - Windows: GSMTC through the `windows` crate (`win`).
//! - Linux: MPRIS over D-Bus (`mpris_linux`).
//! - Anything else: nothing playing.
//!
//! Rules, all in pure functions so tests cover them without an OS:
//! - Only a session that is playing counts; paused and stopped are none.
//! - Web browsers and OwnCord itself never count ([`is_browser`],
//!   [`is_own_app`]): a video or a call in a tab is not "listening", and
//!   OwnCord's own sounds are not music. The user can also hide a player
//!   ([`MediaPrefs`]).
//! - A song with an empty title is none.
//! - With several players playing, the one shown last time stays while it is
//!   still playing, else the OS's current session (Windows) or the first in a
//!   stable order (Linux), so the answer does not flicker.

#[cfg(target_os = "linux")]
mod mpris_linux;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod win;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// What the user chose to hide. Ids are the `playerId` of an earlier answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPrefs {
    #[serde(default)]
    pub hidden: Vec<String>,
}

/// The song being played, as the frontend sees it. Serialised in camelCase:
/// `{ title, artist, player, playerId, positionMs, durationMs }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedMedia {
    pub title: String,
    /// May be empty.
    pub artist: String,
    /// The player's display name ("Spotify").
    pub player: String,
    /// A stable id for the hide list.
    pub player_id: String,
    /// How far into the song, in milliseconds.
    pub position_ms: u64,
    /// The song's length in milliseconds; 0 when the player does not say.
    pub duration_ms: u64,
}

/// One session the OS reported, before the filters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub playing: bool,
    pub media: DetectedMedia,
}

/// The answer to one poll, serialised with a `state` tag:
/// `{ "state": "playing", title, ... }`, `{ "state": "none" }` or
/// `{ "state": "unknown" }`. Unknown means the read failed or timed out, or a
/// previous read is still running; the caller keeps what it showed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum MediaReading {
    Playing(DetectedMedia),
    None,
    Unknown,
}

/// The player shown by the last answer; kept while it is still playing.
static LAST_PLAYER: Mutex<Option<String>> = Mutex::new(None);

/// Set while a read is running, so polls do not pile up behind a stalled OS call.
static READING: AtomicBool = AtomicBool::new(false);

/// Holds a "read in progress" flag until dropped.
struct BusyGuard<'a>(&'a AtomicBool);

impl<'a> BusyGuard<'a> {
    /// `None` when the flag is already held.
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
            .then(|| Self(flag))
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// The song being played. Read-only; the frontend polls it while the setting
/// is on. `async` so the OS call runs off the IPC main thread, like
/// `detect_game`. A poll that starts while one is still running answers
/// unknown at once.
#[tauri::command(async)]
pub fn detect_media(prefs: MediaPrefs) -> MediaReading {
    let Some(_guard) = BusyGuard::acquire(&READING) else {
        return MediaReading::Unknown;
    };
    let candidates = platform_candidates();
    let mut last = crate::sync::lock(&LAST_PLAYER);
    reading_from(candidates, &prefs, &mut last)
}

/// Turn what the OS reported into the answer. `None` (the read failed) is
/// unknown and leaves `last` alone; a list, even an empty one, is a real answer.
pub(crate) fn reading_from(
    candidates: Option<Vec<Candidate>>,
    prefs: &MediaPrefs,
    last: &mut Option<String>,
) -> MediaReading {
    match candidates {
        None => MediaReading::Unknown,
        Some(list) => {
            choose_media(list, prefs, last).map_or(MediaReading::None, MediaReading::Playing)
        }
    }
}

#[cfg(windows)]
fn platform_candidates() -> Option<Vec<Candidate>> {
    win::candidates()
}

#[cfg(target_os = "linux")]
fn platform_candidates() -> Option<Vec<Candidate>> {
    mpris_linux::candidates()
}

#[cfg(not(any(windows, target_os = "linux")))]
fn platform_candidates() -> Option<Vec<Candidate>> {
    Some(Vec::new())
}

/// Pick the song to show from the sessions in the OS's preference order, and
/// remember its player in `last`. The first candidate left after the filters
/// wins, unless the player in `last` is still among them.
pub(crate) fn choose_media(
    candidates: Vec<Candidate>,
    prefs: &MediaPrefs,
    last: &mut Option<String>,
) -> Option<DetectedMedia> {
    let hidden: Vec<String> = prefs
        .hidden
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    let mut eligible: Vec<DetectedMedia> = candidates
        .into_iter()
        .filter(|c| c.playing)
        .map(|c| c.media)
        .filter(|m| !m.title.trim().is_empty() && !m.player_id.trim().is_empty())
        .filter(|m| !is_browser(&m.player_id) && !is_own_app(&m.player_id))
        .filter(|m| !hidden.contains(&m.player_id.trim().to_lowercase()))
        .collect();
    let kept = last.as_deref().and_then(|id| {
        eligible
            .iter()
            .position(|m| m.player_id.eq_ignore_ascii_case(id))
    });
    let index = kept.unwrap_or(0);
    let chosen = (index < eligible.len()).then(|| eligible.remove(index));
    *last = chosen.as_ref().map(|m| m.player_id.clone());
    chosen.map(|mut m| {
        m.title = m.title.trim().to_owned();
        m.artist = m.artist.trim().to_owned();
        m
    })
}

/// Names of web browsers; a token of the id that contains one is a browser.
const BROWSER_PARTS: &[&str] = &[
    "chrome",
    "chromium",
    "msedge",
    "microsoftedge",
    "firefox",
    "brave",
    "browser",
    "epiphany",
    "falkon",
    "konqueror",
    "iridium",
    "duckduckgo",
    "ungoogled",
    "midori",
    "seamonkey",
    "palemoon",
    "opera",
    "vivaldi",
    "librewolf",
    "waterfox",
    "floorp",
    "thorium",
    "yandex",
    "safari",
];
/// Short names that only count as a whole token ("arc", not "search").
const BROWSER_TOKENS: &[&str] = &["edge", "zen", "arc"];

/// True when a player id is a web browser, in a GSMTC app id (`chrome`,
/// `MSEdge`, `Brave.exe`) or an MPRIS bus-name suffix (`firefox.instance42`,
/// `plasma-browser-integration`).
///
/// Firefox and its forks (LibreWolf, Waterfox, Floorp, Zen) report a 16-digit
/// hex install hash on Windows, so that shape is a browser too. An id with
/// "music" in it is never one (Yandex Music is not Yandex Browser).
pub(crate) fn is_browser(player_id: &str) -> bool {
    let lower = player_id.trim().to_lowercase();
    if lower.contains("music") {
        return false;
    }
    if lower.len() == 16 && lower.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .any(|token| {
            BROWSER_TOKENS.contains(&token) || BROWSER_PARTS.iter().any(|p| token.contains(p))
        })
}

/// True when a player id belongs to OwnCord itself.
pub(crate) fn is_own_app(player_id: &str) -> bool {
    player_id.to_lowercase().contains("owncord")
}

/// An MPRIS bus name as a stable player id: without the
/// `org.mpris.MediaPlayer2.` prefix and without a `.instanceNNN` tail (a second
/// window of the same player gets a new tail each run, of any shape:
/// `vlc.instance_1_123`).
#[cfg(any(target_os = "linux", test))]
pub(crate) fn mpris_player_id(bus_name: &str) -> String {
    let suffix = bus_name
        .strip_prefix("org.mpris.MediaPlayer2.")
        .unwrap_or(bus_name);
    match suffix.rsplit_once(".instance") {
        Some((head, _)) if !head.is_empty() => head.to_owned(),
        _ => suffix.to_owned(),
    }
}

/// Known Windows players: a part of the lowercased id with everything but
/// letters and digits removed, and the name shown for it. First match wins.
#[cfg(any(windows, test))]
const KNOWN_PLAYERS: &[(&str, &str)] = &[
    ("spotify", "Spotify"),
    ("applemusic", "Apple Music"),
    ("itunes", "iTunes"),
    ("foobar2000", "foobar2000"),
    ("musicbee", "MusicBee"),
    ("aimp", "AIMP"),
    ("vlc", "VLC"),
    ("tidal", "TIDAL"),
    ("deezer", "Deezer"),
    ("amazonmusic", "Amazon Music"),
    ("youtubemusic", "YouTube Music"),
    ("ytmdesktop", "YouTube Music"),
    ("zunemusic", "Media Player"),
    ("wmplayer", "Windows Media Player"),
    ("winamp", "Winamp"),
    ("dopamine", "Dopamine"),
    ("mediamonkey", "MediaMonkey"),
];

/// The name to show for a GSMTC `SourceAppUserModelId`: a known player's proper
/// name, else the program name (`Foo.exe` -> `Foo`) or the last part of a
/// packaged app's family name (`Vendor.CoolPlayer_hash!App` -> `CoolPlayer`).
#[cfg(any(windows, test))]
pub(crate) fn gsmtc_display_name(app_id: &str) -> String {
    let squashed: String = app_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_lowercase();
    if let Some((_, name)) = KNOWN_PLAYERS
        .iter()
        .find(|(part, _)| squashed.contains(part))
    {
        return (*name).to_owned();
    }
    let base = app_id.rsplit(['\\', '/']).next().unwrap_or(app_id);
    let stem = match base.split_once('!') {
        // Packaged app: "Family.Name_publisherhash!AppId" -> the family's name.
        Some((family, _)) => {
            let name = family.split('_').next().unwrap_or(family);
            name.rsplit('.').next().unwrap_or(name)
        }
        None => base
            .get(base.len().saturating_sub(4)..)
            .filter(|tail| tail.eq_ignore_ascii_case(".exe"))
            .map_or(base, |_| &base[..base.len() - 4]),
    };
    let stem = stem.trim();
    if stem.is_empty() {
        return app_id.trim().to_owned();
    }
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) if !stem.chars().any(char::is_uppercase) => {
            first.to_uppercase().chain(chars).collect()
        }
        _ => stem.to_owned(),
    }
}

/// Windows ticks (100 ns) in a millisecond.
#[cfg(any(windows, test))]
const TICKS_PER_MS: i64 = 10_000;

/// The position to report for a playing session: the timeline's position plus
/// the time since the timeline was last updated (GSMTC only refreshes it on
/// play, pause and seek), clamped to the length when there is one. Both times
/// are Windows ticks (100 ns since 1601). A missing update time (`<= 0`) or one
/// in the future adds nothing.
#[cfg(any(windows, test))]
pub(crate) fn caught_up_position_ms(
    position_ms: u64,
    duration_ms: u64,
    last_updated_ticks: i64,
    now_ticks: i64,
) -> u64 {
    let elapsed_ms = if last_updated_ticks <= 0 {
        0
    } else {
        u64::try_from(now_ticks.saturating_sub(last_updated_ticks) / TICKS_PER_MS).unwrap_or(0)
    };
    let position = position_ms.saturating_add(elapsed_ms);
    if duration_ms > 0 {
        position.min(duration_ms)
    } else {
        position
    }
}
