//! The app id a Wayland session's portal knows OwnCord by.
//!
//! xdg-desktop-portal refuses `GlobalShortcuts.CreateSession` ("An app id is
//! required") for a host (non-Flatpak) app that has no id. It learns one
//! from a systemd scope named `app-<id>-N.scope`, or from the app calling
//! `org.freedesktop.host.portal.Registry.Register` before any other portal
//! call on its D-Bus connection. Both need a desktop entry named
//! `<app id>.desktop` that GIO can find, or the portal rejects the id. The
//! `.deb` ships one under another name and the AppImage ships none, so this
//! module writes a hidden one into the user's applications directory when
//! nothing else provides it.
//!
//! The decisions are pure functions over environment values; only
//! `ensure_desktop_entry` reads the environment and touches the disk.

use std::path::{Path, PathBuf};

/// The bundle identifier in `tauri.conf.json`, which is also the app id the
/// compositor's bind lines name (`global, com.owncord.client:toggle-mute`).
pub(crate) const APP_ID: &str = "com.owncord.client";

/// A line only the entry this module writes carries, so a later run may
/// rewrite it (the AppImage moved) without touching one the user or a
/// package owns.
const MARKER: &str = "X-OwnCord-Generated=true";

/// What `ensure_desktop_entry` found or did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ensured {
    /// An entry for the app id already existed and was left alone.
    Present,
    /// This call wrote (or rewrote) the entry.
    Written,
    /// There is no entry and none could be written.
    Failed,
}

/// The environment values the directory search reads.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DirEnv<'a> {
    pub xdg_data_home: Option<&'a str>,
    pub home: Option<&'a str>,
    pub xdg_data_dirs: Option<&'a str>,
    pub appdir: Option<&'a str>,
}

fn file_name() -> String {
    format!("{APP_ID}.desktop")
}

fn absolute(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    path.is_absolute().then(|| path.to_path_buf())
}

/// The user's applications directory: `$XDG_DATA_HOME/applications` when that
/// is absolute, else `$HOME/.local/share/applications`.
pub(crate) fn user_applications_dir(env: DirEnv<'_>) -> Option<PathBuf> {
    let data_home = env
        .xdg_data_home
        .filter(|v| !v.is_empty())
        .and_then(absolute)
        .or_else(|| {
            env.home
                .filter(|v| !v.is_empty())
                .and_then(absolute)
                .map(|home| home.join(".local/share"))
        })?;
    Some(data_home.join("applications"))
}

/// The system applications directories, in search order. An AppImage's
/// AppRun prepends its own `usr/share` to our environment; the portal runs
/// outside the image and never sees it, so a directory under `$APPDIR` does
/// not count.
pub(crate) fn system_applications_dirs(env: DirEnv<'_>) -> Vec<PathBuf> {
    let raw = env
        .xdg_data_dirs
        .filter(|v| !v.is_empty())
        .unwrap_or("/usr/local/share:/usr/share");
    let appdir = env.appdir.filter(|v| !v.is_empty()).map(PathBuf::from);
    raw.split(':')
        .filter_map(absolute)
        .filter(|dir| {
            appdir
                .as_ref()
                .is_none_or(|appdir| !dir.starts_with(appdir))
        })
        .map(|dir| dir.join("applications"))
        .collect()
}

