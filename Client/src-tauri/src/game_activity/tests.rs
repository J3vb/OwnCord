// Tests plant fixture files directly: scratch trees, not stores.
#![allow(clippy::disallowed_methods)]

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::libraries::{
    linux_steam_roots, parse_app_manifest, parse_epic_item, parse_vdf, read_epic, read_steam,
    steam_library_paths, Libraries, Vdf,
};
use super::*;

// -- fixtures --------------------------------------------------------------------

/// A temp directory removed on drop.
pub(super) struct TempDir(PathBuf);

impl TempDir {
    pub(super) fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "owncord-game-activity-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn acf(appid: u32, name: &str, installdir: &str) -> String {
    format!(
        "\"AppState\"\n{{\n\t\"appid\"\t\t\"{appid}\"\n\t\"Universe\"\t\t\"1\"\n\
         \t\"name\"\t\t\"{name}\"\n\t\"StateFlags\"\t\t\"4\"\n\
         \t\"installdir\"\t\t\"{installdir}\"\n}}\n"
    )
}

/// A path as VDF text spells it: backslashes doubled.
fn vdf_path(path: &Path) -> String {
    path.display().to_string().replace('\\', "\\\\")
}

/// Two Steam libraries: `<base>/steam` (the Steam root) and `<base>/games`
/// (a second library), with a Proton install the reader must skip.
fn steam_fixture(base: &Path) -> (PathBuf, PathBuf) {
    let root = base.join("steam");
    let second = base.join("games");
    let vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t\t\"label\"\t\t\"\"\n\
         \t\t\"apps\"\n\t\t{{\n\t\t\t\"1245620\"\t\t\"1\"\n\t\t}}\n\t}}\n\
         \t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}\n",
        vdf_path(&root),
        vdf_path(&second)
    );
    write(&root.join("steamapps/libraryfolders.vdf"), &vdf);
    write(
        &root.join("steamapps/appmanifest_1245620.acf"),
        &acf(1245620, "ELDEN RING", "ELDEN RING"),
    );
    write(
        &root.join("steamapps/appmanifest_1145360.acf"),
        &acf(1145360, "Hades", "Hades"),
    );
    write(
        &root.join("steamapps/appmanifest_2805730.acf"),
        &acf(2805730, "Proton 9.0", "Proton 9.0"),
    );
    write(
        &second.join("steamapps/appmanifest_367520.acf"),
        &acf(367520, "Hollow Knight", "Hollow Knight"),
    );
    write(
        &root.join("steamapps/appmanifest_431960.acf"),
        &acf(431960, "Wallpaper Engine", "wallpaper_engine"),
    );
    write(
        &second.join("steamapps/appmanifest_365670.acf"),
        &acf(365670, "Blender", "Blender"),
    );
    fs::create_dir_all(root.join("steamapps/common/ELDEN RING/Game")).unwrap();
    (root, second)
}

fn steam_libs(base: &Path) -> Libraries {
    let (root, _) = steam_fixture(base);
    read_steam(&[root])
}

/// Normalised spelling of a fixture path, as `Proc` paths are.
fn norm(path: &Path) -> String {
    normalize_path(&path.to_string_lossy())
}

pub(super) fn proc_at(path: &str, started_at_ms: u64) -> Proc {
    Proc::new(&[path], path, started_at_ms)
}

fn proc_cmd(path: &str, cmdline: &str, started_at_ms: u64) -> Proc {
    Proc::new(&[path], cmdline, started_at_ms)
}

fn list() -> Vec<ListEntry> {
    parse_list(GAMES_JSON)
}

fn names(libs: &Libraries) -> Vec<String> {
    let mut names: Vec<String> = libs.games().iter().map(|g| g.name.clone()).collect();
    names.sort();
    names.dedup();
    names
}

// -- normalisation -----------------------------------------------------------------

#[test]
fn proton_windows_paths_normalise_to_the_linux_path() {
    assert_eq!(
        normalize_path(
            r"Z:\home\u\.local\share\Steam\steamapps\common\Elden Ring\Game\eldenring.exe"
        ),
        "/home/u/.local/share/steam/steamapps/common/elden ring/game/eldenring.exe"
    );
    assert_eq!(
        normalize_path(r"C:\Program Files (x86)\Steam\steamapps\common\Hades\Hades.exe"),
        "/program files (x86)/steam/steamapps/common/hades/hades.exe"
    );
}

#[test]
fn normalise_strips_quotes_extended_prefix_and_deleted_suffix() {
    assert_eq!(normalize_path("\"D:\\Games\\a.exe\""), "/games/a.exe");
    assert_eq!(normalize_path(r"\\?\C:\Games\a.exe"), "/games/a.exe");
    assert_eq!(normalize_path("/usr/bin/game (deleted)"), "/usr/bin/game");
    assert_eq!(normalize_path("java"), "java");
}

#[test]
fn filetime_zero_point_is_the_unix_epoch() {
    assert_eq!(filetime_to_unix_ms(116_444_736_000_000_000), 0);
    assert_eq!(filetime_to_unix_ms(116_444_736_010_000_000), 1_000);
    assert_eq!(filetime_to_unix_ms(5), 0);
}

#[test]
fn detected_game_serialises_in_camel_case_with_a_lowercase_source() {
    let game = DetectedGame {
        name: "Hades".into(),
        source: GameSource::Steam,
        started_at_ms: 1_700_000_000_000,
    };
    assert_eq!(
        serde_json::to_string(&game).unwrap(),
        r#"{"name":"Hades","source":"steam","startedAtMs":1700000000000}"#
    );
    for (source, text) in [(GameSource::Epic, "epic"), (GameSource::List, "list")] {
        assert_eq!(
            serde_json::to_string(&source).unwrap(),
            format!("\"{text}\"")
        );
    }
}

// -- VDF and Steam -------------------------------------------------------------------

#[test]
fn vdf_reads_nested_maps_escapes_and_comments() {
    let text = "// a comment\n\"root\"\n{\n\t\"path\"\t\"C:\\\\Program Files\\\\Steam\"\n\
                \t\"inner\"\n\t{\n\t\t\"say\"\t\"a \\\"quote\\\"\"\n\t}\n\tbare value\n}\n";
    let top = parse_vdf(text);
    let Some((key, Vdf::Map(root))) = top.first() else {
        panic!("no root map: {top:?}");
    };
    assert_eq!(key, "root");
    assert_eq!(
        root[0],
        ("path".into(), Vdf::Str(r"C:\Program Files\Steam".into()))
    );
    assert_eq!(
        root[1],
        (
            "inner".into(),
            Vdf::Map(vec![("say".into(), Vdf::Str("a \"quote\"".into()))])
        )
    );
    assert_eq!(root[2], ("bare".into(), Vdf::Str("value".into())));
}

