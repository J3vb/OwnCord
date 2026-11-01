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
