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
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// Virtual key code for the PTT key. 0 = disabled.
static PTT_VKEY: AtomicI32 = AtomicI32::new(0);
/// The polling thread paired with its OWN shutdown flag. `Some` means a thread
/// is registered; `None` means none exists. This Mutex is the authoritative
/// critical section that prevents duplicate spawns.
///
/// The shutdown flag is per-generation, not global: each `ptt_start` mints a
/// fresh `Arc<AtomicBool>` and moves a clone into its thread. A later start can
/// therefore never reset the stop signal that an earlier thread's `join()` is
/// still waiting on — the lost-signal race (ATOMICRACE-001) that a single
/// shared flag allowed.
static PTT_THREAD: Mutex<Option<(Arc<AtomicBool>, std::thread::JoinHandle<()>)>> = Mutex::new(None);

/// Caps Lock.
const VK_CAPS_LOCK: i32 = 0x14;
/// The key left of 1 (backtick on a US layout). Stored as VK_OEM_3 on every
/// platform and read as that physical key, whatever character the active
/// layout puts on it.
const VK_BACKTICK: i32 = 0xC0;

/// Returns true if a VK code may be bound as the PTT key.
///
/// Security hardening (BUG-136): only non-text keys qualify. Capture
/// (`ptt_listen_for_key`) and `ptt_set_key` both enforce this one list, so the
/// poller never watches a key outside it.
fn is_allowed_ptt_vk(vk: i32) -> bool {
    // Function keys F1-F24.
    if (0x70..=0x87).contains(&vk) {
        return true;
    }

    // Non-text navigation/control keys, single modifiers, Caps Lock and the
    // backtick key. The Windows/Meta key stays out. Escape is excluded: it's
    // also the Settings overlay's close key, so a capture in progress races the
    // panel tearing down and can bind PTT to Escape with no visible
    // confirmation (OC-0334).
    matches!(
        vk,
        0x10 | // Shift
        0x11 | // Ctrl
        0x12 | // Alt
        VK_CAPS_LOCK |
        VK_BACKTICK |
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
        VK_XBUTTON1 |
        VK_XBUTTON2
    )
}

/// One capture tick: the first bindable key in `down` that was not already
/// held when capture started. `stale` holds those start-time keys and drops
/// each one once it is released, so a key held while the picker opened is only
/// captured after a fresh press.
fn next_captured(down: &[i32], stale: &mut Vec<i32>) -> Option<i32> {
    stale.retain(|vk| down.contains(vk));
    down.iter()
        .copied()
        .find(|vk| is_allowed_ptt_vk(*vk) && !stale.contains(vk))
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
        unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(layout_vk(vk)) };
    // High-order bit set (negative when interpreted as i16) = key is down
    (state as i16) < 0
}

/// The VK the active layout gives the key `vk` stands for. Only the backtick
/// key differs: it is the physical key left of 1 (scan code 0x29), which
/// layouts map to different OEM VKs (VK_OEM_3 on US English, other OEM codes
/// on many European layouts).
/// Anything outside the OEM punctuation range falls back to VK_OEM_3, so the
/// mapping can never turn into a letter or digit. The layout is the polling
/// thread's own (the default input language), so a user who switches layouts
/// per window may find the binding follows a different OEM key.
#[cfg(windows)]
fn layout_vk(vk: i32) -> i32 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VSC_TO_VK};
    if vk != VK_BACKTICK {
        return vk;
    }
    // SAFETY: MapVirtualKeyW only reads the calling thread's keyboard layout.
    let mapped = unsafe { MapVirtualKeyW(0x29, MAPVK_VSC_TO_VK) } as i32;
    if (0xBA..=0xE2).contains(&mapped) {
        mapped
    } else {
        VK_BACKTICK
    }
}

/// F21 (the first of F21-F24, VK 0x84..=0x87), which `device_query` cannot read.
#[cfg(any(target_os = "linux", test))]
const VK_F21: i32 = 0x84;

/// Mouse 4 and Mouse 5 (XBUTTON1/XBUTTON2).
const VK_XBUTTON1: i32 = 0x05;
const VK_XBUTTON2: i32 = 0x06;

#[cfg(target_os = "linux")]
fn is_key_down(vk: i32) -> bool {
    match vk {
        VK_XBUTTON1 | VK_XBUTTON2 => side_button_vks(held_side_buttons()).contains(&vk),
        VK_F21..=0x87 => f21_f24_vks(held_f21_f24()).contains(&vk),
        _ => linux::vk_held(vk, &held_keys()),
    }
}

