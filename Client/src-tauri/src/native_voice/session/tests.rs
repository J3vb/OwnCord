use super::events::{mic_allowed, track_info};
use super::*;
use livekit::e2ee::key_provider::KeyDerivationAlgorithm;
use livekit::options::{DegradationPreference, TrackPublishOptions, VideoCodec};
use livekit_protocol as proto;

#[test]
fn room_options_enable_dynacast_and_gcm_e2ee() {
    let key_provider = KeyProvider::with_shared_key(key_provider_options(), vec![7; 32]);
    let options = room_options(key_provider.clone());
    assert!(options.dynacast);
    #[allow(deprecated)]
    let e2ee = options.e2ee;
    let e2ee = e2ee.expect("e2ee is configured");
    assert!(matches!(e2ee.encryption_type, EncryptionType::Gcm));
}

#[test]
fn retire_keeps_every_generation_a_follower_still_holds() {
    let mut retired = Vec::new();
    let first = Arc::new(1);
    let held_by_lagging_callback = first.clone();
    retire(&mut retired, Some(first));
    retire(&mut retired, Some(Arc::new(2)));
    assert_eq!(retired.len(), 2, "the first generation is still held");
    drop(held_by_lagging_callback);
    retire(&mut retired, None);
    assert!(retired.is_empty(), "unheld generations are freed here");
}

fn permission(can_publish: bool, sources: &[proto::TrackSource]) -> proto::ParticipantPermission {
    proto::ParticipantPermission {
        can_publish,
        can_publish_sources: sources.iter().map(|s| *s as i32).collect(),
        ..Default::default()
    }
}

fn screen(simulcast: bool) -> ScreenOptions {
    ScreenOptions {
        width: 1920,
        height: 1080,
        max_bitrate: 6_000_000,
        max_framerate: 30.0,
        simulcast,
        codec: PublishCodec::default(),
    }
}

#[test]
fn screen_share_simulcasts_with_a_text_friendly_720p_layer() {
    let opts = screen_publish_options(&screen(true));
    assert_eq!(opts.source, TrackSource::Screenshare);
    assert!(opts.simulcast);
    let encoding = opts.video_encoding.expect("top layer encoding");
    assert_eq!(encoding.max_bitrate, 6_000_000);
    assert_eq!(encoding.max_framerate, 30.0);
    let layers = opts.simulcast_layers.expect("custom simulcast layers");
    assert_eq!(layers.len(), 1);
    assert_eq!((layers[0].width, layers[0].height), (1280, 720));
    assert!(layers[0].encoding.max_bitrate <= 1_200_000);
    assert_eq!(layers[0].encoding.max_framerate, 15.0);
}

#[test]
fn screen_quality_is_refused_without_a_published_share() {
    let refused = |r: Result<(), QualityError>| matches!(r, Err(QualityError::Refused(_)));
    assert!(quality_gate(Some(4), true, false, 4).is_ok());
    // No capture, an unpublished one (a failed republish or a codec
    // switch in flight), or a stale id (a source change or stop came
    // first).
    assert!(refused(quality_gate(None, false, false, 4)));
    assert!(refused(quality_gate(Some(4), false, false, 4)));
    assert!(refused(quality_gate(Some(5), true, false, 4)));
    // A pending source change keeps the options it started with.
    assert!(refused(quality_gate(Some(4), true, true, 4)));
}

#[test]
fn a_quality_error_names_its_stage_for_the_webview() {
    let json = |e| serde_json::to_value(e).unwrap();
    assert_eq!(
        json(QualityError::Refused("x".into())),
        serde_json::json!({"stage": "refused", "message": "x"})
    );
    assert_eq!(
        json(QualityError::Publish("y".into())),
        serde_json::json!({"stage": "publish", "message": "y"})
    );
}

#[test]
fn screen_share_without_simulcast_is_one_layer() {
    let opts = screen_publish_options(&screen(false));
    assert!(!opts.simulcast);
    assert!(opts.simulcast_layers.is_none());
}

