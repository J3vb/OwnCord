// Tests plant fixture files directly: scratch trees, not stores.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use super::launchers::{
    battlenet_games, game_dirs, gog_games, heroic_roots, read_heroic, read_heroic_gog,
    read_legendary, RegKey,
};
use super::libraries::{GameDir, Libraries};
use super::tests::{proc_at, write, TempDir};
use super::wine::{
    is_launcher_exe, is_launcher_name, lutris_dirs, lutris_games, parse_lutris_config,
    parse_system_reg, prefix_candidates, read_lutris, read_prefix, LutrisConfig,
};
use super::*;

fn dirs(games: &[GameDir]) -> Vec<(String, GameSource, String)> {
    games
        .iter()
        .map(|g| (g.name.clone(), g.source, g.dir().to_string()))
        .collect()
}

fn names(games: &[GameDir]) -> Vec<&str> {
    let mut n: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    n.sort_unstable();
    n.dedup();
    n
}

fn key(path: &str, values: &[(&str, &str)]) -> RegKey {
    RegKey {
        path: path.to_string(),
        values: values
            .iter()
            .map(|(n, v)| ((*n).to_string(), (*v).to_string()))
            .collect(),
    }
}

/// The game a process path resolves to through `pick`, with its source.
fn resolve(libs: &Libraries, path: &str) -> Option<(String, GameSource)> {
    let procs = [proc_at(path, 1)];
    pick(&procs, libs, &[], &Prefs::default(), "linux")
        .game
        .map(|g| (g.name, g.source))
}

/// A Windows-style `Z:` command line for a Linux path.
fn z_path(linux: &Path, rest: &str) -> String {
    format!(
        "Z:{}\\{}",
        linux.display().to_string().replace('/', "\\"),
        rest
    )
}

// -- the drive_c alias helper -------------------------------------------------------

#[test]
fn a_windows_folder_in_a_prefix_gets_both_spellings() {
    let roots = vec!["/home/u/games/bnet".to_string()];
    let games = game_dirs(
        "Diablo IV",
        GameSource::Battlenet,
        r"C:\Program Files (x86)\Diablo IV",
        &roots,
    );
    let found: Vec<&str> = games.iter().map(GameDir::dir).collect();
    assert_eq!(
        found,
        [
            "/program files (x86)/diablo iv/",
            "/home/u/games/bnet/drive_c/program files (x86)/diablo iv/",
        ]
    );
}

#[test]
fn a_linux_folder_inside_drive_c_also_gets_the_windows_tail() {
    let games = game_dirs(
        "Game",
        GameSource::Lutris,
        "/home/u/Games/x/drive_c/Program Files/Game/",
        &[],
    );
    let found: Vec<&str> = games.iter().map(GameDir::dir).collect();
    assert_eq!(
        found,
        [
            "/home/u/games/x/drive_c/program files/game/",
            "/program files/game/",
        ]
    );
}

#[test]
fn a_plain_folder_gets_one_spelling_and_a_broad_one_none() {
    let plain = game_dirs("G", GameSource::Epic, "/home/u/Games/G", &[]);
    assert_eq!(plain.len(), 1);
    for broad in [
        "/usr/bin",
        "/home/u",
        "/home/u/",
        r"C:\Windows\System32",
        r"C:\Program Files (x86)",
        "/",
        "relative/dir",
        "",
    ] {
        assert!(
            game_dirs("G", GameSource::Epic, broad, &[]).is_empty(),
            "{broad}"
        );
    }
    assert!(game_dirs("  ", GameSource::Epic, "/home/u/g", &[]).is_empty());
    // A Z: path is a Linux path already: no prefix spelling is invented.
    let roots = vec!["/p".to_string()];
    let z = game_dirs("G", GameSource::Epic, r"Z:\home\u\games\g", &roots);
    assert_eq!(z.len(), 1);
}

// -- Heroic ----------------------------------------------------------------------------

