//! Native Linux camera capture for the native room, over GStreamer.
//!
//! WebKitGTK suspends a hidden page: it stops servicing
//! `requestVideoFrameCallback` and freezes the `<video>` element, so the
//! webview camera pump (`features/voice/native/cameraUplink.ts`) sends no
//! frames while the OwnCord window is hidden, minimized or covered — exactly
//! what sharing the screen or switching apps does
//! (`docs/architecture/voice-e2ee.md`, "the camera stalls while the window is
//! hidden"). Capture therefore runs here, independent of the window: a
//! `GstDeviceMonitor` lists `Video/Source` devices (V4L2 and PipeWire), and
//! `v4l2src` or `pipewiresrc` (or the monitor's own element for the id) feeds
//! `decodebin` and `videoconvert` into an I420 `appsink`. Frames go straight
//! to the camera's `NativeVideoSource` and to the local preview (the frame
//! socket's `/camera` route), the way `screen.rs` drives the screen share.
//!
//! The capture id scopes everything, as the screen capture's does: start
//! returns one, stop names it, a stop naming a capture a newer start replaced
//! is a no-op. Dropping the [`CameraCapture`] stops and joins the thread and
//! tears the pipeline down (Null state), which releases the device.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::AppSink;
use gstreamer_video::{VideoFormat, VideoFrameRef, VideoInfo};
use livekit::webrtc::prelude::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use serde::Serialize;
use tokio::sync::{oneshot, watch};

use super::screen::{Preview, Started};
use crate::sync::lock;

/// Capture threads alive, for the debug surface: it drops to zero only once
/// every camera pipeline has been torn down.
static CAPTURES: AtomicUsize = AtomicUsize::new(0);

pub fn active_captures() -> usize {
    CAPTURES.load(Ordering::Relaxed)
}

/// The error a camera reports when it fails before the first frame.
pub const FAILED: &str = "camera capture failed to start";

/// The error a camera reports when no first frame arrives in time. The webview
/// matches this text (`CAMERA_NO_FRAME` in `nativeRoom.ts`) to keep the live
/// camera instead of restarting onto a device that gives no picture.
pub const TIMED_OUT: &str = "camera capture produced no frame in time";

/// The error a camera reports when the requested device is gone.
pub const NO_DEVICE: &str = "that camera is no longer available";

/// How long a camera may take to produce its first frame.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(15);

/// One camera device, in the shape the webview's device list consumes.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraDevice {
    pub id: String,
    pub name: String,
    /// Offers only greyscale formats: a face-unlock infrared sensor, which
    /// usually shares the colour camera's name and gives no usable picture.
    pub infrared: bool,
    #[serde(skip)]
    pub index: u16,
}

/// `gst::init` with GStreamer's plugin-load fault trap off. The trap catches
/// a fault while a plugin loads and ends the process with `exit(-1)`, which
/// leaves no crash line and no core dump; without it a fault reaches the
/// crash log like any other. The trap can only be set before the first
/// init (gstreamer-rs panics otherwise), so it is set once, and only while
/// nothing has initialised GStreamer yet.
fn init_gst() -> Result<(), gst::glib::Error> {
    static TRAP_OFF: std::sync::Once = std::sync::Once::new();
    TRAP_OFF.call_once(|| {
        // SAFETY: a plain query of GStreamer's global init flag.
        if unsafe { gst::ffi::gst_is_initialized() } == gst::glib::ffi::GFALSE {
            gst::segtrap_set_enabled(false);
        }
    });
    gst::init()
}

/// The device property that carries a stable path. V4L2 uses `device.path`
/// (`/dev/video0`); PipeWire's monitor uses `pipewire.path` or `object.path`
/// depending on the release. The first present wins, then the display name.
fn device_id(device: &gst::Device) -> Option<String> {
    let props = device.properties()?;
    ["device.path", "pipewire.path", "object.path", "api"]
        .iter()
        .find_map(|key| props.get::<&str>(*key).ok().map(str::to_string))
        .filter(|id| !id.is_empty())
        .or_else(|| Some(device.display_name().to_string()))
}

