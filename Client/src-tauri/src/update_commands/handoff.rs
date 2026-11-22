//! What the app shows while the Windows installer launches.
//!
//! The updater plugin unpacks the installer, runs a pre-exit step, then
//! launches the installer with `ShellExecuteW`. A launch exits this process;
//! a launch that fails (SmartScreen's "Don't run", antivirus removing the
//! file) returns an error, and this process goes on serving the user.
//!
//! The plugin's default pre-exit step is `AppHandle::cleanup_before_exit`,
//! which also drops the tray icon and, through the single-instance plugin,
//! the lock that hands a new launch over to the running app. `build_updater`
//! replaces it with [`Handoff::before_launch`], which only hides the visible
//! windows and the tray icon. When the launch fails, [`Handoff::launch_failed`]
//! shows them again. The lock stays held until the process exits, which
//! releases it with every other handle, so a launch made during the gap is
//! handed to this process (and ignored while `installer_launching()`).

use tauri::{AppHandle, Manager};

use crate::window_prefs::MAIN_WINDOW_LABEL;

/// The two screen changes around an installer launch. A trait so the
/// sequence is unit-tested without a window or a tray.
pub(crate) trait HandoffUi: Send + Sync + 'static {
    /// Hide every visible window and the tray icon; return the windows hidden.
    fn hide(&self) -> Vec<String>;
    /// Show `windows` and the tray icon again, the main window in front.
    fn show(&self, windows: &[String]);
}

/// One update's installer launch.
pub(crate) struct Handoff<U> {
    ui: U,
    /// The windows the pre-exit step hid: `Some` from that step until the
    /// screen is back.
    hidden: std::sync::Mutex<Option<Vec<String>>>,
}

impl<U: HandoffUi> Handoff<U> {
    pub(crate) fn new(ui: U) -> Self {
        Self {
            ui,
            hidden: std::sync::Mutex::new(None),
        }
    }

    /// The plugin's pre-exit step: runs after the installer is unpacked, just
    /// before it is launched.
    pub(crate) fn before_launch(&self) {
        let windows = self.ui.hide();
        log::info!(
            "[update] {} window(s) and the tray icon hidden for the installer launch",
            windows.len()
        );
        *crate::sync::lock(&self.hidden) = Some(windows);
    }

    /// `install()` returned an error. After the pre-exit step that means the
    /// installer did not start, so the windows and the tray icon come back.
    /// An error before that step (unpacking) changed nothing on screen.
    pub(crate) fn launch_failed(&self) {
        let hidden = crate::sync::lock(&self.hidden).take();
        if let Some(windows) = hidden {
            log::warn!("[update] the installer did not start; showing the window and tray again");
            self.ui.show(&windows);
        }
    }
}

/// The real window and tray.
pub(crate) struct LiveUi(pub(crate) AppHandle);

impl HandoffUi for LiveUi {
    fn hide(&self) -> Vec<String> {
        let mut hidden = Vec::new();
        for (label, window) in self.0.webview_windows() {
            if window.is_visible().unwrap_or(false) && window.hide().is_ok() {
                hidden.push(label);
            }
        }
        set_tray_visible(&self.0, false);
        hidden
    }

    fn show(&self, windows: &[String]) {
        set_tray_visible(&self.0, true);
        for label in windows.iter().filter(|l| l.as_str() != MAIN_WINDOW_LABEL) {
            if let Some(window) = self.0.get_webview_window(label) {
                let _ = window.show();
            }
        }
        if windows.iter().any(|l| l == MAIN_WINDOW_LABEL) {
            crate::message_notification::focus_main_window_with(&self.0, None);
        }
    }
}

fn set_tray_visible(app: &AppHandle, visible: bool) {
    let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) else {
        return;
    };
    if let Err(e) = tray.set_visible(visible) {
        log::warn!("[update] cannot set the tray icon visible={visible}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, PartialEq)]
    enum Seen {
        Hide,
        Show(Vec<String>),
    }

    /// Records what the hand-off did to the screen; `hide` reports `windows`.
    struct FakeUi {
        windows: Vec<String>,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl HandoffUi for FakeUi {
        fn hide(&self) -> Vec<String> {
            crate::sync::lock(&self.seen).push(Seen::Hide);
            self.windows.clone()
        }

        fn show(&self, windows: &[String]) {
            crate::sync::lock(&self.seen).push(Seen::Show(windows.to_vec()));
        }
    }

    fn handoff(windows: &[&str]) -> (Handoff<FakeUi>, Arc<Mutex<Vec<Seen>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let ui = FakeUi {
            windows: windows.iter().map(|w| w.to_string()).collect(),
            seen: Arc::clone(&seen),
        };
        (Handoff::new(ui), seen)
    }

    /// The plugin's Windows install, as far as this process can see it: unpack,
    /// the pre-exit step, then the launch, whose failure is returned.
    fn plugin_install<U: HandoffUi>(
        step: &Handoff<U>,
        unpacked: bool,
        launched: bool,
    ) -> Result<(), &'static str> {
        if !unpacked {
            return Err("unpack failed");
        }
        step.before_launch();
        if launched {
            Ok(())
        } else {
            Err("ShellExecuteW failed")
        }
    }

    #[test]
    fn a_launch_that_fails_after_the_pre_exit_step_brings_the_windows_and_tray_back() {
        let (step, seen) = handoff(&["main", "popout-1"]);
        let result = plugin_install(&step, true, false);
        if result.is_err() {
            step.launch_failed();
        }
        assert_eq!(
            *crate::sync::lock(&seen),
            vec![
                Seen::Hide,
                Seen::Show(vec!["main".into(), "popout-1".into()])
            ]
        );
        // A second report (a retry's error path) does not show anything twice.
        step.launch_failed();
        assert_eq!(crate::sync::lock(&seen).len(), 2);
    }

    #[test]
    fn a_failure_before_the_pre_exit_step_leaves_the_screen_alone() {
        let (step, seen) = handoff(&["main"]);
        assert!(plugin_install(&step, false, true).is_err());
        step.launch_failed();
        assert!(crate::sync::lock(&seen).is_empty());
    }

    #[test]
    fn a_launch_keeps_the_screen_hidden_until_the_process_exits() {
        let (step, seen) = handoff(&["main"]);
        assert!(plugin_install(&step, true, true).is_ok());
        assert_eq!(*crate::sync::lock(&seen), vec![Seen::Hide]);
    }

    /// The production code of a source file, its tests and comments left out,
    /// so a sentence or a test that names a call cannot satisfy or trip the
    /// gate below.
    fn code_of(source: &str) -> String {
        source
            .split("#[cfg(test)]")
            .next()
            .unwrap_or("")
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_updater_runs_the_app_pre_exit_step_and_keeps_the_single_instance_lock() {
        let parent = code_of(include_str!("../update_commands.rs"));
        let this = code_of(include_str!("handoff.rs"));
        // The step replaces the plugin's default, so it must be set on the
        // builder the install path uses.
        let build = parent
            .split("fn build_updater(")
            .nth(1)
            .and_then(|rest| rest.split("\nfn ").next())
            .expect("build_updater is in update_commands.rs");
        assert!(
            build.contains(".on_before_exit("),
            "build_updater must set the app's own pre-exit step"
        );
        assert!(
            parent.contains("launch_failed()"),
            "a failed launch must bring the window and tray back"
        );
        // Releasing the lock before the launch lets a second copy start in the
        // gap, and nothing could take it back after a failed launch.
        for code in [&parent, &this] {
            for call in [".cleanup_before_exit(", "single_instance::destroy("] {
                assert!(!code.contains(call), "the install path calls {call}");
            }
        }
    }
}
