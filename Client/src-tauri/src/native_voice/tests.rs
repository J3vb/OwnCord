use super::*;

/// Proves both that the SDK version is readable and that a libwebrtc symbol
/// links and runs. If the prebuilt archive were missing or ABI-mismatched,
/// this binary would not link at all.
#[test]
fn build_info_reports_sdk_and_libwebrtc() {
    let info = native_voice_build_info();
    assert!(info.contains("livekit 0.10.0"), "unexpected: {info}");
    assert!(info.contains("libwebrtc-ok"), "unexpected: {info}");
}

#[test]
fn video_codecs_probe_runs() {
    // Either answer is valid for a build; the probe must not panic.
    let _ = probe_video_codecs();
    assert!(is_h264_mime("video/h264"));
    assert!(!is_h264_mime("video/VP8"));
    assert!(is_vp9_mime("video/vp9"));
    assert!(!is_vp9_mime("video/VP8"));
}

#[test]
fn decode_names_lowercase_dedupe_and_drop_support_entries() {
    let mimes = [
        "video/VP8",
        "video/H264",
        "video/H264",
        "video/VP9",
        "video/rtx",
        "video/red",
        "video/ulpfec",
        "video/flexfec-03",
        "video/AV1",
    ];
    assert_eq!(
        decode_names(mimes.into_iter()),
        vec!["vp8", "h264", "vp9", "av1"]
    );
    assert!(decode_names(std::iter::empty()).is_empty());
    assert_eq!(decode_codec_name("video"), None);
}

#[test]
fn wipe_zeroes_before_dropping() {
    let mut key = Some(vec![7u8; 4]);
    wipe(&mut key);
    assert!(key.is_none());
}

#[test]
fn key_after_connect_applies_a_rotation_and_rejects_supersession() {
    let mut inner = Inner {
        key: Some(vec![1]),
        session: None,
        standalone: None,
        standalone_generation: 0,
        next_id: 3,
        ..Default::default()
    };
    assert_eq!(inner.key_after_connect(3, &[1]), Ok(None));
    inner.key = Some(vec![2]);
    assert_eq!(inner.key_after_connect(3, &[1]), Ok(Some(vec![2])));
    assert!(inner.key_after_connect(2, &[1]).is_err());
    inner.key = None;
    assert!(inner.key_after_connect(3, &[1]).is_err());
}

#[test]
fn a_staged_key_waits_in_its_slot_until_sending_switches() {
    let mut inner = Inner::default();
    // The first key is sent with at once, whatever it asks.
    assert!(!inner.install_key(vec![1], 0, true));
    assert_eq!((inner.key.clone(), inner.key_slot), (Some(vec![1]), 0));

    assert!(inner.install_key(vec![2], 1, true));
    assert_eq!(inner.key, Some(vec![1]), "staging keeps the sending key");
    assert_eq!(inner.staged, Some((1, vec![2])));

    assert!(inner.use_key_slot(1));
    assert_eq!((inner.key.clone(), inner.key_slot), (Some(vec![2]), 1));
    assert_eq!(
        inner.staged,
        Some((0, vec![1])),
        "the old key stays for frames in flight"
    );

    // Staging into the slot being sent on is a send-at-once.
    assert!(!inner.install_key(vec![3], 1, true));
    assert_eq!((inner.key.clone(), inner.key_slot), (Some(vec![3]), 1));
}

#[test]
fn switching_to_an_empty_slot_is_refused_and_leave_clears_every_key() {
    let mut inner = Inner::default();
    inner.install_key(vec![1], 0, false);
    assert!(!inner.use_key_slot(1));
    assert_eq!((inner.key.clone(), inner.key_slot), (Some(vec![1]), 0));

    inner.install_key(vec![2], 1, true);
    // A key used at once in the staged slot replaces the staged one.
    inner.install_key(vec![3], 1, false);
    assert_eq!(inner.staged, None);
    assert_eq!((inner.key.clone(), inner.key_slot), (Some(vec![3]), 1));

    inner.install_key(vec![4], 0, true);
    inner.clear_keys();
    assert_eq!(
        (inner.key.clone(), inner.staged.clone(), inner.key_slot),
        (None, None, 0)
    );
}