/// Whether every format in `caps` is greyscale raw video (V4L2 `GREY`/`Y16`):
/// an infrared sensor. Empty or any caps (nothing known) are not.
fn greyscale_only(caps: &gst::CapsRef) -> bool {
    !caps.is_empty()
        && !caps.is_any()
        && caps.iter().all(|s| {
            s.name() == "video/x-raw"
                && match s.get::<&str>("format") {
                    Ok(f) => f.starts_with("GRAY"),
                    Err(_) => s.get::<gst::List>("format").is_ok_and(|l| {
                        !l.is_empty()
                            && l.iter()
                                .all(|v| v.get::<&str>().is_ok_and(|f| f.starts_with("GRAY")))
                    }),
                }
        })
}

/// Colour cameras first, infrared sensors after, each group in monitor
/// order: `Target::Default` opens the first one listed.
fn colour_first(mut devices: Vec<CameraDevice>) -> Vec<CameraDevice> {
    devices.sort_by_key(|d| d.infrared);
    devices
}

/// Enumerate the `Video/Source` devices GStreamer knows: V4L2 cameras and
/// PipeWire virtual cameras. Blocking (the monitor starts a discovery pass).
pub fn list_devices() -> Vec<CameraDevice> {
    // The monitor needs GStreamer initialised; a failure just means no list.
    if init_gst().is_err() {
        return Vec::new();
    }
    let monitor = gst::DeviceMonitor::new();
    if monitor.add_filter(Some("Video/Source"), None).is_none() {
        return Vec::new();
    }
    if monitor.start().is_err() {
        return Vec::new();
    }
    let devices = monitor.devices();
    monitor.stop();
    let listed = devices
        .iter()
        .enumerate()
        .filter_map(|(i, d)| {
            let id = device_id(d)?;
            let name = {
                let n = d.display_name().to_string();
                if n.is_empty() {
                    id.clone()
                } else {
                    n
                }
            };
            Some(CameraDevice {
                id,
                name,
                infrared: d.caps().is_some_and(|c| greyscale_only(&c)),
                index: i as u16,
            })
        })
        .collect();
    colour_first(listed)
}

/// The elements every capture pipeline builds by name, plus the source
/// elements it needs at least one of: `device_source` opens a device through
/// `v4l2src` or `pipewiresrc` (or the monitor's own element), so either source
/// alone suffices.
const REQUIRED_CAMERA_ELEMENTS: [&str; 5] = [
    "decodebin",
    "videoconvert",
    "videoscale",
    "capsfilter",
    "appsink",
];
const CAMERA_SOURCE_ELEMENTS: [&str; 2] = ["v4l2src", "pipewiresrc"];

/// Whether the host can capture cameras, in the shape the webview's support
/// notice consumes.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraSupport {
    /// GStreamer initialised and every required element exists.
    pub available: bool,
    /// The required elements GStreamer could not find, in pipeline order.
    pub missing: Vec<String>,
}

/// A camera-support check with the live GStreamer state left out: `init`
/// reports whether GStreamer initialised and `find` whether an element exists
/// by name. Split out so a test can pin a missing element without touching the
/// host's installed plugins.
fn support_with(init: bool, find: &dyn Fn(&str) -> bool) -> CameraSupport {
    if !init {
        return CameraSupport {
            available: false,
            missing: Vec::new(),
        };
    }
    let mut missing: Vec<String> = Vec::new();
    if !CAMERA_SOURCE_ELEMENTS.iter().any(|name| find(name)) {
        missing.extend(
            CAMERA_SOURCE_ELEMENTS
                .iter()
                .map(|name| (*name).to_string()),
        );
    }
    missing.extend(
        REQUIRED_CAMERA_ELEMENTS
            .iter()
            .filter(|name| !find(name))
            .map(|name| (*name).to_string()),
    );
    CameraSupport {
        available: missing.is_empty(),
        missing,
    }
}

/// Whether the host can capture cameras: GStreamer initialises and the
/// capture pipeline's required elements exist. A minimal or non-Debian Linux
/// install without the GStreamer plugin packages has no `v4l2src` or
/// `pipewiresrc`, lists no cameras and cannot capture; this tells the webview
/// why instead of leaving an unexplained empty list.
pub fn support() -> CameraSupport {
    support_with(init_gst().is_ok(), &|name| {
        gst::ElementFactory::find(name).is_some()
    })
}