/// The F21-F24 VKs held in an (F21, F22, F23, F24) reading.
#[cfg(any(target_os = "linux", test))]
fn f21_f24_vks(held: [bool; 4]) -> Vec<i32> {
    (VK_F21..)
        .zip(held)
        .filter_map(|(vk, down)| down.then_some(vk))
        .collect()
}

/// (F21, F22, F23, F24) held now; all false with no X display (or no XInput2,
/// since the reading shares the side-button connection).
#[cfg(target_os = "linux")]
fn held_f21_f24() -> [bool; 4] {
    SIDE_BUTTONS.with(|b| b.as_ref().map_or([false; 4], |b| b.held_f21_f24()))
}

/// The side-button VKs held in a (Mouse 4, Mouse 5) reading.
#[cfg(any(target_os = "linux", test))]
fn side_button_vks((back, forward): (bool, bool)) -> Vec<i32> {
    [(back, VK_XBUTTON1), (forward, VK_XBUTTON2)]
        .into_iter()
        .filter_map(|(held, vk)| held.then_some(vk))
        .collect()
}

/// (Mouse 4, Mouse 5) held now; both false with no X display or no XInput2.
#[cfg(target_os = "linux")]
fn held_side_buttons() -> (bool, bool) {
    SIDE_BUTTONS.with(|b| b.as_ref().map_or((false, false), |b| b.held()))
}

/// One XQueryKeymap snapshot of every held key (empty with no X display).
#[cfg(target_os = "linux")]
fn held_keys() -> Vec<device_query::Keycode> {
    use device_query::DeviceQuery;
    DEVICE_STATE.with(|ds| ds.as_ref().map(|ds| ds.get_keys()).unwrap_or_default())
}

// The shared per-thread X11 key-state handle. Hoisted to module scope so both
// `is_key_down` and `combo_state` read the same cached DeviceState. Cache per
// thread — creating it on every call would open/close /dev/input/ file
// descriptors every 20ms in a polling loop. checked_new() returns None when no
// X11 display is reachable (e.g. a pure-Wayland session without XWayland), so
// the global paths degrade to "key never pressed" instead of panicking.
#[cfg(target_os = "linux")]
thread_local! {
    static DEVICE_STATE: Option<device_query::DeviceState> = {
        use device_query::DeviceState;
        let ds = DeviceState::checked_new();
        if ds.is_none() {
            log::warn!("Global key state unavailable: no X11/XWayland display");
        }
        ds
    };
}

// The side buttons need XInput2, which `device_query` does not use; one
// display connection per polling thread, like DEVICE_STATE.
#[cfg(target_os = "linux")]
thread_local! {
    static SIDE_BUTTONS: Option<crate::mouse_buttons::SideButtons> = {
        let buttons = crate::mouse_buttons::SideButtons::open();
        static WARNED: std::sync::Once = std::sync::Once::new();
        if buttons.is_none() {
            WARNED.call_once(|| {
                log::warn!("Mouse side buttons unavailable: no X display with XInput2");
            });
        }
        buttons
    };
}

#[cfg(not(any(windows, target_os = "linux")))]
fn is_key_down(_vk: i32) -> bool {
    false
}

/// Which modifiers are held right now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Modifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

/// The held modifiers plus whether each of `vks` is down, for U6's global
/// Ctrl+Shift+M/Ctrl+Shift+D. The modifiers cannot come from `is_key_down` on
/// Linux: the modifier VKs are deliberately absent from `linux::vk_to_keycode`
/// (LShift/RShift and LControl/RControl each collapse to one VK, which a single
/// (vk, Keycode) pair cannot represent). `device_query` does expose them as
/// distinct Keycodes, so Linux reads them from the same single key snapshot.
#[cfg(windows)]
pub(crate) fn combo_state<const N: usize>(vks: [i32; N]) -> (Modifiers, [bool; N]) {
    let mods = Modifiers {
        ctrl: is_key_down(0x11),
        shift: is_key_down(0x10),
        alt: is_key_down(0x12),
        meta: is_key_down(0x5B) || is_key_down(0x5C),
    };
    (mods, vks.map(is_key_down))
}

#[cfg(target_os = "linux")]
pub(crate) fn combo_state<const N: usize>(vks: [i32; N]) -> (Modifiers, [bool; N]) {
    combo_state_from(&held_keys(), vks)
}

