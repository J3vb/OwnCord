//! Push-to-Talk via key-state polling.
//!
//! Uses a 20ms polling loop to detect key press/release without consuming
//! the keystroke — other applications and the chat input continue to
//! receive the key normally.
//!
//! Key codes use Windows Virtual Key (VK) code values on all platforms:
//! letters 0x41–0x5A, digits 0x30–0x39, Space 0x20, Enter 0x0D, etc.
//! This ensures the stored integer is consistent on both Windows and Linux.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// Virtual key code for the PTT key. 0 = disabled.
static PTT_VKEY: AtomicI32 = AtomicI32::new(0);
/// Whether the polling loop is running (intent flag, kept for backwards compat).
static PTT_RUNNING: AtomicBool = AtomicBool::new(false);
/// Shutdown signal sent into the polling thread. Separate from PTT_RUNNING so
/// that "stop the loop now" and "should a loop be running" are distinct.
static PTT_SHUTDOWN: AtomicBool = AtomicBool::new(false);
/// Handle to the polling thread. `Some` means a thread is alive; `None` means
/// no thread exists. This Mutex is the authoritative critical section that
/// prevents duplicate thread spawns.
static PTT_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

/// Returns true if a VK code is allowed for global capture in ptt_listen_for_key.
///
/// Security hardening (BUG-136): only non-text keys are capturable to reduce
/// misuse potential if the renderer is compromised.
fn is_allowed_ptt_capture_vk(vk: i32) -> bool {
    // Explicitly reject modifier keys.
    if matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C) {
        return false;
    }

    // Function keys F1-F24.
    if (0x70..=0x87).contains(&vk) {
        return true;
    }

    // Non-text navigation/control keys.
    matches!(
        vk,
        0x1B | // Escape
        0x20 | // Space
        0x21 | // Page Up
        0x22 | // Page Down
        0x23 | // End
        0x24 | // Home
        0x25 | // Left
        0x26 | // Up
        0x27 | // Right
        0x28 | // Down
        0x2D | // Insert
        0x2E | // Delete
        0x05 | // Mouse X1
        0x06   // Mouse X2
    )
}

// ---------------------------------------------------------------------------
// Platform-specific key detection
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn is_key_down(vk: i32) -> bool {
    // VK codes 1-254 are valid; 0 and 255 are reserved/undefined
    if !(1..=254).contains(&vk) {
        return false;
    }
    // SAFETY: GetAsyncKeyState is safe to call with valid VK codes 1-254
    let state =
        unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk) };
    // High-order bit set (negative when interpreted as i16) = key is down
    (state as i16) < 0
}

