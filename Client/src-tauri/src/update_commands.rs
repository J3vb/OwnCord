use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::utils::{config::BundleType, platform::bundle_type};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::tofu::{cert_store_key, load_stored_fingerprint, HostScopedVerifier};

const UPDATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_READ_TIMEOUT: Duration = Duration::from_secs(30);

// The native operation outlives a webview notifier and server switches. Keep
// its ownership here so a remount (or another invoke) cannot start a second
// installer against the same executable.
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// Set once the download is done and `install()` is about to be called. From
// that point the old process still owns the single-instance mutex while
// `ShellExecuteW` waits for the installer, so the single-instance callback must
// stop restoring the old window for any forwarded launch (shortcut click,
// owncord:// link, autostart): doing so puts the old UI back for the whole gap.
static INSTALLER_LAUNCHING: AtomicBool = AtomicBool::new(false);

/// True while `install()` runs (on Windows, until the process exits). Read by the
/// single-instance callback (`lib.rs`) to ignore forwarded launches.
pub(crate) fn installer_launching() -> bool {
    INSTALLER_LAUNCHING.load(Ordering::SeqCst)
}

/// True for the whole download+install operation; logged by the single-instance
/// callback so a report shows whether a forwarded launch landed mid-update.
pub(crate) fn update_in_progress() -> bool {
    UPDATE_IN_PROGRESS.load(Ordering::SeqCst)
}

struct InstallGuard<'a> {
    active: &'a AtomicBool,
    installed: bool,
}

impl<'a> InstallGuard<'a> {
    fn acquire(active: &'a AtomicBool) -> Result<Self, String> {
        active
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "an update is already in progress or waiting for restart".to_string())?;
        Ok(Self {
            active,
            installed: false,
        })
    }

    fn installed(mut self) {
        // Linux returns after replacing the AppImage, before the frontend
        // relaunches. Its running version is still old in that interval, so
        // retain ownership until process exit even if relaunch fails.
        self.installed = true;
    }
}

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        if !self.installed {
            // Every error and dropped/cancelled future can be retried.
            self.active.store(false, Ordering::Release);
        }
    }
}

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
    /// True when this install kind cannot update itself at all, so
    /// `available: false` must not be read as "you are up to date".
    pub manual_upgrade: bool,
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
    let parsed =
        url::Url::parse(server_url).map_err(|e| format!("failed to parse server URL: {e}"))?;
    let host = parsed
        .host_str()
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
fn build_tls_config(
    app: &AppHandle,
    server_url: &str,
) -> Result<Option<rustls::ClientConfig>, String> {
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
    app.updater_builder()
        .pubkey(updater_public_key(app)?)
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?
        .configure_client(move |client| {
            // This callback applies to both metadata checks and downloads.
            // UpdaterBuilder::timeout only bounds checks through updater 2.13;
            // its returned Update has no timeout. Bound idle reads instead
            // of total download time so slow, progressing downloads finish.
            let client = client
                .connect_timeout(UPDATE_CONNECT_TIMEOUT)
                .read_timeout(UPDATE_READ_TIMEOUT);
            match &tls_config {
                Some(config) => client.use_preconfigured_tls(config.clone()),
                None => client,
            }
        })
        .build()
        .map_err(|e| format!("failed to build updater: {e}"))
}

/// Use one configured trust anchor for the plugin and the artifact-name check.
fn updater_public_key(app: &AppHandle) -> Result<&str, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "updater public key is not configured".to_string())
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

/// Whether an install packaged this way can ever update itself from an OwnCord
/// server.
///
/// The release publishes signed updater artifacts for the appimage and nsis
/// targets only, and the server answers every other target with 204
/// (`Server/updater/assets.go`, `TestClientUpdate_DebTargetNoContent`). A .deb
/// or .rpm client therefore gets `None` from `check()` whether or not it is
/// behind — indistinguishable from an up-to-date one. `bundle_type()` is the
/// type the bundler patched into this binary, i.e. how it was packaged, which
/// is what decides whether any updater artifact exists for it. An unpatched or
/// tarball binary reports no type and stays silent rather than guessing.
fn cannot_self_update(bundle: Option<&BundleType>) -> bool {
    matches!(bundle, Some(BundleType::Deb | BundleType::Rpm))
}