#[cfg(target_os = "linux")]
fn combo_state_from<const N: usize>(
    keys: &[device_query::Keycode],
    vks: [i32; N],
) -> (Modifiers, [bool; N]) {
    use device_query::Keycode;
    let any = |a: Keycode, b: Keycode| keys.contains(&a) || keys.contains(&b);
    let mods = Modifiers {
        ctrl: any(Keycode::LControl, Keycode::RControl),
        shift: any(Keycode::LShift, Keycode::RShift),
        alt: any(Keycode::LAlt, Keycode::RAlt),
        meta: any(Keycode::LMeta, Keycode::RMeta),
    };
    let down = vks.map(|vk| linux::vk_to_keycode(vk).is_some_and(|k| keys.contains(&k)));
    (mods, down)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn combo_state<const N: usize>(_vks: [i32; N]) -> (Modifiers, [bool; N]) {
    (Modifiers::default(), [false; N])
}

// ---------------------------------------------------------------------------
// Linux key code mapping (VK ↔ device_query::Keycode)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use device_query::Keycode;

    /// Non-modifier VK <-> Keycode pairs. Every entry here round-trips:
    /// `vk_to_keycode(vk) == Some(key)` and `keycode_to_vk(&key) == vk`.
    /// Modifier keys are NOT in this table — several Keycodes collapse to one
    /// VK (LShift/RShift both -> 0x10), which a single (vk, Keycode) pair
    /// cannot represent, and the reverse direction was never defined for them
    /// (`vk_to_keycode` returned `None` for 0x10/0x11/0x12/0x5B before this
    /// table existed). They are handled as a small match prefix in
    /// `keycode_to_vk` instead.
    const VK_KEYCODES: &[(i32, Keycode)] = &[
        // Digits
        (0x30, Keycode::Key0),
        (0x31, Keycode::Key1),
        (0x32, Keycode::Key2),
        (0x33, Keycode::Key3),
        (0x34, Keycode::Key4),
        (0x35, Keycode::Key5),
        (0x36, Keycode::Key6),
        (0x37, Keycode::Key7),
        (0x38, Keycode::Key8),
        (0x39, Keycode::Key9),
        // Letters
        (0x41, Keycode::A),
        (0x42, Keycode::B),
        (0x43, Keycode::C),
        (0x44, Keycode::D),
        (0x45, Keycode::E),
        (0x46, Keycode::F),
        (0x47, Keycode::G),
        (0x48, Keycode::H),
        (0x49, Keycode::I),
        (0x4A, Keycode::J),
        (0x4B, Keycode::K),
        (0x4C, Keycode::L),
        (0x4D, Keycode::M),
        (0x4E, Keycode::N),
        (0x4F, Keycode::O),
        (0x50, Keycode::P),
        (0x51, Keycode::Q),
        (0x52, Keycode::R),
        (0x53, Keycode::S),
        (0x54, Keycode::T),
        (0x55, Keycode::U),
        (0x56, Keycode::V),
        (0x57, Keycode::W),
        (0x58, Keycode::X),
        (0x59, Keycode::Y),
        (0x5A, Keycode::Z),
        // Control keys
        (0x08, Keycode::Backspace),
        (0x09, Keycode::Tab),
        (0x0D, Keycode::Enter),
        (0x1B, Keycode::Escape),
        (0x20, Keycode::Space),
        (0x21, Keycode::PageUp),
        (0x22, Keycode::PageDown),
        (0x23, Keycode::End),
        (0x24, Keycode::Home),
        (0x25, Keycode::Left),
        (0x26, Keycode::Up),
        (0x27, Keycode::Right),
        (0x28, Keycode::Down),
        (0x2D, Keycode::Insert),
        (0x2E, Keycode::Delete),
        // Numpad
        (0x60, Keycode::Numpad0),
        (0x61, Keycode::Numpad1),
        (0x62, Keycode::Numpad2),
        (0x63, Keycode::Numpad3),
        (0x64, Keycode::Numpad4),
        (0x65, Keycode::Numpad5),
        (0x66, Keycode::Numpad6),
        (0x67, Keycode::Numpad7),
        (0x68, Keycode::Numpad8),
        (0x69, Keycode::Numpad9),
        // Function keys
        (0x70, Keycode::F1),
        (0x71, Keycode::F2),
        (0x72, Keycode::F3),
        (0x73, Keycode::F4),
        (0x74, Keycode::F5),
        (0x75, Keycode::F6),
        (0x76, Keycode::F7),
        (0x77, Keycode::F8),
        (0x78, Keycode::F9),
        (0x79, Keycode::F10),
        (0x7A, Keycode::F11),
        (0x7B, Keycode::F12),
        (0x7C, Keycode::F13),
        (0x7D, Keycode::F14),
        (0x7E, Keycode::F15),
        (0x7F, Keycode::F16),
        (0x80, Keycode::F17),
        (0x81, Keycode::F18),
        (0x82, Keycode::F19),
        (0x83, Keycode::F20),
        // Lock keys
        (0x14, Keycode::CapsLock),
        // Punctuation
        (0xC0, Keycode::Grave),
    ];

    /// Convert a device_query Keycode to its Windows-VK-equivalent integer.
    /// Returns 0 for keys that have no mapping (treated as "unknown").
    pub fn keycode_to_vk(key: &Keycode) -> i32 {
        match key {
            // Modifier keys, as the generic VK of either side. See the
            // VK_KEYCODES doc comment for why these live here instead.
            Keycode::LShift | Keycode::RShift => 0x10,
            Keycode::LControl | Keycode::RControl => 0x11,
            Keycode::LAlt | Keycode::RAlt => 0x12,
            Keycode::LMeta | Keycode::RMeta => 0x5B,
            _ => VK_KEYCODES
                .iter()
                .find(|(_, k)| k == key)
                .map(|(vk, _)| *vk)
                .unwrap_or(0),
        }
    }

    /// Whether `vk` is down in one key snapshot. A modifier VK matches either
    /// side, the way `GetAsyncKeyState` reads the generic VK on Windows.
    pub fn vk_held(vk: i32, keys: &[Keycode]) -> bool {
        let any = |a: Keycode, b: Keycode| keys.contains(&a) || keys.contains(&b);
        match vk {
            0x10 => any(Keycode::LShift, Keycode::RShift),
            0x11 => any(Keycode::LControl, Keycode::RControl),
            0x12 => any(Keycode::LAlt, Keycode::RAlt),
            _ => vk_to_keycode(vk).is_some_and(|k| keys.contains(&k)),
        }
    }

    /// Convert a VK-equivalent integer back to a device_query Keycode.
    /// Returns `None` for unknown codes (including the modifier VKs above,
    /// which this never reverses — see the VK_KEYCODES doc comment).
    pub fn vk_to_keycode(vk: i32) -> Option<Keycode> {
        VK_KEYCODES.iter().find(|(v, _)| *v == vk).map(|(_, k)| *k)
    }
}