#[cfg(target_os = "linux")]
fn is_key_down(vk: i32) -> bool {
    use device_query::{DeviceQuery, DeviceState};
    // Cache DeviceState per thread — creating it on every call would open/close
    // /dev/input/ file descriptors every 20ms in the polling loop.
    // checked_new() returns None when no X11 display is reachable (e.g. a
    // pure-Wayland session without XWayland), so PTT degrades to "key never
    // pressed" instead of panicking on every poll.
    thread_local! {
        static DEVICE_STATE: Option<DeviceState> = {
            let ds = DeviceState::checked_new();
            if ds.is_none() {
                log::warn!(
                    "PTT unavailable: no X11/XWayland display for global key state"
                );
            }
            ds
        };
    }
    let Some(keycode) = linux::vk_to_keycode(vk) else {
        return false;
    };
    DEVICE_STATE.with(|ds| ds.as_ref().is_some_and(|ds| ds.get_keys().contains(&keycode)))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn is_key_down(_vk: i32) -> bool {
    false
}

// ---------------------------------------------------------------------------
// Linux key code mapping (VK ↔ device_query::Keycode)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use device_query::Keycode;

    /// Convert a device_query Keycode to its Windows-VK-equivalent integer.
    /// Returns 0 for keys that have no mapping (treated as "unknown").
    pub fn keycode_to_vk(key: &Keycode) -> i32 {
        match key {
            // Digits
            Keycode::Key0 => 0x30,
            Keycode::Key1 => 0x31,
            Keycode::Key2 => 0x32,
            Keycode::Key3 => 0x33,
            Keycode::Key4 => 0x34,
            Keycode::Key5 => 0x35,
            Keycode::Key6 => 0x36,
            Keycode::Key7 => 0x37,
            Keycode::Key8 => 0x38,
            Keycode::Key9 => 0x39,
            // Letters
            Keycode::A => 0x41,
            Keycode::B => 0x42,
            Keycode::C => 0x43,
            Keycode::D => 0x44,
            Keycode::E => 0x45,
            Keycode::F => 0x46,
            Keycode::G => 0x47,
            Keycode::H => 0x48,
            Keycode::I => 0x49,
            Keycode::J => 0x4A,
            Keycode::K => 0x4B,
            Keycode::L => 0x4C,
            Keycode::M => 0x4D,
            Keycode::N => 0x4E,
            Keycode::O => 0x4F,
            Keycode::P => 0x50,
            Keycode::Q => 0x51,
            Keycode::R => 0x52,
            Keycode::S => 0x53,
            Keycode::T => 0x54,
            Keycode::U => 0x55,
            Keycode::V => 0x56,
            Keycode::W => 0x57,
            Keycode::X => 0x58,
            Keycode::Y => 0x59,
            Keycode::Z => 0x5A,
            // Control keys
            Keycode::Backspace => 0x08,
            Keycode::Tab => 0x09,
            Keycode::Enter => 0x0D,
            Keycode::Escape => 0x1B,
            Keycode::Space => 0x20,
            Keycode::PageUp => 0x21,
            Keycode::PageDown => 0x22,
            Keycode::End => 0x23,
            Keycode::Home => 0x24,
            Keycode::Left => 0x25,
            Keycode::Up => 0x26,
            Keycode::Right => 0x27,
            Keycode::Down => 0x28,
            Keycode::Insert => 0x2D,
            Keycode::Delete => 0x2E,
            // Numpad
            Keycode::Numpad0 => 0x60,
            Keycode::Numpad1 => 0x61,
            Keycode::Numpad2 => 0x62,
            Keycode::Numpad3 => 0x63,
            Keycode::Numpad4 => 0x64,
            Keycode::Numpad5 => 0x65,
            Keycode::Numpad6 => 0x66,
            Keycode::Numpad7 => 0x67,
            Keycode::Numpad8 => 0x68,
            Keycode::Numpad9 => 0x69,
            // Function keys
            Keycode::F1 => 0x70,
            Keycode::F2 => 0x71,
            Keycode::F3 => 0x72,
            Keycode::F4 => 0x73,
            Keycode::F5 => 0x74,
            Keycode::F6 => 0x75,
            Keycode::F7 => 0x76,
            Keycode::F8 => 0x77,
            Keycode::F9 => 0x78,
            Keycode::F10 => 0x79,
            Keycode::F11 => 0x7A,
            Keycode::F12 => 0x7B,
            // Lock keys
            Keycode::CapsLock => 0x14,
            // Modifier keys (included so ptt_listen_for_key can skip them)
            Keycode::LShift | Keycode::RShift => 0x10,
            Keycode::LControl | Keycode::RControl => 0x11,
            Keycode::LAlt | Keycode::RAlt => 0x12,
            Keycode::LMeta | Keycode::RMeta => 0x5B,
            _ => 0,
        }
    }

    /// Convert a VK-equivalent integer back to a device_query Keycode.
    /// Returns `None` for unknown codes.
    pub fn vk_to_keycode(vk: i32) -> Option<Keycode> {
        match vk {
            0x30 => Some(Keycode::Key0),
            0x31 => Some(Keycode::Key1),
            0x32 => Some(Keycode::Key2),
            0x33 => Some(Keycode::Key3),
            0x34 => Some(Keycode::Key4),
            0x35 => Some(Keycode::Key5),
            0x36 => Some(Keycode::Key6),
            0x37 => Some(Keycode::Key7),
            0x38 => Some(Keycode::Key8),
            0x39 => Some(Keycode::Key9),
            0x41 => Some(Keycode::A),
            0x42 => Some(Keycode::B),
            0x43 => Some(Keycode::C),
            0x44 => Some(Keycode::D),
            0x45 => Some(Keycode::E),
            0x46 => Some(Keycode::F),
            0x47 => Some(Keycode::G),
            0x48 => Some(Keycode::H),
            0x49 => Some(Keycode::I),
            0x4A => Some(Keycode::J),
            0x4B => Some(Keycode::K),
            0x4C => Some(Keycode::L),
            0x4D => Some(Keycode::M),
            0x4E => Some(Keycode::N),
            0x4F => Some(Keycode::O),
            0x50 => Some(Keycode::P),
            0x51 => Some(Keycode::Q),
            0x52 => Some(Keycode::R),
            0x53 => Some(Keycode::S),
            0x54 => Some(Keycode::T),
            0x55 => Some(Keycode::U),
            0x56 => Some(Keycode::V),
            0x57 => Some(Keycode::W),
            0x58 => Some(Keycode::X),
            0x59 => Some(Keycode::Y),
            0x5A => Some(Keycode::Z),
            0x08 => Some(Keycode::Backspace),
            0x09 => Some(Keycode::Tab),
            0x0D => Some(Keycode::Enter),
            0x1B => Some(Keycode::Escape),
            0x20 => Some(Keycode::Space),
            0x21 => Some(Keycode::PageUp),
            0x22 => Some(Keycode::PageDown),
            0x23 => Some(Keycode::End),
            0x24 => Some(Keycode::Home),
            0x25 => Some(Keycode::Left),
            0x26 => Some(Keycode::Up),
            0x27 => Some(Keycode::Right),
            0x28 => Some(Keycode::Down),
            0x2D => Some(Keycode::Insert),
            0x2E => Some(Keycode::Delete),
            0x60 => Some(Keycode::Numpad0),
            0x61 => Some(Keycode::Numpad1),
            0x62 => Some(Keycode::Numpad2),
            0x63 => Some(Keycode::Numpad3),
            0x64 => Some(Keycode::Numpad4),
            0x65 => Some(Keycode::Numpad5),
            0x66 => Some(Keycode::Numpad6),
            0x67 => Some(Keycode::Numpad7),
            0x68 => Some(Keycode::Numpad8),
            0x69 => Some(Keycode::Numpad9),
            0x70 => Some(Keycode::F1),
            0x71 => Some(Keycode::F2),
            0x72 => Some(Keycode::F3),
            0x73 => Some(Keycode::F4),
            0x74 => Some(Keycode::F5),
            0x75 => Some(Keycode::F6),
            0x76 => Some(Keycode::F7),
            0x77 => Some(Keycode::F8),
            0x78 => Some(Keycode::F9),
            0x79 => Some(Keycode::F10),
            0x7A => Some(Keycode::F11),
            0x7B => Some(Keycode::F12),
            0x14 => Some(Keycode::CapsLock),
            _ => None,
        }
    }

    /// Modifier VK codes to skip in ptt_listen_for_key.
    pub fn is_modifier_vk(vk: i32) -> bool {
        matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start the PTT polling loop. Emits `ptt-state` (bool) events.
///
/// Uses `PTT_THREAD`'s Mutex as the critical section to prevent duplicate
/// thread spawns. The `PTT_SHUTDOWN` flag is passed into the thread loop so
/// it can be stopped cleanly from `ptt_stop` or `ptt_stop_internal`.
#[tauri::command]
pub fn ptt_start<R: Runtime>(app: AppHandle<R>) {
    let mut guard = PTT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return; // thread already alive — Mutex is the authoritative check
    }

    // Reset the shutdown flag before spawning so the loop doesn't exit
    // immediately if a previous ptt_stop set it.
    PTT_SHUTDOWN.store(false, Ordering::SeqCst);
    PTT_RUNNING.store(true, Ordering::SeqCst);

    let handle = std::thread::spawn(move || {
        // Wrap the entire loop body in catch_unwind so that panics from
        // is_key_down (unsafe FFI) or app.emit do not leave PTT_RUNNING
        // stuck at true with no way to recover.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut was_pressed = false;

            while !PTT_SHUTDOWN.load(Ordering::SeqCst) {
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
        }));

        // Clear the thread handle slot so ptt_start can spawn a replacement.
        // Use unwrap_or_else to handle a poisoned Mutex defensively, matching
        // the pattern used in ptt_stop_internal.
        let mut g = PTT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
        PTT_RUNNING.store(false, Ordering::SeqCst);

        if result.is_err() {
            log::error!("PTT polling thread panicked — PTT is no longer active");
            // Notify the frontend so it can surface a warning and offer retry.
            let _ = app.emit("ptt-error", "PTT thread panicked");
        }
    });

    *guard = Some(handle);
}

