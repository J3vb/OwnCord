//! The Linux reader: MPRIS players on the session bus.
//!
//! Every player owns a name `org.mpris.MediaPlayer2.<name>`. For each one that
//! is playing we read `Metadata`, `Position` and the player's `Identity`. One
//! poll has one total deadline ([`POLL_DEADLINE`]) and each call is also capped
//! ([`CALL_TIMEOUT`]); a player that times out is dropped for this poll, and a
//! poll that runs out of time answers "could not read" rather than a guess.
//! The parsing is in plain functions over `dbus` values so tests feed it
//! fixtures.

use std::time::{Duration, Instant};

use dbus::arg::{prop_cast, PropMap, RefArg};
use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
use dbus::blocking::Connection;

use super::{is_browser, is_own_app, mpris_player_id, Candidate, DetectedMedia};

const NAME_PREFIX: &str = "org.mpris.MediaPlayer2.";
const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const ROOT_IFACE: &str = "org.mpris.MediaPlayer2";
/// The longest any one call may take.
const CALL_TIMEOUT: Duration = Duration::from_millis(500);
/// The longest a whole poll may take, over every player.
const POLL_DEADLINE: Duration = Duration::from_millis(1_500);

/// What `Metadata` told us about the song.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Metadata {
    pub title: String,
    /// Artists joined with ", ".
    pub artist: String,
    /// `mpris:length` in milliseconds; 0 when missing.
    pub duration_ms: u64,
}

/// True for the `PlaybackStatus` that counts as listening.
pub(super) fn parse_playing(status: &str) -> bool {
    status == "Playing"
}

/// Read `xesam:title`, `xesam:artist` (an array of strings, or a bare string
/// from players that get the type wrong) and `mpris:length` (microseconds, as
/// any integer type) out of a `Metadata` map.
pub(super) fn parse_metadata(map: &PropMap) -> Metadata {
    let title = prop_cast::<String>(map, "xesam:title")
        .map(|t| t.trim().to_owned())
        .unwrap_or_default();
    let artist = map
        .get("xesam:artist")
        .map(|v| artists(&v.0))
        .unwrap_or_default();
    let duration_ms = map
        .get("mpris:length")
        .and_then(|v| as_micros(&v.0))
        .map_or(0, |us| us / 1_000);
    Metadata {
        title,
        artist,
        duration_ms,
    }
}

