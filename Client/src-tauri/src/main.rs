// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// libX11 is already linked: GTK, device_query (push-to-talk) and libwebrtc
// (screen capture; the audio device module's typing detection) all use it.
#[cfg(target_os = "linux")]
#[link(name = "X11")]
extern "C" {
    fn XInitThreads() -> i32;
}

fn main() {
    // Xlib is not thread-safe unless XInitThreads runs before any other Xlib
    // call. libwebrtc's audio device module opens and queries its own X display
    // from whichever thread creates it (a Tokio worker listing devices at
    // sign-in), racing GTK's main-thread Xlib use; without this the app aborts
    // with "[xcb] Too much data requested from _XRead" (seen by the B7-17
    // artifact smoke on Ubuntu 22.04, x64 and arm64). It only enables Xlib's
    // locking, so it is harmless where no X display is ever opened.
    #[cfg(target_os = "linux")]
    // SAFETY: the first Xlib call in the process, made before any thread exists.
    unsafe {
        XInitThreads();
    }

    // WebKitGTK's DMABUF renderer is known to crash or produce a blank window
    // under Wayland (notably on NVIDIA). Disable it on Wayland sessions unless
    // the user has already set the variable themselves (any value wins).
    #[cfg(target_os = "linux")]
    {
        let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"));
        if is_wayland && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    owncord_client_lib::run()
}
