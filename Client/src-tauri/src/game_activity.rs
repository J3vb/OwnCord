//! Which game is running, for the "Playing <game>" status (WP 8.3b).
//!
//! The scanner lists the user's own processes, matches them against the games
//! installed in the Steam and Epic libraries on this machine and against a
//! small list we write ourselves (`resources/games.json`), and answers with
//! one game or `None`. The process list never leaves this module: only a
//! [`DetectedGame`] (the display name, where the name came from and when the
//! game started) crosses IPC, and process names are not logged.
//!
//! - Windows: a Toolhelp snapshot for the list, `QueryFullProcessImageNameW`
//!   with limited query rights for each path (what Task Manager uses, so
//!   anti-cheat is not bothered). A path the OS refuses (Microsoft Store
//!   games under `WindowsApps`) falls back to the program name alone.
//! - Linux: `/proc/<pid>/cmdline` and the `exe` link of processes owned by
//!   this user. A Proton game shows up as its Windows command line
//!   (`Z:\home\u\...\steamapps\common\Game\game.exe`), which normalises to the
//!   same path as a native one.
//! - Anything else: `None`.
//!
//! Matching, in priority order:
//! 1. A process whose path is inside an installed Steam or Epic game's folder
//!    (`<library>/steamapps/common/<installdir>/`), unless its name is a
//!    launcher, crash reporter or other helper ([`is_helper`]).
//! 2. A process matching an entry of the own list: the path tails of the
//!    process (`cs2.exe`, `win64/cs2.exe`, ...), also with `64`, `x64` and
//!    `_64` removed, equal one of the entry's `exe` strings, and the entry's
//!    optional `args` is a substring of the command line.
//!
//! With several candidates the one that started first wins, so the answer does
//! not flicker. The libraries are read once and again only when a scan finds a
//! process under a library's `steamapps/common/` folder it has not seen
//! before (a game installed while OwnCord runs). There is no file watching.

mod libraries;
#[cfg(target_os = "linux")]
mod proc_linux;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod win;

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use libraries::{GameDir, Libraries};

/// Where a detected game's name came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GameSource {
    Steam,
    Epic,
    List,
}

/// The running game, as the frontend sees it. Serialised in camelCase like the
/// other command structs: `{ name, source, startedAtMs }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGame {
    pub name: String,
    pub source: GameSource,
    /// Unix milliseconds the game's process started.
    pub started_at_ms: u64,
}

/// The game being played, or `None` when nothing recognised is running or the
/// OS cannot list processes. Read-only and argument-free; the frontend polls
/// it while the setting is on. `async` so the scan runs on a worker thread,
/// not the IPC main thread.
#[tauri::command(async)]
pub fn detect_game() -> Option<DetectedGame> {
    let procs = platform_processes()?;
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    detect_with(
        &procs,
        &mut state,
        libraries::load_installed,
        own_list(),
        current_os(),
    )
}

/// A process start time the OS would not give. It sorts after every known
/// start, and `detect_with` turns it into the start already shown for the same
/// game, or "now".
const UNKNOWN_START: u64 = u64::MAX;

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX - 1))
}

/// One running process, already normalised for matching.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Proc {
    /// Normalised executable path candidates: the command line's program and
    /// the OS-reported image path. Under Proton the first is the Windows path
    /// and the second is Wine's loader, so both are kept.
    paths: Vec<String>,
    /// The whole command line, lower-cased with `\` turned into `/`.
    cmdline: String,
    started_at_ms: u64,
}

impl Proc {
    fn new(raw_paths: &[&str], raw_cmdline: &str, started_at_ms: u64) -> Self {
        let mut paths: Vec<String> = Vec::new();
        for raw in raw_paths {
            let path = normalize_path(raw);
            if !path.is_empty() && !paths.contains(&path) {
                paths.push(path);
            }
        }
        Proc {
            paths,
            cmdline: normalize_cmdline(raw_cmdline),
            started_at_ms,
        }
    }
}

/// Lower-case, `\` -> `/`, and drop a leading drive (`z:`, `c:`) so a Proton
/// command line matches the Linux path it points at. Also drops a `\\?\`
/// prefix and Linux's ` (deleted)` suffix on a replaced binary.
fn normalize_path(raw: &str) -> String {
    let lower = raw
        .trim()
        .trim_matches('"')
        .to_lowercase()
        .replace('\\', "/");
    let s = lower.strip_suffix(" (deleted)").unwrap_or(&lower);
    let s = s.strip_prefix("//?/").unwrap_or(s);
    match s.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => s[2..].to_string(),
        _ => s.to_string(),
    }
}