#[test]
fn vdf_with_a_missing_close_brace_keeps_what_was_read() {
    let top = parse_vdf("\"a\" { \"b\" \"c\"");
    assert_eq!(
        top,
        vec![(
            "a".into(),
            Vdf::Map(vec![("b".into(), Vdf::Str("c".into()))])
        )]
    );
}

#[test]
fn library_folders_lists_both_layouts_and_ignores_other_keys() {
    let current = "\"libraryfolders\" {\n \"0\" { \"path\" \"/home/u/.local/share/Steam\" }\n \
                   \"1\" { \"path\" \"/mnt/games/SteamLibrary\" \"label\" \"\" }\n \
                   \"contentstatsid\" \"123\" }";
    assert_eq!(
        steam_library_paths(current),
        ["/home/u/.local/share/Steam", "/mnt/games/SteamLibrary"]
    );
    let old = "\"LibraryFolders\" { \"TimeNextStatsReport\" \"99\" \"1\" \"D:\\\\Games\" }";
    assert_eq!(steam_library_paths(old), [r"D:\Games"]);
    assert!(steam_library_paths("not vdf").is_empty());
}

#[test]
fn app_manifest_gives_name_and_installdir() {
    assert_eq!(
        parse_app_manifest(&acf(1245620, "ELDEN RING", "ELDEN RING")),
        Some(("ELDEN RING".into(), "ELDEN RING".into()))
    );
    assert_eq!(parse_app_manifest("\"AppState\" { \"appid\" \"1\" }"), None);
    assert_eq!(parse_app_manifest(&acf(1, "", "x")), None);
    assert_eq!(parse_app_manifest("nonsense"), None);
}

#[test]
fn steam_reader_finds_both_libraries_and_skips_steam_tools() {
    let tmp = TempDir::new("steam");
    let libs = steam_libs(tmp.path());
    assert_eq!(names(&libs), ["ELDEN RING", "Hades", "Hollow Knight"]);
    let (root, second) = (tmp.path().join("steam"), tmp.path().join("games"));
    let dirs: Vec<&str> = libs.games().iter().map(|g| g.dir()).collect();
    for dir in [
        format!("{}/steamapps/common/elden ring/", norm(&root)),
        format!("{}/steamapps/common/hollow knight/", norm(&second)),
    ] {
        assert!(dirs.contains(&dir.as_str()), "{dir} not in {dirs:?}");
    }
}

#[test]
fn steam_reader_tolerates_missing_roots_and_files() {
    let tmp = TempDir::new("steam-missing");
    assert!(read_steam(&[tmp.path().join("nope")]).games().is_empty());
    fs::create_dir_all(tmp.path().join("steam/steamapps")).unwrap();
    assert!(read_steam(&[tmp.path().join("steam")]).games().is_empty());
}

#[cfg(unix)]
#[test]
fn a_symlinked_steam_root_is_one_library_that_matches_either_spelling() {
    let tmp = TempDir::new("steam-link");
    let (root, _) = steam_fixture(tmp.path());
    let link = tmp.path().join("dot-steam");
    std::os::unix::fs::symlink(&root, &link).unwrap();
    let libs = read_steam(&[link.clone(), root.clone()]);
    for base in [&root, &link] {
        let path = format!("{}/steamapps/common/hades/hades", norm(base));
        assert_eq!(
            libs.game_dir_of(&path).map(|g| g.name.as_str()),
            Some("Hades")
        );
    }
}

#[test]
fn linux_steam_roots_cover_native_and_flatpak() {
    let roots = linux_steam_roots(Path::new("/home/u"));
    assert_eq!(
        roots,
        [
            PathBuf::from("/home/u/.steam/steam"),
            PathBuf::from("/home/u/.local/share/Steam"),
            PathBuf::from("/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam"),
        ]
    );
}

#[test]
fn steam_background_apps_are_not_games_and_do_not_beat_the_game() {
    let tmp = TempDir::new("nongame");
    let libs = steam_libs(tmp.path());
    assert_eq!(names(&libs), ["ELDEN RING", "Hades", "Hollow Knight"]);
    for (name, dir) in [
        ("Lossless Scaling", "Lossless Scaling"),
        ("Soundpad", "Soundpad"),
        ("Voicemod", "Voicemod"),
        ("Wallpaper Engine", "wallpaper_engine"),
        ("Blender", "Blender"),
    ] {
        assert!(super::libraries::is_steam_non_game(name, dir), "{name}");
    }
    assert!(!super::libraries::is_steam_non_game("Hades", "Hades"));
    let root = norm(&tmp.path().join("steam"));
    let wallpaper = proc_at(
        &format!("{root}/steamapps/common/wallpaper_engine/wallpaper64.exe"),
        1,
    );
    let hades = proc_at(&format!("{root}/steamapps/common/hades/hades"), 9_000);
    let game = pick(&[wallpaper, hades], &libs, &[], &Prefs::default(), "linux")
        .game
        .unwrap();
    assert_eq!(game.name, "Hades");
}

#[test]
fn start_time_is_remembered_while_the_same_game_keeps_running() {
    let tmp = TempDir::new("firstseen");
    let (root, _) = steam_fixture(tmp.path());
    let root_norm = norm(&root);
    let load = || read_steam(std::slice::from_ref(&root));
    let path = format!("{root_norm}/steamapps/common/hades/hades");
    let mut state = None;
    let started = |state: &mut Option<State>, ms: u64| {
        detect_with(
            &[proc_at(&path, ms)],
            state,
            load,
            &[],
            &Prefs::default(),
            "linux",
        )
        .map(|g| g.started_at_ms)
    };
    assert_eq!(started(&mut state, 1_000), Some(1_000));
    // The OS later will not say when it started: the answer does not move.
    assert_eq!(started(&mut state, UNKNOWN_START), Some(1_000));
    assert_eq!(started(&mut state, UNKNOWN_START), Some(1_000));
    // A quick restart between two polls reports its own known start.
    assert_eq!(started(&mut state, 40_000), Some(40_000));
    // The game quits, then it starts again: its own time is used.
    assert_eq!(
        detect_with(&[], &mut state, load, &[], &Prefs::default(), "linux"),
        None
    );
    assert_eq!(started(&mut state, 50_000), Some(50_000));
    // First seen with no known start: "now", then kept.
    assert_eq!(
        detect_with(&[], &mut state, load, &[], &Prefs::default(), "linux"),
        None
    );
    let first = started(&mut state, UNKNOWN_START).unwrap();
    assert!(first > 50_000 && first < UNKNOWN_START);
    assert_eq!(started(&mut state, UNKNOWN_START), Some(first));
}