const LEGENDARY: &str = r#"{
  "Sugar": { "title": "Rocket League", "install_path": "/home/u/Games/Heroic/Rocket League", "is_dlc": false },
  "Fortnite": { "title": "Fortnite", "install_path": "/home/u/Games/Heroic/Fortnite" },
  "DLC1": { "title": "Some DLC", "install_path": "/home/u/Games/Heroic/Dlc", "is_dlc": true },
  "NoTitle": { "title": " ", "install_path": "/home/u/Games/Heroic/X" },
  "NoPath": { "title": "Y", "install_path": "" },
  "Weird": null
}"#;

#[test]
fn heroic_legendary_gives_epic_games_and_skips_dlc() {
    let tmp = TempDir::new("legendary");
    let file = tmp.path().join("installed.json");
    write(&file, LEGENDARY);
    let games = read_legendary(&file);
    assert_eq!(
        dirs(&games),
        [
            (
                "Fortnite".to_string(),
                GameSource::Epic,
                "/home/u/games/heroic/fortnite/".to_string()
            ),
            (
                "Rocket League".to_string(),
                GameSource::Epic,
                "/home/u/games/heroic/rocket league/".to_string()
            ),
        ]
    );
}

#[test]
fn legendary_with_malformed_or_missing_json_is_empty() {
    let tmp = TempDir::new("legendary-bad");
    let file = tmp.path().join("installed.json");
    write(&file, "{ \"Sugar\": { \"title\": \"Rocket Lea");
    assert!(read_legendary(&file).is_empty());
    write(&file, "[1, 2]");
    assert!(read_legendary(&file).is_empty());
    assert!(read_legendary(&tmp.path().join("missing.json")).is_empty());
}

const HEROIC_GOG: &str = r#"{ "installed": [
  { "appName": "1207658930", "install_path": "/home/u/Games/Heroic/The Witcher 3", "is_dlc": false },
  { "appName": "999", "install_path": "/home/u/Games/Heroic/Some Old Game" },
  { "appName": "555", "install_path": "/home/u/Games/Heroic/Addon", "is_dlc": true }
] }"#;

#[test]
fn heroic_gog_takes_titles_from_the_library_files_else_the_folder_name() {
    let tmp = TempDir::new("heroic-gog");
    let root = tmp.path();
    write(&root.join("gog_store/installed.json"), HEROIC_GOG);
    write(
        &root.join("store_cache/gog_library.json"),
        r#"{ "games": [ { "app_name": "1207658930", "title": "The Witcher 3: Wild Hunt" } ] }"#,
    );
    let games = read_heroic_gog(root);
    assert_eq!(names(&games), ["Some Old Game", "The Witcher 3: Wild Hunt"]);
    assert!(games.iter().all(|g| g.source == GameSource::Gog));

    // The older library file is a fallback for what the cache lacks.
    write(
        &root.join("gog_store/library.json"),
        r#"{ "games": [ { "app_name": "999", "title": "Old Game Title" }, { "app_name": "1207658930", "title": "Stale" } ] }"#,
    );
    assert_eq!(
        names(&read_heroic_gog(root)),
        ["Old Game Title", "The Witcher 3: Wild Hunt"]
    );
}

#[test]
fn heroic_gog_without_library_files_uses_the_folder_name() {
    let tmp = TempDir::new("heroic-gog-nolib");
    write(&tmp.path().join("gog_store/installed.json"), HEROIC_GOG);
    assert_eq!(
        names(&read_heroic_gog(tmp.path())),
        ["Some Old Game", "The Witcher 3"]
    );
}

#[test]
fn heroic_roots_cover_native_flatpak_and_windows() {
    let roots = heroic_roots(Some(Path::new("/h")), Some(Path::new("/a")));
    assert_eq!(
        roots,
        [
            PathBuf::from("/h/.config/heroic"),
            PathBuf::from("/h/.var/app/com.heroicgameslauncher.hgl/config/heroic"),
            PathBuf::from("/a/heroic"),
        ]
    );
    assert!(heroic_roots(None, None).is_empty());
}

// -- system.reg ---------------------------------------------------------------------------

