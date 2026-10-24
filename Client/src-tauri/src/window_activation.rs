//! Raising the window when the launcher or a notification hands us a token.
//!
//! A Wayland compositor only focuses (or marks urgent) a window whose
//! activation request carries an `xdg-activation` token, which the launcher
//! put in the environment of the process that was started (`XDG_ACTIVATION_TOKEN`;
//! X11 uses `DESKTOP_STARTUP_ID`). Two paths lose it:
//!
//! * **Second launch.** `tauri-plugin-single-instance` forwards only argv and
//!   cwd to the running instance, so the second process writes its token to a
//!   file under `$XDG_RUNTIME_DIR` ([`stash_launch_token`]) before the plugin
//!   forwards, and the first instance reads it back ([`take_forwarded_token`]).
//! * **Notification click.** The notification server sends the token in an
//!   `ActivationToken` signal (`notification_bus.rs`).
//!
//! The AppImage bundles GTK 3.24.33, whose GDK has no xdg-activation support,
//! so GTK cannot use the token: [`activate`] speaks `xdg_activation_v1` itself
//! on GDK's own `wl_display`. On X11 it sets the startup id and presents.
//! Any failure logs at warn and leaves the caller's plain `set_focus` as the
//! fallback.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Runtime, WebviewWindow};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_registry::WlRegistry, wl_surface::WlSurface};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols::xdg::activation::v1::client::xdg_activation_v1::XdgActivationV1;

const TOKEN_FILE: &str = "owncord-activation-token";

/// A forwarded token older than this is not from the launch that just
/// forwarded to us (e.g. our own first launch's token, never taken).
const FRESH_FOR: Duration = Duration::from_secs(10);

/// The file the second process leaves for the first.
fn token_path() -> Option<PathBuf> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty())?;
    Some(Path::new(&dir).join(TOKEN_FILE))
}

/// The launch token in this process's environment, if any.
fn env_launch_token() -> Option<String> {
    ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|t| !t.is_empty()))
}

/// Remember this process's launch token for the running instance to pick up.
/// Called first thing in `run()`, before the single-instance plugin forwards.
pub(crate) fn stash_launch_token() {
    let (Some(path), Some(token)) = (token_path(), env_launch_token()) else {
        return;
    };
    if let Err(e) = write_token(&path, &token) {
        log::warn!("[focus] cannot stash the launch token: {e}");
    }
}

/// Write `token` to `path` readable by us alone: a temp file, then a rename,
/// so a reader never sees a half-written token.
fn write_token(path: &Path, token: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    // `create_new` refuses a leftover from an earlier crash of this pid.
    let _ = fs::remove_file(&tmp);
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(token.as_bytes()))
        .and_then(|()| fs::rename(&tmp, path));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// Whether a token file of this age is still the forwarding launch's.
fn is_fresh(age: Duration) -> bool {
    age <= FRESH_FOR
}

/// The token the second launch left, once: the file is deleted either way, so
/// a stale one is never used and a fresh one cannot be reused.
pub(crate) fn take_forwarded_token() -> Option<String> {
    take_token_at(&token_path()?, SystemTime::now())
}

fn take_token_at(path: &Path, now: SystemTime) -> Option<String> {
    let age = fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|modified| now.duration_since(modified).unwrap_or_default());
    let token = fs::read_to_string(path);
    let _ = fs::remove_file(path);
    let age = age.ok()?;
    let token = token.ok()?;
    let token = token.trim();
    (is_fresh(age) && !token.is_empty()).then(|| token.to_string())
}

/// Ask the compositor to focus `window` with `token`. Runs on the GTK main
/// thread, where the GDK handles are valid.
pub(crate) fn activate<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, token: String) {
    let window = window.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = activate_on_main_thread(&window, &token) {
            log::warn!("[focus] activation with a token failed: {e}");
        }
    }) {
        log::warn!("[focus] cannot reach the main thread to activate: {e}");
    }
}

fn activate_on_main_thread<R: Runtime>(
    window: &WebviewWindow<R>,
    token: &str,
) -> Result<(), String> {
    use gtk::prelude::*;

    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
    let gdk_window = gtk_window.window().ok_or("window is not realized")?;
    if gdk_window.display().type_().name() != "GdkWaylandDisplay" {
        // X11: the startup id is what the window manager matches the request on.
        gtk_window.set_startup_id(token);
        gtk_window.present();
        return Ok(());
    }
    wayland_activate(&gdk_window, token)
}

