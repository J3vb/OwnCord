//! In-app update of a Linux .deb install.
//!
//! The download and signature checks are the shared ones in
//! `update_commands.rs`. This module is the install step: it writes the
//! verified bytes into a private directory, then runs
//! `pkexec /usr/lib/owncord-client/owncord-deb-update <file> <sha256>`. That
//! helper (`packaging/linux/owncord-deb-update`, root-owned) copies the file
//! into a directory only root can write, re-hashes it, checks it is this very
//! package for this machine, and installs the copy with apt-get. So root
//! installs exactly the bytes verified here, never whatever is at a path when
//! it gets around to reading it.
//!
//! The command sits behind [`PrivilegedRunner`] so tests never run pkexec, and
//! the install owns the [`InstallGuard`] inside its blocking task: a webview
//! reload (or any dropped command future) while the password prompt is open
//! cannot start a second pkexec, because the guard lives until pkexec returns.

use std::fs::{DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Emitter};

use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};

use crate::text;
use crate::update_commands::InstallGuard;

/// The root-owned helper the .deb ships (`tauri.conf.json`, `bundle.linux.deb.files`).
pub(crate) const HELPER: &str = "/usr/lib/owncord-client/owncord-deb-update";
/// pkexec is always called by this absolute path, never looked up on `PATH`.
const PKEXEC: &str = "/usr/bin/pkexec";
/// How many trailing stderr lines of a failed run reach the log.
const STDERR_LOG_LINES: usize = 20;

/// What the readiness probe needs to know about one file.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FileFacts {
    pub is_file: bool,
    pub uid: u32,
    pub mode: u32,
}

impl FileFacts {
    fn of(meta: &std::fs::Metadata) -> Self {
        Self {
            is_file: meta.file_type().is_file(),
            uid: meta.uid(),
            mode: meta.mode(),
        }
    }
}

/// The helper is a regular file owned by root, executable, and not writable by
/// group or others. Anything else is not trusted to run as root.
pub(crate) fn helper_is_trusted(helper: Option<FileFacts>) -> bool {
    helper.is_some_and(|f| f.is_file && f.uid == 0 && f.mode & 0o022 == 0 && f.mode & 0o100 != 0)
}

/// pkexec exists and is executable.
pub(crate) fn pkexec_is_usable(pkexec: Option<FileFacts>) -> bool {
    pkexec.is_some_and(|f| f.is_file && f.mode & 0o111 != 0)
}

/// Whether this install can take an in-app update: pkexec and the helper are
/// both present and trusted. Probed once per update check.
pub(crate) fn ready() -> bool {
    let helper = std::fs::symlink_metadata(HELPER)
        .ok()
        .map(|m| FileFacts::of(&m));
    let pkexec = std::fs::metadata(PKEXEC).ok().map(|m| FileFacts::of(&m));
    helper_is_trusted(helper) && pkexec_is_usable(pkexec)
}

/// The verified package, written where only this user can reach it. Dropping
/// it removes the directory, on every path out of the install.
pub(crate) struct PreparedDeb {
    dir: PathBuf,
    file: PathBuf,
    sha256: String,
}

impl PreparedDeb {
    pub(crate) fn file(&self) -> &Path {
        &self.file
    }

    pub(crate) fn sha256(&self) -> &str {
        &self.sha256
    }
}

impl Drop for PreparedDeb {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.dir) {
            log::warn!("[update] cannot remove {}: {e}", self.dir.display());
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hash `bytes` and write them to `<cache_dir>/owncord-update-<16 hex>/OwnCord.deb`
/// (directory 0700, file 0600).
pub(crate) fn prepare(cache_dir: &Path, bytes: &[u8]) -> Result<PreparedDeb, String> {
    let fail = |what: &str, e: std::io::Error| {
        log::warn!("[update] cannot {what}: {e}");
        text::UPDATE_PACKAGE_MANAGER_FAILED.to_string()
    };
    std::fs::create_dir_all(cache_dir).map_err(|e| fail("create the cache directory", e))?;
    let mut name = [0u8; 8];
    SystemRandom::new()
        .fill(&mut name)
        .map_err(|_| text::UPDATE_PACKAGE_MANAGER_FAILED.to_string())?;
    let dir = cache_dir.join(format!("owncord-update-{}", hex(&name)));
    DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|e| fail("create the update directory", e))?;
    // From here the guard owns the directory, so a failed write removes it.
    let file = dir.join("OwnCord.deb");
    let prepared = PreparedDeb {
        dir,
        file,
        sha256: hex(digest(&SHA256, bytes).as_ref()),
    };
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&prepared.file)
        .map_err(|e| fail("create the package file", e))?;
    out.write_all(bytes)
        .and_then(|()| out.flush())
        .map_err(|e| fail("write the package file", e))?;
    Ok(prepared)
}