// -- Epic ---------------------------------------------------------------------------------

const EPIC_ITEM: &str = r#"{
  "FormatVersion": 0,
  "bIsIncompleteInstall": false,
  "AppCategories": ["public", "games", "applications"],
  "DisplayName": "Rocket League",
  "InstallLocation": "C:\\Program Files\\Epic Games\\rocketleague",
  "AppName": "Sugar"
}"#;

#[test]
fn epic_item_gives_display_name_and_folder() {
    let game = parse_epic_item(EPIC_ITEM).unwrap();
    assert_eq!(game.name, "Rocket League");
    assert_eq!(game.source, GameSource::Epic);
    assert_eq!(game.dir(), "/program files/epic games/rocketleague/");
}

#[test]
fn epic_item_skips_incomplete_installs_non_games_and_empty_folders() {
    let incomplete = EPIC_ITEM.replace(
        "\"bIsIncompleteInstall\": false",
        "\"bIsIncompleteInstall\": true",
    );
    assert_eq!(parse_epic_item(&incomplete), None);
    let tool = EPIC_ITEM.replace("\"games\", ", "");
    assert_eq!(parse_epic_item(&tool), None);
    let rootless = EPIC_ITEM.replace(r"C:\\Program Files\\Epic Games\\rocketleague", "C:\\\\");
    assert_eq!(parse_epic_item(&rootless), None);
    assert_eq!(parse_epic_item("{"), None);
    assert_eq!(parse_epic_item("{}"), None);
}

#[test]
fn epic_reader_reads_every_item_file() {
    let tmp = TempDir::new("epic");
    write(&tmp.path().join("A1.item"), EPIC_ITEM);
    write(
        &tmp.path().join("B2.item"),
        &EPIC_ITEM
            .replace("Rocket League", "Fortnite")
            .replace("rocketleague", "Fortnite"),
    );
    write(&tmp.path().join("readme.txt"), "not a manifest");
    let games = read_epic(tmp.path());
    let found: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(found, ["Fortnite", "Rocket League"]);
    assert!(read_epic(&tmp.path().join("missing")).is_empty());
}

// -- the own list ---------------------------------------------------------------------------

#[test]
fn bundled_list_is_well_formed() {
    let entries = list();
    assert!(entries.len() >= 50, "only {} entries", entries.len());
    let mut seen = HashSet::new();
    for entry in &entries {
        assert!(!entry.name.trim().is_empty());
        assert!(!entry.exe.is_empty(), "{} has no exe", entry.name);
        assert!(!entry.os.is_empty(), "{} has no os", entry.name);
        for os in &entry.os {
            assert!(["windows", "linux", "macos"].contains(&os.as_str()), "{os}");
        }
        for exe in &entry.exe {
            assert_eq!(
                exe,
                &normalize_path(exe),
                "{} exe not normalised",
                entry.name
            );
            assert!(!exe.is_empty());
        }
        assert!(
            seen.insert((entry.name.clone(), entry.exe.clone(), entry.args.clone())),
            "duplicate entry {}",
            entry.name
        );
    }
    let raw: Vec<serde_json::Value> = serde_json::from_str(GAMES_JSON).unwrap();
    assert_eq!(raw.len(), entries.len());
}

#[test]
fn path_tails_cover_every_tail_and_the_64_variants() {
    let tails = path_tails("/games/counter/game/bin/win64/cs2.exe");
    for tail in [
        "cs2.exe",
        "win64/cs2.exe",
        "bin/win64/cs2.exe",
        "win/cs2.exe",
    ] {
        assert!(tails.contains(tail), "{tail} missing from {tails:?}");
    }
    let tails = path_tails("/g/sc2_x64.exe");
    assert!(tails.contains("sc2_.exe"));
    assert!(tails.contains("sc2_x64.exe"));
    let tails = path_tails("/g/game_64.exe");
    assert!(tails.contains("game.exe"));
    let tails = path_tails("/g/gamex64.exe");
    assert!(tails.contains("game.exe"));
}

fn entry(name: &str, exe: &[&str], args: Option<&str>, os: &[&str]) -> ListEntry {
    ListEntry {
        name: name.into(),
        exe: exe.iter().map(|e| e.to_string()).collect(),
        args: args.map(str::to_string),
        os: os.iter().map(|o| o.to_string()).collect(),
    }
}

fn list_game(entries: &[ListEntry], procs: &[Proc], os: &str) -> Option<DetectedGame> {
    pick(procs, &Libraries::default(), entries, &Prefs::default(), os).game
}

#[test]
fn list_matches_by_tail_and_by_a_stripped_64() {
    let entries = [entry("Cool Game", &["coolgame.exe"], None, &["windows"])];
    let plain = proc_at(r"C:\Games\Cool\coolgame.exe", 5);
    assert_eq!(
        list_game(&entries, &[plain], "windows").map(|g| g.name),
        Some("Cool Game".into())
    );
    for variant in ["coolgame64.exe", "coolgamex64.exe", "coolgame_64.exe"] {
        let p = proc_at(&format!(r"C:\Games\Cool\{variant}"), 5);
        assert_eq!(
            list_game(&entries, &[p], "windows").map(|g| g.name),
            Some("Cool Game".into()),
            "{variant}"
        );
    }
    let other = proc_at(r"C:\Games\Cool\coolgame2.exe", 5);
    assert_eq!(list_game(&entries, &[other], "windows"), None);
}

#[test]
fn list_entry_with_a_folder_tail_needs_that_folder() {
    let entries = [entry("G", &["win64/game.exe"], None, &["windows"])];
    assert!(list_game(&entries, &[proc_at(r"C:\x\Win64\Game.exe", 1)], "windows").is_some());
    assert!(list_game(&entries, &[proc_at(r"C:\x\Win32\Game.exe", 1)], "windows").is_none());
}

#[test]
fn list_entry_is_limited_to_its_operating_systems() {
    let entries = [entry("G", &["g.exe"], None, &["windows"])];
    let procs = [proc_at("/opt/g.exe", 1)];
    assert!(list_game(&entries, &procs, "windows").is_some());
    assert!(list_game(&entries, &procs, "linux").is_none());
}

