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
mod tests {
    use super::*;

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
            CaptureOptions {
                fps: 30.0,
                max_width: 0,
                max_height: 0,
            },
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

    /// A camera that never yields a first frame must not spin the start loop
    /// forever; the timeout is a failure the caller is told about.
    #[test]
    fn a_camera_that_never_produces_a_first_frame_times_out() {
        assert_eq!(
            start_result(|| Grab::Pending, Some(Duration::from_millis(20)), FAILED),
            Some(Err(TIMED_OUT.to_string()))
        );
    }

    #[test]
    fn a_failure_before_the_first_frame_reports_why() {
        assert_eq!(
            start_result(|| Grab::Failed, Some(Duration::from_secs(5)), FAILED),
            Some(Err(FAILED.to_string()))
        );
    }

    #[test]
    fn device_ids_parse_and_an_empty_one_is_the_default() {
        assert_eq!(
            Target::parse("/dev/video0"),
            Ok(Target::Device("/dev/video0".into()))
        );
        assert_eq!(Target::parse("42"), Ok(Target::Device("42".into())));
        assert_eq!(Target::parse(""), Ok(Target::Default));
    }

    #[test]
    fn a_listed_device_wins_and_a_stale_or_empty_one_falls_back_to_the_first() {
        let listed = vec![
            CameraDevice {
                id: "/dev/video0".into(),
                name: "Cam A".into(),
                infrared: false,
                index: 0,
            },
            CameraDevice {
                id: "/dev/video2".into(),
                name: "Cam B".into(),
                infrared: false,
                index: 1,
            },
        ];
        assert_eq!(
            Target::Device("/dev/video2".into())
                .resolve_id(&listed)
                .as_deref(),
            Some("/dev/video2")
        );
        assert_eq!(
            Target::Default.resolve_id(&listed).as_deref(),
            Some("/dev/video0")
        );
        assert_eq!(Target::Device("/dev/video9".into()).resolve_id(&[]), None);
        assert_eq!(Target::Default.resolve_id(&[]), None);
    }

    /// An unlisted id must never reach a GStreamer property: only an id that
    /// exactly matches a listed device resolves, otherwise the first listed
    /// camera does; with nothing listed the caller is told there is no device.
    #[test]
    fn an_unlisted_or_hostile_id_resolves_to_a_listed_device_or_none() {
        let listed = vec![CameraDevice {
            id: "/dev/video0".into(),
            name: "Cam A".into(),
            infrared: false,
            index: 0,
        }];
        for id in ["evil;id", "-evil", "", "/dev/video9"] {
            assert_eq!(
                Target::Device(id.into()).resolve_id(&listed).as_deref(),
                Some("/dev/video0"),
                "{id:?} must not be used as-is"
            );
        }
        for id in ["evil;id", "-evil", "/dev/video9"] {
            assert_eq!(Target::Device(id.into()).resolve_id(&[]), None, "{id:?}");
        }
    }