/// How a privileged run ended: pkexec's exit code (`None` for a signal) and
/// the tail of its stderr, for the log.
pub(crate) struct RunOutput {
    pub code: Option<i32>,
    pub stderr_tail: Vec<String>,
}

/// Runs the privileged helper. A trait so tests never reach pkexec.
pub(crate) trait PrivilegedRunner: Send + 'static {
    fn run(&self, file: &Path, sha256: &str) -> std::io::Result<RunOutput>;
}

/// `pkexec <helper> <file> <sha256>`, exactly.
pub(crate) fn pkexec_command(file: &Path, sha256: &str) -> Command {
    let mut command = Command::new(PKEXEC);
    command.arg(HELPER).arg(file).arg(sha256);
    // pkexec refuses a SHELL missing from /etc/shells; without it, it uses the
    // account's own shell.
    command.env_remove("SHELL");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

pub(crate) struct PkexecRunner;

impl PrivilegedRunner for PkexecRunner {
    fn run(&self, file: &Path, sha256: &str) -> std::io::Result<RunOutput> {
        let output = pkexec_command(file, sha256).output()?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lines: Vec<&str> = stderr.lines().collect();
        let start = lines.len().saturating_sub(STDERR_LOG_LINES);
        Ok(RunOutput {
            code: output.status.code(),
            stderr_tail: lines[start..].iter().map(|l| (*l).to_string()).collect(),
        })
    }
}

/// Map the exit code of `pkexec <helper> …` to an outcome. The two
/// `update …` errors are stable strings the renderer matches.
pub(crate) fn classify(code: Option<i32>) -> Result<(), String> {
    match code {
        Some(0) => Ok(()),
        // pkexec: the authentication dialog was dismissed.
        Some(126) => Err(text::UPDATE_CANCELLED.to_string()),
        // pkexec: not authorized, or no polkit agent to ask.
        Some(127) => Err(text::UPDATE_NOT_AUTHORIZED.to_string()),
        // The helper refused the package (arguments, source, hash, identity).
        Some(c @ 10..=13) => Err(format!("{} ({c})", text::UPDATE_PACKAGE_CHECK_FAILED)),
        // apt-get failed, the helper could not prepare, or a signal.
        _ => Err(text::UPDATE_PACKAGE_MANAGER_FAILED.to_string()),
    }
}

/// What the install does around pkexec; the live one touches the webview and
/// the restart bookkeeping, a test one records the order.
pub(crate) trait InstallHooks: Send + 'static {
    /// Just before pkexec runs.
    fn installing(&self);
    /// pkexec returned non-zero (or could not start).
    fn failed(&self);
    /// pkexec returned 0.
    fn succeeded(&self);
}

/// The webview event that says the password prompt is (about to be) open.
const INSTALLING_EVENT: &str = "update-installing";

/// The live hooks: tell the webview, and make the restart show its window. The
/// relaunch exits through tauri's restart, so the exit watch records a clean
/// exit; `INSTALLER_LAUNCHING` covers only the Windows installer launch gap.
pub(crate) struct LiveHooks {
    app: AppHandle,
}

impl LiveHooks {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl InstallHooks for LiveHooks {
    fn installing(&self) {
        // The restart copies this process's argv; make it show its window.
        crate::window_prefs::set_show_next_launch(&self.app, true);
        // A failed emit must never abort the install.
        let _ = self.app.emit(INSTALLING_EVENT, ());
    }

    fn failed(&self) {
        crate::window_prefs::set_show_next_launch(&self.app, false);
    }

