//! Global voice shortcuts (U6): Ctrl+Shift+M mute and Ctrl+Shift+D deafen that
//! fire while OwnCord is not focused.
//!
//! Reuses the same global key-state machinery as push-to-talk (`ptt.rs`'s
//! `is_key_down`): a 20 ms polling loop that OBSERVES the combination without
//! consuming it, so other applications still receive the keystroke normally.
//! Emits `voice-shortcut` ("mute"/"deafen") once per press edge.
//!
//! Platform coverage mirrors PTT: Windows (`GetAsyncKeyState`) and X11/XWayland
//! Linux (`device_query`). A pure-Wayland session has no reachable display, so
//! `device_query` returns None and `voice_shortcuts_supported` reports false —
//! the global path there needs the xdg-desktop-portal GlobalShortcuts API,
//! which is not wired yet (see the Settings disclosure). The tray's Mute and
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

/// Whether the main window has focus, fed by `WindowEvent::Focused` in
/// `lib.rs`. The poller reads this flag rather than asking the window: that
/// getter round-trips through the event loop and blocks forever once the loop
/// has stopped, which would hang the Exit handler's join.
static MAIN_FOCUSED: AtomicBool = AtomicBool::new(false);

/// Record the main window's focus (called from the window-event handler).
pub fn set_main_focused(focused: bool) {
    MAIN_FOCUSED.store(focused, Ordering::SeqCst);
}

/// A combination only counts while the window is unfocused: focused, the
/// renderer's own keydown handler owns the voice shortcuts.
fn pressed_when_unfocused(focused: bool, combo_down: bool) -> bool {
    !focused && combo_down
}

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

/// Whether this platform can observe global key state (mirrors
/// `ptt_polling_supported`). False on macOS and on a pure-Wayland session.
#[tauri::command]
pub fn voice_shortcuts_supported() -> bool {
    crate::ptt::ptt_polling_supported()
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
                let focused = MAIN_FOCUSED.load(Ordering::SeqCst);
                let mods = modifiers_down();

                let mute_down =
                    pressed_when_unfocused(focused, combo_matches(mods, is_key_down(MUTE_KEY_VK)));
                if shortcut_pressed(mute_down, mute_was_down) {
                    let _ = app.emit("voice-shortcut", "mute");
                }
                mute_was_down = mute_down;

                let deafen_down = pressed_when_unfocused(
                    focused,
                    combo_matches(mods, is_key_down(DEAFEN_KEY_VK)),
                );
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
    fn focused_window_suppresses_the_global_combo() {
        // Focused, the renderer's own keydown handler owns the combo.
        assert!(!pressed_when_unfocused(true, true));
        assert!(!pressed_when_unfocused(true, false));
        // Unfocused, the global poller owns it.
        assert!(pressed_when_unfocused(false, true));
        assert!(!pressed_when_unfocused(false, false));
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
    fn focus_flag_tracks_the_window_event() {
        set_main_focused(true);
        assert!(MAIN_FOCUSED.load(Ordering::SeqCst));
        set_main_focused(false);
        assert!(!MAIN_FOCUSED.load(Ordering::SeqCst));
    }

    #[test]
    fn stop_is_a_clean_noop_when_not_running() {
        voice_shortcuts_stop_internal();
        voice_shortcuts_stop_internal(); // idempotent
        let g = SHORTCUT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
        assert!(g.is_none(), "slot must stay empty when nothing was running");
    }
}