    /// A synthetic camera drives the capture loop, previews, publishes to a
    /// `NativeVideoSource`, and releases the thread and pipeline on drop.
    #[test]
    fn a_synthetic_camera_starts_previews_and_stops_cleanly() {
        let _serial = lock(&SERIAL);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        // `NativeVideoSource::new` starts its keepalive task, which needs a
        // Tokio context at construction (and for the `block_on` waits below).
        let _guard = rt.enter();
        let base = active_captures();
        let (capture, started) = CameraCapture::start(
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
        // The first frame's size is the scaled one, and it is delivered to a
        // published source as well as the preview.
        let source = NativeVideoSource::new(
            livekit::webrtc::video_source::VideoResolution {
                width: 320,
                height: 180,
            },
            false,
        );
        capture.set_source(Some(source));
        assert_eq!(rt.block_on(started).unwrap(), Ok((320, 180)));
        let mut preview = capture.preview().subscribe();
        rt.block_on(preview.changed()).unwrap();
        let frame = preview.borrow().clone().unwrap();
        assert_eq!((frame.width(), frame.height()), (320, 180));
        assert_eq!(active_captures(), base + 1);
        drop(capture);
        assert_eq!(active_captures(), base);
        // The preview ends with the capture.
        assert!(rt.block_on(preview.changed()).is_err());
    }

    fn synthetic(width: u32, height: u32) -> (CameraCapture, Started) {
        CameraCapture::start(
            Target::Synthetic { width, height },
            CaptureOptions {
                fps: 30.0,
                max_width: 0,
                max_height: 0,
            },
            || {},
        )
        .unwrap()
    }

    /// A camera change: the new capture carries the source and the preview
    /// socket, so a receiver taken from the old capture keeps getting frames,
    /// at the new size, once the old capture is gone.
    #[test]
    fn take_over_moves_preview_and_source_to_the_new_capture() {
        let _serial = lock(&SERIAL);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let _guard = rt.enter();
        let (old, old_started) = synthetic(640, 360);
        let source = NativeVideoSource::new(
            livekit::webrtc::video_source::VideoResolution {
                width: 640,
                height: 360,
            },
            false,
        );
        old.set_source(Some(source));
        assert_eq!(rt.block_on(old_started).unwrap(), Ok((640, 360)));
        let mut preview = old.preview().subscribe();
        rt.block_on(preview.changed()).unwrap();
        let (new, new_started) = synthetic(320, 240);
        assert_eq!(rt.block_on(new_started).unwrap(), Ok((320, 240)));
        new.take_over(&old);
        assert!(lock(&old.shared.source).is_none());
        assert!(lock(&new.shared.source).is_some());
        drop(old);
        // Frames the old capture sent before the swap may still be queued;
        // wait for one at the new size.
        let got = rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    preview.changed().await.ok()?;
                    let frame = preview.borrow().clone()?;
                    if (frame.width(), frame.height()) == (320, 240) {
                        return Some(());
                    }
                }
            })
            .await
        });
        assert_eq!(got, Ok(Some(())), "preview carries on at the new size");
        drop(new);
    }

    /// A pending change dropped before it takes over leaves the live
    /// capture's preview running, untouched.
    #[test]
    fn a_dropped_pending_capture_leaves_the_live_preview_running() {
        let _serial = lock(&SERIAL);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let _guard = rt.enter();
        let (live, live_started) = synthetic(640, 360);
        assert_eq!(rt.block_on(live_started).unwrap(), Ok((640, 360)));
        let mut preview = live.preview().subscribe();
        let (pending, pending_started) = synthetic(320, 240);
        assert_eq!(rt.block_on(pending_started).unwrap(), Ok((320, 240)));
        drop(pending);
        rt.block_on(preview.changed()).unwrap();
        let frame = preview.borrow().clone().unwrap();
        assert_eq!((frame.width(), frame.height()), (640, 360));
        rt.block_on(preview.changed()).unwrap();
        drop(live);
    }

    /// The real GStreamer frame path, with no camera: `videotestsrc` through
    /// `videoconvert` into an I420 `appsink`, converted to a libwebrtc
    /// `I420Buffer` exactly as a device sample is. This is the path a V4L2 or
    /// PipeWire camera takes once its source element is wired.
    #[test]
    fn an_appsink_sample_converts_to_i420_for_the_published_source() {
        if gst::init().is_err() {
            eprintln!("no GStreamer runtime; skipping the appsink frame-path proof");
            return;
        }
        let source = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .property("num-buffers", 30i32)
            .build()
            .expect("videotestsrc");
        let (pipeline, sink) = build_pipeline(source, None).expect("pipeline");
        pipeline.set_state(gst::State::Playing).unwrap();
        let sample = (0..100)
            .find_map(|_| {
                std::thread::sleep(Duration::from_millis(20));
                sink.try_pull_sample(gst::ClockTime::from_mseconds(200))
            })
            .expect("a sample");
        pipeline.set_state(gst::State::Null).ok();
        let info = VideoInfo::from_caps(sample.caps().unwrap()).unwrap();
        let frame = to_i420(sample.buffer().unwrap(), &info).expect("I420 conversion");
        assert_eq!(
            (frame.width(), frame.height()),
            (info.width(), info.height())
        );
        assert!(frame.width() > 0 && frame.height() > 0);
        let (_, _, _) = frame.strides();
        let (y, u, v) = frame.data();
        // videotestsrc's default pattern is not all black: real pixels.
        assert!(y.iter().any(|&p| p > 16), "luma has content");
        assert!(!u.is_empty() && !v.is_empty());
    }

    /// A typical laptop webcam: raw YUYV is slow at its larger sizes, MJPEG
    /// keeps 30 fps at every size.
    const WEBCAM: &str = "video/x-raw, format=YUY2, width=1920, height=1080, framerate=5/1; \
        video/x-raw, format=YUY2, width=1280, height=720, framerate=10/1; \
        video/x-raw, format=YUY2, width=640, height=360, framerate={ 30/1, 15/1 }; \
        video/x-raw, format=YUY2, width=320, height=180, framerate=30/1; \
        image/jpeg, width=1920, height=1080, framerate={ 30/1, 15/1 }; \
        image/jpeg, width=1280, height=720, framerate=30/1; \
        image/jpeg, width=640, height=360, framerate=30/1";

    fn webcam_modes() -> Vec<Mode> {
        gst::init().unwrap();
        camera_modes(&WEBCAM.parse::<gst::Caps>().unwrap())
    }

    fn pick(fps: f64, max_width: u32, max_height: u32) -> Option<(bool, u32, u32, i32)> {
        pick_mode(
            &webcam_modes(),
            &CaptureOptions {
                fps,
                max_width,
                max_height,
            },
        )
        .map(|m| (m.jpeg, m.width, m.height, m.fps.numer()))
    }

    #[test]
    fn camera_modes_lists_each_fixed_size_at_each_rate() {
        let modes = webcam_modes();
        assert_eq!(modes.len(), 9);
        let ranged = "video/x-raw, width=[ 1, 4096 ], height=[ 1, 2160 ], framerate=30/1; \
            image/jpeg, width=640, height=480, framerate=[ 1/1, 60/1 ]; \
            video/x-bayer, width=640, height=480, framerate=30/1"
            .parse::<gst::Caps>()
            .unwrap();
        let modes = camera_modes(&ranged);
        assert_eq!(modes.len(), 1, "ranged sizes and other formats are skipped");
        assert_eq!(
            (modes[0].jpeg, modes[0].width, modes[0].fps.numer()),
            (true, 640, 60)
        );
    }

    #[test]
    fn the_call_camera_takes_a_mode_that_keeps_its_rate() {
        // 720p at 30 fps: raw 720p only does 10, so MJPEG 720p.
        assert_eq!(pick(30.0, 1280, 720), Some((true, 1280, 720, 30)));
        // 360p at 30 fps: raw keeps up, and raw needs no decode.
        assert_eq!(pick(30.0, 640, 360), Some((false, 640, 360, 30)));
        // The settings preview: the smallest mode covering 320x180 at 15 fps.
        assert_eq!(pick(15.0, 320, 180), Some((false, 320, 180, 30)));
        // No cap (the source preset): the largest size that still keeps 30 fps.
        assert_eq!(pick(30.0, 0, 0), Some((true, 1920, 1080, 30)));
        // Asked for more than the camera has: the fastest it can do.
        assert_eq!(pick(60.0, 1280, 720), Some((true, 1280, 720, 30)));
    }

    #[test]
    fn a_camera_without_a_fast_mode_gets_its_fastest_one() {
        gst::init().unwrap();
        let slow = "video/x-raw, width=1920, height=1080, framerate=5/1; \
            video/x-raw, width=1280, height=720, framerate=10/1"
            .parse::<gst::Caps>()
            .unwrap();
        let options = CaptureOptions {
            fps: 30.0,
            max_width: 1920,
            max_height: 1080,
        };
        let mode = pick_mode(&camera_modes(&slow), &options).unwrap();
        assert_eq!((mode.width, mode.fps.numer()), (1280, 10));
        assert_eq!(pick_mode(&[], &options), None);
    }

    #[test]
    fn gstreamer_init_is_safe_to_repeat_after_any_init() {
        if gst::init().is_err() {
            return;
        }
        assert!(init_gst().is_ok());
        assert!(init_gst().is_ok());
    }

    #[test]
    fn a_pipewire_v4l2_camera_resolves_to_its_video_node() {
        if gst::init().is_err() {
            eprintln!("no GStreamer runtime; skipping the V4L2 node proof");
            return;
        }
        let node = |s: gst::Structure| v4l2_node(&s);
        assert_eq!(
            node(
                gst::Structure::builder("props")
                    .field("api.v4l2.path", "/dev/video2")
                    .field("object.path", "v4l2:/dev/video2")
                    .build()
            ),
            Some("/dev/video2".to_string())
        );
        assert_eq!(
            node(
                gst::Structure::builder("props")
                    .field("object.path", "v4l2:/dev/video0")
                    .build()
            ),
            Some("/dev/video0".to_string()),
            "older PipeWire names the node only in object.path"
        );
        assert_eq!(
            node(
                gst::Structure::builder("props")
                    .field("object.path", "libcamera:\\_SB_.PCI0.I2C2")
                    .field("api.libcamera.path", "\\_SB_.PCI0.I2C2")
                    .build()
            ),
            None,
            "a libcamera camera stays on pipewiresrc"
        );
        assert_eq!(
            node(
                gst::Structure::builder("props")
                    .field("api.v4l2.path", "/etc/passwd")
                    .build()
            ),
            None
        );
        assert_eq!(node(gst::Structure::new_empty("props")), None);
    }

    #[test]
    fn a_pipewire_source_copies_frames_out_and_a_v4l2_source_is_left_alone() {
        if gst::init().is_err() {
            eprintln!("no GStreamer runtime; skipping the pipewiresrc copy proof");
            return;
        }
        if let Ok(pw) = gst::ElementFactory::make("pipewiresrc").build() {
            if pw.find_property("always-copy").is_some() {
                pw.set_property("always-copy", false);
                copy_out_of_pipewire(&pw);
                assert!(pw.property::<bool>("always-copy"));
            }
        }
        let other = gst::ElementFactory::make("videotestsrc")
            .build()
            .expect("videotestsrc");
        copy_out_of_pipewire(&other);
    }

    /// A pinned mode is a capsfilter between the source and decodebin: a
    /// source that can produce the mode negotiates it and frames flow.
    #[test]
    fn a_pinned_mode_reaches_the_appsink() {
        if gst::init().is_err() {
            eprintln!("no GStreamer runtime; skipping the pinned-mode proof");
            return;
        }
        let source = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .build()
            .expect("videotestsrc");
        let mode = Mode {
            jpeg: false,
            width: 320,
            height: 180,
            fps: gst::Fraction::new(30, 1),
        };
        let (pipeline, sink) = play(build_pipeline(source, Some(&mode.caps())).unwrap()).unwrap();
        let sample = sink
            .try_pull_sample(gst::ClockTime::from_seconds(5))
            .expect("a sample");
        pipeline.set_state(gst::State::Null).ok();
        let info = VideoInfo::from_caps(sample.caps().unwrap()).unwrap();
        assert_eq!((info.width(), info.height()), (320, 180));
    }

    #[test]
    fn fit_keeps_aspect_and_even_sizes_within_the_cap() {
        assert_eq!(fit(1920, 1080, 1920, 1080), None);
        assert_eq!(fit(3840, 2160, 0, 0), None, "source preset: no cap");
        assert_eq!(fit(3840, 2160, 1920, 1080), Some((1920, 1080)));
        assert_eq!(fit(2560, 1600, 1280, 720), Some((1152, 720)));
    }

    #[test]
    fn a_greyscale_only_device_is_infrared() {
        gst::init().unwrap();
        let caps = |s: &str| s.parse::<gst::Caps>().unwrap();
        assert!(greyscale_only(&caps(
            "video/x-raw, format=GRAY8, width=640, height=360"
        )));
        assert!(greyscale_only(&caps(
            "video/x-raw, format={ GRAY8, GRAY16_LE }"
        )));
        assert!(!greyscale_only(&caps(
            "video/x-raw, format=YUY2; image/jpeg"
        )));
        assert!(!greyscale_only(&caps(
            "video/x-raw, format=GRAY8; video/x-raw, format=YUY2"
        )));
        assert!(!greyscale_only(&caps("image/jpeg")));
        assert!(!greyscale_only(&gst::Caps::new_any()));
        assert!(!greyscale_only(&gst::Caps::new_empty()));
    }

    #[test]
    fn infrared_sensors_list_after_colour_cameras() {
        let cam = |id: &str, infrared: bool| CameraDevice {
            id: id.into(),
            name: "Integrated_Webcam_FHD: Integrat".into(),
            infrared,
            index: 0,
        };
        let ids: Vec<String> = colour_first(vec![
            cam("/dev/video2", true),
            cam("/dev/video0", false),
            cam("/dev/video4", false),
        ])
        .into_iter()
        .map(|d| d.id)
        .collect();
        assert_eq!(ids, ["/dev/video0", "/dev/video4", "/dev/video2"]);
        assert_eq!(
            Target::Default.resolve_id(&colour_first(vec![
                cam("/dev/video2", true),
                cam("/dev/video0", false),
            ])),
            Some("/dev/video0".into()),
            "the default camera is never the infrared sensor"
        );
    }

    /// Device listing must not panic when there is no camera (CI), and any id
    /// it does report must round-trip back through `Target::parse`.
    #[test]
    fn listing_devices_is_safe_without_a_camera() {
        let devices = list_devices();
        for d in &devices {
            assert!(!d.id.is_empty());
            assert_eq!(Target::parse(&d.id), Ok(Target::Device(d.id.clone())));
        }
    }

    /// A required element the host lacks (a minimal install without the
    /// GStreamer plugin packages) makes support unavailable and is named, so
    /// the client can explain why no camera appears instead of showing an
    /// empty list.
    #[test]
    fn camera_support_names_a_missing_required_element() {
        assert_eq!(
            support_with(true, &|name| name != "decodebin"),
            CameraSupport {
                available: false,
                missing: vec!["decodebin".to_string()],
            }
        );
    }

    /// The capture picks `v4l2src` or `pipewiresrc` per device, so either
    /// source alone suffices: a V4L2-only host without PipeWire still captures.
    #[test]
    fn camera_support_is_available_without_pipewiresrc() {
        assert_eq!(
            support_with(true, &|name| name != "pipewiresrc"),
            CameraSupport {
                available: true,
                missing: Vec::new(),
            }
        );
    }

    /// A PipeWire-only host (Wayland, `gstreamer1.0-pipewire` but no V4L2) can
    /// still capture its PipeWire cameras, so a missing `v4l2src` alone must
    /// not report support as unavailable.
    #[test]
    fn camera_support_is_available_without_v4l2src() {
        assert_eq!(
            support_with(true, &|name| name != "v4l2src"),
            CameraSupport {
                available: true,
                missing: Vec::new(),
            }
        );
    }

    /// Neither source element present: no device can be opened, and both names
    /// are reported.
    #[test]
    fn camera_support_is_unavailable_without_a_source_element() {
        assert_eq!(
            support_with(true, &|name| name != "v4l2src" && name != "pipewiresrc"),
            CameraSupport {
                available: false,
                missing: vec!["v4l2src".to_string(), "pipewiresrc".to_string()],
            }
        );
    }

    /// Every required element present: support is available.
    #[test]
    fn camera_support_is_available_when_the_required_elements_exist() {
        assert_eq!(
            support_with(true, &|_| true),
            CameraSupport {
                available: true,
                missing: Vec::new(),
            }
        );
    }

    /// GStreamer failing to initialise is also no camera support.
    #[test]
    fn camera_support_is_unavailable_without_gstreamer() {
        assert!(!support_with(false, &|_| true).available);
    }
}