#[test]
fn minecraft_java_needs_its_main_class_in_the_command_line() {
    let entries = list();
    let minecraft = proc_cmd(
        "/usr/lib/jvm/java-21/bin/java",
        "/usr/lib/jvm/java-21/bin/java -Xmx4G -cp a.jar:b.jar net.minecraft.client.main.Main --username x",
        10,
    );
    let other_java = proc_cmd(
        "/usr/lib/jvm/java-21/bin/java",
        "/usr/lib/jvm/java-21/bin/java -jar server.jar",
        10,
    );
    assert_eq!(
        list_game(&entries, &[minecraft], "linux").map(|g| g.name),
        Some("Minecraft".into())
    );
    assert_eq!(list_game(&entries, &[other_java], "linux"), None);
    let fabric = proc_cmd(
        "/usr/bin/java",
        "java -cp x net.fabricmc.loader.impl.launch.knot.KnotClient",
        10,
    );
    assert_eq!(
        list_game(&entries, &[fabric], "linux").map(|g| g.name),
        Some("Minecraft".into())
    );
}

#[test]
fn bundled_list_matches_known_programs() {
    let entries = list();
    for (path, game) in [
        (
            r"C:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe",
            "VALORANT",
        ),
        (
            r"C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe",
            "World of Warcraft",
        ),
        (r"C:\Games\Warframe\Warframe.x64.exe", "Warframe"),
        (
            r"C:\Program Files\WindowsApps\MojangStudios.Minecraft_1.21\Minecraft.Windows.exe",
            "Minecraft Bedrock Edition",
        ),
        (r"C:\osu!\osu!.exe", "osu!"),
    ] {
        assert_eq!(
            list_game(&entries, &[proc_at(path, 1)], "windows").map(|g| g.name),
            Some(game.into()),
            "{path}"
        );
    }
}

// -- selection ---------------------------------------------------------------------------------

#[test]
fn a_library_game_is_found_by_its_folder_and_named_from_the_manifest() {
    let tmp = TempDir::new("pick");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let exe = format!("{root}/steamapps/common/elden ring/game/eldenring.exe");
    let found = pick(&[proc_at(&exe, 42)], &libs, &[], &Prefs::default(), "linux");
    assert_eq!(
        found.game,
        Some(DetectedGame {
            name: "ELDEN RING".into(),
            source: GameSource::Steam,
            started_at_ms: 42
        })
    );
}

#[test]
fn helper_processes_in_a_game_folder_do_not_count() {
    let tmp = TempDir::new("deny");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    for helper in [
        "crashreporter.exe",
        "UnityCrashHandler64.exe",
        "BootstrapLauncher.exe",
        "unins000.exe",
        "vc_redist.x64.exe",
        "EasyAntiCheat_EOS_Setup.exe",
        "BEService.exe_battleye",
        "dotnetfx.exe",
        "DXSETUP.exe",
        "UE4PrereqSetup_x64.exe",
        "steamwebhelper",
        "steamerrorreporter",
        "ErrorReporter.exe",
        "GameHelper.exe",
        "redist_installer.exe",
    ] {
        let path = format!("{root}/steamapps/common/elden ring/{helper}");
        assert_eq!(
            pick(&[proc_at(&path, 1)], &libs, &[], &Prefs::default(), "linux").game,
            None,
            "{helper} counted as the game"
        );
    }
    // The real game beside a helper still wins.
    let game = format!("{root}/steamapps/common/elden ring/game/eldenring.exe");
    let crash = format!("{root}/steamapps/common/elden ring/crashpad_handler");
    let found = pick(
        &[proc_at(&crash, 1), proc_at(&game, 9)],
        &libs,
        &[],
        &Prefs::default(),
        "linux",
    );
    assert_eq!(found.game.map(|g| g.started_at_ms), Some(9));
}

#[test]
fn games_with_helper_words_inside_their_names_still_count() {
    let tmp = TempDir::new("notdenied");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    for game in [
        "CastleCrashers.exe",
        "Crashlands.exe",
        "CrashBandicoot.exe",
        "hades",
        "Unsetupable.exe",
        "Launcherless.exe",
    ] {
        let path = format!("{root}/steamapps/common/elden ring/{game}");
        assert!(
            pick(&[proc_at(&path, 1)], &libs, &[], &Prefs::default(), "linux")
                .game
                .is_some(),
            "{game} was dropped as a helper"
        );
    }
    for helper in [
        "UnrealCEFSubProcess.exe",
        "BsSndRpt64.exe",
        "QtWebEngineProcess.exe",
        "CefSharp.BrowserSubprocess.exe",
        "crashpad_handler.exe",
        "CrashReportClient.exe",
        "game_launcher.exe",
        "Setup.exe",
        "Launcher.exe",
    ] {
        let path = format!("{root}/steamapps/common/elden ring/{helper}");
        assert_eq!(
            pick(&[proc_at(&path, 1)], &libs, &[], &Prefs::default(), "linux").game,
            None,
            "{helper} counted as the game"
        );
    }
}

#[test]
fn a_rejected_helper_does_not_hide_the_game_beside_it() {
    let tmp = TempDir::new("hide");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let helper = proc_at(
        &format!("{root}/steamapps/common/elden ring/crashpad_handler"),
        1,
    );
    let game = proc_at(&format!("{root}/steamapps/common/elden ring/e.exe"), 5);
    // The helper started first and comes first; the game is still found.
    let found = pick(
        &[helper.clone(), game.clone()],
        &libs,
        &[],
        &Prefs::default(),
        "linux",
    );
    assert_eq!(found.game.map(|g| g.started_at_ms), Some(5));
    // A helper-named program that the own list knows is still a list match.
    let entries = [entry("Odd", &["crashpad_handler"], None, &["linux"])];
    let found = pick(&[helper], &libs, &entries, &Prefs::default(), "linux").game;
    assert_eq!(found.map(|g| g.name), Some("Odd".into()));
}

#[test]
fn list_entries_with_args_are_not_offered_on_windows() {
    // Windows has no command line to test `args` against.
    for entry in list().iter().filter(|e| e.args.is_some()) {
        assert!(!entry.os.iter().any(|o| o == "windows"), "{}", entry.name);
    }
}

#[test]
fn deny_list_does_not_apply_to_exact_list_entries() {
    let entries = [entry("Odd", &["launcher-game.exe"], None, &["windows"])];
    assert!(list_game(
        &entries,
        &[proc_at(r"C:\x\launcher-game.exe", 1)],
        "windows"
    )
    .is_some());
}

#[test]
fn steam_tool_folders_are_not_games() {
    let tmp = TempDir::new("tools");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let loader = format!("{root}/steamapps/common/proton 9.0/files/bin/wine64-preloader");
    let found = pick(
        &[proc_at(&loader, 1)],
        &libs,
        &[],
        &Prefs::default(),
        "linux",
    );
    assert_eq!(found.game, None);
    assert_eq!(
        found.unknown_dirs,
        [format!("{root}/steamapps/common/proton 9.0/")]
    );
}

