//! Global voice shortcuts (U6): mute and deafen that fire whether or not
//! OwnCord is focused. The combination is Ctrl+Shift plus a key that Settings
//! (Keybinds) can rebind; both default to Ctrl+Shift+M / Ctrl+Shift+D, and a
//! rebind is live on the running poller (the keys are read each tick). The
//! in-app keydown handler fires on the same combinations only where this
//! poller is not running, so a focused press toggles exactly once.
//!
//! Reuses the same global key-state machinery as push-to-talk (`ptt.rs`'s
//! `combo_state`): a 20 ms polling loop that OBSERVES the combination without
//! consuming it, so other applications still receive the keystroke normally.
//! Emits `voice-shortcut` ("mute"/"deafen") once per press edge.
//!
//! Platform coverage: Windows (`GetAsyncKeyState`) and X11 Linux
//! (`device_query`) poll. A Wayland session never polls, XWayland included:
//! XQueryKeymap there only sees keys while an X11 window has focus, so a
//! native Wayland app in front hides the combination. It binds through the
//! xdg-desktop-portal GlobalShortcuts interface instead (`portal_shortcuts.rs`)
//! and reports supported only once the portal has reported a trigger; where
//! the interface is missing it reports unsupported. `global_keys_status`
//! names the backend. The tray's Mute and Deafen items cover every platform
//! regardless.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

#[cfg(target_os = "linux")]
use crate::portal_shortcuts as portal;
use crate::ptt::{combo_state, Modifiers};

/// Windows Virtual-Key codes for the shipped combinations, used until the
/// renderer overrides them: M and D with Ctrl+Shift.
pub(crate) const DEFAULT_MUTE_KEY_VK: i32 = 0x4D; // M
pub(crate) const DEFAULT_DEAFEN_KEY_VK: i32 = 0x44; // D

/// The key codes the poller reads on every tick. Atomics rather than consts so
/// a rebind from Settings (`voice_shortcuts_set_keys`) takes effect on the
/// running loop without a restart; both stay within the range `ptt.rs`'s
/// VK/keycode table can observe.
static MUTE_KEY_VK: AtomicI32 = AtomicI32::new(DEFAULT_MUTE_KEY_VK);
static DEAFEN_KEY_VK: AtomicI32 = AtomicI32::new(DEFAULT_DEAFEN_KEY_VK);

/// The poller thread paired with its own per-generation shutdown flag, exactly
/// as `ptt.rs`'s `PTT_THREAD`: the Mutex is the authoritative duplicate-spawn
/// guard, and the private flag means a later start cannot reset the signal an
/// earlier thread's join is waiting on.
static SHORTCUT_THREAD: Mutex<Option<(Arc<AtomicBool>, std::thread::JoinHandle<()>)>> =
    Mutex::new(None);

/// One shortcut's edge decision: true when the combination has just been
/// pressed. A held combination fires once — the caller toggles on the rising
/// edge only, so leaning on the combination cannot machine-gun the mute.
fn shortcut_pressed(combo_down: bool, was_down: bool) -> bool {
    combo_down && !was_down
}

/// Whether the combination is held with exactly Ctrl+Shift: an extra Alt or
/// Win/Super makes it a different shortcut that belongs to another app.
fn combo_matches(mods: Modifiers, key_down: bool) -> bool {
    key_down && mods.ctrl && mods.shift && !mods.alt && !mods.meta
}

/// Whether the session is Wayland, from `WAYLAND_DISPLAY` and
/// `XDG_SESSION_TYPE`.
#[cfg(target_os = "linux")]
fn is_wayland_session(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
    wayland_display.is_some_and(|d| !d.is_empty())
        || session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland"))
}

/// Whether global key state is observable while another app is in front: not
/// on a Wayland session, and only where key polling works at all.
pub(crate) fn global_keys_observable(wayland: bool, polling_supported: bool) -> bool {
    !wayland && polling_supported
}

/// Whether this process runs in a Wayland session.
#[cfg(target_os = "linux")]
pub(crate) fn wayland_now() -> bool {
    is_wayland_session(
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
    )
}

