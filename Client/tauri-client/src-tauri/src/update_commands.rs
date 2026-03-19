use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
}

/// Check for a client update using the given server URL to build the endpoint
/// dynamically. This is required because OwnCord is self-hosted and the
/// server address varies per user.
#[tauri::command]
pub async fn check_client_update(
    app: AppHandle,
    server_url: String,
) -> Result<UpdateCheckResult, String> {
    let current_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    let endpoint = format!(
        "{}/api/v1/client-update/{{{{target}}}}/{}",
        server_url.trim_end_matches('/'),
        current_version,
    );

    let url: url::Url = endpoint
        .parse()
        .map_err(|e: url::ParseError| format!("bad endpoint URL: {e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?
        .build()
        .map_err(|e| format!("failed to build updater: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    match update {
        Some(u) => Ok(UpdateCheckResult {
            available: true,
            version: Some(u.version.clone()),
            body: Some(u.body.clone().unwrap_or_default()),
        }),
        None => Ok(UpdateCheckResult {
            available: false,
            version: None,
            body: None,
        }),
    }
}

/// Download and install a pending update, then signal the frontend.
/// The frontend should call `relaunch()` from @tauri-apps/plugin-process
/// after this completes.
#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    server_url: String,
) -> Result<(), String> {
    let current_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    let endpoint = format!(
        "{}/api/v1/client-update/{{{{target}}}}/{}",
        server_url.trim_end_matches('/'),
        current_version,
    );

    let url: url::Url = endpoint
        .parse()
        .map_err(|e: url::ParseError| format!("bad endpoint URL: {e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?
        .build()
        .map_err(|e| format!("failed to build updater: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    match update {
        Some(u) => {
            u.download_and_install(|_chunk_len, _total| {}, || {})
                .await
                .map_err(|e| format!("download/install failed: {e}"))?;
            Ok(())
        }
        None => Err("no update available".into()),
    }
}