#[test]
fn among_several_games_the_one_started_first_wins() {
    let tmp = TempDir::new("first");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let second = norm(&tmp.path().join("games"));
    let elden = proc_at(&format!("{root}/steamapps/common/elden ring/e.exe"), 2_000);
    let hades = proc_at(&format!("{root}/steamapps/common/hades/hades"), 1_000);
    let knight = proc_at(
        &format!("{second}/steamapps/common/hollow knight/hk"),
        3_000,
    );
    for order in [
        [&elden, &hades, &knight],
        [&knight, &elden, &hades],
        [&hades, &knight, &elden],
    ] {
        let procs: Vec<Proc> = order.iter().map(|p| (*p).clone()).collect();
        let game = pick(&procs, &libs, &[], &Prefs::default(), "linux")
            .game
            .unwrap();
        assert_eq!(game.name, "Hades");
        assert_eq!(game.started_at_ms, 1_000);
    }
}

#[test]
fn a_library_game_beats_an_earlier_list_game() {
    let tmp = TempDir::new("priority");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let entries = [entry("Listed", &["listed.exe"], None, &["linux"])];
    let listed = proc_at("/opt/listed.exe", 1);
    let steam = proc_at(&format!("{root}/steamapps/common/hades/hades"), 9_999);
    let game = pick(
        &[listed, steam],
        &libs,
        &entries,
        &Prefs::default(),
        "linux",
    )
    .game
    .unwrap();
    assert_eq!(
        (game.name.as_str(), game.source),
        ("Hades", GameSource::Steam)
    );
}

#[test]
fn among_list_games_the_earliest_start_wins() {
    let entries = [
        entry("A", &["a.exe"], None, &["linux"]),
        entry("B", &["b.exe"], None, &["linux"]),
    ];
    let game = list_game(
        &entries,
        &[proc_at("/x/a.exe", 50), proc_at("/x/b.exe", 10)],
        "linux",
    )
    .unwrap();
    assert_eq!((game.name.as_str(), game.started_at_ms), ("B", 10));
}

#[test]
fn nothing_running_is_none() {
    let tmp = TempDir::new("none");
    let libs = steam_libs(tmp.path());
    assert_eq!(
        pick(&[], &libs, &list(), &Prefs::default(), "linux").game,
        None
    );
    let idle = [proc_at("/usr/bin/bash", 1), proc_at("/usr/bin/firefox", 2)];
    assert_eq!(
        pick(&idle, &libs, &list(), &Prefs::default(), "linux").game,
        None
    );
}

#[test]
fn epic_games_match_by_install_location() {
    let epic = parse_epic_item(EPIC_ITEM).unwrap();
    let mut libs = Libraries::default();
    libs.push_game_for_test(epic);
    let exe = proc_at(
        r"C:\Program Files\Epic Games\rocketleague\Binaries\Win64\RocketLeague.exe",
        7,
    );
    let game = pick(&[exe], &libs, &[], &Prefs::default(), "windows")
        .game
        .unwrap();
    assert_eq!(
        (game.name.as_str(), game.source),
        ("Rocket League", GameSource::Epic)
    );
}

// -- library re-read ----------------------------------------------------------------------------

#[test]
fn libraries_are_read_once_and_again_only_for_a_new_library_folder() {
    let tmp = TempDir::new("reload");
    let (root, _) = steam_fixture(tmp.path());
    let root_norm = norm(&root);
    let loads = Cell::new(0u32);
    let load = || {
        loads.set(loads.get() + 1);
        read_steam(std::slice::from_ref(&root))
    };
    let mut state = None;
    let hades = proc_at(&format!("{root_norm}/steamapps/common/hades/hades"), 1);

    // Known game: one read, no re-read, on any number of scans.
    for _ in 0..3 {
        assert!(detect_with(
            std::slice::from_ref(&hades),
            &mut state,
            load,
            &[],
            &Prefs::default(),
            "linux"
        )
        .is_some());
    }
    assert_eq!(loads.get(), 1);

    // A game installed since: one re-read finds it; later scans do not re-read.
    write(
        &root.join("steamapps/appmanifest_1.acf"),
        &acf(1, "Brand New", "Brand New"),
    );
    let fresh = proc_at(&format!("{root_norm}/steamapps/common/brand new/new"), 5);
    let found = detect_with(
        std::slice::from_ref(&fresh),
        &mut state,
        load,
        &[],
        &Prefs::default(),
        "linux",
    );
    assert_eq!(found.map(|g| g.name), Some("Brand New".into()));
    assert_eq!(loads.get(), 2);
    detect_with(
        std::slice::from_ref(&fresh),
        &mut state,
        load,
        &[],
        &Prefs::default(),
        "linux",
    );
    assert_eq!(loads.get(), 2);

    // A folder no manifest explains costs one re-read, not one per scan.
    let tool = proc_at(&format!("{root_norm}/steamapps/common/mystery/bin"), 5);
    for _ in 0..3 {
        assert_eq!(
            detect_with(
                std::slice::from_ref(&tool),
                &mut state,
                load,
                &[],
                &Prefs::default(),
                "linux"
            ),
            None
        );
    }
    assert_eq!(loads.get(), 3);
}