/// What to capture: `Default` (the first listed device), a device id from
/// [`list_devices`], or moving bars for the interop test (CI has no camera).
/// `Synthetic` is not reachable from the webview.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Device(String),
    Default,
    Synthetic { width: u32, height: u32 },
}

impl Target {
    /// A picker id from the webview. A non-empty string is a device id; an
    /// empty one is the default (the first camera listed); the synthetic
    /// target is not parseable.
    pub fn parse(id: &str) -> Result<Self, String> {
        if id.is_empty() {
            return Ok(Self::Default);
        }
        Ok(Self::Device(id.to_string()))
    }

    /// The concrete device id to open: the requested one only when it exactly
    /// matches a listed device, otherwise the first listed camera — what
    /// `Default`, and a saved id that no longer matches any device, both mean.
    /// A requested id that no listed camera matches is never used as-is.
    /// `None` when no camera is listed; `Synthetic` opens no device.
    fn resolve_id(&self, listed: &[CameraDevice]) -> Option<String> {
        match self {
            Target::Synthetic { .. } => None,
            Target::Device(id) if listed.iter().any(|d| d.id == *id) => Some(id.clone()),
            Target::Device(_) | Target::Default => listed.first().map(|d| d.id.clone()),
        }
    }
}

/// Capture pacing and size cap, from the web path's camera presets.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub fps: f64,
    /// 0 for either means the source size.
    pub max_width: u32,
    pub max_height: u32,
}

struct Shared {
    /// The published camera's source; `None` while not published.
    source: Mutex<Option<NativeVideoSource>>,
    /// Swapped by `take_over` so the preview socket outlives a capture.
    preview: Mutex<Arc<Preview>>,
}

/// A running native camera capture.
pub struct CameraCapture {
    shared: Arc<Shared>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

/// Counts a capture thread from before it is spawned until it has dropped its
/// pipeline.
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

impl CameraCapture {
    pub fn start(
        target: Target,
        options: CaptureOptions,
        on_end: impl FnOnce() + Send + 'static,
    ) -> Result<(Self, Started), String> {
        let (stop, stopped) = mpsc::channel();
        let (ready, started) = oneshot::channel();
        let shared = Arc::new(Shared {
            source: Mutex::new(None),
            preview: Mutex::new(Arc::new(watch::channel(None).0)),
        });
        let counted = Counted::new();
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("owncord-camera".into())
            .spawn(move || {
                let _counted = counted;
                run(target, options, &thread_shared, &stopped, ready, on_end);
            })
            .map_err(|e| format!("camera capture thread: {e}"))?;
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
        lock(&self.shared.preview).clone()
    }

    pub fn set_source(&self, source: Option<NativeVideoSource>) {
        *lock(&self.shared.source) = source;
    }