#[test]
fn every_screen_share_rate_keeps_its_frame_rate() {
    let mut opts = screen(false);
    for fps in [30.0, 60.0, 120.0] {
        opts.max_framerate = fps;
        assert_eq!(
            screen_publish_options(&opts).degradation_preference,
            Some(DegradationPreference::MaintainFramerate)
        );
    }
}

fn camera(height: u32, simulcast: bool) -> CameraOptions {
    CameraOptions {
        width: height * 16 / 9,
        height,
        max_bitrate: 4_000_000,
        max_framerate: 30.0,
        simulcast,
        codec: PublishCodec::default(),
    }
}

#[test]
fn camera_publish_options_carry_the_codec() {
    let mut opts = camera(720, false);
    assert_eq!(camera_publish_options(&opts).video_codec, VideoCodec::VP8);
    opts.codec = PublishCodec::H264;
    assert_eq!(camera_publish_options(&opts).video_codec, VideoCodec::H264);
}

#[test]
fn screen_publish_options_carry_the_codec() {
    let mut opts = screen(false);
    assert_eq!(screen_publish_options(&opts).video_codec, VideoCodec::VP8);
    opts.codec = PublishCodec::H264;
    assert_eq!(screen_publish_options(&opts).video_codec, VideoCodec::H264);
}

#[test]
fn vp9_publish_is_one_svc_layer_without_simulcast() {
    // Camera: a 1080p simulcast request, which would add two layers for
    // VP8, is one L1T3 encoding for VP9.
    let mut cam = camera(1080, true);
    cam.codec = PublishCodec::Vp9;
    let opts = camera_publish_options(&cam);
    assert_eq!(opts.video_codec, VideoCodec::VP9);
    assert_eq!(opts.scalability_mode.as_deref(), Some("L1T3"));
    assert!(!opts.simulcast);
    assert!(opts.simulcast_layers.is_none());

    // Screen share, the same.
    let mut share = screen(true);
    share.codec = PublishCodec::Vp9;
    let opts = screen_publish_options(&share);
    assert_eq!(opts.video_codec, VideoCodec::VP9);
    assert_eq!(opts.scalability_mode.as_deref(), Some("L1T3"));
    assert!(!opts.simulcast);
    assert!(opts.simulcast_layers.is_none());

    // VP8 and H.264 keep their simulcast and set no scalability mode.
    assert!(camera_publish_options(&camera(1080, true))
        .scalability_mode
        .is_none());
    assert!(screen_publish_options(&screen(true))
        .scalability_mode
        .is_none());
    assert!(PublishCodec::H264.svc().is_none());
}

#[test]
fn codec_defaults_to_vp8_when_absent() {
    let camera: CameraOptions = serde_json::from_str(
        r#"{"width":1280,"height":720,"maxBitrate":1,"maxFramerate":30.0,"simulcast":false}"#,
    )
    .expect("camera options without codec");
    assert_eq!(camera.codec, PublishCodec::Vp8);
    let screen: ScreenOptions = serde_json::from_str(
        r#"{"width":1280,"height":720,"maxBitrate":1,"maxFramerate":30.0,"simulcast":false}"#,
    )
    .expect("screen options without codec");
    assert_eq!(screen.codec, PublishCodec::Vp8);
    let h264: CameraOptions = serde_json::from_str(
        r#"{"width":1,"height":1,"maxBitrate":1,"maxFramerate":1.0,"simulcast":false,"codec":"h264"}"#,
    )
    .expect("camera options with h264");
    assert_eq!(h264.codec, PublishCodec::H264);
    let vp9: CameraOptions = serde_json::from_str(
        r#"{"width":1,"height":1,"maxBitrate":1,"maxFramerate":1.0,"simulcast":false,"codec":"vp9"}"#,
    )
    .expect("camera options with vp9");
    assert_eq!(vp9.codec, PublishCodec::Vp9);
}

