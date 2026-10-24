//! Installed-game libraries: what the launchers say is on this machine.
//!
//! Steam and Epic (Windows) are read here; Heroic, GOG Galaxy, Battle.net,
//! Lutris and Wine prefixes are read by `launchers.rs` and `wine.rs`. Each
//! launcher keeps one small file per installed game with its display name and
//! install folder. The readers are pure functions over a root path so tests run
//! them over fixture files; only [`load_installed`] (and the launcher loader it
//! calls) knows where the launchers live on this OS.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{normalize_path, GameSource};

/// An installed game: its display name and its folder, normalised
/// (`normalize_path`) and ending in `/` so a prefix test is a folder test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GameDir {
    pub name: String,
    pub source: GameSource,
    pub(super) dir: String,
}

impl GameDir {
    /// A game whose already-normalised folder `dir` ends in `/`.
    pub(super) fn new(name: &str, source: GameSource, dir: String) -> Self {
        GameDir {
            name: name.to_string(),
            source,
            dir,
        }
    }

    #[cfg(test)]
    pub(super) fn dir(&self) -> &str {
        &self.dir
    }
}

/// Everything read from the launchers.
#[derive(Debug, Default)]
pub(super) struct Libraries {
    games: Vec<GameDir>,
    /// Normalised `<library>/steamapps/common/` folders, each ending in `/`.
    common_roots: Vec<String>,
}

impl Libraries {
    /// The installed game whose folder contains this normalised path.
    pub(super) fn game_dir_of(&self, path: &str) -> Option<&GameDir> {
        self.games.iter().find(|g| path.starts_with(&g.dir))
    }

    /// The `steamapps/common/<folder>/` this path is under when no manifest
    /// explains the folder (a game installed since the libraries were read, or
    /// a tool such as Proton). `None` for a path outside every library.
    pub(super) fn unknown_dir_of(&self, path: &str) -> Option<String> {
        let root = self.common_roots.iter().find(|r| path.starts_with(*r))?;
        let folder = path[root.len()..]
            .split('/')
            .next()
            .filter(|f| !f.is_empty())?;
        Some(format!("{root}{folder}/"))
    }

    /// Add games read by another launcher reader, skipping any already known.
    pub(super) fn extend_games(&mut self, games: impl IntoIterator<Item = GameDir>) {
        for game in games {
            if !self.games.contains(&game) {
                self.games.push(game);
            }
        }
    }

    #[cfg(test)]
    pub(super) fn push_game_for_test(&mut self, game: GameDir) {
        self.games.push(game);
    }

    #[cfg(test)]
    pub(super) fn games(&self) -> &[GameDir] {
        &self.games
    }
}

// -- VDF (Valve key/value text) -------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Vdf {
    Str(String),
    Map(Vec<(String, Vdf)>),
}

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Str(String),
    Open,
    Close,
}

fn tokenize(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' => tokens.push(Token::Open),
            '}' => tokens.push(Token::Close),
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(other) => s.push(other),
                            None => break,
                        },
                        other => s.push(other),
                    }
                }
                tokens.push(Token::Str(s));
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {}
            c => {
                // Unquoted token: runs to whitespace, a brace or a quote.
                let mut s = String::from(c);
                while let Some(&next) = chars.peek() {
                    if next.is_whitespace() || matches!(next, '{' | '}' | '"') {
                        break;
                    }
                    s.push(next);
                    chars.next();
                }
                tokens.push(Token::Str(s));
            }
        }
    }
    tokens
}

fn parse_map(tokens: &mut std::iter::Peekable<std::vec::IntoIter<Token>>) -> Vec<(String, Vdf)> {
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        match token {
            Token::Close => break,
            Token::Open => {}
            Token::Str(key) => match tokens.next() {
                Some(Token::Str(value)) => entries.push((key, Vdf::Str(value))),
                Some(Token::Open) => entries.push((key, Vdf::Map(parse_map(tokens)))),
                Some(Token::Close) | None => break,
            },
        }
    }
    entries
}

/// Parse VDF text into its top-level entries. Lenient: an unbalanced file
/// yields what was read before the break.
pub(super) fn parse_vdf(text: &str) -> Vec<(String, Vdf)> {
    parse_map(&mut tokenize(text).into_iter().peekable())
}

fn get<'a>(map: &'a [(String, Vdf)], key: &str) -> Option<&'a Vdf> {
    map.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v)
}