/// Whether the artifact a release offers is built for the given machine target
/// (`{os}-{arch}` in the updater plugin's spelling, e.g. `windows-x86_64`).
///
/// Used for both the offered URL and the authenticated artifact name. The URL
/// check is a preflight filter; the signed name is checked again after download
/// and before installation. Names without an OS and architecture fail closed.
fn artifact_matches_target(download_url: &str, machine_target: &str) -> bool {
    let Some((machine_os, machine_arch)) = machine_target.split_once('-') else {
        return false;
    };

    let filename = download_url
        .rsplit('/')
        .next()
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("");

    let tokens: Vec<String> = filename
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();

    let mut seen_arch: Option<&'static str> = None;
    let mut seen_os: Option<&'static str> = None;
    for (index, token) in tokens.iter().enumerate() {
        if seen_arch.is_none() {
            let is_x86_64 =
                token == "x86" && tokens.get(index + 1).map(String::as_str) == Some("64");
            seen_arch = plugin_arch(if is_x86_64 { "x86_64" } else { token });
        }
        if seen_os.is_none() {
            seen_os = plugin_os(token);
        }
    }

    match (seen_arch, seen_os) {
        (Some(arch), Some(os)) => arch == machine_arch && os == machine_os,
        _ => false,
    }
}

/// Wrap `artifact_matches_target` for the running machine.
fn artifact_matches_this_machine(download_url: &str) -> bool {
    tauri_plugin_updater::target().is_none_or(|t| artifact_matches_target(download_url, &t))
}

/// Map a file-name token to the updater plugin's architecture spelling.
fn plugin_arch(token: &str) -> Option<&'static str> {
    match token {
        "x86_64" | "x64" | "amd64" => Some("x86_64"),
        "aarch64" | "arm64" => Some("aarch64"),
        "i686" | "i386" | "ia32" | "x86" => Some("i686"),
        "armv7" | "arm" => Some("armv7"),
        "riscv64" => Some("riscv64"),
        _ => None,
    }
}

/// Map a file-name token to the updater plugin's OS spelling. Bare `app` is
/// deliberately absent: it appears in product names and `appimage` is handled
/// separately, so mapping it would misread unrelated names.
fn plugin_os(token: &str) -> Option<&'static str> {
    match token {
        "windows" | "win" | "nsis" | "msi" | "exe" => Some("windows"),
        "linux" | "appimage" | "deb" | "rpm" => Some("linux"),
        "darwin" | "macos" | "dmg" => Some("darwin"),
        _ => None,
    }
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
        Some(u) if artifact_matches_this_machine(u.download_url.as_str()) => {
            Ok(UpdateCheckResult {
                available: true,
                version: Some(u.version.clone()),
                body: Some(u.body.clone().unwrap_or_default()),
                manual_upgrade: false,
            })
        }
        // An offered file built for another OS or processor is not an update
        // this machine can take, so it must not raise the banner. The install
        // path refuses it too; this keeps the two commands from disagreeing.
        Some(u) => {
            log::warn!(
                "[update] ignoring version {}: offered artifact is not for this machine",
                u.version
            );
            Ok(UpdateCheckResult {
                available: false,
                version: None,
                body: None,
                manual_upgrade: false,
            })
        }
        None => Ok(UpdateCheckResult {
            available: false,
            version: None,
            body: None,
            manual_upgrade: cannot_self_update(bundle_type().as_ref()),
        }),
    }
}