// -- /proc fixture tree (Linux) --------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use std::os::unix::fs::MetadataExt;

    use super::*;
    use crate::game_activity::proc_linux::read_proc_tree;

    const BOOT: u64 = 1_700_000_000;
    const TICKS: u64 = 100;

    fn proc_root(tmp: &Path) -> PathBuf {
        let root = tmp.join("proc");
        write(
            &root.join("stat"),
            &format!("cpu 1 2 3\nbtime {BOOT}\nprocesses 9\n"),
        );
        root
    }

    /// One `/proc/<pid>`: NUL-separated `cmdline`, an `exe` link, a `stat`.
    fn add_proc(root: &Path, pid: u32, args: &[&str], exe: Option<&str>, start_ticks: u64) {
        let dir = root.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        let mut cmdline = args.join("\0").into_bytes();
        cmdline.push(0);
        fs::write(dir.join("cmdline"), cmdline).unwrap();
        let stat = format!(
            "{pid} (game) S 1 {pid} {pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 {start_ticks} 0 0\n"
        );
        fs::write(dir.join("stat"), stat).unwrap();
        if let Some(exe) = exe {
            std::os::unix::fs::symlink(exe, dir.join("exe")).unwrap();
        }
    }

    fn own_uid(path: &Path) -> u32 {
        fs::metadata(path).unwrap().uid()
    }

    fn scan(root: &Path, list: &[ListEntry]) -> Option<DetectedGame> {
        let procs = read_proc_tree(root, own_uid(root), TICKS).unwrap();
        pick(
            &procs,
            &Libraries::default(),
            list,
            &Prefs::default(),
            "linux",
        )
        .game
    }

    #[test]
    fn a_native_linux_game_is_found_by_its_exe_link() {
        let tmp = TempDir::new("proc-native");
        let libs = steam_libs(tmp.path());
        let steam = tmp.path().join("steam");
        let game = format!("{}/steamapps/common/Hades/Hades", steam.display());
        let root = proc_root(tmp.path());
        add_proc(&root, 100, &["bash"], Some("/usr/bin/bash"), 10);
        add_proc(&root, 200, &["./Hades"], Some(&game), 1_000);
        let procs = read_proc_tree(&root, own_uid(&root), TICKS).unwrap();
        let found = pick(&procs, &libs, &[], &Prefs::default(), "linux")
            .game
            .unwrap();
        assert_eq!(found.name, "Hades");
        assert_eq!(found.source, GameSource::Steam);
        assert_eq!(found.started_at_ms, BOOT * 1000 + 1_000 * 1000 / TICKS);
    }

    #[test]
    fn a_proton_game_is_found_by_its_windows_command_line() {
        let tmp = TempDir::new("proc-proton");
        let libs = steam_libs(tmp.path());
        let steam = tmp.path().join("steam");
        let win = format!(
            "Z:{}\\steamapps\\common\\Elden Ring\\Game\\eldenring.exe",
            steam.display().to_string().replace('/', "\\")
        );
        let root = proc_root(tmp.path());
        // Wine's loader is the exe link; the Windows path is the program.
        add_proc(
            &root,
            300,
            &[&win],
            Some("/home/u/.steam/steam/steamapps/common/Proton 9.0/files/bin/wine64-preloader"),
            500,
        );
        let procs = read_proc_tree(&root, own_uid(&root), TICKS).unwrap();
        let found = pick(&procs, &libs, &[], &Prefs::default(), "linux")
            .game
            .unwrap();
        assert_eq!(
            (found.name.as_str(), found.source),
            ("ELDEN RING", GameSource::Steam)
        );
    }

    #[test]
    fn a_crash_reporter_in_the_game_folder_is_not_the_game() {
        let tmp = TempDir::new("proc-crash");
        let libs = steam_libs(tmp.path());
        let steam = tmp.path().join("steam");
        let crash = format!("{}/steamapps/common/Hades/CrashReporter", steam.display());
        let root = proc_root(tmp.path());
        add_proc(&root, 400, &[&crash], Some(&crash), 5);
        let procs = read_proc_tree(&root, own_uid(&root), TICKS).unwrap();
        assert_eq!(
            pick(&procs, &libs, &[], &Prefs::default(), "linux").game,
            None
        );
    }

    #[test]
    fn another_users_processes_are_not_read() {
        let tmp = TempDir::new("proc-uid");
        let root = proc_root(tmp.path());
        add_proc(&root, 500, &["/opt/a"], Some("/opt/a"), 5);
        let me = own_uid(&root);
        assert_eq!(read_proc_tree(&root, me, TICKS).unwrap().len(), 1);
        assert!(read_proc_tree(&root, me.wrapping_add(1), TICKS)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn kernel_threads_and_non_pid_entries_are_skipped() {
        let tmp = TempDir::new("proc-skip");
        let root = proc_root(tmp.path());
        add_proc(&root, 600, &[], None, 5); // empty cmdline: a kernel thread
        fs::create_dir_all(root.join("self")).unwrap();
        fs::create_dir_all(root.join("sys")).unwrap();
        assert!(read_proc_tree(&root, own_uid(&root), TICKS)
            .unwrap()
            .is_empty());
        assert!(read_proc_tree(&root.join("missing"), 0, TICKS).is_none());
    }

    #[test]
    fn a_process_whose_stat_cannot_be_read_is_skipped() {
        let tmp = TempDir::new("proc-nostat");
        let root = proc_root(tmp.path());
        add_proc(&root, 800, &["/opt/a"], Some("/opt/a"), 5);
        add_proc(&root, 801, &["/opt/b"], Some("/opt/b"), 5);
        fs::remove_file(root.join("800/stat")).unwrap();
        write(&root.join("801/stat"), "801 (b) S garbage\n");
        add_proc(&root, 802, &["/opt/c"], Some("/opt/c"), 5);
        let procs = read_proc_tree(&root, own_uid(&root), TICKS).unwrap();
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].paths[0], "/opt/c");
    }

    #[test]
    fn a_missing_boot_time_means_every_process_starts_now() {
        let tmp = TempDir::new("proc-nobtime");
        let root = proc_root(tmp.path());
        write(&root.join("stat"), "cpu 1 2 3\n");
        add_proc(&root, 900, &["/opt/a"], Some("/opt/a"), 5);
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let procs = read_proc_tree(&root, own_uid(&root), TICKS).unwrap();
        assert!(
            procs[0].started_at_ms >= before,
            "{}",
            procs[0].started_at_ms
        );
    }

    #[test]
    fn the_list_matches_a_process_from_the_tree() {
        let tmp = TempDir::new("proc-list");
        let root = proc_root(tmp.path());
        add_proc(
            &root,
            700,
            &["java", "-Xmx2G", "net.minecraft.client.main.Main"],
            Some("/usr/lib/jvm/java-21-openjdk/bin/java"),
            50,
        );
        let found = scan(&root, &list()).unwrap();
        assert_eq!(
            (found.name.as_str(), found.source),
            ("Minecraft", GameSource::List)
        );
    }

    #[test]
    fn three_hundred_processes_scan_well_inside_the_budget() {
        let tmp = TempDir::new("proc-cost");
        let libs = steam_libs(tmp.path());
        let steam = tmp.path().join("steam");
        let game = format!("{}/steamapps/common/Hades/Hades", steam.display());
        let root = proc_root(tmp.path());
        for pid in 1..=299u32 {
            let exe = format!("/usr/lib/app{pid}/bin/tool{pid}");
            add_proc(
                &root,
                pid,
                &[&exe, "--flag", "value"],
                Some(&exe),
                u64::from(pid),
            );
        }
        add_proc(&root, 300, &[&game], Some(&game), 1);
        let entries = list();
        let me = own_uid(&root);
        let started = Instant::now();
        let procs = read_proc_tree(&root, me, TICKS).unwrap();
        let found = pick(&procs, &libs, &entries, &Prefs::default(), "linux").game;
        let elapsed = started.elapsed();
        assert_eq!(procs.len(), 300);
        assert_eq!(found.map(|g| g.name), Some("Hades".into()));
        // The target is 20 ms; the bound is loose so a loaded CI box passes.
        assert!(elapsed.as_millis() < 200, "scan took {elapsed:?}");
    }
}