/// An `Exec=` value for one program path, quoted per the Desktop Entry
/// specification: double quotes around it, a backslash before each `"`, `` ` ``,
/// `$` and `\` inside, then every backslash doubled (the file's own string
/// escaping), and `%` as `%%`. `None` for a path with a control character,
/// which no entry can carry.
fn quote_exec(path: &str) -> Option<String> {
    if path.chars().any(char::is_control) {
        return None;
    }
    let mut out = String::with_capacity(path.len() + 2);
    out.push('"');
    for c in path.chars() {
        match c {
            '"' | '`' | '$' => {
                out.push_str("\\\\");
                out.push(c);
            }
            '\\' => out.push_str("\\\\\\\\"),
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out.push('"');
    Some(out)
}

/// The text of the entry that launches `exec`.
pub(crate) fn desktop_entry(exec: &Path) -> Option<String> {
    let exec = quote_exec(exec.to_str()?)?;
    Some(format!(
        "[Desktop Entry]\nType=Application\nName=OwnCord\nExec={exec}\nIcon=owncord-client\nNoDisplay=true\n{MARKER}\n"
    ))
}

/// Decide and act against explicit directories. `exec` is the program the
/// entry should launch.
fn ensure_in(user_dir: Option<&Path>, system_dirs: &[PathBuf], exec: Option<&Path>) -> Ensured {
    let name = file_name();
    let wanted = exec.and_then(desktop_entry);
    let user_file = user_dir.map(|dir| dir.join(&name));

    if let Some(file) = user_file.as_ref().filter(|file| file.is_file()) {
        let current = match std::fs::read_to_string(file) {
            Ok(text) => text,
            Err(e) => {
                log::warn!("[portal] cannot read {}: {e}", file.display());
                return Ensured::Present;
            }
        };
        return match wanted {
            Some(wanted) if current.contains(MARKER) && current != wanted => {
                write_entry(file, &wanted)
            }
            _ => Ensured::Present,
        };
    }
    if system_dirs.iter().any(|dir| dir.join(&name).is_file()) {
        return Ensured::Present;
    }
    match (user_file, wanted) {
        (Some(file), Some(wanted)) => write_entry(&file, &wanted),
        _ => {
            log::warn!("[portal] no place or program path to write the desktop entry");
            Ensured::Failed
        }
    }
}

/// Write through a temporary file and a rename, so the portal never reads half
/// an entry.
fn write_entry(file: &Path, text: &str) -> Ensured {
    match crate::json_store::write_atomic(file, text.as_bytes()) {
        Ok(()) => Ensured::Written,
        Err(e) => {
            log::warn!("[portal] cannot write {}: {e}", file.display());
            Ensured::Failed
        }
    }
}

/// Make sure a desktop entry named for the app id exists where the portal
/// looks, writing a hidden one to the user's applications directory when none
/// does.
pub(crate) fn ensure_desktop_entry() -> Ensured {
    let var = |name: &str| std::env::var(name).ok();
    let (xdg_data_home, home, xdg_data_dirs, appdir) = (
        var("XDG_DATA_HOME"),
        var("HOME"),
        var("XDG_DATA_DIRS"),
        var("APPDIR"),
    );
    let env = DirEnv {
        xdg_data_home: xdg_data_home.as_deref(),
        home: home.as_deref(),
        xdg_data_dirs: xdg_data_dirs.as_deref(),
        appdir: appdir.as_deref(),
    };
    let exec = var("APPIMAGE")
        .and_then(|v| absolute(&v))
        .or_else(|| std::env::current_exe().ok());
    ensure_in(
        user_applications_dir(env).as_deref(),
        &system_applications_dirs(env),
        exec.as_deref(),
    )
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // tests plant desktop entries directly
mod tests {
    use super::*;

    /// A scratch directory removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "owncord-portal-app-id-{}-{tag}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create the scratch directory");
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn app_id_is_the_bundle_identifier() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(conf["identifier"], APP_ID);
    }

    #[test]
    fn user_dir_prefers_an_absolute_xdg_data_home() {
        let env = DirEnv {
            xdg_data_home: Some("/data"),
            home: Some("/home/u"),
            ..DirEnv::default()
        };
        assert_eq!(
            user_applications_dir(env),
            Some(PathBuf::from("/data/applications"))
        );
        let relative = DirEnv {
            xdg_data_home: Some("data"),
            home: Some("/home/u"),
            ..DirEnv::default()
        };
        assert_eq!(
            user_applications_dir(relative),
            Some(PathBuf::from("/home/u/.local/share/applications"))
        );
        let empty = DirEnv {
            xdg_data_home: Some(""),
            home: Some("/home/u"),
            ..DirEnv::default()
        };
        assert_eq!(
            user_applications_dir(empty),
            Some(PathBuf::from("/home/u/.local/share/applications"))
        );
        assert_eq!(user_applications_dir(DirEnv::default()), None);
    }

    #[test]
    fn system_dirs_default_split_and_skip_relative_and_appdir() {
        assert_eq!(
            system_applications_dirs(DirEnv::default()),
            vec![
                PathBuf::from("/usr/local/share/applications"),
                PathBuf::from("/usr/share/applications")
            ]
        );
        let env = DirEnv {
            xdg_data_dirs: Some("/tmp/.mount_Own/usr/share:rel/share:/opt/share:/usr/share"),
            appdir: Some("/tmp/.mount_Own"),
            ..DirEnv::default()
        };
        assert_eq!(
            system_applications_dirs(env),
            vec![
                PathBuf::from("/opt/share/applications"),
                PathBuf::from("/usr/share/applications")
            ]
        );
        let sibling = DirEnv {
            xdg_data_dirs: Some("/tmp/.mount_Own2/usr/share"),
            appdir: Some("/tmp/.mount_Own"),
            ..DirEnv::default()
        };
        assert_eq!(
            system_applications_dirs(sibling),
            vec![PathBuf::from("/tmp/.mount_Own2/usr/share/applications")],
            "a sibling with a common prefix is not under APPDIR"
        );
    }

    #[test]
    fn exec_quoting_follows_the_desktop_entry_spec() {
        assert_eq!(
            quote_exec("/opt/own cord/app").unwrap(),
            "\"/opt/own cord/app\""
        );
        assert_eq!(quote_exec("/a\"b").unwrap(), "\"/a\\\\\"b\"");
        assert_eq!(quote_exec("/a`b$c").unwrap(), "\"/a\\\\`b\\\\$c\"");
        assert_eq!(quote_exec("/a\\b").unwrap(), "\"/a\\\\\\\\b\"");
        assert_eq!(quote_exec("/100%").unwrap(), "\"/100%%\"");
        assert_eq!(quote_exec("/a\nb"), None);
        assert_eq!(quote_exec("/a\tb"), None);
    }

    #[test]
    fn entry_text_is_hidden_and_marked() {
        let text = desktop_entry(Path::new("/opt/OwnCord.AppImage")).unwrap();
        assert_eq!(
            text,
            "[Desktop Entry]\nType=Application\nName=OwnCord\nExec=\"/opt/OwnCord.AppImage\"\nIcon=owncord-client\nNoDisplay=true\nX-OwnCord-Generated=true\n"
        );
        assert_eq!(desktop_entry(Path::new("/bad\npath")), None);
    }

    #[test]
    fn a_missing_entry_is_written_once_and_then_present() {
        let scratch = Scratch::new("write");
        let user = scratch.0.join("home/applications");
        let exec = Path::new("/opt/OwnCord.AppImage");
        assert_eq!(ensure_in(Some(&user), &[], Some(exec)), Ensured::Written);
        let file = user.join("com.owncord.client.desktop");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            desktop_entry(exec).unwrap()
        );
        assert_eq!(ensure_in(Some(&user), &[], Some(exec)), Ensured::Present);
        assert!(!user.join("com.owncord.client.desktop.tmp").exists());
    }

    #[test]
    fn a_generated_entry_follows_a_moved_appimage() {
        let scratch = Scratch::new("moved");
        let user = scratch.0.join("applications");
        assert_eq!(
            ensure_in(Some(&user), &[], Some(Path::new("/old/OwnCord.AppImage"))),
            Ensured::Written
        );
        let moved = Path::new("/new/OwnCord.AppImage");
        assert_eq!(ensure_in(Some(&user), &[], Some(moved)), Ensured::Written);
        let text = std::fs::read_to_string(user.join("com.owncord.client.desktop")).unwrap();
        assert_eq!(text, desktop_entry(moved).unwrap());
    }

    #[test]
    fn an_entry_without_the_marker_is_never_rewritten() {
        let scratch = Scratch::new("foreign");
        let user = scratch.0.join("applications");
        std::fs::create_dir_all(&user).unwrap();
        let file = user.join("com.owncord.client.desktop");
        std::fs::write(&file, "[Desktop Entry]\nName=Mine\n").unwrap();
        assert_eq!(
            ensure_in(Some(&user), &[], Some(Path::new("/x"))),
            Ensured::Present
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "[Desktop Entry]\nName=Mine\n"
        );
    }

    #[test]
    fn a_system_entry_is_enough() {
        let scratch = Scratch::new("system");
        let user = scratch.0.join("user/applications");
        let system = scratch.0.join("system/applications");
        std::fs::create_dir_all(&system).unwrap();
        std::fs::write(system.join("com.owncord.client.desktop"), "x").unwrap();
        assert_eq!(
            ensure_in(Some(&user), &[system], Some(Path::new("/x"))),
            Ensured::Present
        );
        assert!(!user.exists(), "nothing is written when one exists");
    }

    #[test]
    fn nothing_to_write_with_fails() {
        let scratch = Scratch::new("fail");
        let user = scratch.0.join("applications");
        assert_eq!(ensure_in(None, &[], Some(Path::new("/x"))), Ensured::Failed);
        assert_eq!(ensure_in(Some(&user), &[], None), Ensured::Failed);
        assert_eq!(
            ensure_in(Some(&user), &[], Some(Path::new("/bad\npath"))),
            Ensured::Failed
        );
        // A user directory that is really a file cannot be created.
        let blocker = scratch.0.join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        assert_eq!(
            ensure_in(
                Some(&blocker.join("applications")),
                &[],
                Some(Path::new("/x"))
            ),
            Ensured::Failed
        );
    }
}
