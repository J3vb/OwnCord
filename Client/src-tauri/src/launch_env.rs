//! Process setup that has to happen before GTK, GLib or GStreamer start
//! (Linux): `main` calls [`crate::prepare_linux_launch`] first, while the
//! process still has one thread. Tauri's path resolver does not exist yet, so
//! the directories are worked out here the way it works them out.
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The bundle identifier (`tauri.conf.json`), which names the app's own
/// directories.
const IDENTIFIER: &str = "com.owncord.client";

/// An XDG base directory: the variable when it holds an absolute path,
/// otherwise `fallback` under the home directory.
fn xdg_dir(var: Option<OsString>, home: Option<OsString>, fallback: &str) -> Option<PathBuf> {
    var.map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            home.filter(|h| !h.is_empty())
                .map(|h| PathBuf::from(h).join(fallback))
        })
}

/// The directory Tauri's `app_log_dir` resolves to on Linux.
pub(crate) fn log_dir() -> Option<PathBuf> {
    let data = xdg_dir(
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("HOME"),
        ".local/share",
    )?;
    Some(data.join(IDENTIFIER).join("logs"))
}

/// The registry [`use_private_gstreamer_registry`] set, if it did.
static OWN_REGISTRY: OnceLock<PathBuf> = OnceLock::new();

/// Inside an AppImage, give the bundled GStreamer a plugin registry of its
/// own. Its plugins sit under a mount path that changes on every launch, so
/// with the shared `~/.cache/gstreamer-1.0` registry each run rewrote the
/// host's cache with paths gone by the next, and the host's media apps
/// rescanned every plugin after each OwnCord run. OwnCord still rescans its
/// own bundled plugins each launch; the host's cache now stays valid. A
/// registry the user chose is left alone; child processes never see this one
/// (`external_open.rs`).
pub(crate) fn use_private_gstreamer_registry() {
    let set = |name: &str| std::env::var_os(name).is_some_and(|v| !v.is_empty());
    let in_appimage = set("APPIMAGE") && set("APPDIR");
    let user_chose = set("GST_REGISTRY_1_0") || set("GST_REGISTRY");
    let cache = xdg_dir(
        std::env::var_os("XDG_CACHE_HOME"),
        std::env::var_os("HOME"),
        ".cache",
    );
    let Some(registry) = private_registry(in_appimage, user_chose, cache.as_deref()) else {
        return;
    };
    // Made here so the first write never fails on a missing folder.
    if let Some(dir) = registry.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    std::env::set_var("GST_REGISTRY_1_0", &registry);
    let _ = OWN_REGISTRY.set(registry);
}

/// The GStreamer registry set at launch, for keeping it out of the programs
/// we start.
pub(crate) fn own_gstreamer_registry() -> Option<&'static Path> {
    OWN_REGISTRY.get().map(PathBuf::as_path)
}

/// The registry file to use, or `None` to keep GStreamer's default.
fn private_registry(in_appimage: bool, user_chose: bool, cache: Option<&Path>) -> Option<PathBuf> {
    if !in_appimage || user_chose {
        return None;
    }
    Some(
        cache?
            .join(IDENTIFIER)
            .join("gstreamer-1.0")
            .join(format!("registry.{}.bin", std::env::consts::ARCH)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_directories_follow_xdg_with_the_home_fallback() {
        let home = || Some(OsString::from("/home/u"));
        assert_eq!(
            xdg_dir(Some("/data".into()), home(), ".local/share"),
            Some(PathBuf::from("/data"))
        );
        // A relative value is invalid per the XDG spec and ignored.
        assert_eq!(
            xdg_dir(Some("data".into()), home(), ".local/share"),
            Some(PathBuf::from("/home/u/.local/share"))
        );
        assert_eq!(
            xdg_dir(None, home(), ".cache"),
            Some(PathBuf::from("/home/u/.cache"))
        );
        assert_eq!(xdg_dir(None, Some(OsString::new()), ".cache"), None);
    }

    #[test]
    fn only_an_appimage_without_a_chosen_registry_gets_its_own() {
        let cache = Path::new("/home/u/.cache");
        let own = private_registry(true, false, Some(cache)).unwrap();
        assert!(own.starts_with("/home/u/.cache/com.owncord.client/gstreamer-1.0"));
        assert_eq!(private_registry(false, false, Some(cache)), None);
        assert_eq!(private_registry(true, true, Some(cache)), None);
        assert_eq!(private_registry(true, false, None), None);
    }

    /// The directories are worked out before Tauri starts; they must be the
    /// ones its path resolver gives once it has.
    #[test]
    fn the_identifier_is_the_bundle_identifier_with_no_directory_override() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
        assert!(config["app"].get("appDirectoriesOverride").is_none());
    }
}
