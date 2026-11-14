//! Music share, host half: which apps have sound, and capturing one of them.
//!
//! `list_audio_apps` reads the audio sessions on the default output and shows
//! one row per app; `start_music_audio` captures the picked app's process tree
//! in a capture slot of its own and `stop_music_audio` ends it. The capture,
//! its frame format and its loopback socket are the ones of `start_app_audio`
//! (see the parent module). The pure parts (ids, grouping, sorting, the target
//! check) build and are tested everywhere; the sessions themselves are
//! `cfg(windows)` in `windows_music.rs`.
//!
//! Error codes of `start_music_audio`: `unavailable`, `not_found` (the id is
//! malformed, the app is gone, its pid now runs another program, or it is
//! OwnCord's own process tree), `activation_failed`, `superseded` (a newer
//! start or a stop overtook this one), `internal`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use super::{platform, start_in_slot, stop_in_slot, Capture, Slot};

/// One app with an audio session on the default output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    /// Opaque id the page hands back to start a music capture.
    pub id: String,
    /// Display name ("Spotify", "foobar2000").
    pub name: String,
    /// Small PNG data URL (<= 32x32) or None.
    pub icon: Option<String>,
    /// Sound is playing right now (not only an open session).
    pub playing: bool,
}

/// The id of the app whose topmost process is `pid`.
pub fn app_id(pid: u32) -> String {
    format!("pid:{pid}")
}

/// `pid:<n>` -> `n`. Only the canonical spelling [`app_id`] writes is
/// accepted: no sign, spaces, leading zeros or pid 0.
pub fn parse_app_id(id: &str) -> Option<u32> {
    let pid: u32 = id.strip_prefix("pid:")?.parse().ok()?;
    (pid != 0 && app_id(pid) == id).then_some(pid)
}

/// One audio session on the default output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSession {
    pub pid: u32,
    pub playing: bool,
}

/// One app: the topmost process of its tree that has sessions below it, and
/// whether any of them is playing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppGroup {
    pub root_pid: u32,
    pub playing: bool,
}