#[test]
fn key_slots_outside_the_ring_are_refused() {
    assert_eq!(key_slot(None), Ok(0));
    assert_eq!(key_slot(Some(1)), Ok(1));
    assert!(key_slot(Some(2)).is_err());
    assert!(key_slot(Some(-1)).is_err());
}

#[test]
fn stale_session_ids_are_rejected() {
    let mut inner = Inner::default();
    assert!(inner.current(1).is_err());
    assert_eq!(inner.resources().rooms, 0);
}

#[test]
fn a_superseded_camera_preview_start_does_not_claim_the_slot() {
    let mut inner = Inner::default();
    let older = inner.begin_standalone();
    let newer = inner.begin_standalone();
    // The older start finishes last: it must not claim the slot the newer
    // start owns.
    assert!(!inner.standalone_is_latest(older));
    assert!(inner.standalone_is_latest(newer));
    // A stop while a start is in flight supersedes it too.
    inner.clear_standalone();
    assert!(!inner.standalone_is_latest(newer));
}

/// A double start: the older one is superseded and drops its own test.
#[test]
fn a_second_mic_test_start_supersedes_the_first() {
    let mut inner = Inner::default();
    let (_, older, seen) = inner.begin_mic_test().unwrap();
    let (_, newer, _) = inner.begin_mic_test().unwrap();
    assert_ne!(older, newer);
    assert_eq!(
        inner.admit_mic_test(older, seen),
        Err("mic test superseded".to_string())
    );
    assert_eq!(inner.admit_mic_test(newer, seen), Ok(()));
}

#[test]
fn stopping_a_mic_test_supersedes_its_start_and_ignores_stale_ids() {
    let mut inner = Inner::default();
    let (_, older, seen) = inner.begin_mic_test().unwrap();
    let (_, current, _) = inner.begin_mic_test().unwrap();
    assert!(inner.stop_mic_test(older).is_none());
    assert_eq!(
        inner.admit_mic_test(current, seen),
        Ok(()),
        "a stale stop leaves the current start admitted"
    );
    assert!(inner.stop_mic_test(current).is_none(), "nothing stored yet");
    assert!(inner.admit_mic_test(current, seen).is_err());
}

#[test]
fn a_connect_ends_the_mic_test_and_refuses_one_still_starting() {
    let mut inner = Inner::default();
    let (_, id, seen) = inner.begin_mic_test().unwrap();
    // What `native_voice_connect` does under its first lock hold.
    assert!(inner.take_mic_test().is_none());
    inner.next_id += 1;
    assert_eq!(
        inner.admit_mic_test(id, seen),
        Err(MIC_TEST_IN_CALL.to_string())
    );
}

#[test]
fn a_start_between_the_two_connect_locks_is_refused() {
    let mut inner = Inner::default();
    // First lock hold of `native_voice_connect`.
    assert!(inner.take_mic_test().is_none());
    inner.next_id += 1;
    // A start that begins after it sees the bumped connect count, so
    // only the second take can refuse it.
    let (_, id, seen) = inner.begin_mic_test().unwrap();
    assert!(inner.take_mic_test().is_none());
    assert!(inner.admit_mic_test(id, seen).is_err());
}

#[test]
fn a_mic_test_cannot_start_during_a_call() {
    assert!(mic_test_blocked(true));
    assert!(!mic_test_blocked(false));
    let mut inner = Inner::default();
    assert!(!inner.mic_test_blocked());
    assert!(inner.begin_mic_test().is_ok());
}

fn idle_test(monitor: bool) -> MicTest {
    let audio = session::AudioOptions {
        echo_cancellation: false,
        noise_suppression: false,
        auto_gain_control: false,
        enhanced_noise_suppression: false,
    };
    MicTest::idle_for_test(audio, monitor, tokio::spawn(async {}))
}

