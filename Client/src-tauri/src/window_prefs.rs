//! Close to tray and Start minimised.
//!
//! The two preferences live in the Rust-side settings store, not the webview's
//! localStorage, because Rust needs them before the webview exists: whether to
//! show the window at all, and what the window's X button does. They are read
//! once in `setup` into [`WindowPrefs`] (atomics, so the close handler never
//! touches the disk) and written through [`set_window_pref`].
//!
//! The X button on the main window hides it instead of closing it when
//! `minimizeToTray` is on **and** something can bring it back: the tray icon.
//! A hidden window with no way back would be a lost app, so the decision
//! ([`close_action`]) is a plain function that takes that fact as input.
//! Quit from the tray menu calls `AppHandle::exit`, which does not go through
//! `CloseRequested`, so it is always a real exit.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::constants::SETTINGS_STORE;
use crate::{json_store, text};

/// The main window's label: the only window the X button hides.
pub const MAIN_WINDOW_LABEL: &str = "main";
/// Passed to the app by the autostart entry; with `startMinimized` on, the
/// main window stays hidden at that launch.
pub const MINIMIZED_ARG: &str = "--minimized";

const MINIMIZE_TO_TRAY_KEY: &str = "owncord:window:minimizeToTray";
const START_MINIMIZED_KEY: &str = "owncord:window:startMinimized";
const TRAY_NOTICE_SHOWN_KEY: &str = "owncord:window:trayNoticeShown";
/// One-shot marker: the next launch shows the window whatever the flag says.
/// A restart the app starts itself (update, Clear & Restart) copies this
/// process's argv, `--minimized` included, and must not come back hidden.
const SHOW_NEXT_LAUNCH_KEY: &str = "owncord:window:showNextLaunch";

/// Closing to the tray is on unless the user turned it off.
const MINIMIZE_TO_TRAY_DEFAULT: bool = true;
const START_MINIMIZED_DEFAULT: bool = false;

/// What the X button on a window does.
#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    /// Let the window close (the app exits when it was the last one).
    Close,
    /// Veto the close and hide the window; the tray brings it back.
    HideToTray,
}

/// Decide what a close request on `label` does. Only `main` ever hides, and
/// only while the tray can bring it back and no installer is taking over.
pub fn close_action(
    label: &str,
    minimize_to_tray: bool,
    tray_available: bool,
    installer_launching: bool,
) -> CloseAction {
    if label == MAIN_WINDOW_LABEL && minimize_to_tray && tray_available && !installer_launching {
        CloseAction::HideToTray
    } else {
        CloseAction::Close
    }
}

/// Whether this launch leaves the main window hidden: the autostart entry's
/// flag, the preference, and a tray to restore it from must all be there.
///
/// `show_next_launch` (an app-initiated restart) overrides everything. The
/// tray probe is a closure so it only runs once the cheap inputs agree: on
/// Linux it is a D-Bus call a normal startup should not wait for.
pub fn should_start_hidden(
    show_next_launch: bool,
    has_minimized_arg: bool,
    start_minimized: bool,
    tray_available: impl FnOnce() -> bool,
) -> bool {
    !show_next_launch && has_minimized_arg && start_minimized && tray_available()
}

/// Read and clear the one-shot marker. A store that cannot be read or saved
/// gives false: the launch then follows the flag and the pref.
pub fn take_show_next_launch<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Ok(store) = json_store::open(app, SETTINGS_STORE) else {
        return false;
    };
    let set = store
        .get(SHOW_NEXT_LAUNCH_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if set {
        store.delete(SHOW_NEXT_LAUNCH_KEY);
        if let Err(e) = store.save() {
            log::warn!("[window] cannot clear the show-next-launch marker: {e}");
        }
    }
    set
}

/// Record (or withdraw) the marker. Called just before this process starts
/// its own replacement.
pub fn set_show_next_launch<R: Runtime>(app: &AppHandle<R>, on: bool) {
    let Ok(store) = json_store::open(app, SETTINGS_STORE) else {
        return;
    };
    if on {
        store.set(SHOW_NEXT_LAUNCH_KEY, serde_json::Value::Bool(true));
    } else if !store.delete(SHOW_NEXT_LAUNCH_KEY) {
        return;
    }
    if let Err(e) = store.save() {
        log::warn!("[window] cannot save the show-next-launch marker: {e}");
    }
}

/// The frontend calls this just before `relaunch()`.
#[tauri::command]
pub fn show_next_launch(app: AppHandle) {
    set_show_next_launch(&app, true);
}

/// Whether the process was launched with the autostart flag.
pub fn launched_minimized() -> bool {
    std::env::args().any(|a| a == MINIMIZED_ARG)
}

