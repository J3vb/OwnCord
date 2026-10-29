//! Linux-side launcher readers: Wine prefixes (where Epic, GOG Galaxy and
//! Battle.net run through Lutris, Heroic, Bottles or plain Wine), Lutris game
//! configs and standalone Legendary.
//!
//! Pure readers over a home folder or a prefix folder, like the rest of the
//! module; [`read_linux`] ties them together for `load_launcher_games`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::launchers::{
    game_dirs, is_game_registry_key, read_capped, read_legendary, registry_games, RegKey,
};
use super::libraries::{read_epic_raw, GameDir};
use super::{normalize_path, GameSource};

/// The most Wine prefixes scanned.
const MAX_PREFIXES: usize = 64;
/// The biggest `system.reg` read.
const MAX_REG_BYTES: u64 = 16 * 1024 * 1024;
/// The biggest Heroic or Lutris config file read.
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

// -- Wine registry ------------------------------------------------------------------

/// Decode a Wine registry string body: `\\` is `\`, `\"` is `"`, and `\xHHHH`
/// is one UTF-16 code unit (how Wine writes non-ASCII). Any other escape keeps
/// the character after the backslash.
fn unescape_reg(body: &str) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buf = [0u16; 2];
            units.extend_from_slice(c.encode_utf16(&mut buf));
            continue;
        }
        match chars.next() {
            Some('x') => {
                let mut digits = String::new();
                while digits.len() < 4 {
                    match chars.peek() {
                        Some(h) if h.is_ascii_hexdigit() => {
                            digits.push(*h);
                            chars.next();
                        }
                        _ => break,
                    }
                }
                if let Ok(unit) = u16::from_str_radix(&digits, 16) {
                    units.push(unit);
                }
            }
            Some(other) => {
                let mut buf = [0u16; 2];
                units.extend_from_slice(other.encode_utf16(&mut buf));
            }
            None => {}
        }
    }
    String::from_utf16_lossy(&units)
}

/// Split `"..."` off the front of `text`: the raw body (escapes intact) and
/// what follows the closing quote. `None` if `text` does not start with a quote
/// or the string never closes.
fn split_quoted(text: &str) -> Option<(&str, &str)> {
    let inner = text.strip_prefix('"')?;
    let mut escaped = false;
    for (at, c) in inner.char_indices() {
        match (escaped, c) {
            (true, _) => escaped = false,
            (false, '\\') => escaped = true,
            (false, '"') => return Some((&inner[..at], &inner[at + 1..])),
            _ => {}
        }
    }
    None
}

/// Parse Wine's `system.reg` text, keeping only the keys the GOG and Battle.net
/// readers use (see [`is_game_registry_key`]). Lenient: a key line is
/// `[path] timestamp` (`\\` is one `\`), a value line `"name"="text"` (or
/// `"name"=str(2):"text"` for an expandable string); `dword:`/`hex:` values, `@`
/// defaults, comments and anything unreadable are ignored, so a truncated file
/// yields the keys read before the cut.
pub(super) fn parse_system_reg(text: &str) -> Vec<RegKey> {
    let mut keys: Vec<RegKey> = Vec::new();
    // Whether the last key header was kept (its value lines are wanted).
    let mut open = false;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix('[') {
            open = false;
            if let Some(end) = rest.rfind(']') {
                let path = unescape_reg(&rest[..end]);
                if is_game_registry_key(&path) {
                    keys.push(RegKey {
                        path,
                        values: Vec::new(),
                    });
                    open = true;
                }
            }
            continue;
        }
        if !open {
            continue;
        }
        let Some(key) = keys.last_mut() else { continue };
        let Some((name, rest)) = split_quoted(line) else {
            continue;
        };
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = match rest.strip_prefix("str(") {
            Some(typed) => typed.split_once("):").map_or("", |(_, value)| value),
            None => rest,
        };
        if let Some((value, _)) = split_quoted(rest) {
            key.values.push((unescape_reg(name), unescape_reg(value)));
        }
    }
    keys
}

// -- Wine prefixes -------------------------------------------------------------------

/// Whether a folder looks like a Wine prefix.
fn is_prefix(dir: &Path) -> bool {
    dir.join("drive_c").is_dir() || dir.join("system.reg").is_file()
}

/// Subfolders of `dir`, sorted by name; empty when it cannot be read.
fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

