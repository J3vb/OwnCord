//! Opening links and folders in the system's default program.
//!
//! Everywhere except an AppImage this is `tauri-plugin-opener`, unchanged. An
//! AppImage's launcher (linuxdeploy's `AppRun` and its GTK/GStreamer hooks)
//! prefixes `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS` and friends with the
//! bundle's own directories, and the plugin spawns `xdg-open` with that
//! environment. The host program (a file manager, a browser) then loads the
//! bundle's libssl/libbrotli instead of its own and dies on a symbol error, so
//! "Open log folder" and every chat link did nothing.
//!
//! We cannot clear those variables in our own process (WebKitGTK's helper
//! processes need them), so the program we launch gets a cleaned copy: bundle
//! entries are dropped from every path-list variable, and the variables the
//! launcher invents (`APPDIR`, `GTK_THEME`, ...) are removed.

use std::path::Path;

/// URL schemes `open_external_url` accepts: the plugin's `opener:default` scope.
const ALLOWED_SCHEMES: [&str; 4] = ["http", "https", "mailto", "tel"];

/// Check `url` is one the renderer may open and return its normalised text.
fn checked_url(url: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if ALLOWED_SCHEMES.contains(&parsed.scheme()) {
        Ok(parsed.to_string())
    } else {
        Err(format!("url scheme not allowed: {}", parsed.scheme()))
    }
}

/// Open `url` (http, https, mailto or tel) in the default program. The
/// renderer's way to open a link: it reaches the same environment cleaning as
/// the tray's folder opener.
#[tauri::command(async)]
pub fn open_external_url(url: String) -> Result<(), String> {
    let url = checked_url(&url)?;
    open_url(&url)
}

