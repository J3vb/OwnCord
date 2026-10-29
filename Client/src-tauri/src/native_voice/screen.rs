//! Screen share capture for the native room: libwebrtc's `DesktopCapturer`,
//! which is the xdg-desktop-portal ScreenCast flow over PipeWire on a Wayland
//! session and XRandR/XComposite capture on X11.
//!
//! - **Wayland**: the app cannot enumerate or pick anything itself; the
//!   portal's own dialog is the picker and the consent (never bypassed), and
//!   it appears when a `Portal` capture starts. [`list_sources`] reports
//!   `portal: true` so the webview skips its own picker.
//! - **X11**: [`list_sources`] enumerates screens and windows, each with a
//!   thumbnail of what would be shared, for the webview's picker.
//!
//! A capture runs on its own thread, polling the capturer at the requested
//! frame rate. It reports its first frame (or the cancel/failure) through the
//! `Started` receiver, which is how a portal consent reaches the caller; a
//! later permanent failure (the user stopped sharing from the desktop's own
//! indicator, the window closed) runs `on_end`. Frames go to the published
//! source, if any, and to the local preview (the frame socket's `screen`
//! route). Dropping the [`ScreenCapture`] stops and joins the thread, and
//! the capturer it drops releases the X connection or closes the portal
//! session and its PipeWire stream.
//!
//! The portal's D-Bus calls complete on the default GLib main context, which
//! the app's GTK loop already runs; livekit's `glib-main-loop` feature (a
//! second loop on that context) must stay off.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::sync::lock;
use base64::Engine;
use livekit::webrtc::desktop_capturer::{
    CaptureError, CaptureSource, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
    DesktopFrame,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, watch};

/// Capture threads alive, for the debug surface: it drops to zero only once
/// every capturer (and so every portal session) is released.
static CAPTURES: AtomicUsize = AtomicUsize::new(0);

pub fn active_captures() -> usize {
    CAPTURES.load(Ordering::Relaxed)
}

/// The error a portal capture reports when it ends before its first frame.
/// libwebrtc's `CaptureError` has only `Temporary` and `Permanent`, so the
/// portal's response (the user dismissed the dialog, a policy refused it, the
/// PipeWire stream failed) never reaches this layer: the webview shows a soft
/// notice that covers both a cancel and a refusal.
pub const PORTAL_NOT_STARTED: &str = "screen capture portal did not start";

/// The error a picked screen or window reports when its capturer fails
/// before the first frame; the webview shows it.
pub const FAILED: &str = "screen capture failed to start";

/// The error a capture reports when no first frame arrives in time; the
/// webview shows it.
pub const TIMED_OUT: &str = "screen capture produced no frame in time";

/// How long a picked screen or window may take to produce its first frame.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(15);

/// The first-frame bound for `target`, and what a failure before the first
/// frame reports. A portal capture has no bound: its dialog opens once the
/// capture starts, so the wait is the user choosing what to share, and a
/// stop or leave ends it.
fn first_frame(target: Target) -> (Option<Duration>, &'static str) {
    match target {
        Target::Portal => (None, PORTAL_NOT_STARTED),
        _ => (Some(FIRST_FRAME_TIMEOUT), FAILED),
    }
}

/// What to capture.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    /// Let the xdg-desktop-portal dialog pick (Wayland).
    Portal,
    Screen(u64),
    Window(u64),
    /// Moving bars, for the interop test (CI has no display). Not reachable
    /// from the webview.
    Synthetic {
        width: u32,
        height: u32,
    },
}

impl Target {
    /// A picker id from the webview: `portal`, `screen:<id>` or `window:<id>`.
    pub fn parse(id: &str) -> Result<Self, String> {
        if id == "portal" {
            return Ok(Self::Portal);
        }
        let bad = || format!("bad screen source {id}");
        let (kind, n) = id.split_once(':').ok_or_else(bad)?;
        let n: u64 = n.parse().map_err(|_| bad())?;
        match kind {
            "screen" => Ok(Self::Screen(n)),
            "window" => Ok(Self::Window(n)),
            _ => Err(bad()),
        }
    }
}

/// Mirror of libwebrtc's `DesktopCapturer::IsRunningUnderWayland`, which is
/// what makes it choose the portal over X11.
pub fn under_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.starts_with("wayland"))
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn capturer(kind: DesktopCaptureSourceType) -> Option<DesktopCapturer> {
    let mut options = DesktopCapturerOptions::new(kind);
    options.set_include_cursor(true);
    DesktopCapturer::new(options)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// The id [`Target::parse`] takes.
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    /// A `data:image/png` URL of the source as it looks now, when it could
    /// be captured.
    pub thumbnail: Option<String>,
    /// The refresh rate in Hz of the monitor a `screen` source is, when XRandR
    /// reports it. `None` for windows and whenever it cannot be read; the
    /// webview never gates on an unknown rate. Always serialised (`null`).
    pub refresh_hz: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    /// The desktop portal picks (Wayland): `sources` is empty.
    pub portal: bool,
    pub sources: Vec<Source>,
    /// Other applications' sound can be shared with the screen (a PulseAudio
    /// protocol server answers): `share_audio::available()`.
    pub audio: bool,
}

/// Enumerate what can be shared. Blocking: one capture per source for its
/// thumbnail.
pub fn list_sources() -> Sources {
    if under_wayland() {
        return Sources {
            portal: true,
            sources: Vec::new(),
            audio: super::share_audio::available(),
        };
    }
    let mut sources = Vec::new();
    let rates = x11_refresh::monitor_rates();
    for (kind, ty) in [
        ("screen", DesktopCaptureSourceType::Screen),
        ("window", DesktopCaptureSourceType::Window),
    ] {
        let Some(lister) = capturer(ty) else { continue };
        for (i, source) in lister.get_source_list().into_iter().enumerate() {
            let title = match source.title() {
                t if !t.is_empty() => t,
                _ if kind == "screen" => format!("Screen {}", i + 1),
                // Untitled windows are tooltips, docks and the like.
                _ => continue,
            };
            sources.push(Source {
                id: format!("{kind}:{}", source.id()),
                kind,
                title,
                refresh_hz: (kind == "screen")
                    .then(|| rates.get(&source.id()).copied())
                    .flatten(),
                thumbnail: thumbnail(ty, source),
            });
        }
    }
    Sources {
        portal: false,
        sources,
        audio: super::share_audio::available(),
    }
}

