//! Push-to-Talk via GetAsyncKeyState polling.
//!
//! Uses a 20ms polling loop to detect key press/release without consuming
//! the keystroke — other applications and the chat input continue to
//! receive the key normally.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// Virtual key code for the PTT key. 0 = disabled.
static PTT_VKEY: AtomicI32 = AtomicI32::new(0);
/// Whether the polling loop is running.
static PTT_RUNNING: AtomicBool = AtomicBool::new(false);

/// Check if a virtual key is currently held down (non-consuming).
#[cfg(windows)]
fn is_key_down(vk: i32) -> bool {
    let state =
        unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk) };
    (state as u16 & 0x8000) != 0
}

#[cfg(not(windows))]
fn is_key_down(_vk: i32) -> bool {
    false
}

/// Start the PTT polling loop. Emits `ptt-state` (bool) events.
#[tauri::command]
pub fn ptt_start<R: Runtime>(app: AppHandle<R>) {
    if PTT_RUNNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }

    std::thread::spawn(move || {
        let mut was_pressed = false;

        while PTT_RUNNING.load(Ordering::SeqCst) {
            let vk = PTT_VKEY.load(Ordering::SeqCst);
            if vk != 0 {
                let pressed = is_key_down(vk);
                if pressed != was_pressed {
                    was_pressed = pressed;
                    let _ = app.emit("ptt-state", pressed);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
}

/// Stop the PTT polling loop.
#[tauri::command]
pub fn ptt_stop() {
    PTT_RUNNING.store(false, Ordering::SeqCst);
}

/// Set the PTT virtual key code. Pass 0 to disable.
#[tauri::command]
pub fn ptt_set_key(vk_code: i32) {
    PTT_VKEY.store(vk_code, Ordering::SeqCst);
}

/// Get the current PTT virtual key code.
#[tauri::command]
pub fn ptt_get_key() -> i32 {
    PTT_VKEY.load(Ordering::SeqCst)
}

/// Wait for the user to press any non-modifier key and return its VK code.
/// Used by the keybind capture UI. Times out after 10 seconds and returns 0
/// to avoid blocking a thread indefinitely if the user navigates away.
#[tauri::command]
pub fn ptt_listen_for_key() -> i32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);

    while std::time::Instant::now() < deadline {
        for vk in 1..=254i32 {
            // Skip modifier keys
            if matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C) {
                continue;
            }
            if is_key_down(vk) {
                // Wait for release (with its own timeout)
                let release_deadline = std::time::Instant::now() + Duration::from_secs(5);
                while is_key_down(vk) && std::time::Instant::now() < release_deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                return vk;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    0 // timed out — no key pressed
}