/// Stop the PTT polling loop (IPC-callable command).
#[tauri::command]
pub fn ptt_stop() {
    ptt_stop_internal();
}

/// Stop the PTT polling thread and block until it has fully exited.
///
/// This is the internal, non-IPC version called from the Tauri lifecycle
/// handler (`RunEvent::Exit`) to guarantee the thread is gone before the
/// process tears down, preventing the `AppHandle` from being used against
/// a half-torn-down runtime.
pub fn ptt_stop_internal() {
    // Signal the thread to exit.
    PTT_SHUTDOWN.store(true, Ordering::SeqCst);
    PTT_RUNNING.store(false, Ordering::SeqCst);

    // Take the handle out of the Mutex so we can join it outside the lock,
    // avoiding a potential deadlock if the thread itself tries to lock
    // PTT_THREAD on exit.
    let handle = {
        let mut guard = PTT_THREAD.lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };

    if let Some(h) = handle {
        // Best-effort join — ignore if the thread already exited or panicked.
        let _ = h.join();
    }
}

/// Set the PTT virtual key code. Pass 0 to disable.
/// Valid range: 0 (disabled) or 1–254 (VK-equivalent key codes).
#[tauri::command]
pub fn ptt_set_key(vk_code: i32) -> Result<(), String> {
    if vk_code != 0 && !(1..=254).contains(&vk_code) {
        return Err(format!("invalid virtual key code: {vk_code} (must be 0 or 1-254)"));
    }
    PTT_VKEY.store(vk_code, Ordering::SeqCst);
    Ok(())
}