/// Refresh rates of the X11 monitors, read through XRandR.
///
/// libwebrtc's `ScreenCapturerX11` (RandR monitor mode) lists one source per
/// `XRRGetMonitors` entry and uses the monitor's `name` atom as the source id,
/// so the rate is looked up by that atom. Xlib and libXrandr are loaded at
/// runtime (`x11-dl`), like `mouse_buttons`; any failure yields no rates.
mod x11_refresh {
    use std::collections::HashMap;
    use std::os::raw::c_int;
    use std::ptr;

    use x11_dl::xlib::Xlib;
    use x11_dl::xrandr::{RR_DoubleScan, RR_Interlace, Xrandr};

    /// The refresh rate in Hz of an XRandR mode, rounded to the nearest
    /// integer. `None` for a mode with no timing (zero clock or totals).
    /// Double-scan modes draw each line twice and interlaced modes draw half
    /// the lines per field, the same correction `xrandr` makes.
    pub(super) fn mode_refresh_hz(
        dot_clock: u64,
        h_total: u32,
        v_total: u32,
        flags: u64,
    ) -> Option<u32> {
        if dot_clock == 0 || h_total == 0 || v_total == 0 {
            return None;
        }
        let mut v = f64::from(v_total);
        if flags & RR_DoubleScan as u64 != 0 {
            v *= 2.0;
        }
        if flags & RR_Interlace as u64 != 0 {
            v /= 2.0;
        }
        let hz = (dot_clock as f64 / (f64::from(h_total) * v)).round();
        (hz >= 1.0 && hz <= f64::from(u32::MAX)).then_some(hz as u32)
    }

    /// Monitor `name` atom -> refresh rate of its fastest output. Empty when
    /// Xlib/XRandR cannot be loaded or no display is reachable.
    pub(super) fn monitor_rates() -> HashMap<u64, u32> {
        read_rates().unwrap_or_default()
    }

    fn read_rates() -> Option<HashMap<u64, u32>> {
        let xlib = Xlib::open().ok()?;
        let xr = Xrandr::open().ok()?;
        // SAFETY: a null name opens $DISPLAY; a null result is handled.
        let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
        if display.is_null() {
            return None;
        }
        // SAFETY: display is a live connection until the XCloseDisplay below,
        // and every XRR allocation is freed before it.
        let rates = unsafe {
            let root = (xlib.XDefaultRootWindow)(display);
            let mut rates = HashMap::new();
            let res = (xr.XRRGetScreenResourcesCurrent)(display, root);
            if !res.is_null() {
                let mut n: c_int = 0;
                let monitors = (xr.XRRGetMonitors)(display, root, 1, &mut n);
                if !monitors.is_null() {
                    for i in 0..usize::try_from(n).unwrap_or(0) {
                        let m = &*monitors.add(i);
                        if m.noutput < 1 || m.outputs.is_null() {
                            continue;
                        }
                        // A user-defined monitor can span several outputs:
                        // take the fastest, so a slow one never gates it.
                        let outputs = std::slice::from_raw_parts(
                            m.outputs,
                            usize::try_from(m.noutput).unwrap_or(0),
                        );
                        if let Some(hz) = outputs
                            .iter()
                            .filter_map(|&o| output_hz(&xr, display, res, o))
                            .max()
                        {
                            rates.insert(m.name as u64, hz);
                        }
                    }
                    (xr.XRRFreeMonitors)(monitors);
                }
                (xr.XRRFreeScreenResources)(res);
            }
            rates
        };
        // SAFETY: display came from XOpenDisplay and is closed once.
        unsafe { (xlib.XCloseDisplay)(display) };
        Some(rates)
    }

    /// # Safety
    /// `display` and `res` must be live; `output` an id from them.
    unsafe fn output_hz(
        xr: &Xrandr,
        display: *mut x11_dl::xlib::Display,
        res: *mut x11_dl::xrandr::XRRScreenResources,
        output: x11_dl::xlib::XID,
    ) -> Option<u32> {
        // SAFETY: the caller guarantees display, res and output are live;
        // each XRR allocation is read, then freed before return.
        unsafe {
            let info = (xr.XRRGetOutputInfo)(display, res, output);
            if info.is_null() {
                return None;
            }
            let crtc = (*info).crtc;
            (xr.XRRFreeOutputInfo)(info);
            if crtc == 0 {
                return None;
            }
            let crtc_info = (xr.XRRGetCrtcInfo)(display, res, crtc);
            if crtc_info.is_null() {
                return None;
            }
            let mode = (*crtc_info).mode;
            (xr.XRRFreeCrtcInfo)(crtc_info);
            if (*res).modes.is_null() {
                return None;
            }
            let modes =
                std::slice::from_raw_parts((*res).modes, usize::try_from((*res).nmode).ok()?);
            let m = modes.iter().find(|m| m.id == mode)?;
            mode_refresh_hz(m.dotClock, m.hTotal, m.vTotal, m.modeFlags as u64)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn standard_1080p60() {
            assert_eq!(mode_refresh_hz(148_500_000, 2200, 1125, 0), Some(60));
        }

        #[test]
        fn mode_144hz() {
            // 1080p144 CVT-RB: 332.4 MHz, 2080 x 1111.
            assert_eq!(mode_refresh_hz(332_400_000, 2080, 1111, 0), Some(144));
        }

        #[test]
        fn ntsc_rate_rounds_up() {
            // 119.88 Hz rounds to 120, so it is not gated.
            assert_eq!(mode_refresh_hz(296_703_000, 2200, 1125, 0), Some(120));
        }

        #[test]
        fn zero_timing_is_none() {
            assert_eq!(mode_refresh_hz(0, 2200, 1125, 0), None);
            assert_eq!(mode_refresh_hz(148_500_000, 0, 1125, 0), None);
            assert_eq!(mode_refresh_hz(148_500_000, 2200, 0, 0), None);
        }

        #[test]
        fn interlace_and_doublescan() {
            // 1080i: 74.25 MHz, 2200 x 1125 is 60 fields per second.
            assert_eq!(
                mode_refresh_hz(74_250_000, 2200, 1125, RR_Interlace as u64),
                Some(60)
            );
            // A double-scanned mode halves the rate.
            assert_eq!(
                mode_refresh_hz(148_500_000, 2200, 1125, RR_DoubleScan as u64),
                Some(30)
            );
        }
    }
}

/// The process that owns a capture target, so its share audio can be that
/// application's sound only. X11 windows carry it as `_NET_WM_PID`; a screen,
/// the portal (Wayland hides which app a window is) or a window without the
/// property has none. So does a pid that is not one of our own processes:
/// a sandboxed (Flatpak, Snap) or remote app reports a pid from another
/// namespace or host, which here names an unrelated process.
pub fn target_pid(target: Target) -> Option<u32> {
    match target {
        Target::Window(xid) if !under_wayland() => {
            x11_window_pid::read(xid).filter(|&pid| owned_by_us(pid))
        }
        _ => None,
    }
}

/// Whether `/proc/<pid>` exists and belongs to our user.
fn owned_by_us(pid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    std::fs::metadata(format!("/proc/{pid}")).is_ok_and(|m| m.uid() == uid)
}

/// `_NET_WM_PID` of an X11 window, read over its own XCB connection. Not
/// Xlib: an Xlib error (the window closed since the picker listed it) goes
/// to the process-wide error handler, which hands an unknown display's error
/// to Xlib's default, and that exits. XCB returns errors as values. libxcb is
/// loaded at runtime, like the Xlib in `x11_refresh`; any failure is `None`.
mod x11_window_pid {
    use std::ffi::c_void;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::ptr;