fn normalize_cmdline(raw: &str) -> String {
    raw.to_lowercase().replace('\\', "/")
}

/// Last path segment.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Programs that live in a game's folder but are not the game, matched as
/// plain substrings of the lower-case file name. Each is specific enough that a
/// real game's name does not contain it.
const HELPER_SUBSTRINGS: &[&str] = &[
    "crashreport",
    "crash_report",
    "crashhandler",
    "crash_handler",
    "crashpad",
    "crashsender",
    "crashmonitor",
    "unins",
    "vc_redist",
    "easyanticheat",
    "battleye",
    "dotnet",
    "directx",
    "dxsetup",
    "ue4prereq",
    "steamwebhelper",
    "steamerrorreporter",
    "unrealcefsubprocess",
    "bssndrpt",
    "qtwebengineprocess",
    "cefsharp.browsersubprocess",
];

/// Generic words that mark a helper only as a whole word of the file name
/// (`setup.exe`, `game_launcher.exe`, `BootstrapLauncher.exe`): the word must
/// end the name or be followed by a non-alphanumeric character. A game that
/// merely contains the letters inside a longer word is not dropped.
const HELPER_WORDS: &[&str] = &["launcher", "setup", "helper", "reporter", "redist"];

fn has_word(name: &str, word: &str) -> bool {
    name.match_indices(word).any(|(at, _)| {
        name[at + word.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric())
    })
}

/// Whether a program's file name (lower-case) is a helper, not the game.
fn is_helper(file_name: &str) -> bool {
    HELPER_SUBSTRINGS.iter().any(|m| file_name.contains(m))
        || HELPER_WORDS.iter().any(|w| has_word(file_name, w))
}

// -- the own list ------------------------------------------------------------

/// One entry of `resources/games.json`, lower-cased at load.
#[derive(Debug, Deserialize)]
struct ListEntry {
    name: String,
    exe: Vec<String>,
    args: Option<String>,
    os: Vec<String>,
}

const GAMES_JSON: &str = include_str!("../resources/games.json");

/// Parse a games list. Entries are lower-cased here so matching compares like
/// with like; a malformed file yields no entries rather than a panic.
fn parse_list(json: &str) -> Vec<ListEntry> {
    let mut entries: Vec<ListEntry> = serde_json::from_str(json).unwrap_or_default();
    for entry in &mut entries {
        for exe in &mut entry.exe {
            *exe = normalize_path(exe);
        }
        entry.args = entry.args.take().map(|a| a.to_lowercase());
    }
    entries
}

fn own_list() -> &'static [ListEntry] {
    static LIST: OnceLock<Vec<ListEntry>> = OnceLock::new();
    LIST.get_or_init(|| {
        let list = parse_list(GAMES_JSON);
        if list.is_empty() {
            log::warn!("game_activity: the bundled games list is empty or unreadable");
        }
        list
    })
}

fn current_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Every path tail of a normalised path (`cs2.exe`, `win64/cs2.exe`, ...),
/// plus each tail with `x64`, `_64` and `64` removed, the way Discord's arRPC
/// matches (`wow-64.exe` finds `wow.exe`).
fn path_tails(path: &str) -> HashSet<String> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut tails = HashSet::new();
    for start in (0..segments.len()).rev() {
        let tail = segments[start..].join("/");
        for strip in ["x64", "_64", "64"] {
            if tail.contains(strip) {
                tails.insert(tail.replace(strip, ""));
            }
        }
        tails.insert(tail);
    }
    tails
}

fn list_matches(entry: &ListEntry, tails: &HashSet<String>, cmdline: &str, os: &str) -> bool {
    entry.os.iter().any(|o| o == os)
        && entry.exe.iter().any(|exe| tails.contains(exe))
        && entry
            .args
            .as_ref()
            .is_none_or(|a| cmdline.contains(a.as_str()))
}

// -- scan state and selection --------------------------------------------------