#[test]
fn matching_three_hundred_processes_in_memory_is_fast() {
    let tmp = TempDir::new("cost-mem");
    let libs = steam_libs(tmp.path());
    let entries = list();
    let procs: Vec<Proc> = (0..300)
        .map(|n| {
            let path = format!("/usr/lib/app{n}/bin/tool{n}");
            proc_cmd(&path, &format!("{path} --flag value"), n)
        })
        .collect();
    let started = Instant::now();
    let found = pick(&procs, &libs, &entries, &Prefs::default(), "linux");
    let elapsed = started.elapsed();
    assert_eq!(found.game, None);
    assert!(elapsed.as_millis() < 200, "match took {elapsed:?}");
}

// -- manual entries, hidden games and the picker (WP 8.3d) ---------------------------

fn prefs(manual: &[(&str, &str)], hidden: &[&str]) -> Prefs {
    Prefs::new(&DetectPrefs {
        manual: manual
            .iter()
            .map(|(path, name)| ManualGame {
                path: (*path).into(),
                name: (*name).into(),
            })
            .collect(),
        hidden: hidden.iter().map(|n| (*n).into()).collect(),
    })
}

#[test]
fn detect_prefs_read_camel_case_and_tolerate_missing_fields() {
    let parsed: DetectPrefs = serde_json::from_str(
        r#"{"manual":[{"path":"C:\\G\\g.exe","name":"G"}],"hidden":["Hades"]}"#,
    )
    .unwrap();
    assert_eq!((parsed.manual.len(), parsed.hidden.len()), (1, 1));
    let empty: DetectPrefs = serde_json::from_str("{}").unwrap();
    assert!(empty.manual.is_empty() && empty.hidden.is_empty());
    assert_eq!(
        serde_json::to_string(&GameSource::Manual).unwrap(),
        "\"manual\""
    );
}

#[test]
fn a_manual_entry_wins_over_library_and_list_matches() {
    let tmp = TempDir::new("manual-wins");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let entries = [entry("Listed", &["listed.exe"], None, &["linux"])];
    let steam = proc_at(&format!("{root}/steamapps/common/hades/hades"), 1);
    let listed = proc_at("/opt/listed.exe", 2);
    let mine = proc_at("/home/me/tools/mygame", 9_999);
    let p = prefs(&[("/home/me/tools/mygame", "  My Game ")], &[]);
    let game = pick(
        &[steam.clone(), listed.clone(), mine],
        &libs,
        &entries,
        &p,
        "linux",
    )
    .game
    .unwrap();
    assert_eq!(
        (game.name.as_str(), game.source, game.started_at_ms),
        ("My Game", GameSource::Manual, 9_999)
    );
    // Without the entry the earlier library game is the answer again.
    let game = pick(
        &[steam, listed],
        &libs,
        &entries,
        &Prefs::default(),
        "linux",
    )
    .game
    .unwrap();
    assert_eq!(game.source, GameSource::Steam);
}

#[test]
fn a_manual_entry_marks_a_library_programs_name_instead_of_the_manifests() {
    let tmp = TempDir::new("manual-claims");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let exe = format!("{root}/steamapps/common/hades/hades");
    let p = prefs(&[(&exe, "My Hades")], &[]);
    let game = pick(&[proc_at(&exe, 1)], &libs, &[], &p, "linux")
        .game
        .unwrap();
    assert_eq!(game.name, "My Hades");
}

#[test]
fn manual_paths_match_case_insensitively_on_windows_style_paths() {
    let libs = Libraries::default();
    let proc = proc_at(r"C:\Games\Cool Game\CoolGame.EXE", 5);
    for saved in [
        r"c:\games\cool game\coolgame.exe",
        r"C:\GAMES\COOL GAME\COOLGAME.EXE",
        r#""C:\Games\Cool Game\CoolGame.exe""#,
        "C:/Games/Cool Game/CoolGame.exe",
    ] {
        let p = prefs(&[(saved, "Cool")], &[]);
        let game = pick(std::slice::from_ref(&proc), &libs, &[], &p, "windows").game;
        assert_eq!(game.map(|g| g.name), Some("Cool".to_string()), "{saved}");
    }
    let other = prefs(&[(r"C:\Games\Other\other.exe", "Other")], &[]);
    assert_eq!(pick(&[proc], &libs, &[], &other, "windows").game, None);
}

#[test]
fn a_hidden_game_falls_through_to_the_next_candidate() {
    let tmp = TempDir::new("hidden");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let entries = [entry("Listed", &["listed.exe"], None, &["linux"])];
    let hades = proc_at(&format!("{root}/steamapps/common/hades/hades"), 1);
    let elden = proc_at(&format!("{root}/steamapps/common/elden ring/e.exe"), 2);
    let listed = proc_at("/opt/listed.exe", 3);
    let procs = [hades, elden, listed];
    let name = |p: &Prefs| {
        pick(&procs, &libs, &entries, p, "linux")
            .game
            .map(|g| g.name)
    };
    assert_eq!(name(&Prefs::default()).as_deref(), Some("Hades"));
    // Case does not matter, and the next started wins.
    assert_eq!(name(&prefs(&[], &["hADES"])).as_deref(), Some("ELDEN RING"));
    assert_eq!(
        name(&prefs(&[], &["Hades", "Elden Ring"])).as_deref(),
        Some("Listed")
    );
    assert_eq!(name(&prefs(&[], &["Hades", "Elden Ring", "Listed"])), None);
}

#[test]
fn a_hidden_manual_game_is_skipped_and_does_not_come_back_as_another_name() {
    let tmp = TempDir::new("hidden-manual");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    let exe = format!("{root}/steamapps/common/hades/hades");
    let p = prefs(&[(&exe, "My Hades")], &["my hades"]);
    assert_eq!(
        pick(&[proc_at(&exe, 1)], &libs, &[], &p, "linux").game,
        None
    );
}

#[test]
fn a_hidden_game_keeps_the_first_started_rule_for_the_rest() {
    let entries = [
        entry("A", &["a.exe"], None, &["linux"]),
        entry("B", &["b.exe"], None, &["linux"]),
        entry("C", &["c.exe"], None, &["linux"]),
    ];
    let procs = [
        proc_at("/x/a.exe", 10),
        proc_at("/x/b.exe", 30),
        proc_at("/x/c.exe", 20),
    ];
    let game = pick(
        &procs,
        &Libraries::default(),
        &entries,
        &prefs(&[], &["a"]),
        "linux",
    )
    .game
    .unwrap();
    assert_eq!((game.name.as_str(), game.started_at_ms), ("C", 20));
}