/// Whether a tray icon the user can see exists. Windows and macOS always show
/// the one `tray::create_tray` builds (a failure to build it aborts startup).
/// On Linux the icon needs a StatusNotifier host on the session bus, which
/// plain GNOME does not run: without one the icon is invisible, so hiding the
/// window would strand the app.
pub fn tray_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux_tray_host_present()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(target_os = "linux")]
fn linux_tray_host_present() -> bool {
    use dbus::blocking::Connection;
    use std::time::Duration;

    let Ok(conn) = Connection::new_session() else {
        return false;
    };
    let bus = conn.with_proxy(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        Duration::from_millis(500),
    );
    [
        "org.kde.StatusNotifierWatcher",
        "org.freedesktop.StatusNotifierWatcher",
    ]
    .iter()
    .any(|name| {
        bus.method_call("org.freedesktop.DBus", "NameHasOwner", (*name,))
            .map(|(owned,): (bool,)| owned)
            .unwrap_or(false)
    })
}

/// The live values the close handler and startup read. Managed by the app.
pub struct WindowPrefs {
    minimize_to_tray: AtomicBool,
    start_minimized: AtomicBool,
}

impl WindowPrefs {
    /// Read both from the settings store. A missing or unreadable store gives
    /// the defaults: the app must start either way.
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let read = |key: &str, default: bool| match json_store::open(app, SETTINGS_STORE) {
            Ok(store) => store.get(key).and_then(|v| v.as_bool()).unwrap_or(default),
            Err(e) => {
                log::warn!("[window] cannot read {key}: {e}");
                default
            }
        };
        Self {
            minimize_to_tray: AtomicBool::new(read(MINIMIZE_TO_TRAY_KEY, MINIMIZE_TO_TRAY_DEFAULT)),
            start_minimized: AtomicBool::new(read(START_MINIMIZED_KEY, START_MINIMIZED_DEFAULT)),
        }
    }

    pub fn minimize_to_tray(&self) -> bool {
        self.minimize_to_tray.load(Ordering::Relaxed)
    }

    pub fn start_minimized(&self) -> bool {
        self.start_minimized.load(Ordering::Relaxed)
    }
}

/// Handle a close request on the window `label`: hide it when
/// [`close_action`] says so (vetoing the close through `prevent_close`), and
/// tell the user once, with a native notification, that the app kept running.
pub fn on_close_requested<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    api: &tauri::CloseRequestApi,
) {
    let prefs = app.state::<WindowPrefs>();
    let action = close_action(
        window.label(),
        prefs.minimize_to_tray(),
        // Asked only when the preference is on, so a user who turned it off
        // never pays for the bus call.
        prefs.minimize_to_tray() && tray_available(),
        crate::update_commands::installer_launching(),
    );
    if action != CloseAction::HideToTray {
        return;
    }
    api.prevent_close();
    if let Err(e) = window.hide() {
        // The close was vetoed and the hide failed: the window is still up.
        log::warn!("[window] cannot hide the window to the tray: {e}");
        return;
    }
    log::info!("[window] close requested: hidden to the tray");
    notify_once(app);
}

/// The first time the window goes to the tray, say so. Remembered in the
/// settings store, so it never repeats.
fn notify_once<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_notification::NotificationExt;

    let Ok(store) = json_store::open(app, SETTINGS_STORE) else {
        return;
    };
    if store
        .get(TRAY_NOTICE_SHOWN_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return;
    }
    store.set(TRAY_NOTICE_SHOWN_KEY, serde_json::Value::Bool(true));
    if let Err(e) = store.save() {
        // Without the flag the notice would repeat on every close.
        log::warn!("[window] cannot remember the tray notice: {e}");
        return;
    }
    if let Err(e) = app
        .notification()
        .builder()
        .title(text::TRAY_NOTICE_TITLE)
        .body(text::TRAY_NOTICE_BODY)
        .show()
    {
        log::warn!("[window] cannot show the tray notice: {e}");
    }
}

/// The two preferences as the settings tab reads them.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowPrefsDto {
    pub minimize_to_tray: bool,
    pub start_minimized: bool,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindowPref {
    MinimizeToTray,
    StartMinimized,
}

impl WindowPref {
    fn store_key(self) -> &'static str {
        match self {
            Self::MinimizeToTray => MINIMIZE_TO_TRAY_KEY,
            Self::StartMinimized => START_MINIMIZED_KEY,
        }
    }
}

#[tauri::command]
pub fn get_window_prefs(prefs: State<'_, WindowPrefs>) -> WindowPrefsDto {
    WindowPrefsDto {
        minimize_to_tray: prefs.minimize_to_tray(),
        start_minimized: prefs.start_minimized(),
    }
}

