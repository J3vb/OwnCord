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

/// Capture threads alive, for the debug surface: it drops to zero only once
/// every camera pipeline has been torn down.
static CAPTURES: AtomicUsize = AtomicUsize::new(0);

pub fn active_captures() -> usize {
    CAPTURES.load(Ordering::Relaxed)
}

/// The error a camera reports when it fails before the first frame.
pub const FAILED: &str = "camera capture failed to start";

/// The error a camera reports when no first frame arrives in time.
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
    #[serde(skip)]
    pub index: u16,
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

/// Enumerate the `Video/Source` devices GStreamer knows: V4L2 cameras and
/// PipeWire virtual cameras. Blocking (the monitor starts a discovery pass).
pub fn list_devices() -> Vec<CameraDevice> {
    // The monitor needs GStreamer initialised; a failure just means no list.
    if gst::init().is_err() {
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
    devices
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
                index: i as u16,
            })
        })
        .collect()
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
    preview: Arc<Preview>,
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
            preview: Arc::new(watch::channel(None).0),
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
        self.shared.preview.clone()
    }

    pub fn set_source(&self, source: Option<NativeVideoSource>) {
        *self.shared.source.lock().unwrap_or_else(|p| p.into_inner()) = source;
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
    },
    Synthetic {
        width: u32,
        height: u32,
        n: usize,
    },
}

impl Producer {
    fn new(target: &Target) -> Result<Self, String> {
        match target {
            Target::Synthetic { width, height } => Ok(Self::Synthetic {
                width: *width,
                height: *height,
                n: 0,
            }),
            Target::Device(id) => Self::device(id),
            Target::Default => {
                let id = list_devices()
                    .into_iter()
                    .next()
                    .map(|d| d.id)
                    .ok_or_else(|| NO_DEVICE.to_string())?;
                Self::device(&id)
            }
        }
    }

    fn device(id: &str) -> Result<Self, String> {
        let source = device_source(id)?;
        let (pipeline, sink) = build_pipeline(source)?;
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("camera pipeline: {e}"))?;
        Ok(Self::Device { pipeline, sink })
    }

    fn grab(&mut self) -> Grab {
        match self {
            Self::Device { pipeline, sink } => {
                // A device unplugged mid-capture ends the stream: the pipeline
                // posts an error or EOS on its bus. Report it so capture stops
                // (and, once started, the caller is told via `on_end`).
                if let Some(bus) = pipeline.bus() {
                    while let Some(msg) = bus.pop() {
                        if matches!(
                            msg.view(),
                            gst::MessageView::Error(_) | gst::MessageView::Eos(_)
                        ) {
                            return Grab::Failed;
                        }
                    }
                }
                match sink.try_pull_sample(gst::ClockTime::ZERO) {
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

/// The source element for a device id: the monitor's own element when the id
/// round-trips (V4L2 and PipeWire), else a `v4l2src`/`pipewiresrc` by path.
fn device_source(id: &str) -> Result<gst::Element, String> {
    if let Some(element) = monitor_element(id) {
        return Ok(element);
    }
    let (factory, prop) = if id.starts_with('/') {
        ("v4l2src", "device")
    } else {
        ("pipewiresrc", "path")
    };
    gst::ElementFactory::make(factory)
        .property(prop, id)
        .build()
        .map_err(|_| format!("{NO_DEVICE}: {id}"))
}

/// Re-find the monitored device with this id and let it build its element; the
/// monitor knows which backend (V4L2, PipeWire) the id belongs to.
fn monitor_element(id: &str) -> Option<gst::Element> {
    if gst::init().is_err() {
        return None;
    }
    let monitor = gst::DeviceMonitor::new();
    monitor.add_filter(Some("Video/Source"), None)?;
    monitor.start().ok()?;
    let found = monitor
        .devices()
        .iter()
        .find(|d| device_id(d).as_deref() == Some(id))
        .and_then(|d| d.create_element(None).ok());
    monitor.stop();
    found
}

/// `source ! decodebin ! videoconvert ! videoscale ! I420 ! appsink`, linked
/// once GStreamer (re)exposes a decoded pad.
fn build_pipeline(source: gst::Element) -> Result<(gst::Pipeline, AppSink), String> {
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
    source
        .link(&decode)
        .map_err(|e| format!("camera pipeline: {e}"))?;
    Ok((pipeline, sink))
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
    let mut producer = match Producer::new(&target) {
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
            preview: Arc::new(watch::channel(None).0),
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

    /// A synthetic camera drives the capture loop, previews, publishes to a
    /// `NativeVideoSource`, and releases the thread and pipeline on drop.
    #[test]
    fn a_synthetic_camera_starts_previews_and_stops_cleanly() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
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
        let (pipeline, sink) = build_pipeline(source).expect("pipeline");
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

    #[test]
    fn fit_keeps_aspect_and_even_sizes_within_the_cap() {
        assert_eq!(fit(1920, 1080, 1920, 1080), None);
        assert_eq!(fit(3840, 2160, 0, 0), None, "source preset: no cap");
        assert_eq!(fit(3840, 2160, 1920, 1080), Some((1920, 1080)));
        assert_eq!(fit(2560, 1600, 1280, 720), Some((1152, 720)));
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
}