/// Authenticate the signed name before interpreting its target. The plugin
/// exposes the encoded signature, but not its verified trusted comment, so
/// use its verifier and trust anchor again, including the global signature.
fn verify_artifact_target(
    bytes: &[u8],
    signature: &str,
    pubkey: &str,
    target: &str,
    bundle: &BundleType,
) -> Result<(), String> {
    let decode = |encoded: &str| -> Result<String, String> {
        let decoded = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        String::from_utf8(decoded).map_err(|e| e.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(pubkey)?).map_err(|e| e.to_string())?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature, true)
        .map_err(|e| e.to_string())?;

    let mut files = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|field| field.strip_prefix("file:"));
    let filename = files
        .next()
        .ok_or_else(|| "signed update has no artifact name".to_string())?;
    // A file field is a single basename, never a URL or path. Reject ambiguous
    // fields instead of reinterpreting them with the URL preflight parser.
    if files.next().is_some()
        || filename.is_empty()
        || !filename
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err("signed update has an invalid artifact name".into());
    }
    let lower = filename.to_ascii_lowercase();
    let matches_bundle = match bundle {
        BundleType::AppImage => lower.ends_with(".appimage.tar.gz"),
        BundleType::Nsis => lower.ends_with(".nsis.zip") || lower.ends_with("-setup.exe"),
        // OwnCord only publishes updater artifacts for these two bundles.
        _ => false,
    };
    if !matches_bundle || !artifact_matches_target(filename, target) {
        return Err("signed update artifact is not built for this machine".into());
    }
    Ok(())
}

/// Keep the plugin's signature/version checks before the authenticated target
/// check, and return bytes to the installer only after both checks succeed.
async fn download_for_target<C: FnMut(usize, Option<u64>)>(
    update: &tauri_plugin_updater::Update,
    pubkey: &str,
    target: &str,
    bundle: &BundleType,
    on_chunk: C,
) -> Result<Vec<u8>, String> {
    let bytes = update
        .download(on_chunk, || {})
        .await
        .map_err(|e| format!("download/install failed: {e}"))?;
    verify_artifact_target(&bytes, &update.signature, pubkey, target, bundle)
        .map_err(|e| format!("download/install failed: {e}"))?;
    Ok(bytes)
}