    /// Carry `from`'s published source and preview over to this capture, so
    /// the publication and the preview socket keep going on this capture's
    /// frames once `from` is dropped (a camera change).
    pub fn take_over(&self, from: &CameraCapture) {
        *lock(&self.shared.preview) = from.preview();
        let source = lock(&from.shared.source).take();
        self.set_source(source);
    }
}

impl Drop for CameraCapture {
    /// Wake the thread and wait for it: once this returns, the pipeline (and
    /// with it the device) is gone.
    fn drop(&mut self) {
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum Grab {
    Frame(I420Buffer),
    /// Nothing yet: the device is still warming up.
    Pending,
    Failed,
}

enum Producer {
    Device {
        pipeline: gst::Pipeline,
        sink: AppSink,
        /// Set until the first frame while the pipeline is pinned to a camera
        /// mode or opens the V4L2 node directly: a failure then rebuilds it
        /// once, unpinned and from the device monitor's own element (which
        /// shares a camera another app holds through PipeWire).
        fallback: Option<String>,
    },
    Synthetic {
        width: u32,
        height: u32,
        n: usize,
    },
}

impl Producer {
    fn new(target: &Target, options: &CaptureOptions) -> Result<Self, String> {
        match target {
            Target::Synthetic { width, height } => Ok(Self::Synthetic {
                width: *width,
                height: *height,
                n: 0,
            }),
            Target::Device(_) | Target::Default => {
                let id = target
                    .resolve_id(&list_devices())
                    .ok_or_else(|| NO_DEVICE.to_string())?;
                Self::device(&id, options)
            }
        }
    }

    fn device(id: &str, options: &CaptureOptions) -> Result<Self, String> {
        let (source, device_caps, direct) = device_source(id, true)?;
        let mode = device_caps
            .as_ref()
            .map(|caps| camera_modes(caps))
            .and_then(|modes| pick_mode(&modes, options));
        if let Some(mode) = mode {
            log::info!("[native_voice] camera mode {mode:?}");
        }
        let fallback = (mode.is_some() || direct).then(|| id.to_string());
        let pin = mode.map(|m| m.caps());
        match build_pipeline(source, pin.as_ref()).and_then(play) {
            Ok((pipeline, sink)) => Ok(Self::Device {
                pipeline,
                sink,
                fallback,
            }),
            Err(e) if fallback.is_some() => {
                log::warn!("[native_voice] camera refused ({mode:?}, direct {direct}): {e}");
                Self::fallback(id)
            }
            Err(e) => Err(e),
        }
    }

    /// Capture `id` in whatever mode its source picks, from the monitor's own
    /// element, with a fresh source (the old one belongs to the pipeline that
    /// was given up).
    fn fallback(id: &str) -> Result<Self, String> {
        let (source, _, _) = device_source(id, false)?;
        build_pipeline(source, None)
            .and_then(play)
            .map(|(pipeline, sink)| Self::Device {
                pipeline,
                sink,
                fallback: None,
            })
    }

    fn grab(&mut self) -> Grab {
        match self {
            Self::Device {
                pipeline,
                sink,
                fallback,
            } => {
                // A device unplugged mid-capture ends the stream: the pipeline
                // posts an error or EOS on its bus. Report it so capture stops
                // (and, once started, the caller is told via `on_end`).
                if let Some(bus) = pipeline.bus() {
                    while let Some(msg) = bus.pop() {
                        if matches!(
                            msg.view(),
                            gst::MessageView::Error(_) | gst::MessageView::Eos(_)
                        ) {
                            // The chosen mode would not negotiate: let the
                            // source pick its own, as before modes were chosen.
                            let Some(id) = fallback.take() else {
                                return Grab::Failed;
                            };
                            log::warn!("[native_voice] camera failed to start; retrying through the device monitor, unpinned");
                            // Release the device before the new pipeline opens it.
                            let _ = pipeline.set_state(gst::State::Null);
                            return match Self::fallback(&id) {
                                Ok(fresh) => {
                                    *self = fresh;
                                    Grab::Pending
                                }
                                Err(_) => Grab::Failed,
                            };
                        }
                    }
                }
                let sample = sink.try_pull_sample(gst::ClockTime::ZERO);
                if sample.is_some() {
                    fallback.take();
                }
                match sample {
                    Some(sample) => {
                        let frame =
                            sample
                                .buffer()
                                .zip(sample.caps())
                                .and_then(|(buffer, caps)| {
                                    VideoInfo::from_caps(caps)
                                        .ok()
                                        .and_then(|info| to_i420(buffer, &info))
                                });
                        frame.map_or(Grab::Pending, Grab::Frame)
                    }
                    None => Grab::Pending,
                }
            }
            Self::Synthetic { width, height, n } => {
                *n += 1;
                Grab::Frame(bars(*width, *height, *n))
            }
        }
    }
}

impl Drop for Producer {
    fn drop(&mut self) {
        if let Self::Device { pipeline, .. } = self {
            let _ = pipeline.set_state(gst::State::Null);
        }
    }
}

/// The source element for a device id, with the modes the device lists when
/// the monitor knows it: the monitor's own element when the id round-trips
/// (V4L2 and PipeWire), else a `v4l2src`/`pipewiresrc` by path. With
/// `direct`, a PipeWire camera backed by a V4L2 node opens that node instead
/// ([`direct_v4l2`]); the returned flag says it did.
fn device_source(
    id: &str,
    direct: bool,
) -> Result<(gst::Element, Option<gst::Caps>, bool), String> {
    let found = match monitor_element(id, direct) {
        Some(found) => found,
        None => {
            let (factory, prop) = if id.starts_with('/') {
                ("v4l2src", "device")
            } else {
                ("pipewiresrc", "path")
            };
            gst::ElementFactory::make(factory)
                .property(prop, id)
                .build()
                .map(|element| (element, None, false))
                .map_err(|_| format!("{NO_DEVICE}: {id}"))?
        }
    };
    copy_out_of_pipewire(&found.0);
    Ok(found)
}

/// A `pipewiresrc` hands out the camera's own buffers by default, and the
/// camera service refills them while the frame is still on its way through
/// the pipeline. With the few buffers a built-in (libcamera) camera keeps,
/// the picture then cycles through the same handful of frames. Copying each
/// frame out as it arrives costs one memcpy per frame and keeps it intact.
fn copy_out_of_pipewire(source: &gst::Element) {
    if source.find_property("always-copy").is_some() {
        source.set_property("always-copy", true);
    }
}

/// Re-find the monitored device with this id and let it build its element; the
/// monitor knows which backend (V4L2, PipeWire) the id belongs to.
fn monitor_element(id: &str, direct: bool) -> Option<(gst::Element, Option<gst::Caps>, bool)> {
    if init_gst().is_err() {
        return None;
    }
    let monitor = gst::DeviceMonitor::new();
    monitor.add_filter(Some("Video/Source"), None)?;
    monitor.start().ok()?;
    let found = monitor
        .devices()
        .iter()
        .find(|d| device_id(d).as_deref() == Some(id))
        .and_then(|d| {
            let caps = d.caps();
            match direct.then(|| direct_v4l2(d)).flatten() {
                Some(e) => Some((e, caps, true)),
                None => d.create_element(None).ok().map(|e| (e, caps, false)),
            }
        });
    monitor.stop();
    found
}

/// The `/dev/video*` node behind a PipeWire camera, when it is a plain V4L2
/// device and not a libcamera one. PipeWire names it in `api.v4l2.path`, and
/// in `object.path` as `v4l2:<node>`.
fn v4l2_node(props: &gst::StructureRef) -> Option<String> {
    props
        .get::<&str>("api.v4l2.path")
        .ok()
        .or_else(|| {
            props
                .get::<&str>("object.path")
                .ok()
                .and_then(|p| p.strip_prefix("v4l2:"))
        })
        .filter(|path| path.starts_with("/dev/video"))
        .map(str::to_string)
}

/// A `v4l2src` on the node behind a PipeWire V4L2 camera. The AppImage carries
/// GStreamer 1.20's `pipewiresrc`, which runs against the host's far newer
/// PipeWire: switching cameras could crash its streaming thread, and raw
/// frames could be read after PipeWire reused their buffer. A V4L2 camera
/// does not need PipeWire in between, so it is opened directly; only a
/// libcamera camera (no V4L2 node) still goes through `pipewiresrc`.
fn direct_v4l2(device: &gst::Device) -> Option<gst::Element> {
    let props = device.properties()?;
    let node = v4l2_node(&props)?;
    let element = gst::ElementFactory::make("v4l2src")
        .property("device", &node)
        .build()
        .ok()?;
    log::info!("[native_voice] camera opened directly at {node}");
    Some(element)
}

/// Start `pipeline`; on a refusal it goes back to Null so the device is free.
fn play((pipeline, sink): (gst::Pipeline, AppSink)) -> Result<(gst::Pipeline, AppSink), String> {
    if let Err(e) = pipeline.set_state(gst::State::Playing) {
        let _ = pipeline.set_state(gst::State::Null);
        return Err(format!("camera pipeline: {e}"));
    }
    Ok((pipeline, sink))
}

/// `source ! [mode] ! decodebin ! videoconvert ! videoscale ! I420 ! appsink`,
/// linked once GStreamer (re)exposes a decoded pad. `mode` pins the camera
/// mode; without it the source picks its own.
fn build_pipeline(
    source: gst::Element,
    mode: Option<&gst::Caps>,
) -> Result<(gst::Pipeline, AppSink), String> {
    let pipeline = gst::Pipeline::new();
    let make = |name: &str| {
        gst::ElementFactory::make(name)
            .build()
            .map_err(|_| format!("camera pipeline: no {name} element"))
    };
    let decode = make("decodebin")?;
    let convert = make("videoconvert")?;
    let scale = make("videoscale")?;
    let caps = gst::Caps::builder("video/x-raw")
        .field("format", "I420")
        .build();
    let filter = gst::ElementFactory::make("capsfilter")
        .property("caps", &caps)
        .build()
        .map_err(|_| "camera pipeline: no capsfilter".to_string())?;
    let sink = AppSink::builder()
        .max_buffers(1u32)
        .drop(true)
        .sync(false)
        .build();
    let tail: [&gst::Element; 4] = [&convert, &scale, &filter, sink.upcast_ref()];
    pipeline
        .add_many([
            &source,
            &decode,
            &convert,
            &scale,
            &filter,
            sink.upcast_ref(),
        ])
        .map_err(|e| format!("camera pipeline: {e}"))?;
    gst::Element::link_many(tail).map_err(|e| format!("camera pipeline: {e}"))?;
    // decodebin exposes its pad only once it has inspected the stream.
    let convert_sink = convert
        .static_pad("sink")
        .ok_or("camera pipeline: videoconvert has no sink")?;
    decode.connect_pad_added(move |_, pad| {
        if convert_sink.is_linked() {
            return;
        }
        let _ = pad.link(&convert_sink);
    });
    match mode {
        Some(caps) => {
            let pin = gst::ElementFactory::make("capsfilter")
                .property("caps", caps)
                .build()
                .map_err(|_| "camera pipeline: no capsfilter".to_string())?;
            pipeline
                .add(&pin)
                .map_err(|e| format!("camera pipeline: {e}"))?;
            gst::Element::link_many([&source, &pin, &decode])
                .map_err(|e| format!("camera pipeline: {e}"))?;
        }
        None => source
            .link(&decode)
            .map_err(|e| format!("camera pipeline: {e}"))?,
    }
    Ok((pipeline, sink))
}

/// One capture mode a camera lists: raw or MJPEG, a fixed size, one rate.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Mode {
    jpeg: bool,
    width: u32,
    height: u32,
    fps: gst::Fraction,
}

impl Mode {
    fn rate(&self) -> f64 {
        f64::from(self.fps.numer()) / f64::from(self.fps.denom().max(1))
    }

