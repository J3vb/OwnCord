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

/// The error a cancelled portal dialog (or any capturer that fails before
/// its first frame) reports; the webview maps it to a permission refusal.
pub const CANCELLED: &str = "screen capture was cancelled or refused";

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    /// The desktop portal picks (Wayland): `sources` is empty.
    pub portal: bool,
    pub sources: Vec<Source>,
}

/// Enumerate what can be shared. Blocking: one capture per source for its
/// thumbnail.
pub fn list_sources() -> Sources {
    if under_wayland() {
        return Sources {
            portal: true,
            sources: Vec::new(),
        };
    }
    let mut sources = Vec::new();
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
                thumbnail: thumbnail(ty, source),
            });
        }
    }
    Sources {
        portal: false,
        sources,
    }
}

fn thumbnail(ty: DesktopCaptureSourceType, source: CaptureSource) -> Option<String> {
    let mut capturer = capturer(ty)?;
    let slot = Arc::new(Mutex::new(None));
    let out = slot.clone();
    // X11 capturers call back synchronously inside `capture_frame`.
    capturer.start_capture(Some(source), move |result| {
        if let Ok(frame) = result {
            *out.lock().unwrap_or_else(|p| p.into_inner()) = thumbnail_url(&frame);
        }
    });
    capturer.capture_frame();
    let url = slot.lock().unwrap_or_else(|p| p.into_inner()).take();
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
    /// The published screen share's source; `None` while not published.
    source: Mutex<Option<NativeVideoSource>>,
    preview: Arc<Preview>,
}

pub struct ScreenCapture {
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
            source: Mutex::new(None),
            preview: Arc::new(watch::channel(None).0),
        });
        let counted = Counted::new();
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("owncord-screen".into())
            .spawn(move || {
                let _counted = counted;
                run(target, options, &thread_shared, &stopped, ready, on_end);
            })
            .map_err(|e| format!("screen capture thread: {e}"))?;
        Ok((
            Self {
                shared,
                stop: Some(stop),
                thread: Some(thread),
            },
            started,
        ))
    }

    pub fn preview(&self) -> Arc<Preview> {
        self.shared.preview.clone()
    }

    pub fn set_source(&self, source: Option<NativeVideoSource>) {
        *self.shared.source.lock().unwrap_or_else(|p| p.into_inner()) = source;
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
            *out.lock().unwrap_or_else(|p| p.into_inner()) = Some(grab);
        });
        Ok(Self::Desktop { capturer, slot })
    }

    fn grab(&mut self) -> Grab {
        match self {
            Self::Desktop { capturer, slot } => {
                // Both the X11 and the PipeWire capturer call back inside.
                capturer.capture_frame();
                slot.lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take()
                    .unwrap_or(Grab::Pending)
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
            y[row * sy as usize + col] = if (col + n * 8) / 64 % 2 == 0 { 40 } else { 220 };
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

fn run(
    target: Target,
    options: CaptureOptions,
    shared: &Shared,
    stopped: &mpsc::Receiver<()>,
    ready: oneshot::Sender<Result<(u32, u32), String>>,
    on_end: impl FnOnce(),
) {
    let mut ready = Some(ready);
    let mut producer = match Producer::new(target) {
        Ok(p) => p,
        Err(e) => {
            if let Some(r) = ready.take() {
                let _ = r.send(Err(e));
            }
            return;
        }
    };
    let interval = Duration::from_secs_f64(1.0 / options.fps.clamp(1.0, 120.0));
    let started = Instant::now();
    loop {
        let tick = Instant::now();
        match producer.grab() {
            Grab::Frame(mut buffer) => {
                if let Some((w, h)) = fit(
                    buffer.width(),
                    buffer.height(),
                    options.max_width,
                    options.max_height,
                ) {
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
                        let _ = r.send(Err(CANCELLED.into()));
                    }
                    None => on_end(),
                }
                return;
            }
        }
        // A stop (or the owner dropping) wakes this immediately.
        match stopped.recv_timeout(interval.saturating_sub(tick.elapsed())) {
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
    let source = shared
        .source
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(source) = source {
        source.capture_frame(&frame);
    }
    if shared.preview.receiver_count() > 0 {
        shared.preview.send_replace(Some(Arc::new(frame.buffer)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_voice::video::pack_i420;

    /// The capture count is process-wide: tests that start captures take
    /// turns.
    static SERIAL: Mutex<()> = Mutex::new(());

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
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
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

    /// The real X11 path: `xvfb-run cargo test -- --ignored x11` (CI has no
    /// display, and a portal needs a real Wayland desktop).
    #[test]
    #[ignore = "needs an X display"]
    fn x11_lists_sources_with_thumbnails_and_captures_one() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
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
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
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
