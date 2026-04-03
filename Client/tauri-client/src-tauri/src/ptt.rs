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
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// Virtual key code for the PTT key. 0 = disabled.
static PTT_VKEY: AtomicI32 = AtomicI32::new(0);
/// Whether the polling loop is running.
static PTT_RUNNING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Platform-specific key detection
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn is_key_down(vk: i32) -> bool {
    let state =
        unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk) };
    (state as u16 & 0x8000) != 0
}

#[cfg(target_os = "linux")]
fn is_key_down(vk: i32) -> bool {
    use device_query::{DeviceQuery, DeviceState};
    // Cache DeviceState per thread — creating it on every call would open/close
    // /dev/input/ file descriptors every 20ms in the polling loop.
    thread_local! {
        static DEVICE_STATE: DeviceState = DeviceState::new();
    }
    let Some(keycode) = linux::vk_to_keycode(vk) else {
        return false;
    };
    DEVICE_STATE.with(|ds| ds.get_keys().contains(&keycode))
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
            Keycode::Return => 0x0D,
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
            Keycode::NumLock => 0x90,
            Keycode::ScrollLock => 0x91,
            // Modifier keys (included so ptt_listen_for_key can skip them)
            Keycode::LShift | Keycode::RShift => 0x10,
            Keycode::LControl | Keycode::RControl => 0x11,
            Keycode::LAlt | Keycode::RAlt => 0x12,
            Keycode::Meta => 0x5B,
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
            0x0D => Some(Keycode::Return),
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
            0x90 => Some(Keycode::NumLock),
            0x91 => Some(Keycode::ScrollLock),
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
            let device_state = DeviceState::new();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);

            while std::time::Instant::now() < deadline {
                for key in device_state.get_keys() {
                    let vk = linux::keycode_to_vk(&key);
                    if vk == 0 || linux::is_modifier_vk(vk) {
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
                    // Skip modifier keys
                    if matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C) {
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

    #[test]
    fn ptt_set_key_accepts_valid_codes() {
        assert!(ptt_set_key(0).is_ok());
        assert!(ptt_set_key(1).is_ok());
        assert!(ptt_set_key(0x20).is_ok()); // Space
        assert!(ptt_set_key(0x41).is_ok()); // A
        assert!(ptt_set_key(254).is_ok());
    }

    #[test]
    fn ptt_set_key_rejects_invalid_codes() {
        assert!(ptt_set_key(-1).is_err());
        assert!(ptt_set_key(255).is_err());
        assert!(ptt_set_key(300).is_err());
    }

    #[test]
    fn ptt_get_key_reflects_set_key() {
        ptt_set_key(0x41).unwrap();
        assert_eq!(ptt_get_key(), 0x41);
        ptt_set_key(0).unwrap();
        assert_eq!(ptt_get_key(), 0);
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
            (Keycode::Return, 0x0D),
            (Keycode::F1, 0x70),
            (Keycode::F12, 0x7B),
        ];

        for (keycode, vk) in cases {
            assert_eq!(keycode_to_vk(&keycode), vk, "keycode_to_vk failed for {keycode:?}");
            assert_eq!(
                vk_to_keycode(vk),
                Some(keycode.clone()),
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