/// The meter's monitor holds the test slot: a test start takes it over, a
/// stop of the old id is stale, and a connect takes it out.
#[tokio::test]
async fn a_mic_test_start_replaces_a_running_monitor_and_a_connect_ends_it() {
    let mut inner = Inner::default();
    let (_, monitor_id, seen) = inner.begin_mic_test().unwrap();
    inner.admit_mic_test(monitor_id, seen).unwrap();
    inner.mic_test = Some((monitor_id, idle_test(true)));
    let (replaced, test_id, seen) = inner.begin_mic_test().unwrap();
    assert_eq!(replaced.map(|(id, _)| id), Some(monitor_id));
    assert!(inner.stop_mic_test(monitor_id).is_none(), "stale id");
    inner.admit_mic_test(test_id, seen).unwrap();
    inner.mic_test = Some((test_id, idle_test(false)));
    let ended = inner.take_mic_test();
    assert_eq!(ended.map(|(id, _)| id), Some(test_id));
    assert!(inner.mic_test.is_none());
}

/// A monitor that finishes opening after a call joined must not claim
/// the slot: the call's capture owns the device.
#[test]
fn a_monitor_that_finishes_after_a_connect_is_refused() {
    let mut inner = Inner::default();
    let (_, id, seen) = inner.begin_mic_test().unwrap();
    inner.next_id += 1;
    assert_eq!(
        inner.admit_mic_test(id, seen),
        Err(MIC_TEST_IN_CALL.to_string())
    );
}

/// A stop supersedes a preview start still in flight, so the late start
/// releases its own capture instead of claiming the slot.
#[test]
fn a_preview_stop_supersedes_a_start_in_flight() {
    let mut inner = Inner::default();
    let generation = inner.begin_standalone();
    assert!(inner.clear_standalone().is_none());
    assert!(!inner.standalone_is_latest(generation));
    let replacement = inner.begin_standalone();
    assert!(inner.standalone_is_latest(replacement));
}

/// Releasing waits for the drop, which runs on a blocking thread and not on
/// the async worker that awaits it.
#[tokio::test]
async fn release_blocking_drops_off_the_async_worker() {
    struct Probe(std::sync::mpsc::Sender<std::thread::ThreadId>);
    impl Drop for Probe {
        fn drop(&mut self) {
            let _ = self.0.send(std::thread::current().id());
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::current().id();
    release_blocking(Probe(tx)).await;
    let dropped_on = rx.try_recv().expect("dropped before the await returned");
    assert_ne!(dropped_on, worker);
}

/// Nothing retired releases at once.
#[tokio::test]
async fn an_empty_retired_releases_without_waiting() {
    let retired = Retired::default();
    assert!(retired.is_empty());
    retired.release().await;
}

/// A command-shaped sequence: the stop holds the gate through a release that
/// stays blocked until the test lets it go, other async work keeps running,
/// and a start queued behind the stop begins only after the old capture is
/// gone. No clock is involved: the test releases the blocked drop itself.
#[tokio::test(flavor = "current_thread")]
async fn a_start_behind_a_stop_waits_for_the_release_and_the_worker_stays_free() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    struct Held {
        go: std::sync::mpsc::Receiver<()>,
        released: Arc<AtomicBool>,
    }
    impl Drop for Held {
        fn drop(&mut self) {
            let _ = self.go.recv();
            self.released.store(true, Ordering::SeqCst);
        }
    }
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    let released = Arc::new(AtomicBool::new(false));
    let (go_tx, go_rx) = std::sync::mpsc::channel();
    let held = Held {
        go: go_rx,
        released: released.clone(),
    };
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let stop = {
        let gate = gate.clone();
        tokio::spawn(async move {
            let _gate = gate.lock().await;
            let _ = entered_tx.send(());
            release_blocking(held).await;
        })
    };
    entered_rx.await.unwrap();
    let start = {
        let (gate, released) = (gate.clone(), released.clone());
        tokio::spawn(async move {
            let _gate = gate.lock().await;
            released.load(Ordering::SeqCst)
        })
    };
    // The blocked release holds a blocking thread, not this worker: it keeps
    // scheduling, and the queued start has not run.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!start.is_finished());
    assert!(!released.load(Ordering::SeqCst));
    go_tx.send(()).unwrap();
    stop.await.unwrap();
    assert!(start.await.unwrap(), "the start ran after the release");
}