#[test]
fn a_1080p_camera_gets_360p_and_720p_simulcast_layers() {
    let opts = camera_publish_options(&camera(1080, true));
    assert_eq!(opts.source, TrackSource::Camera);
    assert!(opts.simulcast);
    let layers = opts.simulcast_layers.expect("custom simulcast layers");
    let sizes: Vec<_> = layers.iter().map(|l| (l.width, l.height)).collect();
    assert_eq!(sizes, [(640, 360), (1280, 720)]);
}

#[test]
fn a_720p_camera_keeps_the_sdk_default_layers() {
    let opts = camera_publish_options(&camera(720, true));
    assert!(opts.simulcast);
    assert!(opts.simulcast_layers.is_none());
}

#[test]
fn a_camera_without_simulcast_has_no_layers() {
    assert!(camera_publish_options(&camera(1080, false))
        .simulcast_layers
        .is_none());
}

#[test]
fn mic_publish_options_carry_the_configured_bitrate() {
    let o = mic_publish_options(Some(96_000));
    assert!(matches!(o.source, TrackSource::Microphone));
    assert_eq!(o.audio_encoding.map(|e| e.max_bitrate), Some(96_000));
}

#[test]
fn mic_publish_options_keep_the_sdk_default_without_a_bitrate() {
    assert!(mic_publish_options(None).audio_encoding.is_none());
}

#[test]
fn permission_event_serializes_for_the_webview() {
    let json = serde_json::to_string(&permission_event(&permission(
        true,
        &[proto::TrackSource::Microphone, proto::TrackSource::Camera],
    )))
    .unwrap();
    assert_eq!(
        json,
        r#"{"type":"permission","canPublish":true,"canPublishSources":[2,1]}"#
    );
}

#[test]
fn permission_event_carries_a_full_denial() {
    let json = serde_json::to_string(&permission_event(&permission(false, &[]))).unwrap();
    assert_eq!(
        json,
        r#"{"type":"permission","canPublish":false,"canPublishSources":[]}"#
    );
}

#[test]
fn mic_revoked_when_sources_exclude_microphone() {
    assert!(!mic_allowed(&permission(
        true,
        &[proto::TrackSource::Camera]
    )));
    assert!(!mic_allowed(&permission(false, &[])));
}

#[test]
fn only_a_gcm_or_custom_track_counts_as_encrypted() {
    assert!(!is_encrypted(EncryptionType::None));
    assert!(is_encrypted(EncryptionType::Gcm));
    assert!(is_encrypted(EncryptionType::Custom));
    let info = track_info(
        "TR_a".into(),
        TrackKind::Audio,
        TrackSource::Microphone,
        false,
        EncryptionType::None,
    );
    assert!(!info.encrypted);
}

#[test]
fn releasing_a_withdrawn_video_empties_only_its_own_slot() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    let mut slot = Some(VideoPublication::of_capture(sid("TR_a"), Some(7)));
    assert_eq!(release_slot(&mut slot, &sid("TR_b")), None);
    assert!(slot.is_some());
    assert_eq!(release_slot(&mut slot, &sid("TR_a")), Some(7));
    assert!(slot.is_none());
    let mut uncaptured = Some(VideoPublication::new(sid("TR_c")));
    assert_eq!(release_slot(&mut uncaptured, &sid("TR_c")), None);
    assert!(uncaptured.is_none());
}

#[test]
fn a_slot_poisoned_by_a_panic_still_republishes_and_releases() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    let slot: VideoSlot = Arc::new(Mutex::new(Some(VideoPublication::of_capture(
        sid("TR_a"),
        Some(7),
    ))));
    let held = Arc::clone(&slot);
    let _ = std::thread::spawn(move || {
        let _guard = lock(&held);
        panic!("a capture thread panics while it holds the slot");
    })
    .join();
    assert!(slot.is_poisoned());

    let orphan = apply_republish(
        &mut lock(&slot),
        TrackSource::Camera,
        &sid("TR_a"),
        &sid("TR_b"),
    );
    assert_eq!(orphan, None, "the republish lands in the poisoned slot");
    assert_eq!(release_slot(&mut lock(&slot), &sid("TR_b")), Some(7));
    assert!(lock(&slot).is_none());
}