/// Decide whether the polling loop must emit a `ptt-state` event this tick.
///
/// Returns `Some(new_state)` on a press/release edge, `None` when nothing
/// changed.
///
/// The `vk == 0` (unbound) case is folded into `pressed` here rather than
/// guarding the whole tick: clearing the binding while the key is physically
/// held must still produce the `true -> false` falling edge. With the guard
/// outside, `was_pressed` freezes at `true`, no final `ptt-state=false` is
/// ever emitted, and the microphone stays published.
fn ptt_transition(vk: i32, key_down: bool, was_pressed: bool) -> Option<bool> {
    let pressed = vk != 0 && key_down;
    (pressed != was_pressed).then_some(pressed)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Whether key-state polling can observe keys at all: always on Windows, on
/// Linux when an X11 or XWayland display is reachable (`DeviceState::checked_new`
/// is `None` otherwise), never elsewhere (macOS `is_key_down` is a stub).
pub(crate) fn polling_available() -> bool {
    #[cfg(windows)]
    {
        true
    }

    #[cfg(target_os = "linux")]
    {
        use device_query::DeviceState;
        DeviceState::checked_new().is_some()
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    {
        false
    }
}

/// The PTT virtual key currently set; 0 when unset.
#[cfg(target_os = "linux")]
pub(crate) fn ptt_vk() -> i32 {
    PTT_VKEY.load(Ordering::SeqCst)
}

/// Whether a `ptt-state` event can ever arrive, i.e. whether a press can lift
/// the join-time PTT gate.
///
/// `ptt_start` arms unconditionally, so a live thread is NOT evidence that PTT
/// works: on macOS `is_key_down` is a compile-time stub that always returns
/// false. On a Wayland session the app's window is a Wayland one, whose key
/// presses an XWayland display never sees, so nothing polls there; presses
/// arrive from the xdg-desktop-portal GlobalShortcuts interface instead, and
/// only once the user has bound the shortcut and the portal reported a trigger
/// (`GlobalKeysStatus::ptt_supported`). The frontend gates its join-time PTT
/// mute and the Keybinds tab's binding on this, because muting at join where no
/// event can ever arrive would close the microphone for the whole session with
/// no way to reopen it. Async: on Wayland the first call waits for the portal's
/// probe.
#[tauri::command]
pub async fn ptt_polling_supported<R: Runtime>(app: AppHandle<R>) -> bool {
    tokio::task::spawn_blocking(move || crate::shortcuts::ptt_supported_now(&app))
        .await
        .unwrap_or(false)
}

/// Start the PTT polling loop. Emits `ptt-state` (bool) events.
///
/// Uses `PTT_THREAD`'s Mutex as the critical section to prevent duplicate
/// thread spawns. Each spawned thread owns a private `Arc<AtomicBool>` shutdown
/// flag, so `ptt_stop`/`ptt_stop_internal` signal exactly the thread they are
/// tearing down and a concurrent restart cannot clobber that signal.
#[tauri::command]
pub fn ptt_start<R: Runtime>(app: AppHandle<R>) {
    // A Wayland session never polls: arming lets the portal's Activated and
    // Deactivated edges become `ptt-state`.
    #[cfg(target_os = "linux")]
    {
        if crate::shortcuts::wayland_now() {
            crate::portal_shortcuts::arm(&app, crate::portal_shortcuts::Flag::Ptt);
            return;
        }
    }
    let mut guard = crate::sync::lock(&PTT_THREAD);
    if guard.is_some() {
        return; // thread already alive — Mutex is the authoritative check
    }

    // Per-generation shutdown flag: only this thread ever reads it, so a later
    // ptt_start cannot reset it out from under a pending join of a prior thread.
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);

    let handle = std::thread::spawn(move || {
        // Wrap the entire loop body in catch_unwind so that panics from
        // is_key_down (unsafe FFI) or app.emit do not wedge the thread slot
        // at `Some` with no way to recover.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut was_pressed = false;

            while !thread_shutdown.load(Ordering::SeqCst) {
                let vk = PTT_VKEY.load(Ordering::SeqCst);
                // Evaluated on every tick, including vk == 0: clearing the PTT
                // key while it is physically held must still produce a falling
                // edge, otherwise was_pressed freezes at true and the mic never
                // gets its final `ptt-state=false`. `is_key_down` short-circuits
                // to false for vk == 0 on every platform, so this costs nothing.
                if let Some(pressed) = ptt_transition(vk, is_key_down(vk), was_pressed) {
                    was_pressed = pressed;
                    let _ = app.emit("ptt-state", pressed);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }));

        // Self-cleanup, but ONLY if the slot still registers THIS generation.
        // A normal stop already took the handle out (slot is None, or a newer
        // ptt_start has re-registered), so this exists purely so a *panicked*
        // thread doesn't leave the slot stuck at `Some` and block future starts
        // — without a finishing thread ever clearing a newer thread's slot (the
        // handle-slot corruption in ATOMICRACE-001).
        let mut g = crate::sync::lock(&PTT_THREAD);
        if matches!(g.as_ref(), Some((flag, _)) if Arc::ptr_eq(flag, &thread_shutdown)) {
            *g = None;
        }

        if result.is_err() {
            log::error!("PTT polling thread panicked — PTT is no longer active");
            // Notify the frontend so it can surface a warning and offer retry.
            let _ = app.emit("ptt-error", "PTT thread panicked");
        }
    });

    *guard = Some((shutdown, handle));
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
    #[cfg(target_os = "linux")]
    crate::portal_shortcuts::disarm(crate::portal_shortcuts::Flag::Ptt);
    // Take this generation's (flag, handle) out under the lock, then signal and
    // join OUTSIDE the lock — the thread locks PTT_THREAD on exit, so joining
    // while holding it would deadlock. Taking first (slot -> None) also lets a
    // concurrent ptt_start register a fresh generation without racing us.
    let taken = {
        let mut guard = crate::sync::lock(&PTT_THREAD);
        guard.take()
    };

    if let Some((shutdown, handle)) = taken {
        // Signal only the thread we just unregistered; its flag is private, so
        // this can never disturb a newer generation.
        shutdown.store(true, Ordering::SeqCst);
        // Best-effort join — ignore if the thread already exited or panicked.
        let _ = handle.join();
    }
}

