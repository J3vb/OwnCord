// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// libX11 is already linked: GTK, device_query (push-to-talk) and libwebrtc
// (screen capture's shared X display) all use it.
#[cfg(target_os = "linux")]
#[link(name = "X11")]
extern "C" {
    fn XInitThreads() -> i32;
}

fn main() {
    // Xlib is not thread-safe unless XInitThreads runs before any other Xlib
    // call, and libwebrtc and device_query open and query their own X displays
    // from worker threads while GTK uses Xlib on the main one. Without this the
    // app aborted at sign-in with "[xcb] Too much data requested from _XRead"
    // (B7-17 artifact smoke, Ubuntu 22.04 x64 and arm64: libwebrtc's audio
    // device module, since replaced by our own cpal streams, did it from a
    // Tokio worker). It only enables Xlib's locking, so it is harmless where no
    // X display is ever opened.
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
