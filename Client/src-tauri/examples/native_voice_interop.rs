//! Interop peer for the native-voice E2EE test (Linux only).
//!
//! Joins a LiveKit room through the app's own `NativeSession` — the code the
//! Tauri commands run — with the room key the test hands it, publishes a
//! 440 Hz sine as its microphone (a synthetic source: CI has no sound
//! server), and reports the decoded audio it receives from every other
//! participant plus its E2EE state, as JSON lines on stdout. The browser
//! half (`Client/tests/e2e/native-voice/interop.spec.ts`) runs livekit-client
//! exactly as the Windows client does and asserts both directions decode
//! with the right key and stay silent with a wrong one.
//!
//!   native_voice_interop --url ws://127.0.0.1:7880 --token <jwt> \
//!       --key <base64 text> --secs 20 [--cycles N] [--mute-cycles N]
//!
//! `--cycles N` first connects and closes N throwaway sessions, printing the
//! process thread count before and after, which is the measurement for
//! rust-sdks #1408 (a leaked FrameCryptor thread per cryptor).
//! `--mute-cycles N` mutes and unmutes the published microphone N times the
//! way the app does, printing the thread count before and after: an in-place
//! mute creates no new cryptor, so the count must stay flat.
//! `--video WxH` also publishes a camera the way the app does: a synthetic
//! source (moving bars) captured through the native camera thread (CI has no
//! camera) and published as the camera track; the same pipeline a V4L2 or
//! PipeWire device drives. No webview uploads any more — the app captures
//! natively. It reads every subscribed remote video track back through the
//! frame socket and reports decoded frames per second, and it checks the
//! socket itself: a wrong token is refused, and after close the listener is
//! gone.
//! `--simulcast` (with `--video`) publishes that camera simulcast, as the app
//! does for every camera quality but "source".
//! `--camera-cycles N` (with `--video`) first turns the camera off and on
//! N times the way the app does (unpublish, stop capture, start capture,
//! publish), printing the thread count before and after: each publish is a
//! new frame cryptor. Each camera (the first included) is kept until a
//! subscriber acknowledges it with a data message on topic
//! `camera-subscribed` whose payload is the camera's sid (5 s at most, else
//! the example fails), so a peer must be subscribed and send that.
//! `--screen WxH` also shares the screen the way the app does, through the
//! same capture thread and publish, from a synthetic source (moving bars:
//! CI has no display, so neither the X11 capturer nor the Wayland portal
//! runs here). It reads the capture's local preview back through the frame
//! socket (reported as the `preview` identity).
//! `--screen-cycles N` (with `--screen`) first stops and restarts the share
//! N times, printing the thread and file-descriptor counts before and after
//! and checking that a stale stop leaves the live share alone.
//! `--volume G` sets every remote participant's volume to G the way the
//! per-user volume menu does, pulls the session's own playout mix at the
//! device cadence (CI has no sound device to play it on) and reports its RMS
//! once per second, next to the direct decode's `audio` events.
#[cfg(target_os = "linux")]
mod linux {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use futures_util::StreamExt;
    use livekit::prelude::*;
    use livekit::webrtc::audio_frame::AudioFrame;
    use livekit::webrtc::audio_source::native::NativeAudioSource;
    use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
    use livekit::webrtc::audio_stream::native::NativeAudioStream;
    use owncord_client_lib::native_voice::camera::{
        CaptureOptions as CameraCaptureOptions, Target as CameraTarget,
    };
    use owncord_client_lib::native_voice::playout::{Mixer, SAMPLE_RATE as PLAYOUT_RATE};
    use owncord_client_lib::native_voice::screen::{self, CaptureOptions, Target};
    use owncord_client_lib::native_voice::session::{
        process_threads, shared_key_material, CameraOptions, Event, NativeSession, ScreenOptions,
    };
    use tokio_tungstenite::tungstenite::Message;

    const SAMPLE_RATE: u32 = 48_000;
    /// How long a camera cycle waits for a subscriber to acknowledge the new camera.
    const CAMERA_SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(5);
    /// Data topic on which a subscriber acknowledges a camera by its sid.
    const CAMERA_ACK_TOPIC: &str = "camera-subscribed";
    const FRAME_MS: u64 = 10;
    const SINE_AMPLITUDE: f64 = 8000.0;