    const XA_CARDINAL: u32 = 6;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Cookie {
        sequence: c_uint,
    }

    // The reply layouts mirror libxcb's; only some fields are read.
    #[allow(dead_code)]
    #[repr(C)]
    struct InternAtomReply {
        response_type: u8,
        pad0: u8,
        sequence: u16,
        length: u32,
        atom: u32,
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct GetPropertyReply {
        response_type: u8,
        format: u8,
        sequence: u16,
        length: u32,
        kind: u32,
        bytes_after: u32,
        value_len: u32,
        pad0: [u8; 12],
    }

    type Connect = unsafe extern "C" fn(*const c_char, *mut c_int) -> *mut c_void;
    type HasError = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Disconnect = unsafe extern "C" fn(*mut c_void);
    type InternAtom = unsafe extern "C" fn(*mut c_void, u8, u16, *const c_char) -> Cookie;
    type InternAtomReplyFn =
        unsafe extern "C" fn(*mut c_void, Cookie, *mut *mut c_void) -> *mut InternAtomReply;
    type GetProperty = unsafe extern "C" fn(*mut c_void, u8, u32, u32, u32, u32, u32) -> Cookie;
    type GetPropertyReplyFn =
        unsafe extern "C" fn(*mut c_void, Cookie, *mut *mut c_void) -> *mut GetPropertyReply;
    type GetPropertyValue = unsafe extern "C" fn(*const GetPropertyReply) -> *mut c_void;

    struct Xcb {
        lib: *mut c_void,
        connect: Connect,
        has_error: HasError,
        disconnect: Disconnect,
        intern_atom: InternAtom,
        intern_atom_reply: InternAtomReplyFn,
        get_property: GetProperty,
        get_property_reply: GetPropertyReplyFn,
        get_property_value: GetPropertyValue,
    }

