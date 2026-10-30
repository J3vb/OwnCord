//! Android update install. The updater plugin checks and downloads with the
//! same endpoint, TLS pin and signing key as the desktop app, but it cannot
//! install on Android. The verified APK goes to the cache `updates/` folder and
//! Android's package installer opens on it. An app installed outside a store
//! cannot skip that prompt: the user confirms with Install, and Android keeps
//! the app's data.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Wry};

use super::{
    build_updater, updater_public_key, verify_apk_artifact, DownloadProgress, InstallGuard,
    ANDROID_UPDATE_TARGET, UPDATE_IN_PROGRESS,
};
use crate::text;

/// Shared with `res/xml/file_paths.xml` and `ApkInstallerPlugin.kt`, which
/// open only files in this folder.
const UPDATES_DIR: &str = "updates";
const UPDATE_APK: &str = "owncord-update.apk";

struct ApkInstaller(PluginHandle<Wry>);

/// Registers `ApkInstallerPlugin.kt`, the Kotlin half that opens the installer.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-apk-installer")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle = api.register_android_plugin("com.owncord.client", "ApkInstallerPlugin")?;
            app.manage(ApkInstaller(handle));
            Ok(())
        })
        .build()
}

/// Android's half of `build_updater`: ask for the APK by its whole target, and
/// give the plugin an executable path, since it resolves an install folder
/// from one that Android never uses.
pub(super) fn configure(
    app: &AppHandle,
    builder: tauri_plugin_updater::UpdaterBuilder,
) -> Result<tauri_plugin_updater::UpdaterBuilder, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("failed to set up the updater: {e}"))?;
    Ok(builder
        .target(ANDROID_UPDATE_TARGET)
        .executable_path(cache.join(UPDATES_DIR).join(UPDATE_APK)))
}

#[derive(Serialize)]
struct InstallArgs {
    path: String,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
enum InstallerStatus {
    InstallerOpened,
    PermissionNeeded,
}

#[derive(Deserialize)]
struct InstallerResponse {
    status: InstallerStatus,
}

/// Download the offered APK, check it, and open Android's installer on it.
/// Returns once the installer is showing; Android replaces the running app
/// after the user taps Install. When OwnCord may not install apps yet, the
/// Kotlin side opens that settings page and this returns
/// `text::UPDATE_INSTALL_PERMISSION` so the banner can say what to do.
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle, server_url: String) -> Result<(), String> {
    // Released when this returns: the user can cancel Android's prompt, and
    // the next tap must be able to start again.
    let _guard = InstallGuard::acquire(&UPDATE_IN_PROGRESS)?;
    let updater = build_updater(&app, &server_url)?.updater;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?
        .ok_or_else(|| "no update available".to_string())?;

    let progress_app = app.clone();
    let mut received: u64 = 0;
    let bytes = update
        .download(
            move |chunk_len, total| {
                received += chunk_len as u64;
                let _ = progress_app.emit("update-progress", DownloadProgress { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("download/install failed: {e}"))?;
    verify_apk_artifact(&bytes, &update.signature, updater_public_key(&app)?)
        .map_err(|e| format!("download/install failed: {e}"))?;
    log::info!(
        "[update] APK downloaded ({} bytes) for version {}",
        bytes.len(),
        update.version
    );

    let path = write_update_apk(&app, &bytes)?;
    let installer = app.state::<ApkInstaller>();
    let response: InstallerResponse = installer
        .0
        .run_mobile_plugin_async(
            "installApk",
            InstallArgs {
                path: path.to_string_lossy().into_owned(),
            },
        )
        .await
        .map_err(|e| format!("download/install failed: {e}"))?;
    match response.status {
        InstallerStatus::InstallerOpened => {
            log::info!(
                "[update] Android installer opened for version {}",
                update.version
            );
            // Tells the webview not to relaunch: Android restarts the app
            // itself once the user taps Install.
            let _ = app.emit("update-installer-opened", ());
            Ok(())
        }
        InstallerStatus::PermissionNeeded => Err(text::UPDATE_INSTALL_PERMISSION.into()),
    }
}

/// Replace whatever an earlier attempt left in `updates/` with this APK.
/// `write_atomic` writes a temporary file and renames it, so the installer
/// never sees a half-written APK.
fn write_update_apk(app: &AppHandle, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("download/install failed: {e}"))?
        .join(UPDATES_DIR);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("download/install failed: {e}"))?;
    }
    let path = dir.join(UPDATE_APK);
    crate::json_store::write_atomic(&path, bytes)
        .map_err(|e| format!("download/install failed: {e}"))?;
    Ok(path)
}
