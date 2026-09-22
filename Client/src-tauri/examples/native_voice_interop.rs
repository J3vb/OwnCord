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
//! `--video WxH` also publishes a camera the way the app does: moving bars
//! (a synthetic source: CI has no camera) uploaded as RGBA over the
//! session's frame socket, exactly the route the webview's camera takes. It
//! reads every subscribed remote video track back through that socket and
//! reports decoded frames per second, and it checks the socket itself: a
//! wrong token is refused, and after close the listener is gone.
//! `--camera-cycles N` (with `--video`) first turns the camera off and on
//! N times the way the app does (unpublish, publish), printing the thread
//! count before and after: each publish is a new frame cryptor.
//! `--external-camera` (with `--video`) publishes the camera but leaves its
//! frames to someone else: it prints the frame socket's URL, token included,
//! so a webview harness can run the app's own renderer and camera pump
//! against this session (the CPU measurement in docs/architecture/voice-e2ee.md).
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
    use owncord_client_lib::native_voice::session::{
        process_threads, shared_key_material, CameraOptions, Event, NativeSession,
    };
    use tokio_tungstenite::tungstenite::Message;

    const SAMPLE_RATE: u32 = 48_000;
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

    /// Upload moving bars as the camera over the frame socket, the way
    /// `cameraUplink.ts` uploads an RGBA `VideoFrame` (format 1), until the
    /// socket closes or the task is aborted.
    async fn play_bars(camera_url: String, width: u32, height: u32) {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&camera_url).await else {
            emit(
                serde_json::json!({ "event": { "type": "error", "detail": "camera upload refused" } }),
            );
            return;
        };
        let (w, h) = (width as usize, height as usize);
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        let mut n = 0usize;
        loop {
            ticker.tick().await;
            let mut frame = Vec::with_capacity(36 + w * h * 4);
            for v in [1, width, height, 0, width * 4, 0, 0, 0, 0] {
                frame.extend_from_slice(&v.to_le_bytes());
            }
            for y in 0..h {
                let shade = (((y + n * 4) / 16) % 2 * 200 + 30) as u8;
                for _ in 0..w {
                    frame.extend_from_slice(&[shade, 255 - shade, 128, 255]);
                }
            }
            n += 1;
            if futures_util::SinkExt::send(&mut ws, Message::Binary(frame.into()))
                .await
                .is_err()
            {
                return;
            }
        }
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
        let video: Option<(u32, u32)> = match arg("--video") {
            None => None,
            Some(v) => {
                let (w, h) = v.split_once('x').ok_or("--video WxH")?;
                Some((
                    w.parse().map_err(|_| "--video")?,
                    h.parse().map_err(|_| "--video")?,
                ))
            }
        };

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
        let devices = owncord_client_lib::native_voice::session::list_devices_transient();
        emit(
            serde_json::json!({ "event": { "type": "devices", "ok": devices.is_ok(), "detail": match &devices { Ok(d) => format!("{} in / {} out", d.inputs.len(), d.outputs.len()), Err(e) => e.clone() } } }),
        );

        let mut session =
            NativeSession::connect(&url, &token, shared_key_material(&key), sink()).await?;
        let mut room_events = session.subscribe_room_events();
        emit(
            serde_json::json!({ "event": { "type": "joined", "identity": session.local_identity() } }),
        );

        let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 1, 100);
        session
            .publish_audio(RtcAudioSource::Native(source.clone()))
            .await?;
        let sine = tokio::spawn(play_sine(source));

        let frames_url = session.frames_url().to_string();
        let mut bars = None;
        if let Some((width, height)) = video {
            session
                .publish_camera(CameraOptions {
                    width,
                    height,
                    max_bitrate: 1_700_000,
                    max_framerate: 30.0,
                    simulcast: false,
                })
                .await?;
            let camera_cycles: u32 = arg("--camera-cycles")
                .as_deref()
                .unwrap_or("0")
                .parse()
                .map_err(|_| "--camera-cycles")?;
            if camera_cycles > 0 {
                let options = CameraOptions {
                    width,
                    height,
                    max_bitrate: 1_700_000,
                    max_framerate: 30.0,
                    simulcast: false,
                };
                emit(
                    serde_json::json!({ "event": { "type": "threads", "phase": "camera-before", "count": process_threads() } }),
                );
                for _ in 0..camera_cycles {
                    session.unpublish_camera().await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    session.publish_camera(options).await?;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                emit(
                    serde_json::json!({ "event": { "type": "threads", "phase": "camera-after", "cycles": camera_cycles, "count": process_threads() } }),
                );
            }
            if std::env::args().any(|a| a == "--external-camera") {
                emit(serde_json::json!({ "event": { "type": "frames", "url": frames_url } }));
            } else {
                bars = Some(tokio::spawn(play_bars(
                    format!("{frames_url}/camera"),
                    width,
                    height,
                )));
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

        if mute_cycles > 0 {
            emit(
                serde_json::json!({ "event": { "type": "threads", "phase": "mute-before", "count": process_threads() } }),
            );
            for _ in 0..mute_cycles {
                session.set_microphone(false).await?;
                tokio::time::sleep(Duration::from_millis(50)).await;
                session.set_microphone(true).await?;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            emit(
                serde_json::json!({ "event": { "type": "threads", "phase": "mute-after", "cycles": mute_cycles, "count": process_threads() } }),
            );
        }

        let mut meters = Vec::new();
        let deadline = tokio::time::sleep(Duration::from_secs(secs));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                ev = room_events.recv() => match ev {
                    Some(RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), participant, .. }) => {
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
        if let Some(bars) = bars {
            bars.abort();
        }
        session.close().await;
        emit(serde_json::json!({ "event": {
            "type": "closed",
            "threads": process_threads(),
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
