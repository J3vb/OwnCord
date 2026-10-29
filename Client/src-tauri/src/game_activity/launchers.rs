//! Games from the other launchers: Heroic (Epic through Legendary, and GOG),
//! GOG Galaxy and Battle.net (registry keys), and the Wine-side readers in
//! `wine.rs`.
//!
//! Like `libraries.rs`, every reader here is a pure function over a root path or
//! parsed text, so tests run them over fixture files. [`load_launcher_games`]
//! is the one place that knows where these launchers live on this OS, and a
//! reader that fails (missing file, bad JSON, unreadable folder) yields nothing
//! without touching the others.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::libraries::GameDir;
use super::{normalize_path, GameSource};

/// The biggest JSON file read from a launcher.
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;

/// A registry key and its string values, as read from the Windows registry or
/// parsed from a Wine `system.reg`. `path` has single backslashes and no hive
/// (`Software\GOG.com\Games\1207658930`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RegKey {
    pub path: String,
    pub values: Vec<(String, String)>,
}

impl RegKey {
    /// A string value by name, ignoring case; `None` when absent or blank.
    fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    }
}

/// A file's text if it is a regular file of at most `max` bytes. Invalid UTF-8
/// is replaced rather than refused (Wine registry files are not always clean).
pub(super) fn read_capped(path: &Path, max: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Folder names that hold many games or documents; a launcher entry pointing
/// at one would claim every program inside it.
const CONTAINER_NAMES: &[&str] = &[
    "games",
    "heroic",
    "lutris",
    "downloads",
    "desktop",
    "documents",
    "prefixes",
    "bottles",
    "steamapps",
    "common",
];

/// Folders that would match far too many processes if treated as one game's
/// folder: system folders, a user's home and its first levels (`/home/u`,
/// `/home/u/Games`, `/home/u/.local/share`), mount points and disks, and any
/// folder named like a container of games.
fn is_too_broad(dir: &str) -> bool {
    const EXACT: &[&str] = &[
        "",
        "/usr",
        "/usr/bin",
        "/usr/sbin",
        "/usr/lib",
        "/usr/share",
        "/usr/games",
        "/usr/local",
        "/usr/local/bin",
        "/bin",
        "/sbin",
        "/opt",
        "/etc",
        "/var",
        "/tmp",
        "/srv",
        "/windows",
        "/windows/system32",
        "/windows/syswow64",
        "/program files",
        "/program files (x86)",
        "/programdata",
    ];
    if EXACT.contains(&dir) {
        return true;
    }
    let segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    let broad_by_depth = match segments.as_slice() {
        // /home/<user> and one level below; two below when it is a dot folder.
        ["home" | "users", _user, below @ ..] => {
            below.len() <= 1 || (below.len() == 2 && below[0].starts_with('.'))
        }
        ["home" | "users" | "root" | "mnt" | "media" | "run", ..] => {
            // The bare roots, /mnt/<disk>, /media/<user>, /run/media/<u>/<disk>.
            match segments[0] {
                "mnt" | "media" => segments.len() <= 2,
                "run" => segments.len() <= 4,
                _ => segments.len() <= 1,
            }
        }
        _ => false,
    };
    broad_by_depth
        || segments
            .last()
            .is_some_and(|last| CONTAINER_NAMES.contains(last))
}

/// The `GameDir`s for one install folder, under every spelling a process may
/// show:
/// - the folder itself, as `normalize_path` spells it (a Wine game's Windows
///   command line `C:\X\Y` and a Proton `Z:\home\u\...` path both land here);
/// - for a `C:` folder found in a Wine prefix, `<prefix>/drive_c/x/y` (the
///   Linux path of the same folder, which Wine also shows as `Z:\...`), one
///   per prefix spelling in `prefix_roots` (normalised, no trailing `/`);
/// - for any spelling that contains `/drive_c/`, everything after it (that is
///   what `C:` maps to), so a Linux install path inside a prefix also matches
///   the Windows command line.
///
/// Empty for a blank name, a relative path or a folder too broad to be one game.
pub(super) fn game_dirs(
    name: &str,
    source: GameSource,
    raw_path: &str,
    prefix_roots: &[String],
) -> Vec<GameDir> {
    let name = name.trim();
    let folder = normalize_path(raw_path);
    let folder = folder.trim_end_matches('/');
    if name.is_empty() || !folder.starts_with('/') || is_too_broad(folder) {
        return Vec::new();
    }
    let on_c_drive = matches!(
        raw_path.trim().trim_matches('"').as_bytes(),
        [b'c' | b'C', b':', ..]
    );
    let mut spellings = vec![folder.to_string()];
    if on_c_drive {
        spellings.extend(
            prefix_roots
                .iter()
                .map(|root| format!("{root}/drive_c{folder}")),
        );
    }
    let mut aliases = Vec::new();
    for spelling in &spellings {
        let at = spelling.find("/drive_c/").or_else(|| {
            spelling
                .ends_with("/drive_c")
                .then(|| spelling.len() - "/drive_c".len())
        });
        if let Some(at) = at {
            let tail = &spelling[at + "/drive_c".len()..];
            // A folder that is a prefix's `C:` drive or a system folder on it
            // would claim every program in the prefix: refuse the entry.
            if is_too_broad(tail.trim_end_matches('/')) {
                return Vec::new();
            }
            aliases.push(tail.to_string());
        }
    }
    spellings.extend(aliases);
    let mut dirs: Vec<GameDir> = Vec::new();
    for spelling in spellings {
        let game = GameDir::new(name, source, format!("{}/", spelling.trim_end_matches('/')));
        if !dirs.contains(&game) {
            dirs.push(game);
        }
    }
    dirs
}

// -- Heroic and Legendary --------------------------------------------------------

/// Heroic's config folders under the given home (Linux, native and Flatpak)
/// and `%APPDATA%` (Windows); pass `None` for a place that does not apply.
pub(super) fn heroic_roots(home: Option<&Path>, appdata: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home {
        roots.push(home.join(".config/heroic"));
        roots.push(home.join(".var/app/com.heroicgameslauncher.hgl/config/heroic"));
    }
    if let Some(appdata) = appdata {
        roots.push(appdata.join("heroic"));
    }
    roots
}

/// A non-empty string field of a JSON object.
fn json_str<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    object
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The Epic games in a Legendary `installed.json`
/// (`{ "<appName>": { "title", "install_path", "is_dlc" } }`): Heroic's
/// `legendaryConfig/legendary/installed.json` and standalone Legendary's
/// `~/.config/legendary/installed.json` have the same shape. DLC and entries
/// without a title or folder are skipped; unreadable or malformed JSON yields
/// nothing.
pub(super) fn read_legendary(installed: &Path) -> Vec<GameDir> {
    let Some(text) = read_capped(installed, MAX_JSON_BYTES) else {
        return Vec::new();
    };
    let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let mut games: Vec<GameDir> = entries
        .values()
        .filter(|entry| entry.get("is_dlc").and_then(Value::as_bool) != Some(true))
        .filter_map(|entry| {
            let title = json_str(entry, "title")?;
            let path = json_str(entry, "install_path")?;
            Some(game_dirs(title, GameSource::Epic, path, &[]))
        })
        .flatten()
        .collect();
    games.sort_by(|a, b| (&a.name, &a.dir).cmp(&(&b.name, &b.dir)));
    games
}

/// `appName` to title from a Heroic GOG library cache (`{ "games": [ {
/// "app_name", "title" } ] }`); empty when the file is missing or malformed.
fn gog_titles(library: &Path) -> HashMap<String, String> {
    let Some(text) = read_capped(library, MAX_JSON_BYTES) else {
        return HashMap::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return HashMap::new();
    };
    let Some(games) = root.get("games").and_then(Value::as_array) else {
        return HashMap::new();
    };
    games
        .iter()
        .filter_map(|g| {
            Some((
                json_str(g, "app_name")?.to_string(),
                json_str(g, "title")?.to_string(),
            ))
        })
        .collect()
}

/// The last segment of a path in either separator style.
fn last_segment(path: &str) -> &str {
    path.trim()
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

/// The GOG games in Heroic's `gog_store/installed.json` (`{ "installed": [ {
/// "appName", "install_path", "is_dlc" } ] }`). The title comes from
/// `store_cache/gog_library.json`, else the older `gog_store/library.json`,
/// else the install folder's name. DLC is skipped; unreadable or malformed JSON
/// yields nothing.
pub(super) fn read_heroic_gog(heroic: &Path) -> Vec<GameDir> {
    let Some(text) = read_capped(&heroic.join("gog_store/installed.json"), MAX_JSON_BYTES) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(installed) = root.get("installed").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut titles = gog_titles(&heroic.join("gog_store/library.json"));
    titles.extend(gog_titles(&heroic.join("store_cache/gog_library.json")));
    let mut games: Vec<GameDir> = installed
        .iter()
        .filter(|entry| entry.get("is_dlc").and_then(Value::as_bool) != Some(true))
        .filter_map(|entry| {
            let path = json_str(entry, "install_path")?;
            let title = json_str(entry, "appName")
                .and_then(|app| titles.get(app))
                .map_or_else(|| last_segment(path), String::as_str);
            Some(game_dirs(title, GameSource::Gog, path, &[]))
        })
        .flatten()
        .collect();
    games.sort_by(|a, b| (&a.name, &a.dir).cmp(&(&b.name, &b.dir)));
    games
}

/// Every game Heroic knows about under one config folder.
pub(super) fn read_heroic(heroic: &Path) -> Vec<GameDir> {
    let mut games = read_legendary(&heroic.join("legendaryConfig/legendary/installed.json"));
    games.extend(read_heroic_gog(heroic));
    games
}

// -- GOG Galaxy and Battle.net registry keys -------------------------------------

/// The key name under `<parent>` when `path` is exactly one level below it,
/// matched case-insensitively and with or without `Wow6432Node` after
/// `Software`. `parent` has no `Software\` prefix.
/// Whether a key path is one `gog_games` or `battlenet_games` reads.
#[cfg(any(target_os = "linux", test))]
pub(super) fn is_game_registry_key(path: &str) -> bool {
    key_under(path, "GOG.com\\Games").is_some()
        || key_under(path, "Microsoft\\Windows\\CurrentVersion\\Uninstall").is_some()
}

fn key_under<'a>(path: &'a str, parent: &str) -> Option<&'a str> {
    let rest = strip_prefix_ignore_case(path, "software\\")?;
    let rest = strip_prefix_ignore_case(rest, "wow6432node\\").unwrap_or(rest);
    let name = strip_prefix_ignore_case(rest, parent)?;
    let name = name.strip_prefix('\\')?;
    (!name.is_empty() && !name.contains('\\')).then_some(name)
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// GOG Galaxy games from `Software\[Wow6432Node\]GOG.com\Games\<id>` keys, with
/// their `gameName` and `path` values.
pub(super) fn gog_games(keys: &[RegKey], prefix_roots: &[String]) -> Vec<GameDir> {
    keys.iter()
        .filter(|key| key_under(&key.path, "GOG.com\\Games").is_some())
        .filter_map(|key| {
            let name = key.value("gameName")?;
            let path = key.value("path")?;
            Some(game_dirs(name, GameSource::Gog, path, prefix_roots))
        })
        .flatten()
        .collect()
}

/// Whether an install location is the Battle.net app itself.
fn is_battlenet_app(display_name: &str, location: &str) -> bool {
    display_name.trim().eq_ignore_ascii_case("battle.net")
        || last_segment(location).eq_ignore_ascii_case("battle.net")
}

/// Games installed by Battle.net, from uninstall keys
/// (`Software\[Wow6432Node\]Microsoft\Windows\CurrentVersion\Uninstall\<k>`)
/// whose `Publisher` is Blizzard or whose `UninstallString` runs the Blizzard
/// uninstaller (Activision titles). The Battle.net app itself is left out: it
/// runs all the time and is not a game.
pub(super) fn battlenet_games(keys: &[RegKey], prefix_roots: &[String]) -> Vec<GameDir> {
    keys.iter()
        .filter(|key| {
            key_under(&key.path, "Microsoft\\Windows\\CurrentVersion\\Uninstall").is_some()
        })
        .filter(|key| {
            key.value("Publisher")
                .is_some_and(|p| p.to_lowercase().contains("blizzard"))
                || key
                    .value("UninstallString")
                    .is_some_and(|u| u.to_lowercase().contains("blizzard uninstaller"))
        })
        .filter_map(|key| {
            let name = key.value("DisplayName")?;
            let location = key.value("InstallLocation")?;
            if is_battlenet_app(name, location) {
                return None;
            }
            Some(game_dirs(
                name,
                GameSource::Battlenet,
                location,
                prefix_roots,
            ))
        })
        .flatten()
        .collect()
}

/// GOG and Battle.net games from a set of registry keys. `prefix_roots` are
/// the normalised Wine prefix folders the keys came from (none on Windows).
pub(super) fn registry_games(keys: &[RegKey], prefix_roots: &[String]) -> Vec<GameDir> {
    let mut games = gog_games(keys, prefix_roots);
    games.extend(battlenet_games(keys, prefix_roots));
    games
}

// -- the one loader ----------------------------------------------------------------

/// Read every launcher this module knows about on this machine.
pub(super) fn load_launcher_games() -> Vec<GameDir> {
    let mut games = Vec::new();
    let home = if cfg!(target_os = "linux") {
        std::env::var_os("HOME").map(PathBuf::from)
    } else {
        None
    };
    let appdata = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        None
    };
    let heroics = heroic_roots(home.as_deref(), appdata.as_deref());
    for root in &heroics {
        games.extend(read_heroic(root));
    }
    #[cfg(windows)]
    games.extend(registry_games(&super::win::registry_keys(), &[]));
    #[cfg(target_os = "linux")]
    if let Some(home) = &home {
        games.extend(super::wine::read_linux(home, &heroics));
    }
    games
}