    fn succeeded(&self) {}
}

fn run_install<R: PrivilegedRunner, H: InstallHooks>(
    runner: &R,
    hooks: &H,
    cache_dir: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let prepared = prepare(cache_dir, bytes)?;
    hooks.installing();
    let outcome = match runner.run(prepared.file(), prepared.sha256()) {
        Ok(output) => {
            let outcome = classify(output.code);
            if outcome.is_err() {
                log::warn!("[update] deb install ended with {:?}", output.code);
                for line in &output.stderr_tail {
                    log::warn!("[update] helper: {line}");
                }
            }
            outcome
        }
        Err(e) => {
            log::warn!("[update] cannot run pkexec: {e}");
            Err(text::UPDATE_PACKAGE_MANAGER_FAILED.to_string())
        }
    };
    match &outcome {
        Ok(()) => hooks.succeeded(),
        Err(_) => hooks.failed(),
    }
    outcome
}

/// Install the verified package through the privileged helper.
///
/// Everything after the download runs in one blocking task that owns `guard`.
/// If the command future is dropped while the password prompt is open, the task
/// still runs to the end of pkexec before the guard is released (an error) or
/// kept until exit (success), so a second click cannot start a second pkexec.
pub(crate) async fn install_deb_with<R: PrivilegedRunner, H: InstallHooks>(
    guard: InstallGuard<'static>,
    runner: R,
    hooks: H,
    cache_dir: PathBuf,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let task = tauri::async_runtime::spawn_blocking(move || {
        let outcome = run_install(&runner, &hooks, &cache_dir, &bytes);
        if outcome.is_ok() {
            guard.installed();
        }
        outcome
    });
    match task.await {
        Ok(outcome) => outcome,
        Err(e) => {
            log::warn!("[update] install task ended abnormally: {e}");
            Err(text::UPDATE_PACKAGE_MANAGER_FAILED.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{atomic::AtomicBool, mpsc, Arc, Mutex};

    fn facts(is_file: bool, uid: u32, mode: u32) -> Option<FileFacts> {
        Some(FileFacts { is_file, uid, mode })
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let mut id = [0u8; 6];
        SystemRandom::new().fill(&mut id).expect("random");
        let dir = std::env::temp_dir().join(format!("owncord-deb-test-{tag}-{}", hex(&id)));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn deb_ready_needs_root_owned_unwritable_helper_and_pkexec() {
        let good_helper = facts(true, 0, 0o100755);
        let good_pkexec = facts(true, 0, 0o104755);
        assert!(helper_is_trusted(good_helper) && pkexec_is_usable(good_pkexec));

        // Not root-owned.
        assert!(!helper_is_trusted(facts(true, 1000, 0o100755)));
        // Writable by group, or by others.
        assert!(!helper_is_trusted(facts(true, 0, 0o100775)));
        assert!(!helper_is_trusted(facts(true, 0, 0o100757)));
        // Not executable, not a regular file, missing.
        assert!(!helper_is_trusted(facts(true, 0, 0o100644)));
        assert!(!helper_is_trusted(facts(false, 0, 0o040755)));
        assert!(!helper_is_trusted(None));
        // pkexec missing, a directory, or not executable.
        assert!(!pkexec_is_usable(None));
        assert!(!pkexec_is_usable(facts(false, 0, 0o040755)));
        assert!(!pkexec_is_usable(facts(true, 0, 0o100644)));
    }

    #[test]
    fn prepare_writes_the_verified_bytes_in_a_private_dir_and_hashes_them() {
        let cache = scratch_dir("prepare");
        let payload = b"owncord update fixture\n";
        let prepared = prepare(&cache, payload).expect("prepare");

        let dir = prepared.file().parent().expect("parent").to_path_buf();
        assert!(dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n
            .starts_with("owncord-update-")
            && n.len() == "owncord-update-".len() + 16));
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(prepared.file())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(std::fs::read(prepared.file()).unwrap(), payload);
        // SHA-256 of the fixture, computed independently with sha256sum.
        assert_eq!(
            prepared.sha256(),
            "d9c5ff1d5ccf7b385b51de3276351a2bafdffe813fdbe5b34aa4af24c0bb489d"
        );
        drop(prepared);
        assert!(!dir.exists(), "the directory is removed on drop");
        std::fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn pkexec_is_called_by_absolute_path_with_exactly_helper_file_hash() {
        let command = pkexec_command(
            Path::new("/home/u/.cache/x/OwnCord.deb"),
            "ab".repeat(32).as_str(),
        );
        assert_eq!(command.get_program(), "/usr/bin/pkexec");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                "/usr/lib/owncord-client/owncord-deb-update",
                "/home/u/.cache/x/OwnCord.deb",
                "ab".repeat(32).as_str(),
            ]
        );
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "SHELL" && value.is_none()));
    }

    #[test]
    fn exit_codes_map_to_outcomes() {
        assert_eq!(classify(Some(0)), Ok(()));
        assert_eq!(classify(Some(126)), Err("update cancelled".into()));
        assert_eq!(classify(Some(127)), Err("update not authorized".into()));
        for code in 10..=13 {
            assert_eq!(
                classify(Some(code)),
                Err(format!(
                    "download/install failed: package check failed ({code})"
                ))
            );
        }
        for code in [Some(14), Some(15), Some(99), Some(1), None] {
            assert_eq!(
                classify(code),
                Err("download/install failed: package manager failed".into()),
                "{code:?}"
            );
        }
    }

    /// A runner that returns a fixed code, optionally rewriting the staged file
    /// first (the "file changed on disk" case is the helper's to detect; here
    /// the stub just reports what the helper would).
    struct FixedRunner {
        code: Option<i32>,
        seen: Arc<Mutex<Vec<(PathBuf, String, bool)>>>,
    }

    impl PrivilegedRunner for FixedRunner {
        fn run(&self, file: &Path, sha256: &str) -> std::io::Result<RunOutput> {
            self.seen
                .lock()
                .unwrap()
                .push((file.to_path_buf(), sha256.to_string(), file.exists()));
            Ok(RunOutput {
                code: self.code,
                stderr_tail: vec!["helper said something".into()],
            })
        }
    }

    #[derive(Clone, Default)]
    struct RecordingHooks(Arc<Mutex<Vec<&'static str>>>);

    impl InstallHooks for RecordingHooks {
        fn installing(&self) {
            self.0.lock().unwrap().push("installing");
        }
        fn failed(&self) {
            self.0.lock().unwrap().push("failed");
        }
        fn succeeded(&self) {
            self.0.lock().unwrap().push("succeeded");
        }
    }

    #[tokio::test]
    async fn stub_runner_success_marks_installed_and_emits_installing_first() {
        static ACTIVE: AtomicBool = AtomicBool::new(false);
        let cache = scratch_dir("success");
        let hooks = RecordingHooks::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let guard = InstallGuard::acquire(&ACTIVE).expect("guard");

        let result = install_deb_with(
            guard,
            FixedRunner {
                code: Some(0),
                seen: Arc::clone(&seen),
            },
            hooks.clone(),
            cache.clone(),
            b"verified bytes".to_vec(),
        )
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(*hooks.0.lock().unwrap(), ["installing", "succeeded"]);
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].2, "the staged file existed while pkexec ran");
        assert!(!calls[0].0.exists(), "and is removed afterwards");
        // A success keeps the guard until the process exits.
        assert!(InstallGuard::acquire(&ACTIVE).is_err());
        std::fs::remove_dir_all(&cache).ok();
    }