    fn arg(name: &str) -> Option<String> {
        let args: Vec<String> = std::env::args().collect();
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    }

    fn emit(json: serde_json::Value) {
        println!("{json}");
    }

    fn sink() -> Arc<dyn Fn(Event) + Send + Sync> {
        Arc::new(|event: Event| emit(serde_json::json!({ "event": event })))
    }

    /// Push a 440 Hz sine into `source` forever (the task is aborted on exit).
    async fn play_sine(source: NativeAudioSource) {
        let samples = (SAMPLE_RATE as u64 * FRAME_MS / 1000) as usize;
        let mut phase = 0.0f64;
        let step = 2.0 * std::f64::consts::PI * 440.0 / SAMPLE_RATE as f64;
        let mut ticker = tokio::time::interval(Duration::from_millis(FRAME_MS));
        loop {
            ticker.tick().await;
            let data: Vec<i16> = (0..samples)
                .map(|_| {
                    phase += step;
                    (phase.sin() * SINE_AMPLITUDE) as i16
                })
                .collect();
            let frame = AudioFrame {
                data: data.into(),
                sample_rate: SAMPLE_RATE,
                num_channels: 1,
                samples_per_channel: samples as u32,
            };
            if source.capture_frame(&frame).await.is_err() {
                return;
            }
        }
    }

    /// Decode one remote audio track and report its RMS once per second.
    async fn meter(identity: String, track: RemoteAudioTrack) {
        let mut stream = NativeAudioStream::new(track.rtc_track(), SAMPLE_RATE as i32, 1);
        let frames = Arc::new(AtomicU64::new(0));
        let mut sum_sq = 0.0f64;
        let mut count = 0u64;
        let mut last = tokio::time::Instant::now();
        while let Some(frame) = stream.next().await {
            for &s in frame.data.iter() {
                sum_sq += (s as f64) * (s as f64);
            }
            count += frame.data.len() as u64;
            frames.fetch_add(1, Ordering::Relaxed);
            if last.elapsed() >= Duration::from_secs(1) {
                let rms = if count == 0 {
                    0.0
                } else {
                    (sum_sq / count as f64).sqrt()
                };
                emit(serde_json::json!({
                    "event": { "type": "audio", "identity": identity, "frames": frames.load(Ordering::Relaxed), "rms": rms }
                }));
                sum_sq = 0.0;
                count = 0;
                last = tokio::time::Instant::now();
            }
        }
    }

    /// Pull the playout mix every 10 ms, as the output device would, and
    /// report its RMS once per second.
    async fn meter_playout(mixer: Arc<Mixer>) {
        let mut buf = vec![0.0f32; PLAYOUT_RATE as usize / 100];
        let mut ticker = tokio::time::interval(Duration::from_millis(10));
        let (mut sum_sq, mut count, mut ticks) = (0.0f64, 0u64, 0u32);
        loop {
            ticker.tick().await;
            mixer.mix(&mut buf, 1);
            // The same scale as the direct meter's i16 samples.
            sum_sq += buf
                .iter()
                .map(|&s| (s as f64 * 32768.0).powi(2))
                .sum::<f64>();
            count += buf.len() as u64;
            ticks += 1;
            if ticks == 100 {
                emit(serde_json::json!({
                    "event": { "type": "playout", "rms": (sum_sq / count as f64).sqrt() }
                }));
                (sum_sq, count, ticks) = (0.0, 0, 0);
            }
        }
    }

    /// Waits for a subscriber to acknowledge `camera_sid` on `CAMERA_ACK_TOPIC`.
    /// A subscriber that needs a negotiation of its own (the browser peer)
    /// must finish it before the camera it just subscribed to goes away:
    /// livekit-server answers the collision (its PeerConnection drops a
    /// sender while the subscriber's offer is being applied) with a full
    /// reconnect of that subscriber, and the browser then never sees the
    /// final camera. The server's own "subscribed" event precedes that offer,
    /// so the subscriber acknowledges once its track is attached, which is
    /// after the negotiation. Other events are kept for the main loop in `run`.
    async fn await_camera_bound(
        room_events: &mut tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
        pending_events: &mut std::collections::VecDeque<RoomEvent>,
        camera_sid: &str,
    ) -> Result<(), String> {
        let acked = tokio::time::timeout(CAMERA_SUBSCRIBE_TIMEOUT, async {
            loop {
                match room_events.recv().await {
                    Some(RoomEvent::DataReceived { payload, topic, .. })
                        if topic.as_deref() == Some(CAMERA_ACK_TOPIC)
                            && payload.as_slice() == camera_sid.as_bytes() =>
                    {
                        return true
                    }
                    Some(ev) => pending_events.push_back(ev),
                    None => return false,
                }
            }
        })
        .await;
        if acked != Ok(true) {
            return Err(format!(
                "no subscriber acknowledged camera {camera_sid} within {CAMERA_SUBSCRIBE_TIMEOUT:?}"
            ));
        }
        Ok(())
    }