#[test]
fn mic_allowed_when_sources_empty_or_listed() {
    assert!(mic_allowed(&permission(true, &[])));
    assert!(mic_allowed(&permission(
        true,
        &[proto::TrackSource::Microphone]
    )));
}

#[test]
fn failed_republish_keeps_the_withdrawal_pending() {
    let w = MicWithdrawn::default();
    w.keep_if_failed(true, &Ok::<(), String>(()));
    assert!(!w.take());
    w.keep_if_failed(false, &Err::<(), _>("denied".into()));
    assert!(!w.take());
    w.keep_if_failed(true, &Err::<(), _>("denied".into()));
    assert!(w.take());
}

#[test]
fn withdrawn_flag_is_consumed_once() {
    let w = MicWithdrawn::default();
    assert!(!w.take());
    w.set();
    assert!(w.take());
    assert!(!w.take());
}

/// The Windows client derives from the UTF-8 bytes of the base64 text
/// (`ExternalE2EEKeyProvider.setKey(string)`), never from the decoded key.
#[test]
fn key_material_is_the_base64_text_bytes() {
    let b64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    assert_eq!(shared_key_material(b64), b64.as_bytes());
    assert_ne!(
        shared_key_material(b64).len(),
        32,
        "must not be the decoded key"
    );
}

#[test]
fn key_index_is_zero_and_provider_matches_external_key_provider() {
    assert_eq!(KEY_INDEX, 0);
    let o = key_provider_options();
    assert_eq!(o.ratchet_window_size, 0);
    assert_eq!(o.failure_tolerance, -1);
    assert_eq!(o.ratchet_salt, b"LKFrameEncryptionKey");
    assert!(matches!(
        o.key_derivation_algorithm,
        KeyDerivationAlgorithm::PBKDF2
    ));
}