/// Persist one preference, then publish it to the live state. The disk write
/// goes first: a failed save leaves the running app, the shared store and the
/// file in agreement.
#[tauri::command]
pub fn set_window_pref(
    app: AppHandle,
    prefs: State<'_, WindowPrefs>,
    pref: WindowPref,
    enabled: bool,
) -> Result<(), String> {
    let store = json_store::open(&app, SETTINGS_STORE)
        .map_err(|e| format!("failed to open settings store: {e}"))?;
    let previous = store.get(pref.store_key());
    store.set(pref.store_key(), serde_json::Value::Bool(enabled));
    if let Err(e) = store.save() {
        // The store is shared: undo the in-memory change so a later save of
        // another key does not persist the rejected value.
        match previous {
            Some(value) => store.set(pref.store_key(), value),
            None => {
                store.delete(pref.store_key());
            }
        }
        return Err(format!("failed to persist settings: {e}"));
    }
    match pref {
        WindowPref::MinimizeToTray => prefs.minimize_to_tray.store(enabled, Ordering::Relaxed),
        WindowPref::StartMinimized => prefs.start_minimized.store(enabled, Ordering::Relaxed),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_main_window_hides_when_the_pref_is_on_and_the_tray_is_there() {
        assert_eq!(
            close_action("main", true, true, false),
            CloseAction::HideToTray
        );
    }

    #[test]
    fn the_main_window_really_closes_when_the_pref_is_off() {
        assert_eq!(close_action("main", false, true, false), CloseAction::Close);
    }

    #[test]
    fn without_a_tray_the_window_really_closes() {
        // A hidden window with no tray icon to restore it from is a lost app.
        assert_eq!(close_action("main", true, false, false), CloseAction::Close);
    }

    #[test]
    fn an_installer_taking_over_always_closes() {
        assert_eq!(close_action("main", true, true, true), CloseAction::Close);
    }

    #[test]
    fn only_the_main_window_hides() {
        for label in ["popout-1", "stream-2", "", "Main"] {
            assert_eq!(close_action(label, true, true, false), CloseAction::Close);
        }
    }

    #[test]
    fn a_minimised_launch_needs_the_flag_the_pref_and_a_tray() {
        assert!(should_start_hidden(false, true, true, || true));
        assert!(
            !should_start_hidden(false, false, true, || true),
            "a manual launch"
        );
        assert!(
            !should_start_hidden(false, true, false, || true),
            "pref off"
        );
        assert!(!should_start_hidden(false, true, true, || false), "no tray");
    }

    #[test]
    fn an_app_started_restart_always_shows_the_window() {
        assert!(!should_start_hidden(true, true, true, || true));
    }

    #[test]
    fn the_tray_probe_runs_only_when_the_cheap_inputs_agree() {
        for (marker, arg, pref) in [
            (true, true, true),
            (false, false, true),
            (false, true, false),
        ] {
            let probed = std::cell::Cell::new(false);
            should_start_hidden(marker, arg, pref, || {
                probed.set(true);
                true
            });
            assert!(!probed.get(), "probed for {marker} {arg} {pref}");
        }
    }

    #[test]
    fn the_prefs_use_their_own_store_keys_under_the_settings_allowlist() {
        let keys = [
            WindowPref::MinimizeToTray.store_key(),
            WindowPref::StartMinimized.store_key(),
        ];
        assert_ne!(keys[0], keys[1]);
        for key in keys
            .into_iter()
            .chain([TRAY_NOTICE_SHOWN_KEY, SHOW_NEXT_LAUNCH_KEY])
        {
            assert!(key.starts_with("owncord:"), "{key} would be rejected");
        }
    }

    #[test]
    fn the_settings_tab_names_deserialize() {
        let pref: WindowPref = serde_json::from_str("\"minimizeToTray\"").expect("pref");
        assert_eq!(pref, WindowPref::MinimizeToTray);
        let pref: WindowPref = serde_json::from_str("\"startMinimized\"").expect("pref");
        assert_eq!(pref, WindowPref::StartMinimized);
        assert!(serde_json::from_str::<WindowPref>("\"developerMode\"").is_err());
    }

    #[test]
    fn the_dto_uses_the_names_the_tab_reads() {
        let dto = WindowPrefsDto {
            minimize_to_tray: true,
            start_minimized: false,
        };
        assert_eq!(
            serde_json::to_value(dto).expect("json"),
            serde_json::json!({ "minimizeToTray": true, "startMinimized": false })
        );
    }
}