struct State;

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wayland_client::protocol::wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<XdgActivationV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &XdgActivationV1,
        _: <XdgActivationV1 as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

/// `xdg_activation_v1.activate(token, surface)` on GDK's connection, through
/// our own event queue so GDK's queue is not touched.
fn wayland_activate(gdk_window: &gtk::gdk::Window, token: &str) -> Result<(), String> {
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::ObjectExt;
    use wayland_client::backend::{Backend, ObjectId};

    if gdk_window.type_().name() != "GdkWaylandWindow" {
        return Err("not a Wayland window".into());
    }
    let gdk_display = gdk_window.display();
    let display_ptr: *mut gtk::gdk::ffi::GdkDisplay = gdk_display.to_glib_none().0;
    let window_ptr: *mut gtk::gdk::ffi::GdkWindow = gdk_window.to_glib_none().0;

    // SAFETY: both objects were just checked to be of the Wayland GDK types,
    // so the casts name the real structs; GDK owns them and they outlive this
    // call, which runs on the GTK main thread.
    let (wl_display, wl_surface) = unsafe {
        (
            gdk_wayland_sys::gdk_wayland_display_get_wl_display(display_ptr.cast()),
            gdk_wayland_sys::gdk_wayland_window_get_wl_surface(window_ptr.cast()),
        )
    };
    if wl_display.is_null() || wl_surface.is_null() {
        return Err("GDK has no Wayland display or surface".into());
    }

    // SAFETY: `wl_display` is GDK's live connection and stays open while the
    // application runs; a foreign backend never disconnects it on drop.
    let backend = unsafe { Backend::from_foreign_display(wl_display.cast()) };
    let conn = Connection::from_backend(backend);
    let (globals, mut queue) =
        registry_queue_init::<State>(&conn).map_err(|e| format!("registry: {e}"))?;
    let qh = queue.handle();
    let activation: XdgActivationV1 = globals
        .bind(&qh, 1..=1, ())
        .map_err(|e| format!("compositor has no xdg_activation_v1: {e}"))?;

    // SAFETY: `wl_surface` is the live `wl_proxy` of this window's surface,
    // returned by GDK just above; `from_ptr` checks its interface name.
    let surface = unsafe { ObjectId::from_ptr(WlSurface::interface(), wl_surface.cast()) }
        .map_err(|e| format!("surface id: {e}"))
        .and_then(|id| WlSurface::from_id(&conn, id).map_err(|e| format!("surface: {e}")))?;

    activation.activate(token.to_string(), &surface);
    activation.destroy();
    let flushed = conn.flush().map_err(|e| format!("flush: {e}"));
    // Dispatch anything the compositor already answered on our queue.
    let _ = queue.dispatch_pending(&mut State);
    flushed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn scratch_file() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "owncord-activation-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join(TOKEN_FILE)
    }

    #[test]
    fn a_token_is_fresh_for_ten_seconds() {
        assert!(is_fresh(Duration::ZERO));
        assert!(is_fresh(Duration::from_secs(10)));
        assert!(!is_fresh(Duration::from_secs(11)));
    }

    #[test]
    fn a_fresh_token_is_returned_once() {
        let path = scratch_file();
        write_token(&path, "abc123").unwrap();
        assert_eq!(
            take_token_at(&path, SystemTime::now()).as_deref(),
            Some("abc123")
        );
        assert_eq!(take_token_at(&path, SystemTime::now()), None);
        assert!(!path.exists());
    }

    #[test]
    fn a_stale_token_is_ignored_and_deleted() {
        let path = scratch_file();
        write_token(&path, "old").unwrap();
        let later = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(take_token_at(&path, later), None);
        assert!(!path.exists(), "a stale token must not linger");
    }

    #[test]
    fn a_missing_or_blank_token_file_gives_nothing() {
        let path = scratch_file();
        assert_eq!(take_token_at(&path, SystemTime::now()), None);
        write_token(&path, "  \n").unwrap();
        assert_eq!(take_token_at(&path, SystemTime::now()), None);
    }

    #[test]
    fn the_token_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let path = scratch_file();
        write_token(&path, "abc").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = fs::remove_file(&path);
    }
}