    impl Xcb {
        fn open() -> Option<Self> {
            // SAFETY: dlopen with a NUL-terminated name.
            let lib =
                unsafe { libc::dlopen(c"libxcb.so.1".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
            if lib.is_null() {
                return None;
            }
            // SAFETY: lib came from dlopen just above.
            let loaded = unsafe { Self::load(lib) };
            if loaded.is_none() {
                // SAFETY: lib came from dlopen and nothing from it is kept.
                unsafe { libc::dlclose(lib) };
            }
            loaded
        }

        /// # Safety
        /// `lib` must be a live handle from `dlopen` of libxcb.
        unsafe fn load(lib: *mut c_void) -> Option<Self> {
            let sym = |name: &std::ffi::CStr| {
                // SAFETY: the caller guarantees lib; name is NUL-terminated.
                let f = unsafe { libc::dlsym(lib, name.as_ptr()) };
                (!f.is_null()).then_some(f)
            };
            // SAFETY: each symbol is libxcb's public function with the
            // signature declared above.
            unsafe {
                Some(Self {
                    lib,
                    connect: std::mem::transmute::<*mut c_void, Connect>(sym(c"xcb_connect")?),
                    has_error: std::mem::transmute::<*mut c_void, HasError>(sym(
                        c"xcb_connection_has_error",
                    )?),
                    disconnect: std::mem::transmute::<*mut c_void, Disconnect>(sym(
                        c"xcb_disconnect",
                    )?),
                    intern_atom: std::mem::transmute::<*mut c_void, InternAtom>(sym(
                        c"xcb_intern_atom",
                    )?),
                    intern_atom_reply: std::mem::transmute::<*mut c_void, InternAtomReplyFn>(sym(
                        c"xcb_intern_atom_reply",
                    )?),
                    get_property: std::mem::transmute::<*mut c_void, GetProperty>(sym(
                        c"xcb_get_property",
                    )?),
                    get_property_reply: std::mem::transmute::<*mut c_void, GetPropertyReplyFn>(
                        sym(c"xcb_get_property_reply")?,
                    ),
                    get_property_value: std::mem::transmute::<*mut c_void, GetPropertyValue>(sym(
                        c"xcb_get_property_value",
                    )?),
                })
            }
        }
    }

    impl Drop for Xcb {
        fn drop(&mut self) {
            // SAFETY: lib came from dlopen and nothing from it outlives self.
            unsafe { libc::dlclose(self.lib) };
        }
    }

    pub(super) fn read(xid: u64) -> Option<u32> {
        let window = u32::try_from(xid).ok()?;
        let xcb = Xcb::open()?;
        // SAFETY: a null name connects to $DISPLAY. The connection is only
        // used until the disconnect below, even when it reports an error.
        let conn = unsafe { (xcb.connect)(ptr::null(), ptr::null_mut()) };
        if conn.is_null() {
            return None;
        }
        // SAFETY: conn is live; every reply and error is freed with free(),
        // as libxcb requires; the value is read within the reply's length.
        let pid = unsafe {
            if (xcb.has_error)(conn) != 0 {
                None
            } else {
                read_pid(&xcb, conn, window)
            }
        };
        // SAFETY: conn came from xcb_connect and is disconnected once.
        unsafe { (xcb.disconnect)(conn) };
        pid
    }

    /// # Safety
    /// `conn` must be a live connection from `xcb`.
    unsafe fn read_pid(xcb: &Xcb, conn: *mut c_void, window: u32) -> Option<u32> {
        let name = c"_NET_WM_PID";
        let len = u16::try_from(name.to_bytes().len()).ok()?;
        // SAFETY: the caller guarantees conn; replies and errors are freed.
        unsafe {
            let mut err: *mut c_void = ptr::null_mut();
            let cookie = (xcb.intern_atom)(conn, 1, len, name.as_ptr());
            let reply = (xcb.intern_atom_reply)(conn, cookie, &mut err);
            libc::free(err);
            if reply.is_null() {
                return None;
            }
            let atom = (*reply).atom;
            libc::free(reply.cast());
            if atom == 0 {
                return None;
            }
            let mut err: *mut c_void = ptr::null_mut();
            let cookie = (xcb.get_property)(conn, 0, window, atom, XA_CARDINAL, 0, 1);
            let reply = (xcb.get_property_reply)(conn, cookie, &mut err);
            // A closed window answers BadWindow here, as a value.
            libc::free(err);
            if reply.is_null() {
                return None;
            }
            let r = &*reply;
            let pid = (r.kind == XA_CARDINAL && r.format == 32 && r.value_len == 1)
                .then(|| (xcb.get_property_value)(reply).cast::<u32>())
                .filter(|v| !v.is_null())
                .map(|v| v.read_unaligned())
                .filter(|&v| v > 1);
            libc::free(reply.cast());
            pid
        }
    }
}

fn thumbnail(ty: DesktopCaptureSourceType, source: CaptureSource) -> Option<String> {
    let mut capturer = capturer(ty)?;
    let slot = Arc::new(Mutex::new(None));
    let out = slot.clone();
    // X11 capturers call back synchronously inside `capture_frame`.
    capturer.start_capture(Some(source), move |result| {
        if let Ok(frame) = result {
            *lock(&out) = thumbnail_url(&frame);
        }
    });
    capturer.capture_frame();
    let url = lock(&slot).take();
    url
}

/// Small enough that an incompressible thumbnail stays within 33 KB as a
/// data URL, so 30 sources cost about 1 MB of IPC.
const THUMB_WIDTH: usize = 120;
const THUMB_HEIGHT: usize = 68;

fn thumbnail_url(frame: &DesktopFrame) -> Option<String> {
    let (w, h) = (frame.width(), frame.height());
    if w <= 0 || h <= 0 {
        return None;
    }
    png_url(
        frame.data(),
        frame.stride() as usize,
        w as usize,
        h as usize,
    )
}

/// Nearest-neighbour downscale of a BGRA image (a `DesktopFrame`) to fit
/// the thumbnail box, as a `data:image/png` URL.
fn png_url(src: &[u8], stride: usize, w: usize, h: usize) -> Option<String> {
    let scale = (THUMB_WIDTH as f64 / w as f64)
        .min(THUMB_HEIGHT as f64 / h as f64)
        .min(1.0);
    let tw = ((w as f64 * scale) as usize).max(1);
    let th = ((h as f64 * scale) as usize).max(1);
    let mut rgb = Vec::with_capacity(tw * th * 3);
    for y in 0..th {
        let row = &src[(y * h / th) * stride..];
        for x in 0..tw {
            let px = &row[(x * w / tw) * 4..][..3];
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, tw as u32, th as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::High);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(&rgb).ok()?;
    writer.finish().ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// Capture pacing and size cap, from the web path's screen-share presets.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub fps: f64,
    /// 0 for either means the source size (the "source" preset).
    pub max_width: u32,
    pub max_height: u32,
}

/// I420 frames for the local preview (the frame socket's `screen` route),
/// packed only when the socket sends one; the latest only.
pub type Preview = watch::Sender<Option<Arc<I420Buffer>>>;

/// Resolves with the first frame's size, or the reason capture never began.
pub type Started = oneshot::Receiver<Result<(u32, u32), String>>;

struct Shared {
    /// Read at the top of every capture tick, so `set_options` takes effect
    /// on the next frame.
    options: Mutex<CaptureOptions>,
    /// The size of the latest frame before the size cap, for `set_options`;
    /// `None` until the first frame.
    raw: Mutex<Option<(u32, u32)>>,
    /// The published screen share's source; `None` while not published.
    source: Mutex<Option<NativeVideoSource>>,
    /// Swapped by `take_over`, so the frame socket's `screen` route keeps
    /// playing across a source change.
    preview: Mutex<Arc<Preview>>,
}

pub struct ScreenCapture {
    target: Target,
    shared: Arc<Shared>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

/// Counts a capture thread from before it is spawned until it has dropped
/// its capturer.
struct Counted;

impl Counted {
    fn new() -> Self {
        CAPTURES.fetch_add(1, Ordering::Relaxed);
        Self
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        CAPTURES.fetch_sub(1, Ordering::Relaxed);
    }
}

impl ScreenCapture {
    pub fn start(
        target: Target,
        options: CaptureOptions,
        on_end: impl FnOnce() + Send + 'static,
    ) -> Result<(Self, Started), String> {
        let (stop, stopped) = mpsc::channel();
        let (ready, started) = oneshot::channel();
        let shared = Arc::new(Shared {
            options: Mutex::new(options),
            raw: Mutex::new(None),
            source: Mutex::new(None),
            preview: Mutex::new(Arc::new(watch::channel(None).0)),
        });
        let counted = Counted::new();
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("owncord-screen".into())
            .spawn(move || {
                let _counted = counted;
                run(target, &thread_shared, &stopped, ready, on_end);
            })
            .map_err(|e| format!("screen capture thread: {e}"))?;
        Ok((
            Self {
                target,
                shared,
                stop: Some(stop),
                thread: Some(thread),
            },
            started,
        ))
    }

    /// What this capture was started on.
    pub fn target(&self) -> Target {
        self.target
    }

    pub fn preview(&self) -> Arc<Preview> {
        lock(&self.shared.preview).clone()
    }

    /// Re-pace and re-cap the running capture. The size applies from the
    /// next frame; the pacing from the next tick after the current wait
    /// ends (a slow rate's wait is not cut short). Returns the size those
    /// frames will have (`fit` of the latest raw frame, or that frame's own
    /// size), `None` before the first frame.
    pub fn set_options(&self, options: CaptureOptions) -> Option<(u32, u32)> {
        *lock(&self.shared.options) = options;
        let raw = (*lock(&self.shared.raw))?;
        Some(sized(raw, options))
    }

    pub fn set_source(&self, source: Option<NativeVideoSource>) {
        *lock(&self.shared.source) = source;
    }

    /// Carry `from`'s published source and preview over to this capture, so
    /// the publication and the preview socket keep going on this capture's
    /// frames once `from` is dropped (a Change source).
    pub fn take_over(&self, from: &ScreenCapture) {
        *lock(&self.shared.preview) = from.preview();
        let source = lock(&from.shared.source).take();
        self.set_source(source);
    }
}

impl Drop for ScreenCapture {
    /// Wake the thread and wait for it: once this returns, the capturer (and
    /// with it the portal session) is gone.
    fn drop(&mut self) {
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum Grab {
    Frame(I420Buffer),
    /// Nothing yet: the portal dialog is still open, or a transient error.
    Pending,
    Failed,
}

enum Producer {
    Desktop {
        capturer: DesktopCapturer,
        slot: Arc<Mutex<Option<Grab>>>,
    },
    Synthetic {
        width: u32,
        height: u32,
        n: usize,
    },
}

impl Producer {
    fn new(target: Target) -> Result<Self, String> {
        let (ty, id) = match target {
            Target::Synthetic { width, height } => {
                return Ok(Self::Synthetic {
                    width,
                    height,
                    n: 0,
                })
            }
            Target::Portal => (DesktopCaptureSourceType::Generic, None),
            Target::Screen(id) => (DesktopCaptureSourceType::Screen, Some(id)),
            Target::Window(id) => (DesktopCaptureSourceType::Window, Some(id)),
        };
        let mut capturer =
            capturer(ty).ok_or("screen capture is not available in this desktop session")?;
        let source = match id {
            None => None,
            Some(id) => Some(
                capturer
                    .get_source_list()
                    .into_iter()
                    .find(|s| s.id() == id)
                    .ok_or("that screen or window is no longer available")?,
            ),
        };
        let slot = Arc::new(Mutex::new(None));
        let out = slot.clone();
        capturer.start_capture(source, move |result| {
            let grab = match result {
                Ok(frame) => to_i420(&frame).map_or(Grab::Pending, Grab::Frame),
                Err(CaptureError::Temporary) => Grab::Pending,
                Err(CaptureError::Permanent) => Grab::Failed,
            };
            *lock(&out) = Some(grab);
        });
        Ok(Self::Desktop { capturer, slot })
    }

    fn grab(&mut self) -> Grab {
        match self {
            Self::Desktop { capturer, slot } => {
                // Both the X11 and the PipeWire capturer call back inside.
                capturer.capture_frame();
                lock(slot).take().unwrap_or(Grab::Pending)
            }
            Self::Synthetic { width, height, n } => {
                *n += 1;
                Grab::Frame(bars(*width, *height, *n))
            }
        }
    }
}

/// A `DesktopFrame` (BGRA in memory, libyuv's "ARGB") as I420.
fn to_i420(frame: &DesktopFrame) -> Option<I420Buffer> {
    let (w, h) = (frame.width(), frame.height());
    if w <= 0 || h <= 0 {
        return None;
    }
    let mut out = I420Buffer::new(w as u32, h as u32);
    let (sy, su, sv) = out.strides();
    let (y, u, v) = out.data_mut();
    yuv_helper::argb_to_i420(frame.data(), frame.stride(), y, sy, u, su, v, sv, w, h);
    Some(out)
}

/// Vertical bars that move one step per frame.
fn bars(width: u32, height: u32, n: usize) -> I420Buffer {
    let mut out = I420Buffer::new(width, height);
    let (sy, _, _) = out.strides();
    let (y, u, v) = out.data_mut();
    for row in 0..height as usize {
        for col in 0..width as usize {
            y[row * sy as usize + col] = if ((col + n * 8) / 64).is_multiple_of(2) {
                40
            } else {
                220
            };
        }
    }
    u.fill(128);
    v.fill(128);
    out
}

/// The size to scale `(w, h)` to so it fits `max`, even and aspect-kept;
/// `None` when it already fits or there is no cap.
fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> Option<(u32, u32)> {
    if max_w == 0 || max_h == 0 || (w <= max_w && h <= max_h) {
        return None;
    }
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64);
    let even = |v: f64| ((v as u32) & !1).max(2);
    Some((even(w as f64 * scale), even(h as f64 * scale)))
}

/// The size frames of raw size `raw` leave the capture at under `options`.
fn sized(raw: (u32, u32), options: CaptureOptions) -> (u32, u32) {
    fit(raw.0, raw.1, options.max_width, options.max_height).unwrap_or(raw)
}

fn run(
    target: Target,
    shared: &Shared,
    stopped: &mpsc::Receiver<()>,
    ready: oneshot::Sender<Result<(u32, u32), String>>,
    on_end: impl FnOnce(),
) {
    let mut ready = Some(ready);
    let (first_frame_timeout, failed) = first_frame(target);
    let mut producer = match Producer::new(target) {
        Ok(p) => p,
        Err(e) => {
            if let Some(r) = ready.take() {
                let _ = r.send(Err(e));
            }
            return;
        }
    };
    run_loop(
        &mut || producer.grab(),
        shared,
        stopped,
        &mut ready,
        first_frame_timeout,
        failed,
        on_end,
    );
}

/// The capture loop, over any grab source. Split from `run` so a test can
/// drive a source that never yields a first frame and pin the timeout.
#[allow(clippy::too_many_arguments)]
fn run_loop(
    grab: &mut dyn FnMut() -> Grab,
    shared: &Shared,
    stopped: &mpsc::Receiver<()>,
    ready: &mut Option<oneshot::Sender<Result<(u32, u32), String>>>,
    first_frame_timeout: Option<Duration>,
    failed: &str,
    on_end: impl FnOnce(),
) {
    let started = Instant::now();
    // Frames are due on a fixed grid, so a late wake-up or a slow grab does
    // not push every later frame back by the same amount.
    let mut due = started;
    let mut last_fps = f64::NAN;
    loop {
        let options = *lock(&shared.options);
        // A rate change re-anchors the grid, so frames are not owed (or
        // withheld) against the old rate.
        if options.fps != last_fps {
            due = Instant::now();
            last_fps = options.fps;
        }
        let interval = Duration::from_secs_f64(1.0 / options.fps.clamp(1.0, 120.0));
        // Bound the pre-first-frame phase (voice #9): a picked source whose
        // capturer never produces a first frame (a transient error that
        // loops) used to spin here forever while the shared
        // enableScreenshare awaited `ready`, leaving the UI stuck "starting
        // share" with the picker closed and no cancel.
        if ready.is_some() && first_frame_timeout.is_some_and(|t| started.elapsed() > t) {
            if let Some(r) = ready.take() {
                let _ = r.send(Err(TIMED_OUT.into()));
            }
            return;
        }
        match grab() {
            Grab::Frame(mut buffer) => {
                let raw = (buffer.width(), buffer.height());
                *lock(&shared.raw) = Some(raw);
                let (w, h) = sized(raw, options);
                if (w, h) != raw {
                    buffer = buffer.scale(w as i32, h as i32);
                }
                if let Some(r) = ready.take() {
                    let _ = r.send(Ok((buffer.width(), buffer.height())));
                }
                deliver(shared, buffer, started);
            }
            Grab::Pending => {}
            Grab::Failed => {
                match ready.take() {
                    Some(r) => {
                        let _ = r.send(Err(failed.into()));
                    }
                    None => on_end(),
                }
                return;
            }
        }
        // A stop (or the owner dropping) wakes this immediately.
        due += interval;
        let now = Instant::now();
        if due < now {
            due = now;
        }
        match stopped.recv_timeout(due - now) {
            Err(RecvTimeoutError::Timeout) => {}
            _ => return,
        }
    }
}

fn deliver(shared: &Shared, buffer: I420Buffer, started: Instant) {
    let frame = VideoFrame {
        rotation: VideoRotation::VideoRotation0,
        timestamp_us: started.elapsed().as_micros() as i64,
        frame_metadata: None,
        buffer,
    };
    let source = lock(&shared.source).clone();
    if let Some(source) = source {
        source.capture_frame(&frame);
    }
    let preview = lock(&shared.preview).clone();
    if preview.receiver_count() > 0 {
        preview.send_replace(Some(Arc::new(frame.buffer)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_voice::video::pack_i420;

    /// The capture count is process-wide: tests that start captures take
    /// turns.
    static SERIAL: Mutex<()> = Mutex::new(());

    /// What the start loop reports for a grab source, driven until it
    /// returns or a stop 300 ms in; `None` when it sent nothing.
    fn start_result(
        mut grab: fn() -> Grab,
        first_frame_timeout: Option<Duration>,
        failed: &str,
    ) -> Option<Result<(u32, u32), String>> {
        let shared = Shared {
            options: Mutex::new(CaptureOptions {
                fps: 30.0,
                max_width: 0,
                max_height: 0,
            }),
            raw: Mutex::new(None),
            source: Mutex::new(None),
            preview: Mutex::new(Arc::new(watch::channel(None).0)),
        };
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let _ = stop_tx.send(());
        });
        let (ready_tx, mut ready_rx) = oneshot::channel();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        run_loop(
            &mut grab,
            &shared,
            &stop_rx,
            &mut Some(ready_tx),
            first_frame_timeout,
            failed,
            || {},
        );
        stopper.join().unwrap();
        rt.block_on(&mut ready_rx).ok()
    }

    /// 120 fps is the share's top rate: the loop must keep the 8.3 ms grid
    /// rather than drift to a slower rate. The bound is loose enough for a
    /// busy CI runner.
    #[test]
    fn a_120_fps_capture_paces_near_one_frame_per_8_ms() {
        let shared = Shared {
            options: Mutex::new(CaptureOptions {
                fps: 120.0,
                max_width: 0,
                max_height: 0,
            }),
            raw: Mutex::new(None),
            source: Mutex::new(None),
            preview: Mutex::new(Arc::new(watch::channel(None).0)),
        };
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            let _ = stop_tx.send(());
        });
        let mut frames = 0usize;
        let mut grab = || {
            frames += 1;
            Grab::Frame(bars(64, 36, frames))
        };
        let (ready_tx, _ready_rx) = oneshot::channel();
        let began = Instant::now();
        run_loop(
            &mut grab,
            &shared,
            &stop_rx,
            &mut Some(ready_tx),
            None,
            FAILED,
            || {},
        );
        let elapsed = began.elapsed().as_secs_f64();
        stopper.join().unwrap();
        let rate = frames as f64 / elapsed;
        assert!(
            (90.0..=125.0).contains(&rate),
            "{frames} frames in {elapsed:.3}s is {rate:.1} fps"
        );
    }

    /// voice #9: a picked source that never yields a first frame must not
    /// spin the start loop forever — the shared enableScreenshare awaits
    /// `ready`. The timeout is a failure the user is told about.
    #[test]
    fn a_capture_that_never_produces_a_first_frame_times_out_as_a_failure() {
        assert_eq!(
            start_result(|| Grab::Pending, Some(Duration::from_millis(20)), FAILED),
            Some(Err(TIMED_OUT.to_string()))
        );
    }

    /// A portal capture is not bounded: the user may take as long as they
    /// like in the portal's dialog, and only a stop ends the wait.
    #[test]
    fn a_portal_capture_waits_on_its_dialog_until_stopped() {
        let (timeout, failed) = first_frame(Target::Portal);
        assert_eq!(timeout, None);
        assert_eq!(start_result(|| Grab::Pending, timeout, failed), None);
    }

    /// A picked screen or window whose capturer fails before its first frame
    /// is a failure; a portal capture that ends before its first frame
    /// reports that the portal did not start.
    #[test]
    fn a_failure_before_the_first_frame_reports_the_targets_reason() {
        for target in [Target::Portal, Target::Screen(0), Target::Window(1)] {
            let (timeout, failed) = first_frame(target);
            let expected = if target == Target::Portal {
                PORTAL_NOT_STARTED
            } else {
                FAILED
            };
            assert_eq!(
                start_result(|| Grab::Failed, timeout, failed),
                Some(Err(expected.to_string())),
                "{target:?}"
            );
        }
    }

    #[test]
    fn picker_ids_parse_and_synthetic_is_unreachable() {
        assert_eq!(Target::parse("portal"), Ok(Target::Portal));
        assert_eq!(Target::parse("screen:0"), Ok(Target::Screen(0)));
        assert_eq!(
            Target::parse("window:81788935"),
            Ok(Target::Window(81_788_935))
        );
        for bad in ["synthetic", "screen", "screen:", "screen:-1", "tab:1", ""] {
            assert!(Target::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn fit_keeps_aspect_and_even_sizes_within_the_cap() {
        assert_eq!(fit(1920, 1080, 1920, 1080), None);
        assert_eq!(fit(3840, 2160, 0, 0), None, "source preset: no cap");
        assert_eq!(fit(3840, 2160, 1920, 1080), Some((1920, 1080)));
        assert_eq!(fit(2560, 1600, 1280, 720), Some((1152, 720)));
        assert_eq!(fit(1001, 5001, 1280, 720), Some((144, 720)));
    }

    fn decode(url: &str) -> (png::OutputInfo, Vec<u8>) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        (info, buf)
    }

    #[test]
    fn thumbnails_are_downscaled_rgb_pngs() {
        // 4x2 BGRA with a row stride of 20 (4 bytes of padding per row).
        let mut src = vec![0u8; 40];
        for (i, px) in [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]
            .iter()
            .enumerate()
        {
            src[i * 4..i * 4 + 3].copy_from_slice(px);
        }
        src[20..23].copy_from_slice(&[21, 22, 23]);
        let (info, rgb) = decode(&png_url(&src, 20, 4, 2).unwrap());
        assert_eq!((info.width, info.height), (4, 2));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(&rgb[..12], &[3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10]);
        assert_eq!(&rgb[12..15], &[23, 22, 21]);

        // A 4K screen fits the box, keeping its aspect.
        let src = vec![0u8; 3840 * 2160 * 4];
        let (info, _) = decode(&png_url(&src, 3840 * 4, 3840, 2160).unwrap());
        assert_eq!((info.width, info.height), (120, 67));
    }

    #[test]
    fn an_incompressible_thumbnail_stays_within_the_ipc_budget() {
        const MAX_THUMBNAIL: usize = 33 * 1024;
        // Noise that fills the whole box defeats compression: the worst case.
        let (w, h) = (THUMB_WIDTH * 10, THUMB_HEIGHT * 10);
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let src: Vec<u8> = (0..w * h * 4)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        let url = png_url(&src, w * 4, w, h).unwrap();
        let (info, _) = decode(&url);
        assert_eq!(
            (info.width as usize, info.height as usize),
            (THUMB_WIDTH, THUMB_HEIGHT)
        );
        assert!(url.len() <= MAX_THUMBNAIL, "{} bytes", url.len());
    }

    #[test]
    fn a_synthetic_capture_starts_previews_and_stops_cleanly() {
        let _serial = lock(&SERIAL);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let base = active_captures();
        let (capture, started) = ScreenCapture::start(
            Target::Synthetic {
                width: 640,
                height: 360,
            },
            CaptureOptions {
                fps: 30.0,
                max_width: 320,
                max_height: 180,
            },
            || {},
        )
        .unwrap();
        assert_eq!(rt.block_on(started).unwrap(), Ok((320, 180)));
        let mut preview = capture.preview().subscribe();
        rt.block_on(preview.changed()).unwrap();
        let frame = preview.borrow().clone().unwrap();
        assert_eq!(&pack_i420(&frame)[..8], &[64, 1, 0, 0, 180, 0, 0, 0]);
        assert_eq!(active_captures(), base + 1);
        drop(capture);
        assert_eq!(active_captures(), base);
        // The preview ends with the capture.
        assert!(rt.block_on(preview.changed()).is_err());
    }

    fn idle_capture() -> ScreenCapture {
        ScreenCapture {
            target: Target::Screen(0),
            shared: Arc::new(Shared {
                options: Mutex::new(CaptureOptions {
                    fps: 30.0,
                    max_width: 0,
                    max_height: 0,
                }),
                raw: Mutex::new(None),
                source: Mutex::new(None),
                preview: Mutex::new(Arc::new(watch::channel(None).0)),
            }),
            stop: None,
            thread: None,
        }
    }

    #[test]
    fn set_options_before_the_first_frame_returns_none() {
        let capture = idle_capture();
        let options = CaptureOptions {
            fps: 15.0,
            max_width: 1280,
            max_height: 720,
        };
        assert_eq!(capture.set_options(options), None);
        // The loop still picks the options up on its first tick.
        let held = *lock(&capture.shared.options);
        assert_eq!(
            (held.fps, held.max_width, held.max_height),
            (15.0, 1280, 720)
        );
    }

    #[test]
    fn set_options_sizes_the_latest_raw_frame_under_the_new_cap() {
        let capture = idle_capture();
        *lock(&capture.shared.raw) = Some((1920, 1080));
        let capped = |w, h| CaptureOptions {
            fps: 30.0,
            max_width: w,
            max_height: h,
        };
        assert_eq!(capture.set_options(capped(1280, 720)), Some((1280, 720)));
        assert_eq!(capture.set_options(capped(0, 0)), Some((1920, 1080)));
        assert_eq!(capture.set_options(capped(4000, 3000)), Some((1920, 1080)));
        assert_eq!(capture.set_options(capped(640, 640)), Some((640, 360)));
    }

    #[test]
    fn set_options_changes_size_and_pace_of_a_running_capture() {
        let _serial = lock(&SERIAL);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let (capture, started) = ScreenCapture::start(
            Target::Synthetic {
                width: 1280,
                height: 720,
            },
            CaptureOptions {
                fps: 1.0,
                max_width: 0,
                max_height: 0,
            },
            || {},
        )
        .unwrap();
        assert_eq!(rt.block_on(started).unwrap(), Ok((1280, 720)));
        let mut preview = capture.preview().subscribe();
        let size = |frame: &I420Buffer| (frame.width(), frame.height());
        // A stall fails the test instead of hanging it.
        let next = |preview: &mut watch::Receiver<Option<Arc<I420Buffer>>>| {
            // The timer must be created inside the runtime.
            rt.block_on(async {
                tokio::time::timeout(Duration::from_secs(3), preview.changed()).await
            })
            .expect("no preview frame within 3 s")
            .unwrap();
            preview.borrow_and_update().as_deref().map(size)
        };
        assert_eq!(next(&mut preview), Some((1280, 720)));

        let resized = capture.set_options(CaptureOptions {
            fps: 100.0,
            max_width: 640,
            max_height: 360,
        });
        assert_eq!(resized, Some((640, 360)));
        let begun = Instant::now();
        // At most one frame already in flight at the old size.
        let mut last = None;
        for _ in 0..3 {
            last = next(&mut preview);
            if last == Some((640, 360)) {
                break;
            }
        }
        assert_eq!(last, Some((640, 360)));
        for _ in 0..10 {
            assert_eq!(next(&mut preview), Some((640, 360)));
        }
        // The current 1 s wait ends first; ten frames at the old 1 s
        // interval would take another ten seconds.
        assert!(begun.elapsed() < Duration::from_secs(4));
        drop(capture);
    }

    #[test]
    fn a_taken_over_preview_keeps_playing_the_new_capture() {
        let _serial = lock(&SERIAL);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let synthetic = |width, height| {
            ScreenCapture::start(
                Target::Synthetic { width, height },
                CaptureOptions {
                    fps: 30.0,
                    max_width: 0,
                    max_height: 0,
                },
                || {},
            )
            .unwrap()
        };
        let (old, started) = synthetic(320, 180);
        assert_eq!(rt.block_on(started).unwrap(), Ok((320, 180)));
        // What the frame socket holds for the live share.
        let socket = old.preview();
        let mut preview = socket.subscribe();
        let (new, started) = synthetic(160, 90);
        assert_eq!(rt.block_on(started).unwrap(), Ok((160, 90)));
        new.take_over(&old);
        assert!(Arc::ptr_eq(&new.preview(), &socket));
        drop(old);
        // The socket's preview outlives the old capture and now carries the
        // new one's frames.
        let size = |frame: &I420Buffer| (frame.width(), frame.height());
        let mut last = None;
        for _ in 0..10 {
            rt.block_on(preview.changed()).unwrap();
            last = preview.borrow_and_update().as_deref().map(size);
            if last == Some((160, 90)) {
                break;
            }
        }
        assert_eq!(last, Some((160, 90)));
        drop(new);
        drop(socket);
        assert!(rt.block_on(preview.changed()).is_err());
    }

    /// The real X11 path: `xvfb-run cargo test -- --ignored x11` (CI has no
    /// display, and a portal needs a real Wayland desktop).
    #[test]
    #[ignore = "needs an X display"]
    fn x11_lists_sources_with_thumbnails_and_captures_one() {
        let _serial = lock(&SERIAL);
        let fds = || std::fs::read_dir("/proc/self/fd").unwrap().count();
        let before = fds();
        let sources = list_sources();
        assert!(!sources.portal);
        for s in &sources.sources {
            println!(
                "{} {:?} thumbnail={}",
                s.id,
                s.title,
                s.thumbnail.as_ref().map_or(0, String::len)
            );
        }
        let screen = sources
            .sources
            .iter()
            .find(|s| s.kind == "screen")
            .expect("a screen");
        assert!(screen
            .thumbnail
            .as_ref()
            .is_some_and(|t| t.starts_with("data:image/png;base64,iVBOR")));
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        for source in &sources.sources {
            let (capture, started) = ScreenCapture::start(
                Target::parse(&source.id).unwrap(),
                CaptureOptions {
                    fps: 30.0,
                    max_width: 1280,
                    max_height: 720,
                },
                || {},
            )
            .unwrap();
            let size = rt.block_on(started).unwrap();
            println!("{} first frame {size:?}", source.id);
            assert!(size.is_ok());
            drop(capture);
        }
        // Every X connection a listing or capture opened is closed again.
        assert_eq!(fds(), before);
    }

    #[test]
    fn a_capture_that_cannot_start_reports_why() {
        let _serial = lock(&SERIAL);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let (capture, started) = ScreenCapture::start(
            Target::Window(u64::MAX),
            CaptureOptions {
                fps: 30.0,
                max_width: 0,
                max_height: 0,
            },
            || {},
        )
        .unwrap();
        assert!(rt.block_on(started).unwrap().is_err());
        drop(capture);
    }
}