/// The audio thread's report sinks only queue: with the emitter not yet
/// run they return at once, past a full queue, and the emitter then
/// delivers what fit, in order.
#[tokio::test]
async fn capture_reports_queue_without_blocking_and_arrive_in_order() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let (on_gate, on_level, emitter) = capture_report_sinks(Arc::new(move |event| {
        lock(&sink).push(serde_json::to_string(&event).unwrap());
    }));
    on_gate(false);
    for _ in 0..CAPTURE_REPORT_QUEUE * 2 {
        on_level(0.5, false);
    }
    drop((on_gate, on_level));
    emitter.await.unwrap();
    let seen = lock(&seen);
    assert_eq!(seen.len(), CAPTURE_REPORT_QUEUE, "the overflow is dropped");
    assert_eq!(seen[0], r#"{"type":"voiceGate","open":false}"#);
    assert_eq!(seen[1], r#"{"type":"inputLevel","rms":0.5,"open":false}"#);
}

#[test]
fn events_serialize_with_a_type_tag() {
    let json = serde_json::to_string(&Event::ActiveSpeakers {
        identities: vec!["user-1".into()],
    })
    .unwrap();
    assert_eq!(json, r#"{"type":"activeSpeakers","identities":["user-1"]}"#);
    let json = serde_json::to_string(&Event::Disconnected {
        reason: "ClientInitiated".into(),
    })
    .unwrap();
    assert!(json.contains(r#""type":"disconnected""#));
    let json = serde_json::to_string(&Event::InputLevel {
        rms: 0.25,
        open: false,
    })
    .unwrap();
    assert_eq!(json, r#"{"type":"inputLevel","rms":0.25,"open":false}"#);
}

#[test]
fn video_qualities_are_the_web_names() {
    assert_eq!(video_quality("low"), Ok(VideoQuality::Low));
    assert_eq!(video_quality("medium"), Ok(VideoQuality::Medium));
    assert_eq!(video_quality("high"), Ok(VideoQuality::High));
    assert!(video_quality("off").is_err());
}

#[test]
fn device_kinds_are_the_web_names() {
    assert_eq!(DeviceKind::parse("audioinput"), Ok(DeviceKind::Input));
    assert_eq!(DeviceKind::parse("audiooutput"), Ok(DeviceKind::Output));
    assert!(DeviceKind::parse("videoinput").is_err());
}

#[test]
fn devices_serialize_camel_case() {
    let json = serde_json::to_string(&Devices {
        inputs: vec![DeviceInfo {
            id: "Mic".into(),
            name: "Mic".into(),
            index: 3,
        }],
        outputs: vec![],
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"inputs":[{"id":"Mic","name":"Mic"}],"outputs":[]}"#
    );
}

#[test]
fn unknown_device_ids_fall_back_to_the_default() {
    let device = |name: &str, index| DeviceInfo {
        id: name.into(),
        name: name.into(),
        index,
    };
    let listed = vec![
        device("USB Mic", 0),
        device("Built-in", 1),
        device("Built-in", 2),
    ];
    assert_eq!(resolve_device("Built-in", &listed), (Some(1), false));
    assert_eq!(resolve_device("", &listed), (Some(0), false));
    assert_eq!(resolve_device("unplugged", &listed), (Some(0), true));
    let shifted = vec![device("USB Mic", 0), device("Built-in", 3)];
    assert_eq!(resolve_device("Built-in", &shifted), (Some(3), false));
    assert_eq!(resolve_device("unplugged", &[]), (None, true));
    assert_eq!(resolve_device("", &[]), (None, false));
}

#[test]
fn camera_unpublish_follows_its_republished_sid() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    let mut camera = VideoPublication::new(sid("TR_a"));
    camera.republished(&sid("TR_mic"), sid("TR_mic2"));
    assert_eq!(camera.live, sid("TR_a"), "another track's republish");
    camera.republished(&sid("TR_a"), sid("TR_b"));
    camera.republished(&sid("TR_b"), sid("TR_c"));
    assert_eq!(camera.live, sid("TR_c"));
    assert_eq!(camera.issued, "TR_a", "the webview still names TR_a");
}

/// A disable can land while the SDK is between its unpublish of the old
/// sid and the dispatch of `LocalTrackRepublished` during a full
/// reconnect: `release_camera` empties the slot, then the event arrives
/// carrying a fresh publication sid nobody can drive. The slot must hand
/// that sid back so the forwarder unpublishes it — the alternative is a
/// camera published with no frames (frozen remote tiles) beside the next
/// one the webview enables.
#[test]
fn a_camera_republished_after_a_disable_is_orphaned_not_adopted() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    let mut slot = Some(VideoPublication::new(sid("TR_a")));
    // The disable arrives inside the await, before the republish event,
    // emptying the slot.
    assert!(slot.take().is_some());
    assert_eq!(
        apply_republish(&mut slot, TrackSource::Camera, &sid("TR_a"), &sid("TR_b")),
        Some(sid("TR_b")),
        "a republish with no live camera to continue must be unpublished"
    );
    assert!(slot.is_none(), "the orphan must not occupy the slot");

    // The later enable publishes one camera, and its own republish is
    // adopted rather than orphaned: exactly one camera remains.
    let mut slot = Some(VideoPublication::new(sid("TR_c")));
    assert_eq!(
        apply_republish(&mut slot, TrackSource::Camera, &sid("TR_c"), &sid("TR_d")),
        None
    );
    let live = slot.expect("the enabled camera stays published").live;
    assert_eq!(live, sid("TR_d"));
}

#[test]
fn a_republished_camera_replaced_under_its_old_sid_is_orphaned() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    // A newer camera owns the slot; the stale publication's republish
    // arrives with the old sid and must not be attached to it.
    let mut slot = Some(VideoPublication::new(sid("TR_new")));
    assert_eq!(
        apply_republish(
            &mut slot,
            TrackSource::Camera,
            &sid("TR_old"),
            &sid("TR_old2")
        ),
        Some(sid("TR_old2"))
    );
    assert_eq!(slot.unwrap().live, sid("TR_new"));
}

#[test]
fn screen_audio_publish_options_match_the_web_path() {
    let opts = screen_audio_publish_options();
    assert_eq!(opts.source, TrackSource::ScreenshareAudio);
    assert!(!opts.dtx);
    assert!(!opts.red);
    assert_eq!(
        opts.audio_encoding.map(|e| e.max_bitrate),
        Some(128_000),
        "musicHighQualityStereo"
    );
    assert!(opts.stereo, "the share audio asks the SFU for stereo opus");
}

#[test]
fn mic_and_video_publish_options_stay_mono() {
    // TF_STEREO would double the mic's bitrate and switch opus out of
    // VoIP mode; only the share audio asks for it.
    assert!(!TrackPublishOptions::default().stereo);
    assert!(!mic_publish_options(None).stereo);
    assert!(!mic_publish_options(Some(96_000)).stereo);
    assert!(!camera_publish_options(&camera(720, true)).stereo);
    assert!(!camera_publish_options(&camera(1080, false)).stereo);
    assert!(!screen_publish_options(&screen(true)).stereo);
    assert!(!screen_publish_options(&screen(false)).stereo);
}

#[test]
fn a_republished_share_audio_follows_its_new_sid() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    let mut slot = Some(VideoPublication::of_capture(sid("TR_a"), Some(3)));
    assert_eq!(
        apply_republish(
            &mut slot,
            TrackSource::ScreenshareAudio,
            &sid("TR_a"),
            &sid("TR_b")
        ),
        None
    );
    let audio = slot.expect("still published");
    assert_eq!(audio.live, sid("TR_b"));
    assert_eq!(audio.issued, "TR_a", "the webview still names TR_a");
    assert_eq!(audio.capture, Some(3));
}

#[test]
fn a_share_audio_republished_after_a_stop_is_orphaned() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    let mut slot: Option<VideoPublication> = None;
    assert_eq!(
        apply_republish(
            &mut slot,
            TrackSource::ScreenshareAudio,
            &sid("TR_a"),
            &sid("TR_b")
        ),
        Some(sid("TR_b"))
    );
    assert!(slot.is_none(), "the orphan must not occupy the slot");
}