/// Prefix of `ptt_set_key`'s error for a key outside `is_allowed_ptt_vk`, so
/// the frontend can tell a refused saved key from a missing bridge.
const UNSUPPORTED_KEY_ERROR: &str = "unsupported_ptt_key";

/// Set the PTT virtual key code. Pass 0 to disable.
/// Valid: 0 (disabled) or a key `is_allowed_ptt_vk` accepts.
#[tauri::command]
pub fn ptt_set_key(vk_code: i32) -> Result<(), String> {
    if vk_code != 0 && !is_allowed_ptt_vk(vk_code) {
        return Err(format!("{UNSUPPORTED_KEY_ERROR}: {vk_code}"));
    }
    PTT_VKEY.store(vk_code, Ordering::SeqCst);
    Ok(())
}

/// Wait for the user to press a bindable key and return its VK-equivalent code.
/// Used by the keybind capture UI. Times out after 10 seconds and returns 0.
/// Runs on a dedicated thread to avoid blocking the Tauri async thread pool.
#[tauri::command]
pub async fn ptt_listen_for_key() -> i32 {
    tokio::task::spawn_blocking(|| {
        #[cfg(any(windows, target_os = "linux"))]
        {
            #[cfg(target_os = "linux")]
            if DEVICE_STATE.with(|ds| ds.is_none()) {
                log::warn!("PTT key capture unavailable: no X11/XWayland display");
                return 0;
            }
            let mut stale = bindable_keys_down();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);

            while std::time::Instant::now() < deadline {
                if let Some(vk) = next_captured(&bindable_keys_down(), &mut stale) {
                    // Wait for key release (with its own timeout)
                    let release_deadline = std::time::Instant::now() + Duration::from_secs(5);
                    while is_key_down(vk) && std::time::Instant::now() < release_deadline {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    return vk;
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

/// Every bindable key held right now. Only keys on the allow-list are read.
#[cfg(windows)]
fn bindable_keys_down() -> Vec<i32> {
    (1..=254i32)
        .filter(|vk| is_allowed_ptt_vk(*vk) && is_key_down(*vk))
        .collect()
}

#[cfg(target_os = "linux")]
fn bindable_keys_down() -> Vec<i32> {
    let mut down: Vec<i32> = held_keys()
        .iter()
        .map(linux::keycode_to_vk)
        .filter(|vk| is_allowed_ptt_vk(*vk))
        .collect();
    down.dedup();
    down.extend(side_button_vks(held_side_buttons()));
    down.extend(f21_f24_vks(held_f21_f24()));
    down
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn side_button_readings_map_to_the_windows_xbutton_vks() {
        assert_eq!(side_button_vks((false, false)), Vec::<i32>::new());
        assert_eq!(side_button_vks((true, false)), vec![VK_XBUTTON1]);
        assert_eq!(side_button_vks((false, true)), vec![VK_XBUTTON2]);
        assert_eq!(
            side_button_vks((true, true)),
            vec![VK_XBUTTON1, VK_XBUTTON2]
        );
        assert!(is_allowed_ptt_vk(VK_XBUTTON1) && is_allowed_ptt_vk(VK_XBUTTON2));
    }

    #[test]
    fn a_held_side_button_is_captured_like_a_key() {
        let mut stale = Vec::new();
        assert_eq!(
            next_captured(&side_button_vks((true, false)), &mut stale),
            Some(VK_XBUTTON1)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn combo_state_reads_modifiers_and_keys_from_one_snapshot() {
        use device_query::Keycode;
        let (mods, down) = combo_state_from(
            &[Keycode::RControl, Keycode::LShift, Keycode::M],
            [0x4D, 0x44],
        );
        assert_eq!(
            mods,
            Modifiers {
                ctrl: true,
                shift: true,
                alt: false,
                meta: false
            }
        );
        assert_eq!(down, [true, false]);

        let (mods, down) =
            combo_state_from(&[Keycode::LAlt, Keycode::RMeta, Keycode::D], [0x4D, 0x44]);
        assert_eq!(
            mods,
            Modifiers {
                ctrl: false,
                shift: false,
                alt: true,
                meta: true
            }
        );
        assert_eq!(down, [false, true]);
    }

    // PTT_VKEY is a process-global AtomicI32 and cargo runs tests on parallel
    // threads, so every mutating assertion lives in this ONE test — splitting
    // them across tests makes the get/set assertions racy.
    #[test]
    fn ptt_set_key_accepts_valid_codes_and_get_reflects_them() {
        assert!(ptt_set_key(0).is_ok());
        assert!(ptt_set_key(0x05).is_ok()); // Mouse X1
        assert!(ptt_set_key(0x20).is_ok()); // Space
        assert!(ptt_set_key(0x14).is_ok()); // Caps Lock
        assert!(ptt_set_key(0xC0).is_ok()); // Backtick
        assert!(ptt_set_key(0x87).is_ok()); // F24

        ptt_set_key(0x11).unwrap(); // Ctrl
        assert_eq!(PTT_VKEY.load(Ordering::SeqCst), 0x11);
        ptt_set_key(0).unwrap();
        assert_eq!(PTT_VKEY.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn ptt_set_key_rejects_invalid_codes() {
        assert!(ptt_set_key(-1).is_err());
        assert!(ptt_set_key(255).is_err());
        assert!(ptt_set_key(300).is_err());
    }

    // ptt_set_key holds the same line as capture: a key the picker would never
    // return is refused, with an error the frontend recognises.
    #[test]
    fn ptt_set_key_rejects_keys_capture_refuses() {
        for vk in [
            0x41, 0x5A, 0x31, 0x0D, 0x08, 0x09, 0x1B, 0x5B, 0x01, 0xDE, 254,
        ] {
            let err = ptt_set_key(vk).expect_err(&format!("vk {vk:#04x} must be refused"));
            assert!(err.starts_with(UNSUPPORTED_KEY_ERROR), "{err}");
        }
    }

    // Stop with no thread registered must be a clean no-op: it must not panic,
    // hang on take()/join of an empty slot, or leave the slot in a bad state.
    // Guards the empty-slot path of the ATOMICRACE-001 fix. (The threaded
    // start/stop race itself needs a Tauri runtime and is covered in CI /
    // manual testing — no other unit test touches PTT_THREAD, so this stays
    // deterministic under parallel test execution.)
    #[test]
    fn ptt_stop_is_noop_when_not_running() {
        ptt_stop_internal();
        ptt_stop_internal(); // idempotent
        let g = crate::sync::lock(&PTT_THREAD);
        assert!(g.is_none(), "slot must stay empty when nothing was running");
    }

    // The loop must emit only on edges, never on every tick — a repeat emit
    // would re-run the mute logic (and its user-mute guard) 50x/second.
    #[test]
    fn ptt_transition_reports_edges_only() {
        assert_eq!(ptt_transition(0x41, true, false), Some(true), "rising edge");
        assert_eq!(ptt_transition(0x41, true, true), None, "still held");
        assert_eq!(
            ptt_transition(0x41, false, true),
            Some(false),
            "falling edge"
        );
        assert_eq!(ptt_transition(0x41, false, false), None, "still idle");
    }

    // Regression for the "hot mic after Clear while the PTT key is held" bug:
    // clearing the binding (vk -> 0) with the key still physically down must
    // still yield the falling edge that emits the final ptt-state=false. The
    // old loop wrapped the whole comparison in `if vk != 0`, so this case
    // produced no transition at all and the mic stayed published.
    #[test]
    fn ptt_transition_emits_release_when_binding_cleared_while_key_held() {
        assert_eq!(ptt_transition(0, true, true), Some(false));
        // The release is reported once, then the unbound key stays quiet — an
        // unbound key must never read as pressed no matter what the raw
        // key-down probe says.
        assert_eq!(ptt_transition(0, true, false), None);
        assert_eq!(ptt_transition(0, false, false), None);
    }

    #[test]
    fn allowed_vk_accepts_non_text_keys() {
        assert!(is_allowed_ptt_vk(0x70)); // F1
        assert!(is_allowed_ptt_vk(0x7B)); // F12
        assert!(is_allowed_ptt_vk(0x7C)); // F13
        assert!(is_allowed_ptt_vk(0x83)); // F20
        assert!(is_allowed_ptt_vk(0x87)); // F24
        assert!(!is_allowed_ptt_vk(0x88));
        assert!(is_allowed_ptt_vk(0x25)); // Left arrow
        assert!(is_allowed_ptt_vk(0x2E)); // Delete
        assert!(is_allowed_ptt_vk(0x05)); // Mouse X1
        assert!(is_allowed_ptt_vk(0x06)); // Mouse X2
        assert!(is_allowed_ptt_vk(0x14)); // Caps Lock
        assert!(is_allowed_ptt_vk(0xC0)); // Backtick
        assert!(is_allowed_ptt_vk(0x10)); // Shift
        assert!(is_allowed_ptt_vk(0x11)); // Ctrl
        assert!(is_allowed_ptt_vk(0x12)); // Alt
    }

    #[test]
    fn allowed_vk_rejects_text_keys() {
        for vk in 0x41..=0x5A {
            assert!(!is_allowed_ptt_vk(vk), "letter {vk:#04x}");
        }
        for vk in 0x30..=0x39 {
            assert!(!is_allowed_ptt_vk(vk), "digit {vk:#04x}");
        }
        for vk in 0x60..=0x6F {
            assert!(!is_allowed_ptt_vk(vk), "numpad {vk:#04x}");
        }
        // OEM punctuation other than the backtick key.
        for vk in (0xBA..=0xE2).filter(|vk| *vk != 0xC0) {
            assert!(!is_allowed_ptt_vk(vk), "punctuation {vk:#04x}");
        }
        assert!(!is_allowed_ptt_vk(0x0D)); // Enter
        assert!(!is_allowed_ptt_vk(0x08)); // Backspace
        assert!(!is_allowed_ptt_vk(0x09)); // Tab
        assert!(!is_allowed_ptt_vk(0x5B)); // Left Meta
        assert!(!is_allowed_ptt_vk(0x5C)); // Right Meta

        // Side-specific modifiers: only the generic VK is bindable.
        for vk in 0xA0..=0xA5 {
            assert!(!is_allowed_ptt_vk(vk), "side modifier {vk:#04x}");
        }
        // Escape also closes the Settings overlay the capture UI lives in, so
        // it must never be capturable as a PTT key (OC-0334).
        assert!(!is_allowed_ptt_vk(0x1B)); // Escape
    }

    // A key already held when the picker opens (the Shift of a Shift+click, a
    // mouse button) is not captured until it is released and pressed again.
    #[test]
    fn capture_ignores_keys_held_at_start_until_pressed_again() {
        let mut stale = vec![0x10];
        assert_eq!(next_captured(&[0x10], &mut stale), None, "still held");
        assert_eq!(
            next_captured(&[0x10, 0x70], &mut stale),
            Some(0x70),
            "fresh F1"
        );
        assert_eq!(next_captured(&[], &mut stale), None, "released");
        assert!(stale.is_empty());
        assert_eq!(
            next_captured(&[0x10], &mut stale),
            Some(0x10),
            "pressed again"
        );
    }

    #[test]
    fn capture_skips_keys_that_cannot_be_bound() {
        let mut stale = Vec::new();
        assert_eq!(next_captured(&[0x41, 0x5B], &mut stale), None);
        assert_eq!(next_captured(&[0x41, 0x14], &mut stale), Some(0x14));
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
            (Keycode::F13, 0x7C),
            (Keycode::F20, 0x83),
            (Keycode::CapsLock, 0x14),
            (Keycode::Grave, 0xC0),
        ];

        for (keycode, vk) in cases {
            assert_eq!(
                keycode_to_vk(&keycode),
                vk,
                "keycode_to_vk failed for {keycode:?}"
            );
            assert_eq!(
                vk_to_keycode(vk),
                Some(keycode),
                "vk_to_keycode failed for vk={vk:#04x}"
            );
        }
    }

    #[test]
    fn f21_to_f24_map_to_their_vks() {
        assert_eq!(f21_f24_vks([false; 4]), Vec::<i32>::new());
        assert_eq!(f21_f24_vks([true, false, false, true]), vec![0x84, 0x87]);
        assert_eq!(f21_f24_vks([false, true, true, false]), vec![0x85, 0x86]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_modifier_vk_matches_either_side() {
        use super::linux::vk_held;
        use device_query::Keycode;
        assert!(vk_held(0x10, &[Keycode::RShift]));
        assert!(vk_held(0x11, &[Keycode::LControl]));
        assert!(vk_held(0x12, &[Keycode::RAlt]));
        assert!(!vk_held(0x11, &[Keycode::LShift]));
        assert!(vk_held(0xC0, &[Keycode::Grave]));
        assert!(!vk_held(0xC0, &[]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_unknown_vk_returns_none() {
        use super::linux::vk_to_keycode;
        assert_eq!(vk_to_keycode(0xFF), None);
        assert_eq!(vk_to_keycode(0), None);
    }
}
