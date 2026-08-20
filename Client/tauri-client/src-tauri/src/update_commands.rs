use std::sync::Arc;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::tofu::{cert_store_key, load_stored_fingerprint, HostScopedVerifier};

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
}

/// Download progress, emitted to the webview as `update-progress` so the banner
/// can show a percentage/bytes instead of looking hung. `total` is None until
/// the server sends a Content-Length.
#[derive(Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
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

/// Build a rustls ClientConfig for the updater. When a TOFU fingerprint is
/// stored, the pin is enforced for the OwnCord server's host ONLY — the same
/// HTTP client also downloads the installer from GitHub, whose certificate
/// must pass normal web-PKI validation instead (a client-wide pin would
/// reject it and every install would fail).
fn build_tls_config(app: &AppHandle, server_url: &str) -> Result<Option<rustls::ClientConfig>, String> {
    let store_key = extract_host_for_cert_store(server_url)?;
    let fingerprint = load_stored_fingerprint(app, &store_key)?;
    match fingerprint {
        Some(fp) => {
            let parsed = url::Url::parse(server_url)
                .map_err(|e| format!("failed to parse server URL: {e}"))?;
            let host = parsed
                .host_str()
                .ok_or_else(|| "server URL has no host".to_string())?;
            let verifier = HostScopedVerifier::new(host.to_string(), fp)?;
            let config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth();
            Ok(Some(config))
        }
        None => {
            // No TOFU fingerprint stored — use system TLS (works for CA-signed certs).
            Ok(None)
        }
    }
}

/// Tauri updater endpoint on the given server. `{{target}}-{{arch}}-{{bundle_type}}`
/// (expanded by the updater plugin to e.g. "windows-x86_64-nsis") must match
/// the `{os}-{arch}-{installer}` key the plugin looks up FIRST in the response
/// `platforms` map — the server echoes this path segment back as that key.
/// The bundle type matters: a deb-installed client must get 204, not the
/// AppImage archive, or its install step rejects every update.
fn build_update_endpoint(server_url: &str, current_version: &str) -> String {
    format!(
        "{}/api/v1/client-update/{{{{target}}}}-{{{{arch}}}}-{{{{bundle_type}}}}/{}",
        server_url.trim_end_matches('/'),
        current_version,
    )
}

/// Build an updater wired to the given OwnCord server: dynamic endpoint plus
/// host-scoped TOFU TLS. Shared by check and install so the two paths can
/// never diverge on endpoint format or trust configuration.
fn build_updater(
    app: &AppHandle,
    server_url: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    validate_server_url(server_url)?;

    let current_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    let endpoint = build_update_endpoint(server_url, &current_version);
    let url: url::Url = endpoint
        .parse()
        .map_err(|e: url::ParseError| format!("bad endpoint URL: {e}"))?;

    // Use TOFU-pinned certificate for self-signed servers, or system certs
    // for CA-signed servers. Never blindly accept invalid certs (BUG-134).
    let tls_config = build_tls_config(app, server_url)?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?;
    if let Some(config) = tls_config {
        let config = Arc::new(config);
        builder =
            builder.configure_client(move |client| client.use_preconfigured_tls((*config).clone()));
    }
    builder
        .build()
        .map_err(|e| format!("failed to build updater: {e}"))
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
    let updater = build_updater(&app, &server_url)?;

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
    let updater = build_updater(&app, &server_url)?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    match update {
        Some(u) => {
            // Accumulate downloaded bytes and emit progress to the webview.
            // A failed emit must never abort the install, hence `let _ =`.
            let progress_app = app.clone();
            let mut received: u64 = 0;
            u.download_and_install(
                move |chunk_len, total| {
                    received += chunk_len as u64;
                    let _ =
                        progress_app.emit("update-progress", DownloadProgress { received, total });
                },
                || {},
            )
            .await
            .map_err(|e| format!("download/install failed: {e}"))?;
            Ok(())
        }
        None => Err("no update available".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_includes_target_arch_and_bundle_type_variables() {
        // "{{target}}-{{arch}}-{{bundle_type}}" (e.g. "windows-x86_64-nsis")
        // must match the "{os}-{arch}-{installer}" key the updater plugin
        // looks up first in the response platforms map — the server echoes
        // this path segment back as that key.
        assert_eq!(
            build_update_endpoint("https://chat.example.com/", "1.2.3"),
            "https://chat.example.com/api/v1/client-update/{{target}}-{{arch}}-{{bundle_type}}/1.2.3"
        );
    }

    #[test]
    fn endpoint_keeps_non_default_port() {
        assert_eq!(
            build_update_endpoint("https://chat.example.com:8443", "0.0.0"),
            "https://chat.example.com:8443/api/v1/client-update/{{target}}-{{arch}}-{{bundle_type}}/0.0.0"
        );
    }

    #[test]
    fn validate_server_url_rejects_unsafe_urls() {
        // build_updater() calls this first, so it is the only guard before the
        // updater downloads and runs an installer from this host.
        let scheme = "server_url must use https:// scheme";
        let userinfo = "server_url must not contain userinfo";
        for (url, want_err) in [
            ("http://chat.example.com", scheme),
            ("ftp://chat.example.com", scheme),
            ("chat.example.com", scheme),
            // Case-sensitive on purpose: anything not literally https:// is out.
            ("HTTPS://chat.example.com", scheme),
            ("https://evil@chat.example.com", userinfo),
            ("https://user:pass@chat.example.com", userinfo),
            ("https://:pass@chat.example.com", userinfo),
        ] {
            assert_eq!(
                validate_server_url(url),
                Err(want_err.to_string()),
                "expected {url} to be rejected"
            );
        }
    }

    #[test]
    fn validate_server_url_accepts_plain_https() {
        for url in [
            "https://chat.example.com",
            "https://chat.example.com/",
            "https://chat.example.com:8443/",
        ] {
            assert_eq!(validate_server_url(url), Ok(()), "expected {url} to pass");
        }
    }
}