/// The libraries read so far, and the unfamiliar `steamapps/common/` folders
/// that already caused one re-read (so a tool folder with no manifest costs
/// one re-read, not one per scan).
struct State {
    libs: Libraries,
    seen_unknown: HashSet<String>,
    /// The game reported by the last scan and the start time reported with it.
    /// While the same game keeps running the same start time is reused, so a
    /// process whose real start time the OS refused (reported as "now") does
    /// not move the answer on every poll.
    current: Option<(String, u64)>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// What one pass over the process list found.
struct Pick {
    game: Option<DetectedGame>,
    /// Folders under a library's `steamapps/common/` that no manifest explains.
    unknown_dirs: Vec<String>,
}

fn earliest(candidates: Vec<DetectedGame>) -> Option<DetectedGame> {
    candidates
        .into_iter()
        .min_by(|a, b| (a.started_at_ms, &a.name).cmp(&(b.started_at_ms, &b.name)))
}

fn pick(procs: &[Proc], libs: &Libraries, list: &[ListEntry], os: &str) -> Pick {
    let mut library_hits = Vec::new();
    let mut list_hits = Vec::new();
    let mut unknown_dirs = Vec::new();
    for proc in procs {
        let mut in_library = false;
        for path in &proc.paths {
            if let Some(dir) = libs.game_dir_of(path) {
                // A helper is skipped without claiming the process, so a
                // genuine game (or list match) is still found among the rest.
                if !is_helper(file_name(path)) {
                    in_library = true;
                    library_hits.push(detected(dir, proc));
                }
            } else if let Some(unknown) = libs.unknown_dir_of(path) {
                unknown_dirs.push(unknown);
            }
        }
        if in_library {
            continue;
        }
        let tails: HashSet<String> = proc.paths.iter().flat_map(|p| path_tails(p)).collect();
        if let Some(entry) = list
            .iter()
            .find(|e| list_matches(e, &tails, &proc.cmdline, os))
        {
            list_hits.push(DetectedGame {
                name: entry.name.clone(),
                source: GameSource::List,
                started_at_ms: proc.started_at_ms,
            });
        }
    }
    unknown_dirs.sort();
    unknown_dirs.dedup();
    Pick {
        game: earliest(library_hits).or_else(|| earliest(list_hits)),
        unknown_dirs,
    }
}

fn detected(dir: &GameDir, proc: &Proc) -> DetectedGame {
    DetectedGame {
        name: dir.name.clone(),
        source: dir.source,
        started_at_ms: proc.started_at_ms,
    }
}

/// One scan: load the libraries on first use, match, and when the processes
/// include a library folder not seen before, re-read the libraries once and
/// match again.
fn detect_with(
    procs: &[Proc],
    state: &mut Option<State>,
    load: impl Fn() -> Libraries,
    list: &[ListEntry],
    os: &str,
) -> Option<DetectedGame> {
    let st = state.get_or_insert_with(|| State {
        libs: load(),
        seen_unknown: HashSet::new(),
        current: None,
    });
    let first = pick(procs, &st.libs, list, os);
    let mut fresh = false;
    for dir in &first.unknown_dirs {
        fresh |= st.seen_unknown.insert(dir.clone());
    }
    let mut game = if fresh {
        st.libs = load();
        pick(procs, &st.libs, list, os).game
    } else {
        first.game
    };
    if let Some(game) = &mut game {
        // Only an unknown start borrows the one already shown, so a quick
        // restart of the same game still gets its own time.
        if game.started_at_ms == UNKNOWN_START {
            game.started_at_ms = match &st.current {
                Some((name, started)) if *name == game.name => *started,
                _ => unix_now_ms(),
            };
        }
        st.current = Some((game.name.clone(), game.started_at_ms));
    } else {
        st.current = None;
    }
    game
}

// -- platform process lists ------------------------------------------------------

#[cfg(windows)]
fn platform_processes() -> Option<Vec<Proc>> {
    win::processes()
}

#[cfg(target_os = "linux")]
fn platform_processes() -> Option<Vec<Proc>> {
    // SAFETY: geteuid and sysconf take no pointers; sysconf answers -1 for an
    // unknown name, which the fallback below handles.
    let (uid, ticks) = unsafe { (libc::geteuid(), libc::sysconf(libc::_SC_CLK_TCK)) };
    let ticks = u64::try_from(ticks).ok().filter(|t| *t > 0).unwrap_or(100);
    proc_linux::read_proc_tree(std::path::Path::new("/proc"), uid, ticks)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn platform_processes() -> Option<Vec<Proc>> {
    None
}

/// Windows FILETIME (100 ns ticks since 1601) as Unix milliseconds.
#[cfg(any(windows, test))]
fn filetime_to_unix_ms(filetime: u64) -> u64 {
    (filetime / 10_000).saturating_sub(11_644_473_600_000)
}