/// How this session delivers global keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    /// Key-state polling (Windows, X11). Observes keys without consuming them.
    Polling,
    /// The xdg-desktop-portal GlobalShortcuts interface (Wayland).
    Portal,
    /// Nothing can deliver a global key.
    None,
}

/// The portal's own description of each bound trigger; `None` is unbound.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Triggers {
    pub ptt: Option<String>,
    pub mute: Option<String>,
    pub deafen: Option<String>,
    /// The portal holds all three of our shortcuts but names none of their
    /// keys (xdg-desktop-portal-hyprland always does; the user binds them in
    /// the compositor's config).
    #[serde(skip)]
    pub unnamed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalKeysStatus {
    pub backend: Backend,
    /// The portal interface version; 0 when there is no portal.
    pub portal_version: u32,
    pub triggers: Triggers,
    /// Whether the portal can open its own shortcut settings (version 2+).
    pub can_configure: bool,
    /// The portal holds our shortcuts but names none of their keys, so the
    /// user assigns them in the desktop's own settings.
    pub triggers_unnamed: bool,
    /// The portal refused to open a session for us, so no shortcut can work
    /// until it does.
    pub session_refused: bool,
}

impl GlobalKeysStatus {
    pub(crate) fn new(backend: Backend, portal_version: u32, triggers: Triggers) -> Self {
        Self {
            backend,
            portal_version,
            can_configure: backend == Backend::Portal && portal_version >= 2,
            triggers_unnamed: backend == Backend::Portal && triggers.unnamed,
            session_refused: false,
            triggers,
        }
    }

    /// The same status with the portal's refusal of our session recorded.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn with_refused(mut self, refused: bool) -> Self {
        self.session_refused = refused;
        self
    }

    pub(crate) fn without_triggers(backend: Backend) -> Self {
        Self::new(backend, 0, Triggers::default())
    }

    /// Whether a push-to-talk press can arrive. On the portal path that needs
    /// a bound trigger (or a portal that holds the shortcut without naming
    /// its key) and a desktop known to send the release.
    pub(crate) fn ptt_supported(&self, xdg_current_desktop: Option<&str>) -> bool {
        match self.backend {
            Backend::Polling => true,
            Backend::Portal => {
                (self.triggers.ptt.is_some() || self.triggers.unnamed)
                    && portal_ptt_allowed(xdg_current_desktop, PORTAL_PTT_DENY)
            }
            Backend::None => false,
        }
    }

    /// Whether the global mute and deafen keys can fire. The portal path needs
    /// both bound: this flag makes the in-app handler stand down, so a lone
    /// binding would kill the other key.
    pub(crate) fn keys_supported(&self) -> bool {
        match self.backend {
            Backend::Polling => true,
            Backend::Portal => self.triggers.mute.is_some() && self.triggers.deafen.is_some(),
            Backend::None => false,
        }
    }
}

/// Desktops whose portal backend is known not to send `Deactivated`: a
/// push-to-talk press there would never release. Empty until one is found.
pub(crate) const PORTAL_PTT_DENY: &[&str] = &[];

/// Whether `XDG_CURRENT_DESKTOP` (a colon-separated list) is free of every
/// name in `deny`.
pub(crate) fn portal_ptt_allowed(xdg_current_desktop: Option<&str>, deny: &[&str]) -> bool {
    let Some(desktops) = xdg_current_desktop else {
        return true;
    };
    !desktops
        .split(':')
        .any(|d| deny.iter().any(|name| d.eq_ignore_ascii_case(name)))
}

/// Which backend serves this session. Wayland takes the portal when its
/// interface version read; every other session polls where keys are
/// observable and has none where they are not.
pub(crate) fn backend(wayland: bool, polling_ok: bool, portal_version: Option<u32>) -> Backend {
    if wayland {
        return match portal_version {
            Some(_) => Backend::Portal,
            None => Backend::None,
        };
    }
    if polling_ok {
        Backend::Polling
    } else {
        Backend::None
    }
}