/// Get the current PTT virtual key code.
#[tauri::command]
pub fn ptt_get_key() -> i32 {
    PTT_VKEY.load(Ordering::SeqCst)
}

/// Wait for the user to press any non-modifier key and return its VK-equivalent code.
/// Used by the keybind capture UI. Times out after 10 seconds and returns 0.
/// Runs on a dedicated thread to avoid blocking the Tauri async thread pool.
#[tauri::command]
pub async fn ptt_listen_for_key() -> i32 {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "linux")]
        {
            use device_query::{DeviceQuery, DeviceState};
            let Some(device_state) = DeviceState::checked_new() else {
                log::warn!("PTT key capture unavailable: no X11/XWayland display");
                return 0;
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(10);

            while std::time::Instant::now() < deadline {
                for key in device_state.get_keys() {
                    let vk = linux::keycode_to_vk(&key);
                    if vk == 0 || linux::is_modifier_vk(vk) || !is_allowed_ptt_capture_vk(vk) {
                        continue;
                    }
                    // Wait for key release (with its own timeout)
                    let release_deadline =
                        std::time::Instant::now() + Duration::from_secs(5);
                    while device_state.get_keys().contains(&key)
                        && std::time::Instant::now() < release_deadline
                    {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    return vk;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            0
        }

        #[cfg(windows)]
        {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);

            while std::time::Instant::now() < deadline {
                for vk in 1..=254i32 {
                    // Skip keys that are not explicitly allowed for capture.
                    if !is_allowed_ptt_capture_vk(vk) {
                        continue;
                    }
                    if is_key_down(vk) {
                        let release_deadline =
                            std::time::Instant::now() + Duration::from_secs(5);
                        while is_key_down(vk) && std::time::Instant::now() < release_deadline {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        return vk;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            0
        }

        #[cfg(not(any(windows, target_os = "linux")))]
        {
            0 // unsupported platform
        }
    })
    .await
    .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // PTT_VKEY is a process-global AtomicI32 and cargo runs tests on parallel
    // threads, so every mutating assertion lives in this ONE test — splitting
    // them across tests makes the get/set assertions racy.
    #[test]
    fn ptt_set_key_accepts_valid_codes_and_get_reflects_them() {
        assert!(ptt_set_key(0).is_ok());
        assert!(ptt_set_key(1).is_ok());
        assert!(ptt_set_key(0x20).is_ok()); // Space
        assert!(ptt_set_key(254).is_ok());

        ptt_set_key(0x41).unwrap(); // A
        assert_eq!(ptt_get_key(), 0x41);
        ptt_set_key(0).unwrap();
        assert_eq!(ptt_get_key(), 0);
    }

    #[test]
    fn ptt_set_key_rejects_invalid_codes() {
        assert!(ptt_set_key(-1).is_err());
        assert!(ptt_set_key(255).is_err());
        assert!(ptt_set_key(300).is_err());
    }

    #[test]
    fn allowed_capture_vk_accepts_safe_non_text_keys() {
        assert!(is_allowed_ptt_capture_vk(0x70)); // F1
        assert!(is_allowed_ptt_capture_vk(0x7B)); // F12
        assert!(is_allowed_ptt_capture_vk(0x25)); // Left arrow
        assert!(is_allowed_ptt_capture_vk(0x2E)); // Delete
        assert!(is_allowed_ptt_capture_vk(0x05)); // Mouse X1
        assert!(is_allowed_ptt_capture_vk(0x06)); // Mouse X2
    }

    #[test]
    fn allowed_capture_vk_rejects_text_and_modifier_keys() {
        assert!(!is_allowed_ptt_capture_vk(0x41)); // A
        assert!(!is_allowed_ptt_capture_vk(0x31)); // 1
        assert!(!is_allowed_ptt_capture_vk(0x0D)); // Enter
        assert!(!is_allowed_ptt_capture_vk(0x08)); // Backspace
        assert!(!is_allowed_ptt_capture_vk(0x10)); // Shift
        assert!(!is_allowed_ptt_capture_vk(0x11)); // Ctrl
        assert!(!is_allowed_ptt_capture_vk(0x12)); // Alt
        assert!(!is_allowed_ptt_capture_vk(0x5B)); // Meta
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_keycode_round_trips_for_common_keys() {
        use super::linux::{keycode_to_vk, vk_to_keycode};
        use device_query::Keycode;

        let cases = [
            (Keycode::A, 0x41),
            (Keycode::Z, 0x5A),
            (Keycode::Key0, 0x30),
            (Keycode::Key9, 0x39),
            (Keycode::Space, 0x20),
            (Keycode::Enter, 0x0D),
            (Keycode::F1, 0x70),
            (Keycode::F12, 0x7B),
        ];

        for (keycode, vk) in cases {
            assert_eq!(keycode_to_vk(&keycode), vk, "keycode_to_vk failed for {keycode:?}");
            assert_eq!(
                vk_to_keycode(vk),
                Some(keycode),
                "vk_to_keycode failed for vk={vk:#04x}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_unknown_vk_returns_none() {
        use super::linux::vk_to_keycode;
        assert_eq!(vk_to_keycode(0xFF), None);
        assert_eq!(vk_to_keycode(0), None);
    }
}