fn artists(value: &dyn RefArg) -> String {
    let names: Vec<String> = match value.as_str() {
        Some(single) => vec![single.to_owned()],
        None => value
            .as_iter()
            .map(|it| it.filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
    };
    names
        .iter()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// A non-negative microsecond count from whichever number type the player used.
fn as_micros(value: &dyn RefArg) -> Option<u64> {
    value
        .as_i64()
        .and_then(|n| u64::try_from(n).ok())
        .or_else(|| value.as_u64())
}

/// The parent process id out of a `/proc/<pid>/stat` line. The program name is
/// in parentheses and may itself hold spaces and parentheses, so fields are
/// counted from the last `)`: state, then the parent pid.
pub(super) fn parse_stat_ppid(stat: &str) -> Option<u32> {
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_whitespace().nth(1)?.parse().ok()
}

/// True when `pid` is this process or a direct child of it (WebKitGTK plays
/// media in a child process of the app).
pub(super) fn is_own_process(pid: u32, own_pid: u32, parent_of_pid: Option<u32>) -> bool {
    pid == own_pid || parent_of_pid == Some(own_pid)
}

/// The poll ran out of time.
struct OutOfTime;

/// The time left in one poll.
struct Budget(Instant);

impl Budget {
    /// The timeout for the next call: the per-call cap or what is left,
    /// whichever is shorter; `Err` when nothing is left.
    fn next(&self) -> Result<Duration, OutOfTime> {
        let left = self.0.saturating_duration_since(Instant::now());
        if left.is_zero() {
            Err(OutOfTime)
        } else {
            Ok(left.min(CALL_TIMEOUT))
        }
    }
}

fn is_timeout(err: &dbus::Error) -> bool {
    matches!(
        err.name(),
        Some("org.freedesktop.DBus.Error.NoReply" | "org.freedesktop.DBus.Error.Timeout")
    )
}

/// Every MPRIS player that is playing, in bus-name order. `None` when there is
/// no session bus, it cannot list names, or the poll ran out of time.
pub(super) fn candidates() -> Option<Vec<Candidate>> {
    let budget = Budget(Instant::now() + POLL_DEADLINE);
    let conn = Connection::new_session().ok()?;
    let (names,): (Vec<String>,) = conn
        .with_proxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            budget.next().ok()?,
        )
        .method_call("org.freedesktop.DBus", "ListNames", ())
        .ok()?;
    let mut players: Vec<String> = names
        .into_iter()
        .filter(|n| n.starts_with(NAME_PREFIX))
        .collect();
    players.sort();
    let own_pid = std::process::id();
    let mut out = Vec::new();
    for name in &players {
        match read_player(&conn, &budget, name, own_pid) {
            Ok(Some(candidate)) => out.push(candidate),
            Ok(None) => {}
            Err(OutOfTime) => return None,
        }
    }
    Some(out)
}

/// One player. `Ok(None)` for a player that is not playing, is skipped, or
/// failed or timed out on a call (it is dropped for this poll).
fn read_player(
    conn: &Connection,
    budget: &Budget,
    bus_name: &str,
    own_pid: u32,
) -> Result<Option<Candidate>, OutOfTime> {
    let player_id = mpris_player_id(bus_name);
    // Cheap checks first: no D-Bus call for a browser or ourselves by name.
    if is_browser(&player_id) || is_own_app(&player_id) {
        return Ok(None);
    }
    let proxy = conn.with_proxy(bus_name, OBJECT_PATH, budget.next()?);
    let Ok(status) = proxy.get::<String>(PLAYER_IFACE, "PlaybackStatus") else {
        return Ok(None);
    };
    if !parse_playing(&status) {
        return Ok(None);
    }
    // A name owned by this process, or by a child of it (WebKitGTK plays
    // media out of process), is OwnCord's own player.
    let owner: Option<(u32,)> = conn
        .with_proxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            budget.next()?,
        )
        .method_call(
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            (bus_name,),
        )
        .ok();
    if let Some((pid,)) = owner {
        let parent = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| parse_stat_ppid(&stat));
        if is_own_process(pid, own_pid, parent) {
            return Ok(None);
        }
    }
    let proxy = conn.with_proxy(bus_name, OBJECT_PATH, budget.next()?);
    let Ok(map) = proxy.get::<PropMap>(PLAYER_IFACE, "Metadata") else {
        return Ok(None);
    };
    let meta = parse_metadata(&map);
    let proxy = conn.with_proxy(bus_name, OBJECT_PATH, budget.next()?);
    let position_us: i64 = match proxy.get(PLAYER_IFACE, "Position") {
        Ok(us) => us,
        Err(err) if is_timeout(&err) => return Ok(None),
        Err(_) => 0,
    };
    let proxy = conn.with_proxy(bus_name, OBJECT_PATH, budget.next()?);
    let identity: Option<String> = proxy.get(ROOT_IFACE, "Identity").ok();
    let player = identity
        .map(|i| i.trim().to_owned())
        .filter(|i| !i.is_empty())
        .unwrap_or_else(|| player_id.clone());
    let position_ms = u64::try_from(position_us).unwrap_or(0) / 1_000;
    Ok(Some(Candidate {
        playing: true,
        media: DetectedMedia {
            title: meta.title,
            artist: meta.artist,
            player,
            player_id,
            position_ms: if meta.duration_ms > 0 {
                position_ms.min(meta.duration_ms)
            } else {
                position_ms
            },
            duration_ms: meta.duration_ms,
        },
    }))
}