fn get_str<'a>(map: &'a [(String, Vdf)], key: &str) -> Option<&'a str> {
    match get(map, key)? {
        Vdf::Str(s) => Some(s),
        Vdf::Map(_) => None,
    }
}

// -- Steam ----------------------------------------------------------------------------

/// Library folders listed by `steamapps/libraryfolders.vdf`, in both layouts:
/// the current `"0" { "path" "..." }` and the old `"1" "D:\\Games"`.
pub(super) fn steam_library_paths(vdf: &str) -> Vec<String> {
    let top = parse_vdf(vdf);
    let Some(Vdf::Map(folders)) = get(&top, "libraryfolders") else {
        return Vec::new();
    };
    folders
        .iter()
        .filter(|(key, _)| !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|(_, value)| match value {
            Vdf::Str(path) => Some(path.clone()),
            Vdf::Map(entry) => get_str(entry, "path").map(str::to_string),
        })
        .filter(|path| !path.is_empty())
        .collect()
}

/// `(name, installdir)` from an `appmanifest_<appid>.acf`.
pub(super) fn parse_app_manifest(acf: &str) -> Option<(String, String)> {
    let top = parse_vdf(acf);
    let Some(Vdf::Map(state)) = get(&top, "appstate") else {
        return None;
    };
    let name = get_str(state, "name")?.trim();
    let installdir = get_str(state, "installdir")?.trim();
    if name.is_empty() || installdir.is_empty() {
        return None;
    }
    Some((name.to_string(), installdir.to_string()))
}

/// Steam's own runtimes and SDK folders sit in `steamapps/common/` beside the
/// games but are not games.
fn is_steam_tool(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["proton", "steam linux runtime", "steamworks"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// Steam apps that run in the background or beside a game but are not the
/// game: wallpapers, upscalers, voice tools, creative software. Matched as
/// lower-case substrings of the manifest's name or install folder, so a
/// background app that started first cannot win over the game.
const STEAM_NON_GAMES: &[&str] = &[
    "wallpaper engine",
    "wallpaper_engine",
    "lossless scaling",
    "losslessscaling",
    "soundpad",
    "voicemod",
    "blender",
    "obs studio",
    "streamlabs",
    "vtube studio",
    "live2d",
    "aseprite",
    "krita",
    "dedicated server",
];

/// Whether a manifest is a non-game app (see [`STEAM_NON_GAMES`]).
pub(super) fn is_steam_non_game(name: &str, installdir: &str) -> bool {
    let (name, dir) = (name.to_lowercase(), installdir.to_lowercase());
    STEAM_NON_GAMES
        .iter()
        .any(|m| name.contains(m) || dir.contains(m))
}

/// Record `raw` as a Steam library: its canonical path is the identity and
/// every spelling seen (`~/.steam/steam` and `~/.local/share/Steam` are one
/// folder) becomes an alias a process path may use.
fn add_library(libs: &mut BTreeMap<PathBuf, BTreeSet<String>>, raw: &Path) {
    let Ok(canonical) = fs::canonicalize(raw) else {
        return;
    };
    if !canonical.join("steamapps").is_dir() {
        return;
    }
    let aliases = libs.entry(canonical.clone()).or_default();
    for spelling in [raw, canonical.as_path()] {
        let alias = normalize_path(&spelling.to_string_lossy());
        aliases.insert(alias.trim_end_matches('/').to_string());
    }
}

/// Read every Steam library reachable from the given Steam install folders.
pub(super) fn read_steam(roots: &[PathBuf]) -> Libraries {
    let mut libs = BTreeMap::new();
    for root in roots {
        add_library(&mut libs, root);
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        if let Ok(text) = fs::read_to_string(vdf) {
            for path in steam_library_paths(&text) {
                add_library(&mut libs, Path::new(&path));
            }
        }
    }
    let mut out = Libraries::default();
    for (canonical, aliases) in &libs {
        let manifests = read_manifests(&canonical.join("steamapps"));
        for alias in aliases {
            out.common_roots.push(format!("{alias}/steamapps/common/"));
            for (name, installdir) in &manifests {
                let folder = normalize_path(installdir);
                let folder = folder.trim_matches('/');
                if folder.is_empty() {
                    continue;
                }
                out.games.push(GameDir {
                    name: name.clone(),
                    source: GameSource::Steam,
                    dir: format!("{alias}/steamapps/common/{folder}/"),
                });
            }
        }
    }
    out
}

fn read_manifests(steamapps: &Path) -> Vec<(String, String)> {
    let Ok(entries) = fs::read_dir(steamapps) else {
        return Vec::new();
    };
    let mut manifests: Vec<(String, String)> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            name.starts_with("appmanifest_") && name.ends_with(".acf")
        })
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|text| parse_app_manifest(&text))
        .filter(|(name, dir)| !is_steam_tool(name) && !is_steam_non_game(name, dir))
        .collect();
    manifests.sort();
    manifests
}