#[test]
fn a_manual_game_with_an_unknown_start_borrows_the_start_already_shown() {
    let p = prefs(&[("/x/mine", "Mine")], &[]);
    let load = Libraries::default;
    let mut state = None;
    let first = detect_with(
        &[proc_at("/x/mine", UNKNOWN_START)],
        &mut state,
        load,
        &[],
        &p,
        "linux",
    )
    .unwrap();
    assert_ne!(first.started_at_ms, UNKNOWN_START);
    let again = detect_with(
        &[proc_at("/x/mine", UNKNOWN_START)],
        &mut state,
        load,
        &[],
        &p,
        "linux",
    )
    .unwrap();
    assert_eq!(again.started_at_ms, first.started_at_ms);
}

#[test]
fn prefs_drop_entries_that_cannot_match() {
    let p = prefs(&[("", "Empty path"), ("/x/y", "   ")], &[]);
    assert!(p.manual.is_empty());
}

fn program(path: &str) -> Proc {
    proc_at(path, 1)
}

#[test]
fn programs_are_named_by_file_stem_sorted_and_deduplicated_by_path() {
    let procs = [
        program(r"C:\Games\Zed\Zed.exe"),
        program(r"C:\Games\alpha\alpha.exe"),
        // The same program twice (two instances), once in another case.
        program(r"C:\Games\Zed\Zed.exe"),
        program(r"c:\games\zed\zed.EXE"),
        program(r"D:\Other\Beta.exe"),
        program("/usr/bin/python3.12"),
        program("/opt/noext"),
    ];
    let listed = list_programs(&procs, None);
    let names: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["alpha", "Beta", "noext", "python3", "Zed"]);
    assert_eq!(listed[0].path, r"C:\Games\alpha\alpha.exe");
}

#[test]
fn programs_leave_out_helpers_and_the_windows_directory() {
    let procs = [
        program(r"C:\Windows\System32\svchost.exe"),
        program(r"c:\windows\explorer.exe"),
        program(r"C:\Windowsish\game.exe"),
        program(r"C:\Games\Game\CrashReportClient.exe"),
        program(r"C:\Games\Game\Launcher.exe"),
        program(r"C:\Games\Game\Game.exe"),
    ];
    let windows = Some(
        normalize_path(r"C:\Windows")
            .trim_end_matches('/')
            .to_string(),
    );
    let listed = list_programs(&procs, windows.as_deref());
    let names: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["Game", "game"]);
}

#[test]
fn programs_are_capped_at_three_hundred() {
    let procs: Vec<Proc> = (0..450)
        .map(|i| program(&format!("/opt/app{i:03}/prog{i:03}")))
        .collect();
    let listed = list_programs(&procs, None);
    assert_eq!(listed.len(), MAX_PROGRAMS);
    assert_eq!(listed[0].name, "prog000");
    assert_eq!(listed[MAX_PROGRAMS - 1].name, "prog299");
}

#[test]
fn a_proton_process_is_listed_by_its_windows_path_not_the_loader() {
    let proc = Proc::new(
        &[
            r"Z:\home\u\games\Cool\cool.exe",
            "/usr/lib/wine/wine64-preloader",
        ],
        "",
        1,
    );
    let listed = list_programs(&[proc], None);
    assert_eq!(
        listed,
        [RunningProgram {
            name: "cool".into(),
            path: r"Z:\home\u\games\Cool\cool.exe".into()
        }]
    );
}

#[test]
fn a_listed_path_matches_back_as_a_manual_entry() {
    // Whatever the picker hands out is what detect_game later matches.
    for raw in [r"C:\Games\Cool\Cool.exe", "/opt/cool/cool"] {
        let proc = program(raw);
        let listed = list_programs(std::slice::from_ref(&proc), None);
        let p = prefs(&[(&listed[0].path, "Cool")], &[]);
        assert!(p.manual_name(&proc).is_some(), "{raw}");
    }
}

#[test]
fn the_cap_keeps_the_most_recently_started_programs_then_sorts_by_name() {
    // `zzz` programs start last; the alphabet must not decide who is cut.
    let mut procs: Vec<Proc> = (0..250)
        .map(|i| proc_at(&format!("/opt/a{i:03}/aaa{i:03}"), 10 + i))
        .collect();
    procs.extend((0..100).map(|i| proc_at(&format!("/opt/z{i:03}/zzz{i:03}"), 1_000 + i)));
    // An unknown start is the oldest.
    procs.push(proc_at("/opt/unknown/aaa-unknown", UNKNOWN_START));
    let listed = list_programs(&procs, None);
    assert_eq!(listed.len(), MAX_PROGRAMS);
    let names: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
    assert!(names.contains(&"zzz000") && names.contains(&"zzz099"));
    assert!(!names.contains(&"aaa-unknown"));
    // 350 candidates, 50 dropped: the oldest of the aaa group.
    assert!(!names.contains(&"aaa000") && !names.contains(&"aaa049"));
    assert!(names.contains(&"aaa050") && names.contains(&"aaa249"));
    let mut sorted = names.clone();
    sorted.sort_by_key(|n| n.to_lowercase());
    assert_eq!(names, sorted);
}

#[test]
fn duplicates_and_filtered_programs_do_not_use_up_the_cap() {
    let mut procs: Vec<Proc> = (0..400).map(|i| proc_at("/opt/same/same", 1 + i)).collect();
    procs.extend((0..400).map(|i| proc_at(&format!("/opt/h{i}/crashpad_handler{i}"), 5)));
    procs.push(proc_at("/opt/zed/zed", 1));
    let names: Vec<String> = list_programs(&procs, None)
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert_eq!(names, ["same", "zed"]);
}

#[test]
fn a_hidden_library_game_does_not_fall_through_to_a_list_match_for_the_same_process() {
    let tmp = TempDir::new("hidden-no-list");
    let libs = steam_libs(tmp.path());
    let root = norm(&tmp.path().join("steam"));
    // The list also knows this very program, under another name.
    let entries = [
        entry("Listed Hades", &["hades"], None, &["linux"]),
        entry("Other", &["other.exe"], None, &["linux"]),
    ];
    let hades = proc_at(&format!("{root}/steamapps/common/hades/hades"), 1);
    let name = |procs: &[Proc], hidden: &[&str]| {
        pick(procs, &libs, &entries, &prefs(&[], hidden), "linux")
            .game
            .map(|g| g.name)
    };
    assert_eq!(
        name(std::slice::from_ref(&hades), &[]).as_deref(),
        Some("Hades")
    );
    assert_eq!(name(std::slice::from_ref(&hades), &["Hades"]), None);
    // A different process can still win.
    let other = proc_at("/opt/other.exe", 9);
    assert_eq!(name(&[hades, other], &["hades"]).as_deref(), Some("Other"));
}
