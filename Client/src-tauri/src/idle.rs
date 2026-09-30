//! System-wide input idle time, for the client's auto-idle (DP-33).
//!
//! The webview only sees input aimed at its own window, so on its own it
//! turns someone Idle while they work in another app. This asks the OS how
//! long it has been since the last keyboard or mouse input anywhere, and
//! answers `None` where the OS cannot say; the frontend then falls back to
//! in-window activity.
//!
//! - Windows: `GetLastInputInfo`.
//! - Linux: over D-Bus (the libdbus `keyring` already links), GNOME's
//!   `org.gnome.Mutter.IdleMonitor`, then `org.freedesktop.ScreenSaver`'s
//!   `GetSessionIdleTime` (KDE on X11; Plasma refuses it on Wayland). Both
//!   answer in milliseconds, on X11 and Wayland alike where they exist.
//! - Anything else: `None`.

/// Milliseconds since the last keyboard or mouse input on the system, or
/// `None` when the OS cannot say. Read-only, argument-free, and cheap enough
/// for the frontend's 30 s poll; `async` so a slow D-Bus peer blocks a worker
/// thread rather than the IPC main thread.
#[tauri::command(async)]
pub fn system_idle_ms() -> Option<u64> {
    platform_idle_ms()
}

#[cfg(windows)]
fn platform_idle_ms() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a live, correctly sized LASTINPUTINFO for the call.
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    // SAFETY: GetTickCount takes no arguments and cannot fail.
    let now = unsafe { GetTickCount() };
    Some(ticks_since(now, info.dwTime))
}

/// Milliseconds between two `GetTickCount` readings. Both are 32-bit and wrap
/// every 49.7 days, so the difference is taken modulo 2^32: a last input just
/// before the wrap and a "now" just after it is a few ms, not minus 49 days.
#[cfg(any(windows, test))]
fn ticks_since(now: u32, last_input: u32) -> u64 {
    u64::from(now.wrapping_sub(last_input))
}

#[cfg(target_os = "linux")]
fn platform_idle_ms() -> Option<u64> {
    use dbus::blocking::Connection;
    use std::time::Duration;

    // ponytail: a fresh session-bus connection per 30 s poll; cache one if
    // the poll ever gets hotter.
    let conn = Connection::new_session().ok()?;
    let timeout = Duration::from_millis(500);
    first_idle_ms(
        || {
            conn.with_proxy(
                "org.gnome.Mutter.IdleMonitor",
                "/org/gnome/Mutter/IdleMonitor/Core",
                timeout,
            )
            .method_call("org.gnome.Mutter.IdleMonitor", "GetIdletime", ())
            .ok()
            .map(|(ms,): (u64,)| ms)
        },
        || {
            conn.with_proxy(
                "org.freedesktop.ScreenSaver",
                "/org/freedesktop/ScreenSaver",
                timeout,
            )
            .method_call("org.freedesktop.ScreenSaver", "GetSessionIdleTime", ())
            .ok()
            .map(|(ms,): (u32,)| ms)
        },
    )
}

/// The first Linux source to answer, in preference order: Mutter's 64-bit
/// count, else the ScreenSaver interface's 32-bit one. The second is not
/// asked once the first has answered.
#[cfg(any(target_os = "linux", test))]
fn first_idle_ms(
    mutter: impl FnOnce() -> Option<u64>,
    screensaver: impl FnOnce() -> Option<u32>,
) -> Option<u64> {
    mutter().or_else(|| screensaver().map(u64::from))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn platform_idle_ms() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_since_is_the_plain_difference() {
        assert_eq!(ticks_since(10_000, 4_000), 6_000);
        assert_eq!(ticks_since(4_000, 4_000), 0);
    }

    #[test]
    fn ticks_since_survives_the_49_day_wrap() {
        // Last input 100 ms before the counter wrapped, now 50 ms after it.
        assert_eq!(ticks_since(50, u32::MAX - 99), 150);
    }

    #[test]
    fn mutter_answer_wins_and_screensaver_is_not_asked() {
        let got = first_idle_ms(
            || Some(u64::from(u32::MAX) + 1),
            || panic!("the ScreenSaver interface must not be asked"),
        );
        assert_eq!(got, Some(u64::from(u32::MAX) + 1));
    }

    #[test]
    fn screensaver_answer_is_used_when_mutter_is_absent() {
        assert_eq!(first_idle_ms(|| None, || Some(600_000)), Some(600_000));
        assert_eq!(
            first_idle_ms(|| None, || Some(u32::MAX)),
            Some(u64::from(u32::MAX))
        );
    }

    #[test]
    fn no_source_is_none() {
        assert_eq!(first_idle_ms(|| None, || None), None);
    }
}
