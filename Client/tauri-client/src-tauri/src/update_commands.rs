use std::sync::Arc;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::livekit_proxy::{cert_store_key, load_stored_fingerprint, PinnedVerifier};

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
}

/// Extract the host (with port if non-443) from an https:// URL for cert store lookup.
fn extract_host_for_cert_store(server_url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(server_url)
        .map_err(|e| format!("failed to parse server URL: {e}"))?;
    let host = parsed.host_str()
        .ok_or_else(|| "server URL has no host".to_string())?;
    let port = parsed.port().unwrap_or(443);
    let raw = if port == 443 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    Ok(cert_store_key(&raw))
}

/// Build a rustls ClientConfig that validates the server cert against the
/// TOFU-pinned fingerprint. Falls back to system certs if no fingerprint
/// is stored (server uses a real CA cert).
fn build_tls_config(app: &AppHandle, server_url: &str) -> Result<Option<rustls::ClientConfig>, String> {
    let store_key = extract_host_for_cert_store(server_url)?;
    let fingerprint = load_stored_fingerprint(app, &store_key)?;
    match fingerprint {
        Some(fp) => {
            let config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(PinnedVerifier::new(fp)))
                .with_no_client_auth();
            Ok(Some(config))
        }
        None => {
            // No TOFU fingerprint stored — use system TLS (works for CA-signed certs).
            Ok(None)
        }
    }
}

/// Validate that a server URL is safe for the updater to connect to.
fn validate_server_url(server_url: &str) -> Result<(), String> {
    let trimmed = server_url.trim_end_matches('/');
    if !trimmed.starts_with("https://") {
        return Err("server_url must use https:// scheme".into());
    }
    // Reject URLs with userinfo (e.g. "https://evil@host")
    if let Ok(parsed) = url::Url::parse(trimmed) {
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("server_url must not contain userinfo".into());
        }
    }
    Ok(())
}

/// Check for a client update using the given server URL to build the endpoint
/// dynamically. This is required because OwnCord is self-hosted and the
/// server address varies per user.
#[tauri::command]
pub async fn check_client_update(
    app: AppHandle,
    server_url: String,
) -> Result<UpdateCheckResult, String> {
    validate_server_url(&server_url)?;

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

    // Use TOFU-pinned certificate for self-signed servers, or system certs
    // for CA-signed servers. Never blindly accept invalid certs (BUG-134).
    let tls_config = build_tls_config(&app, &server_url)?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?;
    if let Some(config) = tls_config {
        let config = Arc::new(config);
        builder = builder.configure_client(move |client| {
            client.use_preconfigured_tls((*config).clone())
        });
    }
    let updater = builder
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
    validate_server_url(&server_url)?;

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

    // Use TOFU-pinned certificate for self-signed servers (BUG-134).
    let tls_config = build_tls_config(&app, &server_url)?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?;
    if let Some(config) = tls_config {
        let config = Arc::new(config);
        builder = builder.configure_client(move |client| {
            client.use_preconfigured_tls((*config).clone())
        });
    }
    let updater = builder
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