/// The `winePrefix` of every game in Heroic's `GamesConfig/*.json`
/// (`{ "<appName>": { "winePrefix": "/path" } }`).
pub(super) fn heroic_wine_prefixes(heroic: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(heroic.join("GamesConfig"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .is_some_and(|x| x.eq_ignore_ascii_case("json"))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out = Vec::new();
    for file in files {
        let Some(text) = read_capped(&file, MAX_CONFIG_BYTES) else {
            continue;
        };
        let Ok(Value::Object(games)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        for game in games.values() {
            if let Some(prefix) = game.get("winePrefix").and_then(Value::as_str) {
                if !prefix.trim().is_empty() {
                    out.push(PathBuf::from(prefix.trim()));
                }
            }
        }
    }
    out
}

/// The Wine prefixes to scan: `~/.wine`, the `extra` ones the launchers' configs
/// named, Heroic's `~/Games/Heroic/Prefixes` and Bottles' folders. Only real
/// prefixes (a `drive_c` or `system.reg`; a Proton prefix is its `pfx` folder),
/// de-duplicated by canonical path, at most [`MAX_PREFIXES`].
pub(super) fn prefix_candidates(home: &Path, extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut raw: Vec<PathBuf> = vec![home.join(".wine")];
    raw.extend(extra.iter().cloned());
    for folder in [
        home.join("Games/Heroic/Prefixes"),
        home.join("Games/Heroic/Prefixes/default"),
        home.join(".local/share/bottles/bottles"),
        home.join(".var/app/com.usebottles.bottles/data/bottles/bottles"),
    ] {
        raw.extend(subfolders(&folder));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for candidate in raw {
        for dir in [candidate.clone(), candidate.join("pfx")] {
            if out.len() >= MAX_PREFIXES {
                return out;
            }
            if !is_prefix(&dir) {
                continue;
            }
            let Ok(canonical) = fs::canonicalize(&dir) else {
                continue;
            };
            if seen.insert(canonical) {
                out.push(dir);
            }
        }
    }
    out
}

/// The games in one Wine prefix: Epic manifests under `drive_c`, and GOG and
/// Battle.net keys from `system.reg`. Each game is given both its Windows path
/// (`C:\...`, what a Wine process's command line shows) and its Linux path
/// under the prefix. A part that cannot be read contributes nothing.
pub(super) fn read_prefix(prefix: &Path) -> Vec<GameDir> {
    let mut roots = vec![normalize_path(&prefix.to_string_lossy())];
    if let Ok(canonical) = fs::canonicalize(prefix) {
        roots.push(normalize_path(&canonical.to_string_lossy()));
    }
    roots = roots
        .into_iter()
        .map(|r| r.trim_end_matches('/').to_string())
        .filter(|r| !r.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let manifests = prefix.join("drive_c/ProgramData/Epic/EpicGamesLauncher/Data/Manifests");
    let mut games: Vec<GameDir> = read_epic_raw(&manifests)
        .iter()
        .flat_map(|(name, raw)| game_dirs(name, GameSource::Epic, raw, &roots))
        .collect();
    if let Some(text) = read_capped(&prefix.join("system.reg"), MAX_REG_BYTES) {
        games.extend(registry_games(&parse_system_reg(&text), &roots));
    }
    games
}

// -- Lutris ---------------------------------------------------------------------------

/// The parts of a Lutris game config this module reads.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct LutrisConfig {
    pub name: Option<String>,
    pub exe: Option<String>,
    pub prefix: Option<String>,
    pub working_dir: Option<String>,
}

/// A YAML scalar: single- or double-quoted, or plain (cut at ` #`).
fn yaml_scalar(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(inner) = raw.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    out.push('\'');
                    chars.next();
                } else {
                    break;
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if raw.starts_with('"') {
        return split_quoted(raw).map_or_else(String::new, |(body, _)| unescape_yaml(body));
    }
    raw.split(" #").next().unwrap_or("").trim().to_string()
}

/// Escapes in a double-quoted YAML string that matter for paths and titles.
fn unescape_yaml(body: &str) -> String {
    let mut out = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Read a Lutris `games/*.yml`: top-level `name:`, and `exe:`, `prefix:` and
/// `working_dir:` among the children of the top-level `game:` block. No YAML
/// library; anything else is ignored.
pub(super) fn parse_lutris_config(text: &str) -> LutrisConfig {
    let mut config = LutrisConfig::default();
    let mut in_game = false;
    let mut child_indent: Option<usize> = None;
    for line in text.lines() {
        let line = line.trim_end();
        let content = line.trim_start();
        if content.is_empty() || content.starts_with('#') {
            continue;
        }
        let indent = line.len() - content.len();
        let Some((key, value)) = content.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if indent == 0 {
            in_game = key == "game" && value.is_empty();
            child_indent = None;
            if key == "name" {
                config.name = Some(yaml_scalar(value)).filter(|n| !n.is_empty());
            }
        } else if in_game && *child_indent.get_or_insert(indent) == indent {
            let slot = match key {
                "exe" => &mut config.exe,
                "prefix" => &mut config.prefix,
                "working_dir" => &mut config.working_dir,
                _ => continue,
            };
            *slot = Some(yaml_scalar(value)).filter(|v| !v.is_empty());
        }
    }
    config
}

/// Executable file names (lower-case) of store launchers: their games are
/// found through the Wine prefix, and the launcher itself must never show as
/// "Playing".
const LAUNCHER_EXES: &[&str] = &[
    "battle.net.exe",
    "battle.net launcher.exe",
    "epicgameslauncher.exe",
    "galaxyclient.exe",
    "upc.exe",
    "ubisoftconnect.exe",
    "eadesktop.exe",
    "origin.exe",
    "riotclientservices.exe",
    "steam.exe",
    "rockstarlauncher.exe",
];

/// Launcher display names (lower-case) matched as the whole name or as its
/// first words (`Battle.net Launcher`), never as a substring of another word.
const LAUNCHER_NAME_PREFIXES: &[&str] = &[
    "battle.net",
    "epic games store",
    "epic games launcher",
    "gog galaxy",
    "ubisoft connect",
    "ea app",
    "ea desktop",
    "riot client",
    "rockstar games launcher",
];

/// Launcher display names matched only when the whole name is equal.
const LAUNCHER_NAME_EXACT: &[&str] = &["origin", "steam"];

/// Whether an executable's file name is a store launcher's.
pub(super) fn is_launcher_exe(file_name: &str) -> bool {
    LAUNCHER_EXES.contains(&file_name.trim().to_lowercase().as_str())
}

/// Whether a game's display name is a store launcher's.
pub(super) fn is_launcher_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    LAUNCHER_NAME_EXACT.contains(&lower.as_str())
        || LAUNCHER_NAME_PREFIXES.iter().any(|p| {
            lower
                .strip_prefix(p)
                .is_some_and(|rest| rest.chars().next().is_none_or(|c| !c.is_alphanumeric()))
        })
}

/// The folder part of a path in either separator style.
fn parent_of(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rfind(['/', '\\']).map(|at| &trimmed[..at])
}

/// The last segment of a path in either separator style.
fn file_of(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
}

/// Expand a leading `~/` against `home`.
fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// The direct game entry of a Lutris config: needs a `name` and an `exe`, and
/// is skipped for a store launcher. Its folder is `working_dir` or the exe's
/// folder.
pub(super) fn lutris_games(config: &LutrisConfig, home: &Path) -> Vec<GameDir> {
    let (Some(name), Some(exe)) = (&config.name, &config.exe) else {
        return Vec::new();
    };
    if is_launcher_exe(file_of(exe)) || is_launcher_name(name) {
        return Vec::new();
    }
    let roots: Vec<String> = config
        .prefix
        .iter()
        .map(|p| normalize_path(&expand_home(p, home).to_string_lossy()))
        .map(|p| p.trim_end_matches('/').to_string())
        .collect();
    // Matching compares executable paths, so the exe's own folder always
    // counts; a working_dir elsewhere (a sibling `Ship/`) is added beside it.
    let mut games = Vec::new();
    for dir in parent_of(exe)
        .into_iter()
        .chain(config.working_dir.as_deref())
    {
        for game in game_dirs(name, GameSource::Lutris, dir, &roots) {
            if !games.contains(&game) {
                games.push(game);
            }
        }
    }
    games
}

/// Every Lutris game config in the given folders: the direct games and the Wine
/// prefixes the configs name.
pub(super) fn read_lutris(dirs: &[PathBuf], home: &Path) -> (Vec<GameDir>, Vec<PathBuf>) {
    let mut games = Vec::new();
    let mut prefixes = Vec::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|x| {
                    x.eq_ignore_ascii_case("yml") || x.eq_ignore_ascii_case("yaml")
                })
            })
            .collect();
        files.sort();
        for file in files {
            let Some(text) = read_capped(&file, MAX_CONFIG_BYTES) else {
                continue;
            };
            let config = parse_lutris_config(&text);
            if let Some(prefix) = &config.prefix {
                prefixes.push(expand_home(prefix, home));
            }
            games.extend(lutris_games(&config, home));
        }
    }
    (games, prefixes)
}

/// Lutris's game-config folders under a home folder: native and Flatpak, data
/// and config.
pub(super) fn lutris_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/share/lutris/games"),
        home.join(".config/lutris/games"),
        home.join(".var/app/net.lutris.Lutris/data/lutris/games"),
        home.join(".var/app/net.lutris.Lutris/config/lutris/games"),
    ]
}

// -- everything on Linux -----------------------------------------------------------------

/// Standalone Legendary, Lutris games, and every Wine prefix those and Heroic
/// point at (plus the well-known prefix folders).
pub(super) fn read_linux(home: &Path, heroic_roots: &[PathBuf]) -> Vec<GameDir> {
    let mut games = read_legendary(&home.join(".config/legendary/installed.json"));
    let (lutris, mut prefixes) = read_lutris(&lutris_dirs(home), home);
    games.extend(lutris);
    for root in heroic_roots {
        prefixes.extend(heroic_wine_prefixes(root));
    }
    for prefix in prefix_candidates(home, &prefixes) {
        games.extend(read_prefix(&prefix));
    }
    games
}