/// The backend and bound triggers now. Blocking: on Wayland the first call
/// starts the portal thread and waits (at most a few seconds) for its probe.
pub(crate) fn status_now<R: Runtime>(app: &AppHandle<R>) -> GlobalKeysStatus {
    #[cfg(target_os = "linux")]
    {
        if wayland_now() {
            return portal::status(app);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
    GlobalKeysStatus::without_triggers(backend(false, crate::ptt::polling_available(), None))
}

fn current_desktop() -> Option<String> {
    std::env::var("XDG_CURRENT_DESKTOP").ok()
}

/// Whether a push-to-talk press can arrive; see `GlobalKeysStatus::ptt_supported`.
pub(crate) fn ptt_supported_now<R: Runtime>(app: &AppHandle<R>) -> bool {
    status_now(app).ptt_supported(current_desktop().as_deref())
}

/// Which backend serves global keys and which triggers are bound.
#[tauri::command]
pub async fn global_keys_status<R: Runtime>(app: AppHandle<R>) -> GlobalKeysStatus {
    tokio::task::spawn_blocking(move || status_now(&app))
        .await
        .unwrap_or_else(|_| GlobalKeysStatus::without_triggers(Backend::None))
}

/// Ask the portal to bind push to talk, mute and deafen. The VKs only pick the
/// suggested triggers; the desktop's own dialog has the last word. Waits for
/// that dialog (up to five minutes). Errors are codes: `unsupported`,
/// `bind_in_progress`, `bind_cancelled`, `bind_timeout`, `bind_failed`,
/// `portal_lost`.
#[tauri::command]
pub async fn global_keys_portal_bind<R: Runtime>(
    app: AppHandle<R>,
    ptt_vk: i32,
    mute_vk: i32,
    deafen_vk: i32,
) -> Result<GlobalKeysStatus, String> {
    #[cfg(target_os = "linux")]
    {
        let prefs = portal::BindPrefs {
            ptt_vk,
            mute_vk,
            deafen_vk,
        };
        let reply = tokio::task::spawn_blocking(move || portal::bind(&app, prefs))
            .await
            .map_err(|_| "bind_failed".to_string())??;
        reply.await.map_err(|_| "portal_lost".to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, ptt_vk, mute_vk, deafen_vk);
        Err("unsupported".to_string())
    }
}

/// Open the portal's own shortcut settings (interface version 2 and later).
#[tauri::command]
pub async fn global_keys_portal_configure<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let reply = tokio::task::spawn_blocking(move || portal::configure(&app))
            .await
            .map_err(|_| "configure_failed".to_string())??;
        reply.await.map_err(|_| "portal_lost".to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err("unsupported".to_string())
    }
}

/// Whether the global mute and deafen keys can fire while another app is in
/// front: polling where keys are observable, the portal once it has reported
/// both triggers. False on macOS and where the portal is missing or unbound.
#[tauri::command]
pub async fn voice_shortcuts_supported<R: Runtime>(app: AppHandle<R>) -> bool {
    tokio::task::spawn_blocking(move || status_now(&app).keys_supported())
        .await
        .unwrap_or(false)
}

/// Valid VK range, 1-254 (0 is not a key here: a global
/// shortcut is never "disabled", the tray and the in-app shortcuts still work).
pub(crate) fn validate_shortcut_keys(mute_vk: i32, deafen_vk: i32) -> Result<(), String> {
    if !(1..=254).contains(&mute_vk) {
        return Err(format!("invalid mute key code: {mute_vk} (must be 1-254)"));
    }
    if !(1..=254).contains(&deafen_vk) {
        return Err(format!(
            "invalid deafen key code: {deafen_vk} (must be 1-254)"
        ));
    }
    Ok(())
}

/// Replace the global mute/deafen combinations. Live: the poll loop reads the
/// atomics each tick, so a Settings rebind applies without a restart.
#[tauri::command]
pub fn voice_shortcuts_set_keys(mute_vk: i32, deafen_vk: i32) -> Result<(), String> {
    validate_shortcut_keys(mute_vk, deafen_vk)?;
    MUTE_KEY_VK.store(mute_vk, Ordering::SeqCst);
    DEAFEN_KEY_VK.store(deafen_vk, Ordering::SeqCst);
    Ok(())
}

/// Start the global voice-shortcut polling loop. Emits `voice-shortcut` with
/// "mute" or "deafen" on each press edge. On a Wayland session it arms the
/// portal path instead and never polls. A no-op where polling cannot observe
/// keys; the tray items still work there.
#[tauri::command]
pub fn voice_shortcuts_start<R: Runtime>(app: AppHandle<R>) {
    #[cfg(target_os = "linux")]
    {
        if wayland_now() {
            portal::arm(&app, portal::Flag::Keys);
            return;
        }
    }
    if !global_keys_observable(false, crate::ptt::polling_available()) {
        return;
    }
    let mut guard = crate::sync::lock(&SHORTCUT_THREAD);
    if guard.is_some() {
        return; // thread already alive — Mutex is the authoritative check
    }

    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);

    let handle = std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut mute_was_down = false;
            let mut deafen_was_down = false;
            while !thread_shutdown.load(Ordering::SeqCst) {
                let mute_vk = MUTE_KEY_VK.load(Ordering::SeqCst);
                let deafen_vk = DEAFEN_KEY_VK.load(Ordering::SeqCst);
                let (mods, [mute_key, deafen_key]) = combo_state([mute_vk, deafen_vk]);

                let mute_down = combo_matches(mods, mute_key);
                if shortcut_pressed(mute_down, mute_was_down) {
                    let _ = app.emit("voice-shortcut", "mute");
                }
                mute_was_down = mute_down;

                let deafen_down = combo_matches(mods, deafen_key);
                if shortcut_pressed(deafen_down, deafen_was_down) {
                    let _ = app.emit("voice-shortcut", "deafen");
                }
                deafen_was_down = deafen_down;

                std::thread::sleep(Duration::from_millis(20));
            }
        }));

        // Self-cleanup, but only if this generation still owns the slot — a
        // normal stop already took the handle out, so this exists purely so a
        // panicked thread does not leave the slot stuck at Some.
        let mut g = crate::sync::lock(&SHORTCUT_THREAD);
        if matches!(g.as_ref(), Some((flag, _)) if Arc::ptr_eq(flag, &thread_shutdown)) {
            *g = None;
        }

        if result.is_err() {
            // Non-fatal: the tray's Mute/Deafen items still work. There is no
            // renderer error surface for this (unlike PTT, a global shortcut
            // has no mute-ownership latch to strand), so log only.
            log::error!("voice-shortcut polling thread panicked — global mute/deafen is inactive");
        }
    });

    *guard = Some((shutdown, handle));
}