#[test]
fn an_unencrypted_share_audio_republish_ends_the_share() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    let mut slot = Some(VideoPublication::of_capture(sid("TR_a"), Some(9)));
    assert_eq!(release_slot(&mut slot, &sid("TR_a")), Some(9));
    assert!(slot.is_none());
}

#[test]
fn a_non_camera_republish_is_never_orphaned() {
    let sid = |s: &str| TrackSid::try_from(s.to_string()).unwrap();
    // The microphone is tracked by the session, not the camera slot; an
    // empty slot must not make its republish look like a stray camera.
    let mut slot = None;
    assert_eq!(
        apply_republish(
            &mut slot,
            TrackSource::Microphone,
            &sid("TR_mic"),
            &sid("TR_mic2")
        ),
        None
    );
}

#[test]
fn process_threads_reads_procfs() {
    assert!(process_threads() >= 1);
}

fn audio(ec: bool, enhanced: bool) -> AudioOptions {
    AudioOptions {
        echo_cancellation: ec,
        noise_suppression: true,
        auto_gain_control: true,
        enhanced_noise_suppression: enhanced,
    }
}

/// A toggle that changes nothing must not replace the processing (and
/// reset the echo canceller's adaptation); an Enhanced Noise Suppression
/// change only switches the denoiser; any other change rebuilds it, and
/// before audio is enabled it is only remembered.
#[test]
fn set_audio_processing_rebuilds_only_on_a_change() {
    let on = audio(true, false);
    assert_eq!(
        processing_change(true, Some(on), on),
        ProcessingChange::Unchanged
    );
    assert_eq!(
        processing_change(true, Some(on), audio(false, false)),
        ProcessingChange::Rebuild
    );
    assert_eq!(
        processing_change(true, Some(on), audio(true, true)),
        ProcessingChange::Reroute
    );
    assert_eq!(
        processing_change(true, Some(on), audio(false, true)),
        ProcessingChange::Rebuild
    );
    assert_eq!(
        processing_change(false, None, on),
        ProcessingChange::Remember
    );
    assert_eq!(
        processing_change(false, Some(on), audio(false, false)),
        ProcessingChange::Remember
    );
}