    #[tokio::test]
    async fn changed_on_disk_maps_to_a_package_check_failure_and_releases_the_guard() {
        static ACTIVE: AtomicBool = AtomicBool::new(false);
        let cache = scratch_dir("changed");
        let hooks = RecordingHooks::default();
        let guard = InstallGuard::acquire(&ACTIVE).expect("guard");

        // The helper exits 12 when the copy's hash is not the client's.
        let result = install_deb_with(
            guard,
            FixedRunner {
                code: Some(12),
                seen: Arc::default(),
            },
            hooks.clone(),
            cache.clone(),
            b"verified bytes".to_vec(),
        )
        .await;

        assert_eq!(
            result,
            Err("download/install failed: package check failed (12)".into())
        );
        assert_eq!(*hooks.0.lock().unwrap(), ["installing", "failed"]);
        assert!(InstallGuard::acquire(&ACTIVE).is_ok(), "a retry is allowed");
        std::fs::remove_dir_all(&cache).ok();
    }

    /// Blocks inside `run` until released, then returns the given code.
    struct BlockingRunner {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<i32>>,
    }

    impl PrivilegedRunner for BlockingRunner {
        fn run(&self, _file: &Path, _sha256: &str) -> std::io::Result<RunOutput> {
            self.started.send(()).ok();
            let code = self.release.lock().unwrap().recv().unwrap_or(1);
            Ok(RunOutput {
                code: Some(code),
                stderr_tail: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn dropped_install_future_keeps_the_guard_until_pkexec_returns() {
        static ACTIVE: AtomicBool = AtomicBool::new(false);
        let cache = scratch_dir("dropped");
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let guard = InstallGuard::acquire(&ACTIVE).expect("guard");

        let future = install_deb_with(
            guard,
            BlockingRunner {
                started: started_tx,
                release: Mutex::new(release_rx),
            },
            RecordingHooks::default(),
            cache.clone(),
            b"verified bytes".to_vec(),
        );
        let task = tokio::spawn(future);
        // Wait until pkexec (the stub) is running, i.e. the prompt is open.
        tokio::task::spawn_blocking(move || started_rx.recv().expect("runner started"))
            .await
            .expect("join");

        // The webview reloads: the command future is dropped mid-prompt.
        task.abort();
        assert!(task.await.expect_err("cancelled").is_cancelled());
        assert!(
            InstallGuard::acquire(&ACTIVE).is_err(),
            "a second install is refused while pkexec is still running"
        );

        // pkexec returns 126 (prompt dismissed): the guard is released.
        release_tx.send(126).expect("release runner");
        let mut released = false;
        for _ in 0..200 {
            if let Ok(guard) = InstallGuard::acquire(&ACTIVE) {
                drop(guard);
                released = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(released, "the guard is free once pkexec has returned");
        std::fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn helper_script_suite() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("packaging/linux/owncord-deb-update.test.sh");
        let output = Command::new("bash")
            .arg(&script)
            .output()
            .expect("run bash");
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
