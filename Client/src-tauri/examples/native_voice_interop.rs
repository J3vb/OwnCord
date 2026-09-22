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
        process_threads, shared_key_material, Event, NativeSession,
    };

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
                    Some(_) => {}
                    None => break,
                },
            }
        }
        sine.abort();
        for m in meters {
            m.abort();
        }
        emit(
            serde_json::json!({ "event": { "type": "resources", "resources": session.resources() } }),
        );
        session.close().await;
        emit(serde_json::json!({ "event": { "type": "closed", "threads": process_threads() } }));
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
