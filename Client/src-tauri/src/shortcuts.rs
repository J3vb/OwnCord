//! Global voice shortcuts (U6): Ctrl+Shift+M mute and Ctrl+Shift+D deafen that
//! fire whether or not OwnCord is focused. The in-app keydown handler does not
//! claim these combinations, so there is no double toggle to guard against.
//!
//! Reuses the same global key-state machinery as push-to-talk (`ptt.rs`'s
//! `is_key_down`): a 20 ms polling loop that OBSERVES the combination without
//! consuming it, so other applications still receive the keystroke normally.
//! Emits `voice-shortcut` ("mute"/"deafen") once per press edge.
//!
//! Platform coverage: Windows (`GetAsyncKeyState`) and X11 Linux
//! (`device_query`). Any Wayland session reports unsupported, XWayland
//! included: XQueryKeymap there only sees keys while an X11 window has focus,
//! so a native Wayland app in front hides the combination. The global path
//! there needs the xdg-desktop-portal GlobalShortcuts API, which is not wired
//! yet (see the Settings disclosure). The tray's Mute and
//! Deafen items cover every platform regardless.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

use crate::ptt::{is_key_down, modifiers_down, Modifiers};

/// Windows Virtual-Key codes for the fixed combinations.
const MUTE_KEY_VK: i32 = 0x4D; // M
const DEAFEN_KEY_VK: i32 = 0x44; // D

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
fn is_wayland_session(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
    wayland_display.is_some_and(|d| !d.is_empty())
        || session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland"))
}

/// Whether this platform can observe global key state while another app is in
/// front. False on macOS and on any Wayland session.
#[tauri::command]
pub fn voice_shortcuts_supported() -> bool {
    let wayland = is_wayland_session(
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
    );
    !wayland && crate::ptt::ptt_polling_supported()
}

/// Start the global voice-shortcut polling loop. Emits `voice-shortcut` with
/// "mute" or "deafen" on each press edge.
#[tauri::command]
pub fn voice_shortcuts_start<R: Runtime>(app: AppHandle<R>) {
    let mut guard = SHORTCUT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
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
                let mods = modifiers_down();

                let mute_down = combo_matches(mods, is_key_down(MUTE_KEY_VK));
                if shortcut_pressed(mute_down, mute_was_down) {
                    let _ = app.emit("voice-shortcut", "mute");
                }
                mute_was_down = mute_down;

                let deafen_down = combo_matches(mods, is_key_down(DEAFEN_KEY_VK));
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
        let mut g = SHORTCUT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
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
    // Take this generation out under the lock, then signal and join OUTSIDE —
    // the thread locks SHORTCUT_THREAD on exit, so joining while holding it
    // would deadlock.
    let taken = {
        let mut guard = SHORTCUT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
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
    fn any_wayland_session_is_detected() {
        assert!(is_wayland_session(Some("wayland-0"), None));
        assert!(is_wayland_session(None, Some("wayland")));
        assert!(is_wayland_session(Some("wayland-0"), Some("wayland")));
        assert!(!is_wayland_session(None, Some("x11")));
        assert!(!is_wayland_session(None, None));
        assert!(!is_wayland_session(Some(""), Some("x11")));
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
        let g = SHORTCUT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
        assert!(g.is_none(), "slot must stay empty when nothing was running");
    }
}