    fn caps(&self) -> gst::Caps {
        gst::Caps::builder(if self.jpeg {
            "image/jpeg"
        } else {
            "video/x-raw"
        })
        .field("width", self.width as i32)
        .field("height", self.height as i32)
        .field("framerate", self.fps)
        .build()
    }
}

/// The fixed-size raw and MJPEG modes in a device's caps, one per listed
/// rate. Ranged sizes (some PipeWire cameras) are left to the source.
fn camera_modes(caps: &gst::CapsRef) -> Vec<Mode> {
    let mut modes = Vec::new();
    for s in caps.iter() {
        let jpeg = match s.name().as_str() {
            "video/x-raw" => false,
            "image/jpeg" => true,
            _ => continue,
        };
        let (Ok(width), Ok(height)) = (s.get::<i32>("width"), s.get::<i32>("height")) else {
            continue;
        };
        if width <= 0 || height <= 0 {
            continue;
        }
        let Ok(rates) = s.value("framerate") else {
            continue;
        };
        let rates: Vec<gst::Fraction> = if let Ok(f) = rates.get::<gst::Fraction>() {
            vec![f]
        } else if let Ok(list) = rates.get::<gst::List>() {
            list.iter()
                .filter_map(|v| v.get::<gst::Fraction>().ok())
                .collect()
        } else if let Ok(range) = rates.get::<gst::FractionRange>() {
            vec![range.max()]
        } else {
            continue;
        };
        modes.extend(rates.into_iter().filter(|f| f.numer() > 0).map(|fps| Mode {
            jpeg,
            width: width as u32,
            height: height as u32,
            fps,
        }));
    }
    modes
}

/// The camera mode to capture in. Left alone, `v4l2src` takes raw over MJPEG
/// and the largest size, and a webcam's largest raw size (1080p YUYV) often
/// runs at 5 fps. Best first: a mode that reaches the asked rate (else the
/// fastest), then one that covers the size cap with the fewest pixels (else
/// the largest; with no cap, the largest), then raw over MJPEG, then the
/// lowest rate that still reaches the asked one. `None` with no modes.
fn pick_mode(modes: &[Mode], options: &CaptureOptions) -> Option<Mode> {
    let want = options.fps.clamp(1.0, 120.0);
    let capped = options.max_width > 0 && options.max_height > 0;
    let key = |m: &Mode| {
        let fast = m.rate() + 0.5 >= want;
        let covers = !capped || (m.width >= options.max_width && m.height >= options.max_height);
        let area = u64::from(m.width) * u64::from(m.height);
        let rate = (m.rate() * 1000.0) as u64;
        (
            fast,
            if fast { 0 } else { rate },
            covers,
            if capped && covers {
                u64::MAX - area
            } else {
                area
            },
            !m.jpeg,
            if fast { u64::MAX - rate } else { 0 },
        )
    };
    modes.iter().copied().max_by_key(key)
}

/// A `GStreamer` I420 buffer as a libwebrtc `I420Buffer`, honouring strides.
fn to_i420(buffer: &gst::BufferRef, info: &VideoInfo) -> Option<I420Buffer> {
    if info.format() != VideoFormat::I420 {
        return None;
    }
    let (w, h) = (info.width() as usize, info.height() as usize);
    if w == 0 || h == 0 {
        return None;
    }
    let frame = VideoFrameRef::from_buffer_ref_readable(buffer, info).ok()?;
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let mut out = I420Buffer::new(w as u32, h as u32);
    let (sy, su, sv) = out.strides();
    let (y, u, v) = out.data_mut();
    let strides = info.stride();
    for (plane, dst, dst_stride, rows, cols) in
        [(0u32, y, sy, h, w), (1, u, su, ch, cw), (2, v, sv, ch, cw)]
    {
        let src = frame.plane_data(plane).ok()?;
        let src_stride = strides[plane as usize] as usize;
        for row in 0..rows {
            let d = row * dst_stride as usize;
            let s = row * src_stride;
            dst[d..d + cols].copy_from_slice(src.get(s..s + cols)?);
        }
    }
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

fn run(
    target: Target,
    options: CaptureOptions,
    shared: &Shared,
    stopped: &mpsc::Receiver<()>,
    ready: oneshot::Sender<Result<(u32, u32), String>>,
    on_end: impl FnOnce(),
) {
    let mut ready = Some(ready);
    let mut producer = match Producer::new(&target, &options) {
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
        options,
        shared,
        stopped,
        &mut ready,
        Some(FIRST_FRAME_TIMEOUT),
        FAILED,
        on_end,
    );
}

/// The capture loop, over any grab source. Split from `run` so a test can
/// drive a source that never yields a first frame and pin the timeout.
#[allow(clippy::too_many_arguments)]
fn run_loop(
    grab: &mut dyn FnMut() -> Grab,
    options: CaptureOptions,
    shared: &Shared,
    stopped: &mpsc::Receiver<()>,
    ready: &mut Option<oneshot::Sender<Result<(u32, u32), String>>>,
    first_frame_timeout: Option<Duration>,
    failed: &str,
    on_end: impl FnOnce(),
) {
    let interval = Duration::from_secs_f64(1.0 / options.fps.clamp(1.0, 120.0));
    let started = Instant::now();
    loop {
        let tick = Instant::now();
        if ready.is_some() && first_frame_timeout.is_some_and(|t| started.elapsed() > t) {
            if let Some(r) = ready.take() {
                let _ = r.send(Err(TIMED_OUT.into()));
            }
            return;
        }
        match grab() {
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
                        let _ = r.send(Err(failed.into()));
                    }
                    None => on_end(),
                }
                return;
            }
        }
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
mod tests;