/// The executable's file name, lowercased, from a Windows or POSIX path.
pub fn exe_file_name(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?;
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// The file name without its extension, as written.
pub fn exe_stem(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?;
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    (!stem.is_empty()).then(|| stem.to_string())
}

/// Group sessions into apps, one per process tree.
///
/// A session's app root is its topmost ancestor that runs the same
/// executable (Spotify, Chrome and every Electron app play from a child of
/// their main process). The climb stops at a parent that runs something else,
/// that is gone, or that is OwnCord's own tree or one OwnCord descends from.
/// System sounds (pid 0), OwnCord's own processes and its ancestors (a
/// capture of those would contain this app) are left out. `exe_of` gives a
/// pid's lowercased executable name; a process it cannot name is never
/// climbed from.
pub fn group_sessions(
    sessions: &[AudioSession],
    parent_of: &HashMap<u32, u32>,
    exe_of: impl Fn(u32) -> Option<String>,
    own: &HashSet<u32>,
    ancestors: &HashSet<u32>,
) -> Vec<AppGroup> {
    let mut groups: Vec<AppGroup> = Vec::new();
    for session in sessions {
        let pid = session.pid;
        if pid == 0 || own.contains(&pid) || ancestors.contains(&pid) {
            continue;
        }
        let mut root = pid;
        let exe = exe_of(pid);
        for _ in 0..64 {
            let Some(&parent) = parent_of.get(&root) else {
                break;
            };
            let same_family = exe.is_some() && exe_of(parent) == exe;
            if parent == 0
                || parent == root
                || own.contains(&parent)
                || ancestors.contains(&parent)
                || !same_family
            {
                break;
            }
            root = parent;
        }
        match groups.iter_mut().find(|g| g.root_pid == root) {
            Some(group) => group.playing |= session.playing,
            None => groups.push(AppGroup {
                root_pid: root,
                playing: session.playing,
            }),
        }
    }
    groups
}

/// Playing apps first, then by name (case-insensitive), then by id.
pub fn sort_apps(apps: &mut [AudioApp]) {
    apps.sort_by(|a, b| {
        b.playing
            .cmp(&a.playing)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// Turn groups into the rows the page shows. `describe` gives a root
/// process's display name and icon.
pub fn assemble_apps(
    groups: &[AppGroup],
    describe: impl Fn(u32) -> (String, Option<String>),
) -> Vec<AudioApp> {
    let mut apps: Vec<AudioApp> = groups
        .iter()
        .map(|group| {
            let (name, icon) = describe(group.root_pid);
            AudioApp {
                id: app_id(group.root_pid),
                name,
                icon,
                playing: group.playing,
            }
        })
        .collect();
    sort_apps(&mut apps);
    apps
}

/// Whether `pid` may be captured as music: a live process outside OwnCord's
/// own tree and outside the processes OwnCord descends from (their trees
/// contain this app, so the capture would carry the call back to viewers).
/// The error is the `start_music_audio` code.
pub fn check_music_target(
    pid: u32,
    parent_of: &HashMap<u32, u32>,
    own: &HashSet<u32>,
    ancestors: &HashSet<u32>,
) -> Result<u32, &'static str> {
    if pid == 0 || !parent_of.contains_key(&pid) || own.contains(&pid) || ancestors.contains(&pid) {
        return Err("not_found");
    }
    Ok(pid)
}

/// What a listing saw: the rows, and the executable name of each row's root
/// process (empty when it could not be read), keyed by pid.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Listing {
    pub apps: Vec<AudioApp>,
    pub exes: HashMap<u32, String>,
}

/// Whether the process now at a listed pid still runs the executable the
/// listing saw there. A pid that was never listed, or whose process was
/// replaced by another program (the id was reused after the app quit), is not
/// the app the user picked.
pub fn exe_unchanged(listed: Option<&str>, current: &str) -> Result<(), &'static str> {
    match listed {
        Some(seen) if seen == current => Ok(()),
        _ => Err("not_found"),
    }
}

/// Tauri state: the music capture, a slot of its own so it never touches a
/// running screen-share audio capture, nor the other way round, and the
/// executable names the last listing saw (to catch a reused pid).
#[derive(Default)]
pub struct MusicAudioState {
    slot: Mutex<Slot<Capture>>,
    listed: Mutex<HashMap<u32, String>>,
}

impl MusicAudioState {
    pub fn new() -> Self {
        Self::default()
    }

    pub(super) fn slot(&self) -> &Mutex<Slot<Capture>> {
        &self.slot
    }
}

/// List the apps with an audio session on the default output, one row per
/// app, playing ones first. OwnCord itself is left out.
#[tauri::command]
pub async fn list_audio_apps(state: State<'_, MusicAudioState>) -> Result<Vec<AudioApp>, String> {
    if !platform::available() {
        return Err("unavailable".into());
    }
    let listing = tauri::async_runtime::spawn_blocking(platform::list_apps)
        .await
        .map_err(|_| "internal".to_string())??;
    *crate::sync::lock(&state.listed) = listing.exes;
    Ok(listing.apps)
}

/// Start capturing the app `app_id` (from `list_audio_apps`) as music and
/// return the loopback socket URL, same frame format as `start_app_audio`.
/// A running music capture is replaced; a screen-share capture is not touched.
/// Codes: `unavailable`, `not_found`, `activation_failed`, `superseded`,
/// `internal`.
#[tauri::command]
pub async fn start_music_audio(
    state: State<'_, MusicAudioState>,
    app_id: String,
) -> Result<String, String> {
    if !platform::available() {
        return Err("unavailable".into());
    }
    let pid = parse_app_id(&app_id).ok_or_else(|| "not_found".to_string())?;
    let listed = crate::sync::lock(&state.listed).get(&pid).cloned();
    start_in_slot(
        state.slot(),
        move || platform::resolve_music_pid(pid, listed),
        platform::spawn_capture,
    )
    .await
}

/// Stop the music capture, if any. The screen-share capture keeps running.
#[tauri::command]
pub async fn stop_music_audio(state: State<'_, MusicAudioState>) -> Result<(), String> {
    stop_in_slot(state.slot()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_app_ids() {
        assert_eq!(parse_app_id("pid:4242"), Some(4242));
        assert_eq!(app_id(7), "pid:7");
        for bad in [
            "",
            "pid:",
            "pid:0",
            "pid:-1",
            "pid:+5",
            "pid:007",
            "pid: 5",
            "pid:5 ",
            "PID:5",
            "pid:5:6",
            "5",
            "window:5:0",
            "pid:99999999999999999999",
        ] {
            assert_eq!(parse_app_id(bad), None, "{bad:?}");
        }
    }

    fn exes(map: &[(u32, &str)]) -> impl Fn(u32) -> Option<String> {
        let map: HashMap<u32, String> = map.iter().map(|(p, e)| (*p, e.to_lowercase())).collect();
        move |pid| map.get(&pid).cloned()
    }

    fn session(pid: u32, playing: bool) -> AudioSession {
        AudioSession { pid, playing }
    }

    #[test]
    fn child_sessions_group_under_the_topmost_same_exe_ancestor() {
        // explorer(1) > spotify(10) > spotify(11) > spotify(12); chrome(20) > chrome(21)
        let parents = HashMap::from([(10, 1), (11, 10), (12, 11), (20, 1), (21, 20), (1, 0)]);
        let exe = exes(&[
            (1, "explorer.exe"),
            (10, "spotify.exe"),
            (11, "Spotify.exe"),
            (12, "spotify.exe"),
            (20, "chrome.exe"),
            (21, "chrome.exe"),
        ]);
        let groups = group_sessions(
            &[
                session(12, false),
                session(11, true),
                session(21, false),
                session(20, false),
            ],
            &parents,
            exe,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(
            groups,
            vec![
                AppGroup {
                    root_pid: 10,
                    playing: true
                },
                AppGroup {
                    root_pid: 20,
                    playing: false
                },
            ]
        );
    }

    #[test]
    fn grouping_skips_system_sounds_own_tree_and_ancestors() {
        let parents = HashMap::from([(5, 1), (6, 5), (7, 6), (30, 5), (1, 0)]);
        let exe = exes(&[
            (5, "x.exe"),
            (6, "owncord.exe"),
            (7, "owncord.exe"),
            (30, "app.exe"),
        ]);
        let own = HashSet::from([6, 7]);
        let ancestors = HashSet::from([5]);
        let groups = group_sessions(
            &[
                session(0, true),
                session(7, true),
                session(5, true),
                session(30, true),
            ],
            &parents,
            exe,
            &own,
            &ancestors,
        );
        assert_eq!(
            groups,
            vec![AppGroup {
                root_pid: 30,
                playing: true
            }]
        );
    }

    #[test]
    fn grouping_does_not_climb_into_other_exes_or_unknown_or_cycles() {
        let parents = HashMap::from([(2, 1), (3, 2), (8, 9), (9, 8)]);
        // 3 -> 2 differs; 8 and 9 are the same exe but a stale cycle.
        let exe = exes(&[
            (2, "launcher.exe"),
            (3, "game.exe"),
            (8, "a.exe"),
            (9, "a.exe"),
        ]);
        let groups = group_sessions(
            &[session(3, true), session(42, false), session(8, false)],
            &parents,
            exe,
            &HashSet::new(),
            &HashSet::new(),
        );
        let roots: HashSet<u32> = groups.iter().map(|g| g.root_pid).collect();
        assert!(roots.contains(&3) && roots.contains(&42));
        assert_eq!(groups.len(), 3);
        assert!(groups.iter().all(|g| g.root_pid != 2));
    }

    #[test]
    fn rows_sort_playing_first_then_name() {
        let groups = [
            AppGroup {
                root_pid: 1,
                playing: false,
            },
            AppGroup {
                root_pid: 2,
                playing: true,
            },
            AppGroup {
                root_pid: 3,
                playing: false,
            },
            AppGroup {
                root_pid: 4,
                playing: true,
            },
        ];
        let rows = assemble_apps(&groups, |pid| {
            let name = match pid {
                1 => "Zed",
                2 => "spotify",
                3 => "Audacity",
                _ => "Foobar2000",
            };
            (name.to_string(), None)
        });
        let order: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(order, ["Foobar2000", "spotify", "Audacity", "Zed"]);
        assert_eq!(rows[0].id, "pid:4");
        assert!(rows[0].playing && !rows[3].playing);
    }

    #[test]
    fn rows_serialize_camel_case() {
        let row = AudioApp {
            id: "pid:1".into(),
            name: "A".into(),
            icon: None,
            playing: true,
        };
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "pid:1", "name": "A", "icon": null, "playing": true})
        );
    }

    #[test]
    fn exe_names_from_paths() {
        assert_eq!(
            exe_file_name(r"C:\Users\a\Spotify.EXE").as_deref(),
            Some("spotify.exe")
        );
        assert_eq!(
            exe_stem(r"C:\Program Files\foobar2000\foobar2000.exe").as_deref(),
            Some("foobar2000")
        );
        assert_eq!(exe_stem("noext").as_deref(), Some("noext"));
        assert_eq!(exe_file_name(r"C:\dir\"), None);
    }

    #[test]
    fn a_reused_pid_is_not_the_listed_app() {
        assert_eq!(exe_unchanged(Some("spotify.exe"), "spotify.exe"), Ok(()));
        assert_eq!(exe_unchanged(Some(""), ""), Ok(()));
        assert_eq!(
            exe_unchanged(Some("spotify.exe"), "game.exe"),
            Err("not_found")
        );
        assert_eq!(exe_unchanged(Some("spotify.exe"), ""), Err("not_found"));
        assert_eq!(exe_unchanged(None, "spotify.exe"), Err("not_found"));
    }

    #[test]
    fn music_target_refuses_own_ancestors_and_dead() {
        let parents = HashMap::from([(10, 1), (11, 10), (50, 1), (1, 0)]);
        let own = HashSet::from([10, 11]);
        let ancestors = HashSet::from([1]);
        assert_eq!(check_music_target(50, &parents, &own, &ancestors), Ok(50));
        for pid in [0, 10, 11, 1, 99] {
            assert_eq!(
                check_music_target(pid, &parents, &own, &ancestors),
                Err("not_found")
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_the_music_commands_are_unavailable() {
        assert_eq!(platform::list_apps(), Err("unavailable".to_string()));
        assert_eq!(
            platform::resolve_music_pid(1, None),
            Err("unavailable".to_string())
        );
    }
}