const SYSTEM_REG: &str = "WINE REGISTRY Version 2\n\
;; All keys relative to \\\\Machine\n\
\n\
[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Diablo IV] 1698765432\n\
#time=1da0c1f2b3c4d5e\n\
\"DisplayName\"=\"Diablo IV\"\n\
\"InstallLocation\"=\"C:\\\\Program Files (x86)\\\\Diablo IV\"\n\
\"Publisher\"=\"Blizzard Entertainment\"\n\
\"EstimatedSize\"=dword:00000000\n\
\"Blob\"=hex:01,02\n\
@=\"default\"\n\
\n\
[Software\\\\Unrelated\\\\Key] 1\n\
\"Ignored\"=\"yes\"\n\
\n\
[Software\\\\GOG.com\\\\Games\\\\empty] 1\n\
#time=1\n\
\n\
[Software\\\\GOG.com\\\\Games\\\\quoted] 2\n\
\"Say\"=\"he said \\\"hi\\\"\"\n\
\"Exp\"=str(2):\"%SystemRoot%\\\\x\"\n\
\"Accent\"=\"Caf\\x00e9\"\n";

#[test]
fn system_reg_parses_keys_strings_and_escapes() {
    let keys = parse_system_reg(SYSTEM_REG);
    assert_eq!(keys.len(), 3);
    assert_eq!(
        keys[0].path,
        r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Diablo IV"
    );
    // Only the three string values: dword, hex and @ are ignored.
    assert_eq!(
        keys[0].values,
        [
            ("DisplayName".to_string(), "Diablo IV".to_string()),
            (
                "InstallLocation".to_string(),
                r"C:\Program Files (x86)\Diablo IV".to_string()
            ),
            (
                "Publisher".to_string(),
                "Blizzard Entertainment".to_string()
            ),
        ]
    );
    assert_eq!(keys[1].path, r"Software\GOG.com\Games\empty");
    assert!(keys[1].values.is_empty());
    let quoted = &keys[2].values;
    assert_eq!(quoted[0].1, r#"he said "hi""#);
    assert_eq!(quoted[1].1, r"%SystemRoot%\x");
    assert_eq!(quoted[2].1, "Café");
}

#[test]
fn system_reg_garbage_and_truncation_do_not_panic() {
    assert!(parse_system_reg("").is_empty());
    assert!(parse_system_reg("\"orphan\"=\"value\"\n[unclosed\n").is_empty());
    let cut = &SYSTEM_REG[..SYSTEM_REG.find("\"InstallLocation\"").unwrap() + 20];
    let keys = parse_system_reg(cut);
    assert_eq!(keys.len(), 1);
    assert!(battlenet_games(&keys, &[]).is_empty());
}

// -- gog_games and battlenet_games ----------------------------------------------------------

#[test]
fn gog_keys_give_games_in_either_view_and_any_case() {
    let keys = [
        key(
            r"Software\Wow6432Node\GOG.com\Games\1207658930",
            &[
                ("gameName", "The Witcher 3"),
                ("path", r"C:\GOG Games\Witcher 3"),
            ],
        ),
        key(
            r"SOFTWARE\gog.com\games\42",
            &[
                ("GAMENAME", "Cyberpunk 2077"),
                ("PATH", r"D:\GOG Games\Cyberpunk"),
            ],
        ),
        key(r"Software\GOG.com\Games\7", &[("gameName", "No path")]),
        key(
            r"Software\GOG.com\Games\1207658930\ver",
            &[("gameName", "Sub"), ("path", r"C:\Sub")],
        ),
        key(
            r"Software\GOG.com",
            &[("gameName", "Parent"), ("path", r"C:\P")],
        ),
    ];
    let games = gog_games(&keys, &[]);
    assert_eq!(names(&games), ["Cyberpunk 2077", "The Witcher 3"]);
    assert!(games.iter().all(|g| g.source == GameSource::Gog));
    assert!(games.iter().any(|g| g.dir() == "/gog games/cyberpunk/"));
}

fn uninstall(name: &str, values: &[(&str, &str)]) -> RegKey {
    key(
        &format!(r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{name}"),
        values,
    )
}

#[test]
fn battlenet_keys_keep_blizzard_games_and_skip_the_app_and_others() {
    let keys = [
        uninstall(
            "Diablo IV",
            &[
                ("DisplayName", "Diablo IV"),
                ("InstallLocation", r"C:\Program Files (x86)\Diablo IV"),
                ("Publisher", "Blizzard Entertainment"),
            ],
        ),
        uninstall(
            "Call of Duty",
            &[
                ("DisplayName", "Call of Duty"),
                ("InstallLocation", r"D:\Games\Call of Duty"),
                ("Publisher", "Activision"),
                (
                    "UninstallString",
                    r#""C:\ProgramData\Battle.net\Agent\Blizzard Uninstaller.exe" --lang=enUS"#,
                ),
            ],
        ),
        uninstall(
            "Battle.net",
            &[
                ("DisplayName", "Battle.net"),
                ("InstallLocation", r"C:\Program Files (x86)\Battle.net"),
                ("Publisher", "Blizzard Entertainment"),
            ],
        ),
        uninstall(
            "Battle.net renamed",
            &[
                ("DisplayName", "Blizzard App"),
                ("InstallLocation", r"C:\Program Files (x86)\Battle.net\"),
                ("Publisher", "Blizzard Entertainment"),
            ],
        ),
        uninstall(
            "Firefox",
            &[
                ("DisplayName", "Firefox"),
                ("InstallLocation", r"C:\Program Files\Mozilla Firefox"),
                ("Publisher", "Mozilla"),
            ],
        ),
        uninstall(
            "NoLocation",
            &[("DisplayName", "X"), ("Publisher", "Blizzard")],
        ),
    ];
    let games = battlenet_games(&keys, &[]);
    assert_eq!(names(&games), ["Call of Duty", "Diablo IV"]);
    assert!(games.iter().all(|g| g.source == GameSource::Battlenet));
}

// -- Lutris ----------------------------------------------------------------------------------

const LUTRIS_YML: &str = r"name: Hades II
slug: hades-ii
game:
  exe: /home/u/Games/hades2/drive_c/Games/Hades II/Hades2.exe
  prefix: /home/u/Games/hades2
  working_dir: '/home/u/Games/hades2/drive_c/Games/Hades II/Ship'
wine:
  exe: ignored.exe
";

#[test]
fn lutris_config_reads_name_and_game_block_with_quotes() {
    let config = parse_lutris_config(LUTRIS_YML);
    assert_eq!(config.name.as_deref(), Some("Hades II"));
    assert_eq!(
        config.exe.as_deref(),
        Some("/home/u/Games/hades2/drive_c/Games/Hades II/Hades2.exe")
    );
    assert_eq!(config.prefix.as_deref(), Some("/home/u/Games/hades2"));
    assert_eq!(
        config.working_dir.as_deref(),
        Some("/home/u/Games/hades2/drive_c/Games/Hades II/Ship")
    );
    let quoted = parse_lutris_config(
        "name: \"Say \\\"hi\\\"\"\ngame:\n    exe: 'it''s.exe'\n    other:\n      exe: nested.exe\n",
    );
    assert_eq!(quoted.name.as_deref(), Some("Say \"hi\""));
    assert_eq!(quoted.exe.as_deref(), Some("it's.exe"));
}

#[test]
fn lutris_game_uses_the_exe_folder_and_the_working_dir_with_the_drive_alias() {
    let home = Path::new("/home/u");
    let config = parse_lutris_config(LUTRIS_YML);
    let found: Vec<String> = lutris_games(&config, home)
        .iter()
        .map(|g| g.dir().to_string())
        .collect();
    assert_eq!(
        found,
        [
            "/home/u/games/hades2/drive_c/games/hades ii/",
            "/games/hades ii/",
            "/home/u/games/hades2/drive_c/games/hades ii/ship/",
            "/games/hades ii/ship/",
        ]
    );
    // The game's own exe resolves, in both the Linux and the C: spelling,
    // although working_dir is a sibling folder.
    for exe in [
        "/home/u/Games/hades2/drive_c/Games/Hades II/Hades2.exe",
        r"C:\Games\Hades II\Hades2.exe",
    ] {
        let path = normalize_path(exe);
        assert!(
            found.iter().any(|dir| path.starts_with(dir.as_str())),
            "{exe}"
        );
    }
    let no_working = LutrisConfig {
        working_dir: None,
        ..parse_lutris_config(LUTRIS_YML)
    };
    let games = lutris_games(&no_working, home);
    assert_eq!(
        games[0].dir(),
        "/home/u/games/hades2/drive_c/games/hades ii/"
    );
    assert_eq!(games[0].source, GameSource::Lutris);
}

#[test]
fn lutris_without_a_name_has_no_game_but_its_prefix_is_still_read() {
    let tmp = TempDir::new("lutris-noname");
    let home = tmp.path();
    let dir = home.join(".local/share/lutris/games");
    write(
        &dir.join("a.yml"),
        "game:\n  exe: /home/u/x/a.exe\n  prefix: ~/pfx\n",
    );
    write(&dir.join("notes.txt"), "name: Not A Config\n");
    let (games, prefixes) = read_lutris(&lutris_dirs(home), home);
    assert!(games.is_empty());
    assert_eq!(prefixes, [home.join("pfx")]);
}

#[test]
fn lutris_launcher_entries_are_not_games() {
    let home = Path::new("/home/u");
    for (name, exe) in [
        (
            "Battle.net",
            "/home/u/p/drive_c/Program Files (x86)/Battle.net/Battle.net.exe",
        ),
        ("My Store", "/home/u/p/drive_c/Epic/EpicGamesLauncher.exe"),
        ("GOG Galaxy", "/home/u/p/drive_c/GOG/GalaxyClient.exe"),
        ("Game", "/home/u/p/drive_c/Ubisoft/UbisoftConnect.exe"),
        ("EA app", "/home/u/p/drive_c/EA/EADesktop.exe"),
        ("Real Game", "/home/u/p/drive_c/Steam.exe"),
    ] {
        let config = LutrisConfig {
            name: Some(name.to_string()),
            exe: Some(exe.to_string()),
            ..LutrisConfig::default()
        };
        assert!(lutris_games(&config, home).is_empty(), "{name}");
    }
    assert!(is_launcher_name("Ubisoft Connect"));
    assert!(is_launcher_name("Battle.net Launcher"));
    assert!(is_launcher_name("Steam"));
    assert!(!is_launcher_name("Idea App"));
    assert!(!is_launcher_name("Steam Circus"));
    assert!(!is_launcher_name("Originality"));
    assert!(is_launcher_exe("EpicGamesLauncher.exe"));
    assert!(!is_launcher_exe("Hades2.exe"));
    assert!(!is_launcher_exe("ea app.exe.bak"));
}

// -- Wine prefixes ------------------------------------------------------------------------------

const EPIC_ITEM: &str = r#"{
  "DisplayName": "Rocket League",
  "InstallLocation": "C:\\Program Files\\Epic Games\\rocketleague",
  "AppCategories": ["public", "games", "applications"],
  "bIsIncompleteInstall": false
}"#;

const BNET_REG: &str = "WINE REGISTRY Version 2\n\
\n\
[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Diablo IV] 1\n\
\"DisplayName\"=\"Diablo IV\"\n\
\"InstallLocation\"=\"C:\\\\Program Files (x86)\\\\Diablo IV\"\n\
\"Publisher\"=\"Blizzard Entertainment\"\n\
\n\
[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Battle.net] 1\n\
\"DisplayName\"=\"Battle.net\"\n\
\"InstallLocation\"=\"C:\\\\Program Files (x86)\\\\Battle.net\"\n\
\"Publisher\"=\"Blizzard Entertainment\"\n\
\n\
[Software\\\\Wow6432Node\\\\GOG.com\\\\Games\\\\1] 1\n\
\"gameName\"=\"The Witcher 3\"\n\
\"path\"=\"C:\\\\GOG Games\\\\Witcher 3\"\n";

/// A prefix at `<base>/Games/bnet` with an Epic manifest and a `system.reg`.
fn make_prefix(base: &Path) -> PathBuf {
    let prefix = base.join("Games/bnet");
    write(
        &prefix.join("drive_c/ProgramData/Epic/EpicGamesLauncher/Data/Manifests/A.item"),
        EPIC_ITEM,
    );
    write(&prefix.join("system.reg"), BNET_REG);
    prefix
}

#[test]
fn a_prefix_gives_epic_gog_and_battlenet_games_in_both_path_forms() {
    let tmp = TempDir::new("prefix");
    let prefix = make_prefix(tmp.path());
    let games = read_prefix(&prefix);
    assert_eq!(
        names(&games),
        ["Diablo IV", "Rocket League", "The Witcher 3"]
    );
    let linux = format!("{}/drive_c/program files (x86)/diablo iv/", norm(&prefix));
    assert!(games.iter().any(|g| g.dir() == linux), "{linux}");
    assert!(games
        .iter()
        .any(|g| g.dir() == "/program files (x86)/diablo iv/"));
    let sources: Vec<GameSource> = games
        .iter()
        .filter(|g| g.name == "Diablo IV")
        .map(|g| g.source)
        .collect();
    assert_eq!(sources, [GameSource::Battlenet, GameSource::Battlenet]);
}

fn norm(path: &Path) -> String {
    normalize_path(&path.to_string_lossy())
}

#[test]
fn both_wine_path_forms_of_a_process_resolve_to_the_game() {
    let tmp = TempDir::new("prefix-pick");
    let prefix = make_prefix(tmp.path());
    let mut libs = Libraries::default();
    libs.extend_games(read_prefix(&prefix));
    let windows_form = r"C:\Program Files (x86)\Diablo IV\Diablo IV.exe";
    let z_form = z_path(
        &prefix,
        r"drive_c\Program Files (x86)\Diablo IV\Diablo IV.exe",
    );
    for path in [windows_form.to_string(), z_form] {
        assert_eq!(
            resolve(&libs, &path),
            Some(("Diablo IV".to_string(), GameSource::Battlenet)),
            "{path}"
        );
    }
    let epic = z_path(
        &prefix,
        r"drive_c\Program Files\Epic Games\rocketleague\Binaries\Win64\RocketLeague.exe",
    );
    assert_eq!(
        resolve(&libs, &epic),
        Some(("Rocket League".to_string(), GameSource::Epic))
    );
    // The Battle.net app itself is never a game.
    assert_eq!(
        resolve(&libs, r"C:\Program Files (x86)\Battle.net\Battle.net.exe"),
        None
    );
}

#[test]
fn prefix_candidates_dedupe_by_canonical_path_and_skip_non_prefixes() {
    let tmp = TempDir::new("candidates");
    let home = tmp.path();
    std::fs::create_dir_all(home.join(".wine/drive_c")).unwrap();
    std::fs::create_dir_all(home.join("Games/Heroic/Prefixes/default/Hades/drive_c")).unwrap();
    std::fs::create_dir_all(home.join("Games/Heroic/Prefixes/default/Plain")).unwrap();
    std::fs::create_dir_all(home.join(".local/share/bottles/bottles/b1/drive_c")).unwrap();
    write(
        &home.join("Games/proton/pfx/system.reg"),
        "WINE REGISTRY Version 2\n",
    );
    let extra = [
        home.join(".wine"),
        home.join("Games/proton"),
        home.join("Games/Heroic/Prefixes/default/Hades"),
        home.join("missing"),
    ];
    let found = prefix_candidates(home, &extra);
    assert_eq!(
        found,
        [
            home.join(".wine"),
            home.join("Games/proton/pfx"),
            home.join("Games/Heroic/Prefixes/default/Hades"),
            home.join(".local/share/bottles/bottles/b1"),
        ]
    );
}

#[test]
fn prefixes_are_capped_at_sixty_four() {
    let tmp = TempDir::new("cap");
    let home = tmp.path();
    for i in 0..80 {
        std::fs::create_dir_all(home.join(format!(".local/share/bottles/bottles/b{i:02}/drive_c")))
            .unwrap();
    }
    assert_eq!(prefix_candidates(home, &[]).len(), 64);
}

// -- one broken reader never hides the others (pre-flight edge case 1) --------------------------------

#[test]
fn truncated_files_yield_nothing_while_the_other_readers_still_load() {
    let tmp = TempDir::new("partial");
    let home = tmp.path();
    // Heroic: a half-written Legendary file next to a good GOG file.
    let heroic = home.join(".config/heroic");
    write(
        &heroic.join("legendaryConfig/legendary/installed.json"),
        &LEGENDARY[..60],
    );
    write(&heroic.join("gog_store/installed.json"), HEROIC_GOG);
    // Lutris: a good config. Prefix: a good Epic manifest, a cut system.reg.
    write(
        &home.join(".local/share/lutris/games/hades.yml"),
        LUTRIS_YML,
    );
    let prefix = home.join(".wine");
    write(
        &prefix.join("drive_c/ProgramData/Epic/EpicGamesLauncher/Data/Manifests/A.item"),
        &EPIC_ITEM.replace("Rocket League", "Celeste"),
    );
    write(
        &prefix.join("system.reg"),
        &BNET_REG[..BNET_REG.find("\"InstallLocation\"").unwrap() + 15],
    );
    assert!(read_legendary(&heroic.join("legendaryConfig/legendary/installed.json")).is_empty());
    let games = super::wine::read_linux(home, &heroic_roots(Some(home), None));
    let mut all = read_heroic(&heroic);
    all.extend(games);
    // Celeste (Epic prefix), Hades II (Lutris) and the Heroic GOG games load;
    // the cut Legendary file gave no Rocket League and the cut registry no
    // Diablo IV.
    assert_eq!(
        names(&all),
        ["Celeste", "Hades II", "Some Old Game", "The Witcher 3"]
    );
}

#[test]
fn a_prefix_drive_or_system_folder_claims_nothing() {
    let roots = vec!["/home/u/games/x".to_string()];
    for raw in [
        "/home/u/Games/x/drive_c",
        "/home/u/Games/x/drive_c/",
        "/home/u/Games/x/drive_c/Program Files (x86)",
        "/home/u/Games/x/drive_c/Program Files",
        "/home/u/Games/x/drive_c/windows/system32",
    ] {
        assert!(
            game_dirs("G", GameSource::Lutris, raw, &roots).is_empty(),
            "{raw}"
        );
    }
    // A game inside the same prefix is fine.
    assert_eq!(
        game_dirs(
            "G",
            GameSource::Lutris,
            "/home/u/Games/x/drive_c/Games2/G",
            &roots
        )
        .len(),
        2
    );
}

#[test]
fn container_folders_are_not_one_games_folder() {
    for raw in [
        "/home/u/Games",
        "/home/u/.local/share",
        "/home/u/Downloads",
        "/home/u/Games/Heroic",
        "/home/u/Games/Heroic/Prefixes",
        "/mnt/disk",
        "/mnt",
        "/run/media/u/disk",
        "/media/u",
        "/srv",
        "/opt/games",
        "/data/steamapps/common",
        "/data/Documents",
    ] {
        assert!(
            game_dirs("G", GameSource::Lutris, raw, &[]).is_empty(),
            "{raw}"
        );
    }
    for raw in [
        "/home/u/Games/foo",
        "/mnt/disk/foo",
        "/run/media/u/disk/foo",
        "/opt/foo",
        "/home/u/.local/share/foo/bar",
    ] {
        assert_eq!(
            game_dirs("G", GameSource::Lutris, raw, &[]).len(),
            1,
            "{raw}"
        );
    }
}

#[test]
fn extend_games_skips_games_already_known() {
    let mut libs = Libraries::default();
    let game = GameDir::new("G", GameSource::Gog, "/g/".to_string());
    libs.extend_games([game.clone(), game.clone()]);
    libs.extend_games([game]);
    assert_eq!(libs.games().len(), 1);
}

#[test]
fn new_sources_serialise_lowercase() {
    for (source, text) in [
        (GameSource::Gog, "\"gog\""),
        (GameSource::Battlenet, "\"battlenet\""),
        (GameSource::Lutris, "\"lutris\""),
    ] {
        assert_eq!(serde_json::to_string(&source).unwrap(), text);
    }
}