/// Open `url` in the default browser or mail client.
pub(crate) fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Some(appdir) = appimage::appimage_dir() {
        return appimage::spawn_opener(url, &appdir);
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Open `path` (a file or folder) in the default program. Like the plugin, a
/// path that does not exist is an error.
pub(crate) fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Some(appdir) = appimage::appimage_dir() {
        path.metadata()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        return appimage::spawn_opener(&path.to_string_lossy(), &appdir);
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
mod appimage {
    use std::ffi::{OsStr, OsString};
    use std::io::ErrorKind;
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    /// Variables the AppImage launcher sets for itself alone: removed outright.
    const LAUNCHER_ONLY: [&str; 6] = [
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "OWD",
        // The GTK hook forces Adwaita whatever the user's theme is.
        "GTK_THEME",
        "GST_REGISTRY_REUSE_PLUGIN_SCANNER",
    ];

    /// One change to a child's environment.
    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum EnvEdit {
        Set(OsString, OsString),
        Remove(OsString),
    }

    /// The AppImage's mount directory, when we run from one: both `APPIMAGE`
    /// and `APPDIR` set and non-empty (the runtime sets both).
    pub(super) fn appimage_dir() -> Option<PathBuf> {
        let set = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        set("APPIMAGE")?;
        set("APPDIR").map(PathBuf::from)
    }

    /// Collapse runs of `/` and drop a trailing one (the GDK pixbuf hook writes
    /// `$APPDIR//usr/...`).
    fn normalise(path: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(path.len());
        for &b in path {
            if b == b'/' && out.last() == Some(&b'/') {
                continue;
            }
            out.push(b);
        }
        if out.len() > 1 && out.last() == Some(&b'/') {
            out.pop();
        }
        out
    }

    /// Whether `entry` is `appdir` itself or inside it, on a path-component
    /// boundary: `/tmp/.mount_abcd` is not inside `/tmp/.mount_abc`.
    fn inside(entry: &[u8], appdir: &[u8]) -> bool {
        let entry = normalise(entry);
        entry == appdir
            || (entry.len() > appdir.len()
                && entry.starts_with(appdir)
                && entry[appdir.len()] == b'/')
    }

    /// The environment edits that give a program we launch the host's
    /// environment instead of the AppImage's. Pure: `vars` is the environment
    /// to clean.
    pub(super) fn host_env(
        vars: impl IntoIterator<Item = (OsString, OsString)>,
        appdir: &Path,
    ) -> Vec<EnvEdit> {
        let appdir = normalise(appdir.as_os_str().as_bytes());
        let mut edits = Vec::new();
        for (name, value) in vars {
            if LAUNCHER_ONLY.iter().any(|n| OsStr::new(n) == name) {
                edits.push(EnvEdit::Remove(name));
                continue;
            }
            let parts: Vec<&[u8]> = value.as_bytes().split(|&b| b == b':').collect();
            let kept: Vec<&[u8]> = parts
                .iter()
                .copied()
                .filter(|p| !p.is_empty() && !inside(p, &appdir))
                .collect();
            let dropped_bundle = parts.iter().any(|p| !p.is_empty() && inside(p, &appdir));
            if !dropped_bundle {
                continue;
            }
            if kept.is_empty() {
                edits.push(EnvEdit::Remove(name));
            } else {
                edits.push(EnvEdit::Set(name, OsString::from_vec(kept.join(&b':'))));
            }
        }
        edits
    }

    /// Run `program` on `target` with the host environment, detached from our
    /// terminal and process group, and reap it on its own short-lived thread so
    /// it leaves no zombie. A missing program is `NotFound`, to try the next.
    fn spawn(program: &str, args: &[&str], edits: &[EnvEdit]) -> std::io::Result<()> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        for edit in edits {
            match edit {
                EnvEdit::Set(name, value) => command.env(name, value),
                EnvEdit::Remove(name) => command.env_remove(name),
            };
        }
        let mut child = command.spawn()?;
        let reaper = std::thread::Builder::new()
            .name("external-open-reaper".into())
            .spawn(move || {
                let _ = child.wait();
            });
        if let Err(e) = reaper {
            // The child runs on; it just stays a zombie until we exit.
            log::warn!("[open] cannot start the reaper thread: {e}");
        }
        Ok(())
    }

    /// `xdg-open target`, or `gio open target` when xdg-open is not installed.
    pub(super) fn spawn_opener(target: &str, appdir: &Path) -> Result<(), String> {
        let edits = host_env(std::env::vars_os(), appdir);
        match spawn("xdg-open", &[target], &edits) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => spawn("gio", &["open", target], &edits)
                .map_err(|e| format!("cannot open {target}: no xdg-open or gio ({e})")),
            Err(e) => Err(format!("cannot open {target}: {e}")),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
            pairs
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v)))
                .collect()
        }

        fn set(name: &str, value: &str) -> EnvEdit {
            EnvEdit::Set(name.into(), value.into())
        }

        fn remove(name: &str) -> EnvEdit {
            EnvEdit::Remove(name.into())
        }

        const APPDIR: &str = "/tmp/.mount_OwnCorabc123";

        #[test]
        fn a_mixed_var_keeps_its_host_part() {
            let edits = host_env(
                vars(&[
                    (
                        "XDG_DATA_DIRS",
                        "/tmp/.mount_OwnCorabc123/usr/share:/usr/share:/usr/local/share:",
                    ),
                    (
                        "PATH",
                        "/tmp/.mount_OwnCorabc123/usr/bin:/tmp/.mount_OwnCorabc123/usr/sbin:/usr/bin:/bin",
                    ),
                ]),
                Path::new(APPDIR),
            );
            assert_eq!(
                edits,
                [
                    set("XDG_DATA_DIRS", "/usr/share:/usr/local/share"),
                    set("PATH", "/usr/bin:/bin"),
                ]
            );
        }

        #[test]
        fn a_var_of_only_bundle_entries_is_removed() {
            let edits = host_env(
                vars(&[
                    (
                        "LD_LIBRARY_PATH",
                        "/tmp/.mount_OwnCorabc123/usr/lib:/tmp/.mount_OwnCorabc123/usr/lib64",
                    ),
                    (
                        "GDK_PIXBUF_MODULE_FILE",
                        "/tmp/.mount_OwnCorabc123//usr/lib/gdk-pixbuf/loaders.cache",
                    ),
                    ("GTK_EXE_PREFIX", "/tmp/.mount_OwnCorabc123/usr"),
                ]),
                Path::new(APPDIR),
            );
            assert_eq!(
                edits,
                [
                    remove("LD_LIBRARY_PATH"),
                    remove("GDK_PIXBUF_MODULE_FILE"),
                    remove("GTK_EXE_PREFIX"),
                ]
            );
        }

        #[test]
        fn a_sibling_dir_with_the_same_prefix_is_kept() {
            let edits = host_env(
                vars(&[
                    ("PATH", "/tmp/.mount_OwnCorabc1234/bin:/usr/bin"),
                    ("LD_LIBRARY_PATH", "/tmp/.mount_OwnCorabc1234/lib"),
                ]),
                Path::new(APPDIR),
            );
            assert_eq!(edits, []);
        }

        #[test]
        fn a_var_without_bundle_entries_is_left_alone() {
            let edits = host_env(
                vars(&[
                    ("PATH", "/usr/bin::/bin"),
                    ("HOME", "/home/me"),
                    ("EMPTY", ""),
                ]),
                Path::new(APPDIR),
            );
            assert_eq!(edits, []);
        }

        #[test]
        fn the_launchers_own_vars_are_removed() {
            let edits = host_env(
                vars(&[
                    ("APPDIR", APPDIR),
                    ("APPIMAGE", "/home/me/OwnCord.AppImage"),
                    ("ARGV0", "OwnCord.AppImage"),
                    ("OWD", "/home/me"),
                    ("GTK_THEME", "Adwaita:dark"),
                    ("GST_REGISTRY_REUSE_PLUGIN_SCANNER", "no"),
                    ("LANG", "C.UTF-8"),
                ]),
                Path::new(APPDIR),
            );
            assert_eq!(
                edits,
                [
                    remove("APPDIR"),
                    remove("APPIMAGE"),
                    remove("ARGV0"),
                    remove("OWD"),
                    remove("GTK_THEME"),
                    remove("GST_REGISTRY_REUSE_PLUGIN_SCANNER"),
                ]
            );
        }

        #[test]
        fn a_trailing_slash_on_appdir_still_matches() {
            let edits = host_env(
                vars(&[("PYTHONPATH", "/tmp/.mount_OwnCorabc123/usr/lib/python3")]),
                Path::new("/tmp/.mount_OwnCorabc123/"),
            );
            assert_eq!(edits, [remove("PYTHONPATH")]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_contact_schemes_open() {
        for ok in [
            "https://example.com/a?b=c",
            "http://example.com",
            "mailto:me@example.com",
            "tel:+15551234",
        ] {
            assert!(checked_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "owncord://channel/1",
            "ssh://host",
            "not a url",
            "",
        ] {
            assert!(checked_url(bad).is_err(), "{bad}");
        }
    }
}