/// Stop the polling thread and block until it has exited. Called from the
/// Tauri lifecycle handler on exit so the AppHandle the thread holds is
/// released before the runtime tears down.
pub fn voice_shortcuts_stop_internal() {
    #[cfg(target_os = "linux")]
    portal::disarm(portal::Flag::Keys);
    // Take this generation out under the lock, then signal and join OUTSIDE —
    // the thread locks SHORTCUT_THREAD on exit, so joining while holding it
    // would deadlock.
    let taken = {
        let mut guard = crate::sync::lock(&SHORTCUT_THREAD);
        guard.take()
    };
    if let Some((shutdown, handle)) = taken {
        shutdown.store(true, Ordering::SeqCst);
        let _ = handle.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_fires_only_on_the_press_edge() {
        assert!(shortcut_pressed(true, false), "rising edge");
        assert!(!shortcut_pressed(true, true), "still held");
        assert!(!shortcut_pressed(false, true), "released");
        assert!(!shortcut_pressed(false, false), "still idle");
    }

    #[test]
    fn a_held_press_toggles_exactly_once() {
        let mut was_down = false;
        let mut fired = 0;
        for down in [false, true, true, true, true, false, false] {
            if shortcut_pressed(down, was_down) {
                fired += 1;
            }
            was_down = down;
        }
        assert_eq!(fired, 1);
    }

    #[test]
    fn default_keys_are_ctrl_shift_m_and_d() {
        assert_eq!(DEFAULT_MUTE_KEY_VK, 0x4D);
        assert_eq!(DEFAULT_DEAFEN_KEY_VK, 0x44);
    }

    #[test]
    fn set_keys_accepts_valid_codes_and_rejects_out_of_range() {
        assert!(validate_shortcut_keys(0x4D, 0x44).is_ok());
        assert!(validate_shortcut_keys(1, 254).is_ok());
        assert!(validate_shortcut_keys(0, 0x44).is_err(), "0 is not a key");
        assert!(validate_shortcut_keys(0x4D, 0).is_err());
        assert!(validate_shortcut_keys(255, 0x44).is_err());
        assert!(validate_shortcut_keys(0x4D, 300).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn any_wayland_session_is_detected() {
        assert!(is_wayland_session(Some("wayland-0"), None));
        assert!(is_wayland_session(None, Some("wayland")));
        assert!(is_wayland_session(Some("wayland-0"), Some("wayland")));
        assert!(!is_wayland_session(None, Some("x11")));
        assert!(!is_wayland_session(None, None));
        assert!(!is_wayland_session(Some(""), Some("x11")));
    }

    #[test]
    fn poller_runs_only_where_global_keys_are_observable() {
        assert!(global_keys_observable(false, true), "X11 or Windows");
        assert!(!global_keys_observable(true, true), "Wayland with XWayland");
        assert!(
            !global_keys_observable(true, false),
            "Wayland without XWayland"
        );
        assert!(!global_keys_observable(false, false), "macOS");
    }

    #[test]
    fn backend_follows_the_session_table() {
        assert_eq!(backend(false, true, None), Backend::Polling, "Windows");
        assert_eq!(
            backend(false, true, Some(2)),
            Backend::Polling,
            "X11 with a portal"
        );
        assert_eq!(backend(false, false, None), Backend::None, "macOS");
        assert_eq!(
            backend(true, true, Some(1)),
            Backend::Portal,
            "Wayland, portal"
        );
        assert_eq!(
            backend(true, true, None),
            Backend::None,
            "Wayland, no portal"
        );
    }

    #[test]
    fn status_serialises_for_the_webview() {
        let status = GlobalKeysStatus::new(
            Backend::Portal,
            2,
            Triggers {
                ptt: Some("F8".into()),
                ..Triggers::default()
            },
        );
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "backend": "portal",
                "portalVersion": 2,
                "triggers": { "ptt": "F8", "mute": null, "deafen": null },
                "canConfigure": true,
                "triggersUnnamed": false,
                "sessionRefused": false,
            })
        );
    }

    #[test]
    fn combo_needs_exactly_ctrl_and_shift() {
        let mods = |ctrl, shift, alt, meta| Modifiers {
            ctrl,
            shift,
            alt,
            meta,
        };
        assert!(combo_matches(mods(true, true, false, false), true));
        assert!(
            !combo_matches(mods(true, true, false, false), false),
            "key up"
        );
        assert!(
            !combo_matches(mods(true, false, false, false), true),
            "bare Ctrl"
        );
        assert!(
            !combo_matches(mods(false, true, false, false), true),
            "bare Shift"
        );
        assert!(
            !combo_matches(mods(true, true, true, false), true),
            "Ctrl+Shift+Alt"
        );
        assert!(
            !combo_matches(mods(true, true, false, true), true),
            "Ctrl+Shift+Win"
        );
        assert!(
            !combo_matches(mods(true, false, true, false), true),
            "Ctrl+Alt"
        );
    }

    #[test]
    fn stop_is_a_clean_noop_when_not_running() {
        voice_shortcuts_stop_internal();
        voice_shortcuts_stop_internal(); // idempotent
        let g = crate::sync::lock(&SHORTCUT_THREAD);
        assert!(g.is_none(), "slot must stay empty when nothing was running");
    }
}