/// Where Steam may be installed on Linux, under the given home folder: the
/// classic symlink, the XDG data dir and the Flatpak copy.
#[cfg(any(target_os = "linux", test))]
pub(super) fn linux_steam_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".steam/steam"),
        home.join(".local/share/Steam"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
    ]
}

fn steam_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut roots = Vec::new();
        roots.extend(super::win::steam_path_from_registry());
        roots.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
        roots
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("HOME")
            .map(|home| linux_steam_roots(Path::new(&home)))
            .unwrap_or_default()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Vec::new()
    }
}

// -- Epic -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct EpicItem {
    #[serde(rename = "DisplayName")]
    display_name: Option<String>,
    #[serde(rename = "InstallLocation")]
    install_location: Option<String>,
    #[serde(rename = "AppCategories")]
    app_categories: Option<Vec<String>>,
    #[serde(rename = "bIsIncompleteInstall")]
    incomplete: Option<bool>,
}

/// `(name, raw InstallLocation)` from an Epic `*.item` manifest, with the
/// location as written (a Windows path). `None` for an unreadable file, a
/// half-finished install, an entry that is not a game (Epic tags games with
/// the `games` category) or one with no usable install folder.
pub(super) fn parse_epic_raw(json: &str) -> Option<(String, String)> {
    let item: EpicItem = serde_json::from_str(json).ok()?;
    if item.incomplete == Some(true) {
        return None;
    }
    if let Some(categories) = &item.app_categories {
        if !categories.iter().any(|c| c.eq_ignore_ascii_case("games")) {
            return None;
        }
    }
    let name = item.display_name?.trim().to_string();
    let raw = item.install_location?;
    if name.is_empty() || normalize_path(&raw).trim_end_matches('/').is_empty() {
        return None;
    }
    Some((name, raw))
}

/// A game from an Epic `*.item` manifest (see [`parse_epic_raw`]).
pub(super) fn parse_epic_item(json: &str) -> Option<GameDir> {
    let (name, raw) = parse_epic_raw(json)?;
    let location = normalize_path(&raw);
    Some(GameDir {
        name,
        source: GameSource::Epic,
        dir: format!("{}/", location.trim_end_matches('/')),
    })
}

/// `(name, raw InstallLocation)` of every game in an Epic manifests folder,
/// sorted; an unreadable folder or file contributes nothing.
#[cfg(any(target_os = "linux", test))]
pub(super) fn read_epic_raw(manifests: &Path) -> Vec<(String, String)> {
    let Ok(entries) = fs::read_dir(manifests) else {
        return Vec::new();
    };
    let mut games: Vec<(String, String)> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("item"))
        })
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|text| parse_epic_raw(&text))
        .collect();
    games.sort();
    games
}

/// Every game in an Epic manifests folder.
pub(super) fn read_epic(manifests: &Path) -> Vec<GameDir> {
    let Ok(entries) = fs::read_dir(manifests) else {
        return Vec::new();
    };
    let mut games: Vec<GameDir> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("item"))
        })
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|text| parse_epic_item(&text))
        .collect();
    games.sort_by(|a, b| a.name.cmp(&b.name));
    games
}

/// The Epic launcher's manifests folder. Windows only: on Linux, Epic games
/// come through Heroic, Legendary or a Wine prefix (`launchers.rs`, `wine.rs`).
fn epic_manifest_dir() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let base = std::env::var_os("ProgramData")
        .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from);
    Some(base.join(r"Epic\EpicGamesLauncher\Data\Manifests"))
}

/// Read every library on this machine.
pub(super) fn load_installed() -> Libraries {
    let mut libs = read_steam(&steam_roots());
    if let Some(dir) = epic_manifest_dir() {
        libs.extend_games(read_epic(&dir));
    }
    libs.extend_games(super::launchers::load_launcher_games());
    libs
}