/// Download and install a pending update. Windows exits through its installer;
/// on Linux/macOS the frontend must call `relaunch()` after this completes.
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle, server_url: String) -> Result<(), String> {
    let install_guard = InstallGuard::acquire(&UPDATE_IN_PROGRESS)?;
    let updater = build_updater(&app, &server_url)?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    match update {
        Some(u) if artifact_matches_this_machine(u.download_url.as_str()) => {
            // Accumulate downloaded bytes and emit progress to the webview.
            // A failed emit must never abort the install, hence `let _ =`.
            let progress_app = app.clone();
            let mut received: u64 = 0;
            let target = tauri_plugin_updater::target()
                .ok_or_else(|| "download/install failed: unknown machine target".to_string())?;
            let bundle = bundle_type()
                .ok_or_else(|| "download/install failed: unknown bundle type".to_string())?;
            let bytes = download_for_target(
                &u,
                updater_public_key(&app)?,
                &target,
                &bundle,
                move |chunk_len, total| {
                    received += chunk_len as u64;
                    let _ =
                        progress_app.emit("update-progress", DownloadProgress { received, total });
                },
            )
            .await?;
            log::info!(
                "[update] download finished ({} bytes) for version {}",
                bytes.len(),
                u.version
            );

            // The split from `download_and_install` exists for this point: from
            // here the old process may still be alive (the plugin hides the
            // window, then blocks in ShellExecuteW on Windows) while any
            // forwarded launch would otherwise restore the old UI. Set the flag
            // and install.
            INSTALLER_LAUNCHING.store(true, Ordering::SeqCst);
            log::info!(
                "[update] installer launching for version {} (old window will ignore forwarded launches)",
                u.version
            );
            // A successful Windows install exits the process and never returns.
            // Any return (an error, or Linux/macOS success awaiting the
            // frontend relaunch) leaves this process serving the user, so clear
            // the flag or every later forwarded launch is swallowed until restart.
            let installed = u.install(&bytes);
            INSTALLER_LAUNCHING.store(false, Ordering::SeqCst);
            installed.map_err(|e| format!("download/install failed: {e}"))?;
            install_guard.installed();
            Ok(())
        }
        // Refuse a signed artifact built for another OS or processor: its
        // signature is valid, but installing it replaces this install with a
        // binary that cannot start.
        Some(u) => Err(format!(
            "update refused: version {} is not built for this machine",
            u.version
        )),
        None => Err("no update available".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_guard_allows_only_one_concurrent_installer() {
        use std::sync::{atomic::AtomicUsize, Barrier};

        let active = AtomicBool::new(false);
        let winners = AtomicUsize::new(0);
        let started = Barrier::new(8);
        let attempted = Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    started.wait();
                    let guard = InstallGuard::acquire(&active).ok();
                    if guard.is_some() {
                        winners.fetch_add(1, Ordering::Relaxed);
                    }
                    // Keep the winner alive until every contender tried.
                    attempted.wait();
                    drop(guard);
                });
            }
        });

        assert_eq!(winners.load(Ordering::Relaxed), 1);
        assert!(InstallGuard::acquire(&active).is_ok());
    }

    #[test]
    fn failed_install_releases_guard_for_retry() {
        let active = AtomicBool::new(false);
        let attempt = || -> Result<(), String> {
            let _guard = InstallGuard::acquire(&active)?;
            Err("download failed".into())
        };

        assert_eq!(attempt(), Err("download failed".into()));
        assert!(InstallGuard::acquire(&active).is_ok());
    }

    #[tokio::test]
    async fn cancelled_install_releases_guard_for_retry() {
        let active = Arc::new(AtomicBool::new(false));
        let task_active = Arc::clone(&active);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = InstallGuard::acquire(&task_active).expect("first install");
            started_tx.send(()).expect("signal acquired guard");
            std::future::pending::<()>().await;
        });

        started_rx.await.expect("install started");
        assert!(InstallGuard::acquire(&active).is_err());
        task.abort();
        assert!(task
            .await
            .expect_err("task should be cancelled")
            .is_cancelled());
        assert!(InstallGuard::acquire(&active).is_ok());
    }

    #[test]
    fn installed_update_remains_guarded_until_restart() {
        let active = AtomicBool::new(false);
        let guard = InstallGuard::acquire(&active).expect("first install");

        guard.installed();

        assert!(InstallGuard::acquire(&active).is_err());
    }

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
    fn package_installs_report_they_cannot_self_update() {
        // Only these two mean "the server has no updater artifact for you"
        // rather than "you are current".
        assert!(cannot_self_update(Some(&BundleType::Deb)));
        assert!(cannot_self_update(Some(&BundleType::Rpm)));

        // Everything else — including the two targets the release does
        // publish — must stay quiet, or the banner becomes noise on every
        // install that has simply nothing new to fetch.
        for bundle in [
            Some(BundleType::AppImage),
            Some(BundleType::Nsis),
            Some(BundleType::Msi),
            Some(BundleType::App),
            None,
        ] {
            assert!(
                !cannot_self_update(bundle.as_ref()),
                "{bundle:?} must not ask for a manual upgrade"
            );
        }
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

    // One payload signed three times by an ephemeral test key with
    // `tauri signer sign`: without `--app-version` (the shape of every release
    // signed before the CLI recorded one), with `--app-version 2.0.0`, and with
    // `--app-version 99.0.0`. The private key was discarded.
    const FIXTURE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE2RDY3NzVFQkQyNjI4NTgKUldSWUtDYTlYbmZXcHQ2WHJqUXpkNXNMUWdVbFVDM1FiOXhLK2lNUlVwWUsvSm8yQTJzWGF6UHkK";
    const FIXTURE_PAYLOAD: &[u8] = b"owncord update fixture\n";
    const SIG_UNVERSIONED: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSWUtDYTlYbmZXcHZ0RGc4VG1JZkxrOW1xWG85QUczUmg4dlhaMzhlMnRKNVZZMlJnWUxCSVdaNmRuYU9EYnJjWHpTQ0VGdGlyTndhblNxRnVBb0w0Zy9BUVNBT1YzendRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNzk1ODMxCWZpbGU6YTEKMVJ5YWR0aTlsZDRGa256bGNsS2hjZDg5VTROcys1eDh3a2hVUTRTRXV2bmZmb3VjQk9DU1BOUHY3VVArTkhUK0N2ZU14UnJ1Yjd6eFlXQUg5R24rQWc9PQo=";
    const SIG_V2_0_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSWUtDYTlYbmZXcHZnWHdubHBXKzFxSjVWdFpkdkw1enArZDR3NzA4UWRONlhLZXU5dzB3VUFCRklycitzSW1HNVZWcUZqNXRFTU5ETFdsdFZGazBJcFRQZkRiMGs1NkFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNzk1ODMxCWZpbGU6YTIJdmVyc2lvbjoyLjAuMAo2cHFWbzZlUFVLTW94NEJ1UlU5SDFIL1RRYnFLb3FleVdlVG5lSG92UFFEd01qcmdVb1FVTVk5S3ZzbXkzczUrTzhUdGNuUUxyZHlROEEreGY5bXNEUT09Cg==";
    const SIG_V99_0_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSWUtDYTlYbmZXcG4weWU1Y3JZNWxUbXBoYjVsMnhYV0ZBM3NhT2t2SytacU43c010M3o4M1pSSTBQOHBLenNZNFd5emh5RzlmNE0vcWRoKytmRXpvcVdFeUxOMnNuSUEwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNzk1ODMxCWZpbGU6YTMJdmVyc2lvbjo5OS4wLjAKWEVreUJhdk9SaHFJblBUbkx3eUZSS2xnZ2o5dkpUMU4xYzJNekFQNlRMalUxSzRwWjczNnFRWG56NWE3bWcyUHpRTFY5eU1mT1Fsb2xXOUxCWFFwQ0E9PQo=";

    /// A stub OwnCord server that answers every update check with `version`,
    /// `signature` and a URL serving FIXTURE_PAYLOAD. Returns its base URL.
    fn serve_update_offer(version: &str, signature: &str) -> String {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub server");
        let base = format!("http://{}", listener.local_addr().expect("stub address"));
        let offer = serde_json::json!({
            "version": version,
            "url": format!("{base}/artifact/OwnCord_99.0.0_amd64.AppImage.tar.gz"),
            "signature": signature,
        })
        .to_string();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = [0u8; 4096];
                let n = stream.read(&mut request).unwrap_or(0);
                let body = if request[..n].starts_with(b"GET /artifact") {
                    FIXTURE_PAYLOAD.to_vec()
                } else {
                    offer.clone().into_bytes()
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        base
    }

    /// Runs the shipped updater configuration (tauri.conf.json) against a stub
    /// server's offer and downloads it. Only the trust anchor is swapped for
    /// the fixture key, and plain http allowed for the loopback stub.
    async fn download_offer(version: &str, signature: &str) -> Result<(), String> {
        download_offer_for_target(version, signature, FIXTURE_PUBKEY, None).await
    }

    async fn download_offer_for_target(
        version: &str,
        signature: &str,
        pubkey: &str,
        target: Option<(&str, &BundleType)>,
    ) -> Result<(), String> {
        let base = serve_update_offer(version, signature);
        let shipped: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let mut updater_config = shipped["plugins"]["updater"].clone();
        updater_config["pubkey"] = pubkey.into();
        updater_config["dangerousInsecureTransportProtocol"] = true.into();

        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), updater_config);
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .map_err(|e| e.to_string())?;

        let update = app
            .updater_builder()
            .endpoints(vec![format!("{base}/update").parse().expect("endpoint")])
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no update offered")?;
        if let Some((target, bundle)) = target {
            return download_for_target(&update, pubkey, target, bundle, |_, _| {})
                .await
                .map(|_| ());
        }
        update
            .download(|_, _| {}, || {})
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    // Prehashed minisign fixtures over FIXTURE_PAYLOAD, generated with an
    // ephemeral Ed25519 key. Its private half was discarded. Every fixture
    // binds version 99.0.0; only the authenticated file field varies.
    fn target_fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!("update_commands/target-fixtures.json"))
            .expect("signed target fixtures")
    }

    #[tokio::test]
    async fn signed_artifact_for_another_architecture_is_refused() {
        let fixtures = target_fixtures();
        for (name, target, bundle) in [
            ("linux_arm64", "linux-x86_64", BundleType::AppImage),
            ("linux_x64", "linux-aarch64", BundleType::AppImage),
            ("windows_arm64", "windows-x86_64", BundleType::Nsis),
            ("windows_x64", "windows-aarch64", BundleType::Nsis),
        ] {
            let result = download_offer_for_target(
                "99.0.0",
                fixtures[name].as_str().unwrap(),
                fixtures["pubkey"].as_str().unwrap(),
                Some((target, &bundle)),
            )
            .await;
            assert_eq!(
                result,
                Err(
                    "download/install failed: signed update artifact is not built for this machine"
                        .into()
                ),
                "{name} must be refused on {target}",
            );
        }
    }

    #[tokio::test]
    async fn signed_artifact_for_the_running_target_is_accepted() {
        let fixtures = target_fixtures();
        for (name, target, bundle) in [
            ("linux_x64", "linux-x86_64", BundleType::AppImage),
            ("linux_arm64", "linux-aarch64", BundleType::AppImage),
            ("windows_x64", "windows-x86_64", BundleType::Nsis),
            ("windows_arm64", "windows-aarch64", BundleType::Nsis),
        ] {
            assert_eq!(
                download_offer_for_target(
                    "99.0.0",
                    fixtures[name].as_str().unwrap(),
                    fixtures["pubkey"].as_str().unwrap(),
                    Some((target, &bundle)),
                )
                .await,
                Ok(()),
                "{name}"
            );
        }
    }

    #[test]
    fn signed_artifact_target_verifies_the_payload_comment_and_key() {
        let fixtures = target_fixtures();
        let signature = fixtures["linux_x64"].as_str().unwrap();
        let pubkey = fixtures["pubkey"].as_str().unwrap();
        let verify = |bytes: &[u8], signature: &str, pubkey: &str| {
            verify_artifact_target(
                bytes,
                signature,
                pubkey,
                "linux-x86_64",
                &BundleType::AppImage,
            )
        };
        assert_eq!(verify(FIXTURE_PAYLOAD, signature, pubkey), Ok(()));
        assert!(verify(b"changed payload", signature, pubkey).is_err());
        assert!(verify(FIXTURE_PAYLOAD, signature, FIXTURE_PUBKEY).is_err());
        assert!(verify(FIXTURE_PAYLOAD, "invalid base64", pubkey).is_err());

        let arm_signature = String::from_utf8(
            STANDARD
                .decode(fixtures["linux_arm64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let changed_comment = STANDARD.encode(arm_signature.replace("aarch64", "amd64"));
        assert!(verify(FIXTURE_PAYLOAD, &changed_comment, pubkey).is_err());
    }

    #[tokio::test]
    async fn signed_artifact_requires_one_parseable_file_field() {
        let fixtures = target_fixtures();
        for name in [
            "missing",
            "empty",
            "unparseable",
            "duplicate",
            "path",
            "query",
        ] {
            assert!(
                download_offer_for_target(
                    "99.0.0",
                    fixtures[name].as_str().unwrap(),
                    fixtures["pubkey"].as_str().unwrap(),
                    Some(("linux-x86_64", &BundleType::AppImage)),
                )
                .await
                .is_err(),
                "{name} must be refused"
            );
        }
    }

    #[tokio::test]
    async fn signed_artifact_requires_the_running_os_and_bundle() {
        let fixtures = target_fixtures();
        for (target, bundle) in [
            ("windows-x86_64", BundleType::Nsis),
            ("linux-x86_64", BundleType::Deb),
            ("linux-x86_64", BundleType::Rpm),
        ] {
            assert!(download_offer_for_target(
                "99.0.0",
                fixtures["linux_x64"].as_str().unwrap(),
                fixtures["pubkey"].as_str().unwrap(),
                Some((target, &bundle)),
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn update_signed_for_an_older_version_is_refused() {
        // A signature is valid for the bytes it covers whatever version the
        // server announces next to it, so the offered version must itself be
        // bound by the signature.
        assert!(download_offer("99.0.0", SIG_V2_0_0).await.is_err());
        // Releases signed before versions were recorded carry none at all.
        assert!(download_offer("99.0.0", SIG_UNVERSIONED).await.is_err());
    }

    #[tokio::test]
    async fn update_signed_for_the_offered_version_is_accepted() {
        assert_eq!(download_offer("99.0.0", SIG_V99_0_0).await, Ok(()));
    }

    #[test]
    fn artifact_target_check_accepts_the_running_machines_own_artifacts() {
        // The actual release file names (Client/scripts/stage-release-assets.sh,
        // Server/updater/assets.go clientAssetSuffixByTarget).
        for (target, url) in [
            (
                "windows-x86_64",
                "https://releases.example.com/v1/OwnCord_1.0.0_x64-setup.nsis.zip",
            ),
            (
                "windows-aarch64",
                "https://releases.example.com/v1/OwnCord_1.0.0_arm64-setup.nsis.zip",
            ),
            (
                "linux-x86_64",
                "https://releases.example.com/v1/OwnCord_1.0.0_amd64.AppImage.tar.gz",
            ),
            (
                "linux-aarch64",
                "https://releases.example.com/v1/OwnCord_1.0.0_aarch64.AppImage.tar.gz",
            ),
        ] {
            assert!(
                artifact_matches_target(url, target),
                "{url} must be accepted on {target}"
            );
        }
    }

    #[test]
    fn artifact_target_check_refuses_another_platform_or_architecture() {
        let x64_nsis = "https://releases.example.com/v1/OwnCord_1.0.0_x64-setup.nsis.zip";
        let arm64_nsis = "https://releases.example.com/v1/OwnCord_1.0.0_arm64-setup.nsis.zip";
        let x64_appimage = "https://releases.example.com/v1/OwnCord_1.0.0_amd64.AppImage.tar.gz";
        let arm64_appimage =
            "https://releases.example.com/v1/OwnCord_1.0.0_aarch64.AppImage.tar.gz";

        // Wrong architecture, same OS.
        assert!(!artifact_matches_target(x64_nsis, "windows-aarch64"));
        assert!(!artifact_matches_target(arm64_nsis, "windows-x86_64"));
        assert!(!artifact_matches_target(x64_appimage, "linux-aarch64"));
        assert!(!artifact_matches_target(arm64_appimage, "linux-x86_64"));

        // Wrong OS, same architecture.
        assert!(!artifact_matches_target(x64_nsis, "linux-x86_64"));
        assert!(!artifact_matches_target(x64_appimage, "windows-x86_64"));
    }

    #[test]
    fn artifact_target_check_is_case_insensitive_and_ignores_url_suffixes() {
        assert!(artifact_matches_target(
            "https://example.com/OwnCord_1.0.0_AMD64.AppImage.tar.gz",
            "linux-x86_64",
        ));
        assert!(artifact_matches_target(
            "https://example.com/OwnCord_1.0.0_x64-setup.nsis.zip?token=abc123",
            "windows-x86_64",
        ));
    }

    #[test]
    fn artifact_target_check_reads_the_canonical_x86_64_spelling() {
        // The updater plugin spells the 64-bit x86 architecture `x86_64`
        // (tauri_plugin_updater::target()), so a file carrying that whole
        // spelling must not be misread as the 32-bit `i686` its `x86` prefix
        // would otherwise tokenise to.
        assert!(artifact_matches_target(
            "https://releases.example.com/v1/OwnCord_1.0.0_x86_64-setup.nsis.zip",
            "windows-x86_64",
        ));
        assert!(!artifact_matches_target(
            "https://releases.example.com/v1/OwnCord_1.0.0_x86_64-setup.nsis.zip",
            "windows-i686",
        ));
    }

    #[test]
    fn artifact_target_check_fails_closed_on_an_unrecognised_name() {
        // No architecture in the name: refuse rather than guess, because every
        // signed OwnCord artifact names its own.
        assert!(!artifact_matches_target(
            "https://example.com/OwnCord_1.0.0.zip",
            "linux-x86_64",
        ));
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