    /// Start a synthetic native camera capture and publish it, as the app's
    /// `native_voice_start_camera` then `native_voice_publish_camera` do.
    /// Returns the capture id and the publication sid.
    async fn start_camera(
        session: &mut NativeSession,
        width: u32,
        height: u32,
        simulcast: bool,
    ) -> Result<(u64, String), String> {
        let (capture, started) = session
            .start_camera(
                CameraTarget::Synthetic { width, height },
                CameraCaptureOptions {
                    fps: 30.0,
                    max_width: 0,
                    max_height: 0,
                },
            )
            .await?;
        let (w, h) = started.await.map_err(|_| "camera capture dropped")??;
        let sid = session
            .publish_camera(
                capture,
                CameraOptions {
                    width: w,
                    height: h,
                    max_bitrate: 1_700_000,
                    max_framerate: 30.0,
                    simulcast,
                },
            )
            .await?;
        Ok((capture, sid))
    }

    /// Read one remote video track back through the frame socket and report
    /// frames per second and the last frame's size.
    async fn watch(identity: String, url: String) {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&url).await else {
            emit(
                serde_json::json!({ "event": { "type": "error", "detail": "remote video socket refused" } }),
            );
            return;
        };
        // Proves the socket opened even when no frame ever decodes (wrong key).
        emit(serde_json::json!({ "event": { "type": "videoWatch", "identity": identity } }));
        let (mut frames, mut size) = (0u64, (0u32, 0u32));
        let mut last = tokio::time::Instant::now();
        while let Some(Ok(msg)) = ws.next().await {
            let Message::Binary(data) = msg else { continue };
            // Ack each frame as the renderer does, or no next frame is sent.
            if futures_util::SinkExt::send(&mut ws, Message::Binary(Vec::new().into()))
                .await
                .is_err()
            {
                return;
            }
            if data.len() >= 8 {
                let at =
                    |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
                size = (at(0), at(4));
                frames += 1;
            }
            if last.elapsed() >= Duration::from_secs(1) {
                emit(serde_json::json!({
                    "event": { "type": "video", "identity": identity, "frames": frames, "width": size.0, "height": size.1 }
                }));
                frames = 0;
                last = tokio::time::Instant::now();
            }
        }
    }

    /// Open file descriptors: sockets, pipes and device handles a capture or
    /// sender could leak.
    fn open_fds() -> usize {
        std::fs::read_dir("/proc/self/fd").map_or(0, |d| d.count())
    }

    fn size_arg(name: &str) -> Result<Option<(u32, u32)>, String> {
        let Some(v) = arg(name) else { return Ok(None) };
        let bad = || format!("{name} WxH");
        let (w, h) = v.split_once('x').ok_or_else(bad)?;
        Ok(Some((
            w.parse().map_err(|_| bad())?,
            h.parse().map_err(|_| bad())?,
        )))
    }

    /// Start a synthetic screen capture and publish it, as the app's
    /// `native_voice_start_screen` then `native_voice_publish_screen` do.
    /// Returns the capture id.
    async fn share_screen(
        session: &mut NativeSession,
        width: u32,
        height: u32,
    ) -> Result<u64, String> {
        let (capture, started) = session
            .start_screen(
                Target::Synthetic { width, height },
                CaptureOptions {
                    fps: 15.0,
                    max_width: 1920,
                    max_height: 1080,
                },
            )
            .await?;
        let (w, h) = started.await.map_err(|_| "screen capture dropped")??;
        session
            .publish_screen(
                capture,
                ScreenOptions {
                    width: w,
                    height: h,
                    max_bitrate: 3_000_000,
                    max_framerate: 15.0,
                    simulcast: false,
                },
            )
            .await?;
        Ok(capture)
    }

    /// Whether a WebSocket handshake to `url` is refused.
    async fn refused(url: &str) -> bool {
        tokio_tungstenite::connect_async(url).await.is_err()
    }

    pub async fn run() -> Result<(), String> {
        let url = arg("--url").ok_or("--url required")?;
        let token = arg("--token").ok_or("--token required")?;
        let key = arg("--key").ok_or("--key required")?;
        let secs: u64 = arg("--secs")
            .as_deref()
            .unwrap_or("20")
            .parse()
            .map_err(|_| "--secs")?;
        let cycles: u32 = arg("--cycles")
            .as_deref()
            .unwrap_or("0")
            .parse()
            .map_err(|_| "--cycles")?;
        let mute_cycles: u32 = arg("--mute-cycles")
            .as_deref()
            .unwrap_or("0")
            .parse()
            .map_err(|_| "--mute-cycles")?;
        let volume: Option<f32> = arg("--volume")
            .map(|v| v.parse().map_err(|_| "--volume"))
            .transpose()?;
        let video = size_arg("--video")?;
        let screen_size = size_arg("--screen")?;
        let simulcast = std::env::args().any(|a| a == "--simulcast");

        if cycles > 0 {
            emit(
                serde_json::json!({ "event": { "type": "threads", "phase": "before", "count": process_threads() } }),
            );
            for _ in 0..cycles {
                let s = NativeSession::connect(
                    &url,
                    &token,
                    shared_key_material(&key),
                    Arc::new(|_| {}),
                )
                .await?;
                s.close().await;
            }
            // Give libwebrtc's teardown a moment before counting.
            tokio::time::sleep(Duration::from_millis(500)).await;
            emit(
                serde_json::json!({ "event": { "type": "threads", "phase": "after", "cycles": cycles, "count": process_threads() } }),
            );
        }

        // Device enumeration must be callable on a headless box: an error
        // (no sound server) is reported, never a crash.
        let devices = owncord_client_lib::native_voice::session::list_devices();
        emit(
            serde_json::json!({ "event": { "type": "devices", "ok": true, "detail": format!("{} in / {} out", devices.inputs.len(), devices.outputs.len()) } }),
        );

        let mut session =
            NativeSession::connect(&url, &token, shared_key_material(&key), sink()).await?;
        let mut room_events = session.subscribe_room_events();
        let mut pending_events = std::collections::VecDeque::new();
        emit(
            serde_json::json!({ "event": { "type": "joined", "identity": session.local_identity() } }),
        );

        let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 1, 100);
        session
            .publish_audio(RtcAudioSource::Native(source.clone()), None)
            .await?;
        let sine = tokio::spawn(play_sine(source));

        let frames_url = session.frames_url().to_string();
        if let Some((width, height)) = video {
            // A synthetic camera through the same capture thread and publish
            // the app uses (CI has no camera).
            let (mut capture, mut camera_sid) =
                start_camera(&mut session, width, height, simulcast).await?;
            let camera_cycles: u32 = arg("--camera-cycles")
                .as_deref()
                .unwrap_or("0")
                .parse()
                .map_err(|_| "--camera-cycles")?;
            if camera_cycles > 0 {
                // The first camera is subscribed too, and its subscriber
                // must be done negotiating before the first cycle removes
                // it. The wait also settles its sender threads into the
                // baseline.
                await_camera_bound(&mut room_events, &mut pending_events, &camera_sid).await?;
                emit(
                    serde_json::json!({ "event": { "type": "threads", "phase": "camera-before", "count": process_threads() } }),
                );
                for _ in 0..camera_cycles {
                    // Toggle as the app does: unpublish, stop the capture,
                    // start a fresh capture and publish it. A late unpublish
                    // of the replaced camera must leave the new one published.
                    session.unpublish_camera(&camera_sid).await;
                    session.stop_camera(capture).await;
                    let stale = camera_sid;
                    (capture, camera_sid) =
                        start_camera(&mut session, width, height, simulcast).await?;
                    session.unpublish_camera(&stale).await;
                    await_camera_bound(&mut room_events, &mut pending_events, &camera_sid).await?;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                emit(
                    serde_json::json!({ "event": { "type": "threads", "phase": "camera-after", "cycles": camera_cycles, "count": process_threads() } }),
                );
            }
            // The socket is loopback-only and refuses a path without the
            // session's token (the token is the last path segment of the base).
            let (base, token) = frames_url.rsplit_once('/').ok_or("frames url")?;
            let wrong: String = token.chars().rev().collect();
            emit(serde_json::json!({ "event": {
                "type": "frameSocket",
                "loopback": base.starts_with("ws://127.0.0.1:"),
                "wrongTokenRefused": refused(&format!("{base}/{wrong}/camera")).await,
                "noTokenRefused": refused(&format!("{base}/camera")).await,
            } }));
        }

        let mut preview = None;
        if let Some((width, height)) = screen_size {
            let mut capture = share_screen(&mut session, width, height).await?;
            let screen_cycles: u32 = arg("--screen-cycles")
                .as_deref()
                .unwrap_or("0")
                .parse()
                .map_err(|_| "--screen-cycles")?;
            if screen_cycles > 0 {
                emit(
                    serde_json::json!({ "event": { "type": "threads", "phase": "screen-before", "count": process_threads(), "fds": open_fds(), "captures": screen::active_captures() } }),
                );
                for _ in 0..screen_cycles {
                    session.stop_screen(capture).await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let stale = std::mem::replace(
                        &mut capture,
                        share_screen(&mut session, width, height).await?,
                    );
                    // A late stop of the replaced capture must leave the
                    // new one running and published.
                    session.stop_screen(stale).await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                emit(
                    serde_json::json!({ "event": { "type": "threads", "phase": "screen-after", "cycles": screen_cycles, "count": process_threads(), "fds": open_fds(), "captures": screen::active_captures() } }),
                );
            }
            preview = Some(tokio::spawn(watch(
                "preview".into(),
                format!("{frames_url}/screen"),
            )));
        }

        if mute_cycles > 0 {
            emit(
                serde_json::json!({ "event": { "type": "threads", "phase": "mute-before", "count": process_threads() } }),
            );
            for _ in 0..mute_cycles {
                session.set_microphone(false, None).await?;
                tokio::time::sleep(Duration::from_millis(50)).await;
                session.set_microphone(true, None).await?;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            emit(
                serde_json::json!({ "event": { "type": "threads", "phase": "mute-after", "cycles": mute_cycles, "count": process_threads() } }),
            );
        }

        let mut meters = Vec::new();
        if volume.is_some() {
            meters.push(tokio::spawn(meter_playout(session.playout_mixer())));
        }
        let deadline = tokio::time::sleep(Duration::from_secs(secs));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                ev = async {
                    match pending_events.pop_front() {
                        Some(ev) => Some(ev),
                        None => room_events.recv().await,
                    }
                } => match ev {
                    Some(RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), participant, .. }) => {
                        if let Some(v) = volume {
                            session.set_volume(participant.identity().as_str(), v);
                        }
                        meters.push(tokio::spawn(meter(participant.identity().to_string(), track)));
                    }
                    Some(RoomEvent::TrackSubscribed { track: RemoteTrack::Video(_), publication, participant }) => {
                        let url = format!("{frames_url}/remote/{}", publication.sid());
                        meters.push(tokio::spawn(watch(participant.identity().to_string(), url)));
                    }
                    Some(_) => {}
                    None => break,
                },
            }
        }
        sine.abort();
        emit(
            serde_json::json!({ "event": { "type": "resources", "resources": session.resources() } }),
        );
        for m in meters {
            m.abort();
        }
        if let Some(preview) = preview {
            preview.abort();
        }
        session.close().await;
        emit(serde_json::json!({ "event": {
            "type": "closed",
            "threads": process_threads(),
            "screenCaptures": screen::active_captures(),
            "cameraCaptures": owncord_client_lib::native_voice::camera::active_captures(),
            "frameSocketGone": refused(&format!("{frames_url}/camera")).await,
        } }));
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn main() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    if let Err(e) = rt.block_on(linux::run()) {
        eprintln!("native_voice_interop: {e}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("native_voice_interop is Linux-only");
}
