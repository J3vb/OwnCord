use super::*;

/// A stand-in host: counts what the pool builds and drops, and is alive
/// until `dead` is set.
struct FakeHost {
    dead: AtomicBool,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
}

impl Drop for FakeHost {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Counters {
    built: Arc<std::sync::atomic::AtomicUsize>,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
}

impl Counters {
    fn build(&self) -> Option<FakeHost> {
        self.built.fetch_add(1, Ordering::SeqCst);
        Some(FakeHost {
            dead: AtomicBool::new(false),
            dropped: self.dropped.clone(),
        })
    }
    fn built(&self) -> usize {
        self.built.load(Ordering::SeqCst)
    }
    fn dropped(&self) -> usize {
        self.dropped.load(Ordering::SeqCst)
    }
}

fn alive(h: &FakeHost) -> bool {
    !h.dead.load(Ordering::SeqCst)
}

#[test]
fn host_pool_builds_once_and_reuses_the_same_host() {
    let (pool, c) = (HostPool::<u8, FakeHost>::default(), Counters::default());
    let first = pool.live(1, || c.build(), alive).unwrap();
    let second = pool.live(1, || c.build(), alive).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(c.built(), 1);
    pool.live(2, || c.build(), alive).unwrap();
    assert_eq!(c.built(), 2, "another backend gets its own slot");
}

#[test]
fn host_pool_never_drops_a_live_host() {
    let (pool, c) = (HostPool::<u8, FakeHost>::default(), Counters::default());
    for _ in 0..20 {
        drop(pool.live(1, || c.build(), alive).unwrap());
    }
    assert_eq!((c.built(), c.dropped()), (1, 0));
}

#[test]
fn host_pool_rebuilds_a_dead_host_once_then_reuses_the_replacement() {
    let (pool, c) = (HostPool::<u8, FakeHost>::default(), Counters::default());
    let old = pool.live(1, || c.build(), alive).unwrap();
    old.dead.store(true, Ordering::SeqCst);
    let fresh = pool.live(1, || c.build(), alive).unwrap();
    assert!(!Arc::ptr_eq(&old, &fresh));
    assert!(Arc::ptr_eq(
        &fresh,
        &pool.live(1, || c.build(), alive).unwrap()
    ));
    assert_eq!(c.built(), 2);
    drop(old);
    assert_eq!(c.dropped(), 1, "only the dead host is released");
}

#[test]
fn host_pool_keeps_the_dead_host_when_the_rebuild_fails() {
    let pool = HostPool::<u8, FakeHost>::default();
    let c = Counters::default();
    let old = pool.live(1, || c.build(), alive).unwrap();
    old.dead.store(true, Ordering::SeqCst);
    assert!(pool.live(1, || None, alive).is_none());
    assert_eq!(c.dropped(), 0);
    assert!(pool.live(1, || c.build(), alive).is_some());
}

#[test]
fn host_pool_returns_the_replacement_stored_while_it_checked() {
    let (pool, c) = (HostPool::<u8, FakeHost>::default(), Counters::default());
    let dead = pool.live(1, || c.build(), alive).unwrap();
    dead.dead.store(true, Ordering::SeqCst);
    // Another caller replaces the dead host while this one checks it.
    let replaced = Mutex::new(None);
    let got = pool
        .live(
            1,
            || panic!("the replacement must be taken, not built again"),
            |_| {
                *lock(&replaced) = pool.live(1, || c.build(), alive);
                false
            },
        )
        .unwrap();
    assert!(Arc::ptr_eq(&got, lock(&replaced).as_ref().unwrap()));
    assert_eq!(c.built(), 2);
}

#[test]
fn host_pool_racing_callers_build_exactly_once() {
    for dead_first in [false, true] {
        let pool = Arc::new(HostPool::<u8, FakeHost>::default());
        let c = Arc::new(Counters::default());
        if dead_first {
            pool.live(1, || c.build(), alive)
                .unwrap()
                .dead
                .store(true, Ordering::SeqCst);
        }
        let before = c.built();
        let gate = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (pool, c, gate) = (pool.clone(), c.clone(), gate.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    pool.live(1, || c.build(), alive).unwrap()
                })
            })
            .collect();
        let hosts: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(c.built() - before, 1);
        assert!(hosts.iter().all(|h| Arc::ptr_eq(h, &hosts[0])));
    }
}

/// `fill_with` over the mixer and reference, as `open_output` wires them.
fn fill<T>(
    out: &mut [T],
    mixed: &mut [f32],
    channels: usize,
    mixer: &Mixer,
    reference: &Mutex<Option<Reference>>,
) where
    T: Sample + FromSample<f32>,
{
    fill_with(out, mixed, channels, &mut |m: &mut [f32], c| {
        mixer.mix(m, c);
        if let Some(r) = lock(reference).as_mut() {
            r.feed(m, c);
        }
    });
}

fn sine(amplitude: f32, len: usize) -> Vec<i16> {
    (0..len)
        .map(|i| (amplitude * (i as f32 * 0.1).sin()) as i16)
        .collect()
}

fn rms(out: &[f32]) -> f32 {
    (out.iter().map(|s| s * s).sum::<f32>() / out.len() as f32).sqrt()
}

/// Pull `frames` mono frames from the mixer.
fn mixed(mixer: &Mixer, frames: usize) -> Vec<f32> {
    let mut out = vec![0.0; frames];
    mixer.mix(&mut out, 1);
    out
}

fn sinks(ids: &[&'static str]) -> Vec<(DeviceInfo, &'static str)> {
    ids.iter()
        .enumerate()
        .map(|(i, id)| {
            let info = DeviceInfo {
                id: id.to_string(),
                name: id.to_string(),
                index: i as u16,
            };
            (info, *id)
        })
        .collect()
}

#[test]
fn the_default_output_reopens_only_when_the_default_sink_moves() {
    let mut output = None;
    let mut opened = Vec::new();
    let mut open = |sink: &&'static str| {
        opened.push(*sink);
        Ok(*sink)
    };
    switch_output(&mut output, "", false, sinks(&["speakers"]), &mut open).unwrap();
    switch_output(
        &mut output,
        "",
        false,
        sinks(&["speakers", "headphones"]),
        &mut open,
    )
    .unwrap();
    // Headphones plugged in and made the default sink.
    switch_output(
        &mut output,
        "",
        false,
        sinks(&["headphones", "speakers"]),
        &mut open,
    )
    .unwrap();
    assert_eq!(opened, ["speakers", "headphones"]);
    assert_eq!(output, Some(("headphones".to_string(), "headphones")));
}

#[test]
fn a_device_that_fails_to_open_leaves_the_current_stream_playing() {
    let mut output = Some(("speakers".to_string(), "speakers"));
    let result = switch_output(
        &mut output,
        "usb",
        false,
        sinks(&["speakers", "usb"]),
        |_| Err::<&str, _>("busy".to_string()),
    );
    assert_eq!(result, Err("busy".to_string()));
    assert_eq!(output, Some(("speakers".to_string(), "speakers")));
}

#[test]
fn a_reopen_replaces_a_dead_stream_on_the_same_sink() {
    // A suspend or sound-server restart kills the stream but leaves the
    // sink in place: the watcher's reopen must not be skipped as
    // "already plays there".
    let mut output = Some(("speakers".to_string(), "dead"));
    switch_output(&mut output, "speakers", true, sinks(&["speakers"]), |_| {
        Ok("fresh")
    })
    .unwrap();
    assert_eq!(output, Some(("speakers".to_string(), "fresh")));
    // The user-facing switch still keeps a live stream on the same sink.
    switch_output(&mut output, "speakers", false, sinks(&["speakers"]), |_| {
        Ok("again")
    })
    .unwrap();
    assert_eq!(output, Some(("speakers".to_string(), "fresh")));
}

/// The pieces `watch` hands back.
type Watched = (
    Watcher,
    Arc<Mutex<Option<String>>>,
    Arc<AtomicBool>,
    Selected,
    mpsc::Receiver<()>,
);

/// A watcher over a default sink the test moves, reporting each follow.
/// `follows_default` starts the selection at the empty id (else "usb");
/// the selection and a dead-flag set on the returned handles also steer
/// it.
fn watch(playing: Option<&str>, follows_default: bool) -> Watched {
    let default = Arc::new(Mutex::new(playing.map(str::to_string)));
    let dead = Arc::new(AtomicBool::new(false));
    let selected: Selected = Arc::new(Mutex::new(
        if follows_default { "" } else { "usb" }.to_string(),
    ));
    let (followed, follows) = mpsc::channel();
    let source = default.clone();
    let watcher = Watcher::start(
        Duration::from_millis(2),
        playing.map(str::to_string),
        dead.clone(),
        selected.clone(),
        move || lock(&source).clone(),
        || false,
        move || {
            followed.send(()).unwrap();
            true
        },
    );
    (watcher, default, dead, selected, follows)
}

const QUIET: Duration = Duration::from_millis(50);

#[test]
fn the_watcher_follows_each_move_of_the_default_sink_once() {
    let (_watcher, default, _dead, _selected, follows) = watch(Some("speakers"), true);
    assert!(follows.recv_timeout(QUIET).is_err(), "default unchanged");
    *lock(&default) = Some("headphones".to_string());
    follows.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(follows.recv_timeout(QUIET).is_err(), "followed once");
    // The sound server not answering is not a move, nor is its answer
    // coming back unchanged.
    *lock(&default) = None;
    assert!(follows.recv_timeout(QUIET).is_err());
    *lock(&default) = Some("headphones".to_string());
    assert!(follows.recv_timeout(QUIET).is_err());
    *lock(&default) = Some("speakers".to_string());
    follows.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn a_watcher_with_nothing_playing_follows_the_first_default_it_sees() {
    let (_watcher, default, _dead, _selected, follows) = watch(None, true);
    assert!(follows.recv_timeout(QUIET).is_err());
    *lock(&default) = Some("speakers".to_string());
    follows.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn a_pinned_device_watcher_ignores_default_moves_but_reopens_a_dead_stream() {
    // voice #3: even a pinned output must reopen after the sound server
    // tears the stream down.
    let (_watcher, default, dead, _selected, follows) = watch(Some("usb"), false);
    *lock(&default) = Some("headphones".to_string());
    assert!(
        follows.recv_timeout(QUIET).is_err(),
        "pinned: default moves are ignored"
    );
    dead.store(true, Ordering::Relaxed);
    follows.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn the_watcher_reads_the_selection_on_every_tick() {
    // "System default" at start, then a device chosen mid-call: the
    // pinned device must not be moved back to the default.
    let (_watcher, default, _dead, selected, follows) = watch(Some("speakers"), true);
    *lock(&selected) = "usb".to_string();
    *lock(&default) = Some("headphones".to_string());
    assert!(
        follows.recv_timeout(QUIET).is_err(),
        "pinned later: default moves are ignored"
    );
    // Back to "System default": the move seen while pinned is not a new
    // one, the next move is.
    *lock(&selected) = String::new();
    assert!(follows.recv_timeout(QUIET).is_err());
    *lock(&default) = Some("speakers".to_string());
    follows.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn a_failed_reopen_of_a_dead_stream_is_retried_until_it_succeeds() {
    // A sound-server restart: the first reopens find no server yet.
    let dead = Arc::new(AtomicBool::new(true));
    let (attempted, attempts) = mpsc::channel();
    let mut n = 0;
    let _watcher = Watcher::start(
        Duration::from_millis(2),
        Some("speakers".to_string()),
        dead,
        Arc::new(Mutex::new(String::new())),
        || Some("speakers".to_string()),
        || false,
        move || {
            n += 1;
            attempted.send(n).unwrap();
            n >= 3
        },
    );
    for expected in 1..=3 {
        assert_eq!(attempts.recv_timeout(Duration::from_secs(5)), Ok(expected));
    }
    assert!(
        attempts.recv_timeout(QUIET).is_err(),
        "recovered: no more reopens"
    );
}

#[test]
fn a_pinned_sink_that_returns_after_a_restart_is_switched_back_to() {
    // A Bluetooth headset is pinned; after a sound-server restart only
    // the built-in sink is listed at first, so the reopen falls back.
    let listed = Arc::new(Mutex::new(vec!["speakers"]));
    let output = Arc::new(Mutex::new(Some(("bt".to_string(), "dead"))));
    let selected: Selected = Arc::new(Mutex::new("bt".to_string()));
    let dead = Arc::new(AtomicBool::new(true));
    let (opened, opens) = mpsc::channel();
    let returned = {
        let (listed, output, selected) = (listed.clone(), output.clone(), selected.clone());
        move || {
            let target = lock(&selected).clone();
            let playing = lock(&output).as_ref().map(|(id, _)| id.clone());
            pinned_listed(&target, playing.as_deref(), lock(&listed).iter())
        }
    };
    let follow = {
        let (listed, output, selected) = (listed.clone(), output.clone(), selected.clone());
        move || {
            let target = lock(&selected).clone();
            let sinks = sinks(&lock(&listed));
            switch_output(&mut lock(&output), &target, true, sinks, |sink| {
                opened.send(*sink).unwrap();
                Ok("live")
            })
            .is_ok()
        }
    };
    let _watcher = Watcher::start(
        Duration::from_millis(2),
        Some("bt".to_string()),
        dead,
        selected,
        || None,
        returned,
        follow,
    );
    assert_eq!(opens.recv_timeout(Duration::from_secs(5)), Ok("speakers"));
    assert!(
        opens.recv_timeout(QUIET).is_err(),
        "the headset is not back: no reopen storm"
    );
    lock(&listed).push("bt");
    assert_eq!(opens.recv_timeout(Duration::from_secs(5)), Ok("bt"));
    assert!(opens.recv_timeout(QUIET).is_err(), "back on the headset");
    assert_eq!(
        lock(&output).as_ref().map(|(id, _)| id.clone()),
        Some("bt".to_string())
    );
}

#[test]
fn only_a_missing_pin_that_is_listed_again_is_reacquired() {
    let listed = ["speakers", "bt"];
    assert!(pinned_listed("bt", Some("speakers"), listed.iter()));
    assert!(
        !pinned_listed("bt", Some("bt"), listed.iter()),
        "already on it"
    );
    assert!(
        !pinned_listed("bt", Some("speakers"), ["speakers"].iter()),
        "not back yet"
    );
    assert!(pinned_listed("bt", None, listed.iter()), "nothing plays");
    // "System default" pins nothing, even with the stream on no listed id.
    assert!(!pinned_listed("", Some("gone"), listed.iter()));
    assert!(!pinned_listed("", None, ["", "speakers"].iter()));
}

#[test]
fn a_restart_never_settles_on_a_lower_backend() {
    use cpal::HostId::{Alsa, PulseAudio};
    // Mid-restart only ALSA is up: no rebuild onto it.
    assert_eq!(better_backend(PulseAudio, &[Alsa], true), None);
    // The server is back: a fresh connection to it.
    assert_eq!(
        better_backend(PulseAudio, &[PulseAudio, Alsa], true),
        Some(PulseAudio)
    );
    // Started on ALSA while the server was down: upgraded once it is up,
    // but a live ALSA host is not rebuilt on every poll.
    assert_eq!(
        better_backend(Alsa, &[PulseAudio, Alsa], false),
        Some(PulseAudio)
    );
    assert_eq!(better_backend(Alsa, &[Alsa], false), None);
    // A machine with only ALSA still recovers through ALSA.
    assert_eq!(better_backend(Alsa, &[Alsa], true), Some(Alsa));
}

#[test]
fn a_failed_follow_of_a_default_move_is_retried() {
    let default = Arc::new(Mutex::new(Some("speakers".to_string())));
    let (attempted, attempts) = mpsc::channel();
    let mut n = 0;
    let source = default.clone();
    let _watcher = Watcher::start(
        Duration::from_millis(2),
        Some("speakers".to_string()),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(String::new())),
        move || lock(&source).clone(),
        || false,
        move || {
            n += 1;
            attempted.send(n).unwrap();
            n >= 2
        },
    );
    *lock(&default) = Some("headphones".to_string());
    assert_eq!(attempts.recv_timeout(Duration::from_secs(5)), Ok(1));
    assert_eq!(attempts.recv_timeout(Duration::from_secs(5)), Ok(2));
    assert!(attempts.recv_timeout(QUIET).is_err(), "followed: no more");
}

#[test]
fn the_dead_flag_reopens_once_per_set() {
    let (_watcher, _default, dead, _selected, follows) = watch(Some("speakers"), true);
    dead.store(true, Ordering::Relaxed);
    follows.recv_timeout(Duration::from_secs(5)).unwrap();
    // Cleared by the swap: no second follow without another set.
    assert!(follows.recv_timeout(QUIET).is_err());
}

#[test]
fn a_dropped_watcher_has_stopped_following() {
    let (watcher, default, _dead, _selected, follows) = watch(Some("speakers"), true);
    drop(watcher);
    *lock(&default) = Some("headphones".to_string());
    // Dropping joined the thread and with it the follow callback.
    assert_eq!(
        follows.recv_timeout(QUIET),
        Err(mpsc::RecvTimeoutError::Disconnected)
    );
}

#[test]
fn loopback_frames_play_once_primed_at_the_output_gain() {
    let frame = sine(8000.0, SAMPLE_RATE as usize / 100);
    let level = |gain: Option<f32>| {
        let m = Mixer::default();
        m.add_loopback();
        if let Some(g) = gain {
            m.set_gain(LOOPBACK, Volume::Microphone, g);
        }
        m.push(LOOPBACK, &frame);
        m.push(LOOPBACK, &frame);
        assert_eq!(rms(&mixed(&m, PRIME)), 0.0, "two frames are still priming");
        m.push(LOOPBACK, &frame);
        rms(&mixed(&m, PRIME))
    };
    let unity = level(None);
    assert!(unity > 0.1, "unity rms {unity}");
    assert!((level(Some(0.5)) / unity - 0.5).abs() < 0.01);
}

#[test]
fn each_participant_is_scaled_by_its_own_gain() {
    let tone = sine(8000.0, PRIME);
    let level = |gain: Option<f32>| {
        let m = Mixer::default();
        m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
        if let Some(g) = gain {
            m.set_gain("user-1", Volume::Microphone, g);
        }
        m.push("TR_a", &tone);
        rms(&mixed(&m, PRIME))
    };
    let unity = level(None);
    assert!(unity > 0.1, "unity rms {unity}");
    assert!((level(Some(0.5)) / unity - 0.5).abs() < 0.01);
    assert!((level(Some(2.0)) / unity - 2.0).abs() < 0.01);
    assert_eq!(level(Some(0.0)), 0.0);
}

#[test]
fn a_gain_set_on_one_user_leaves_the_others_and_their_screen_share_audio_alone() {
    let tone = sine(8000.0, PRIME);
    let m = Mixer::default();
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    m.add("TR_b", "user-2", Some(Volume::Microphone), 1);
    m.add("TR_s", "user-1", Some(Volume::ScreenShare), 1);
    m.set_gain("user-1", Volume::Microphone, 0.0);
    for sid in ["TR_a", "TR_b", "TR_s"] {
        m.push(sid, &tone);
    }
    let both = rms(&mixed(&m, PRIME));
    let only = Mixer::default();
    only.add("TR_b", "user-2", Some(Volume::Microphone), 1);
    only.push("TR_b", &tone);
    let one = rms(&mixed(&only, PRIME));
    // user-1's microphone is silenced; user-2 and user-1's screen-share
    // audio (the same tone, in phase) remain: twice one track's level.
    assert!((both / one - 2.0).abs() < 0.01, "{both} vs {one}");
}

#[test]
fn screen_share_audio_follows_its_own_gain_and_other_audio_plays_at_unity() {
    let tone = sine(8000.0, PRIME);
    let level = |volume: Option<Volume>| {
        let m = Mixer::default();
        m.add("TR_s", "user-1", volume, 1);
        m.set_gain("user-1", Volume::ScreenShare, 0.25);
        m.set_gain("user-1", Volume::Microphone, 2.0);
        m.push("TR_s", &tone);
        rms(&mixed(&m, PRIME))
    };
    let unity = level(None);
    assert!(unity > 0.1, "unity rms {unity}");
    assert!((level(Some(Volume::ScreenShare)) / unity - 0.25).abs() < 0.01);
}

#[test]
fn a_gain_set_before_the_track_arrives_applies_to_it() {
    let m = Mixer::default();
    m.set_gain("user-1", Volume::Microphone, 0.0);
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    m.push("TR_a", &sine(8000.0, PRIME));
    assert_eq!(rms(&mixed(&m, PRIME)), 0.0);
}

#[test]
fn a_queue_plays_only_once_primed_and_reprimes_after_running_dry() {
    let m = Mixer::default();
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    m.push("TR_a", &vec![1000; PRIME - 1]);
    assert!(mixed(&m, 10).iter().all(|&s| s == 0.0), "not primed yet");
    m.push("TR_a", &[1000]);
    let out = mixed(&m, PRIME + 10);
    assert!(out[..PRIME].iter().all(|&s| s > 0.0));
    assert!(out[PRIME..].iter().all(|&s| s == 0.0), "ran dry");
    m.push("TR_a", &[1000; 10]);
    assert!(mixed(&m, 10).iter().all(|&s| s == 0.0), "reprimes");
}

#[test]
fn mono_plays_on_the_front_pair_only_and_the_sum_is_clipped() {
    let m = Mixer::default();
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    m.set_gain("user-1", Volume::Microphone, 10.0);
    m.push("TR_a", &vec![20000; PRIME]);
    // A 5.1 device: front left, front right, centre, LFE, rear pair.
    let mut out = vec![0.0; 6 * 4];
    m.mix(&mut out, 6);
    for frame in out.chunks(6) {
        assert_eq!(frame, [1.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
    }
}

#[test]
fn stereo_screen_share_audio_keeps_left_and_right() {
    let m = Mixer::default();
    m.add("TR_s", "user-1", Some(Volume::ScreenShare), 2);
    let left_only: Vec<i16> = (0..PRIME * 2)
        .map(|i| if i % 2 == 0 { 16384 } else { 0 })
        .collect();
    m.push("TR_s", &left_only);
    let mut out = vec![0.0; 6 * 4];
    m.mix(&mut out, 6);
    for frame in out.chunks(6) {
        assert_eq!(frame, [0.5, 0.0, 0.0, 0.0, 0.0, 0.0], "left stays left");
    }
    // A mono device hears the pair's mean.
    let mut mono = vec![0.0; 4];
    m.mix(&mut mono, 1);
    assert!(mono.iter().all(|&s| s == 0.25), "{mono:?}");
    // Stereo queues prime and count in frames, not samples.
    assert_eq!(lock(&m.0).queues["TR_s"].frames(), PRIME - 8);
}

#[test]
fn a_stereo_queue_primes_on_30_ms_of_frames_not_samples() {
    let m = Mixer::default();
    m.add("TR_s", "user-1", Some(Volume::ScreenShare), 2);
    m.push("TR_s", &vec![1000; PRIME * 2 - 2]);
    assert!(mixed(&m, 10).iter().all(|&s| s == 0.0), "not primed yet");
    m.push("TR_s", &[1000, 1000]);
    assert!(mixed(&m, 10).iter().all(|&s| s > 0.0), "primed");
}

/// One device period of steady playout: the sender's 20 ms arrives as
/// the device pulls 20 ms.
fn steady(m: &Mixer, periods: usize) {
    let period = SAMPLE_RATE as usize / 50;
    for _ in 0..periods {
        m.push("TR_a", &vec![1000; period]);
        mixed(m, period);
    }
}

fn queued(m: &Mixer) -> usize {
    lock(&m.0).queues["TR_a"].frames()
}

#[test]
fn a_backlog_left_by_a_stall_is_trimmed_once_it_persists() {
    let m = Mixer::default();
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    steady(&m, 10);
    let settled = queued(&m);
    assert!(settled <= PRIME, "steady level {settled}");
    // The device stalled for 100 ms while the sender kept sending.
    m.push("TR_a", &vec![1000; SAMPLE_RATE as usize / 10]);
    steady(&m, 90); // 1.8 s: under the trim interval
    assert!(
        queued(&m) > PRIME + SAMPLE_RATE as usize / 50,
        "kept for now"
    );
    steady(&m, 20); // past 2 s above the bound
    assert!(queued(&m) <= PRIME, "trimmed back: {}", queued(&m));
}

#[test]
fn a_backlog_that_drains_in_time_is_never_trimmed() {
    let m = Mixer::default();
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    steady(&m, 10);
    let backlog = SAMPLE_RATE as usize / 10;
    m.push("TR_a", &vec![1000; backlog]);
    steady(&m, 75); // 1.5 s above the bound
    let before = queued(&m);
    // The sender pauses for 100 ms: the backlog plays out instead of
    // being dropped, and the interval starts over.
    mixed(&m, backlog);
    assert_eq!(queued(&m), before - backlog);
    m.push("TR_a", &vec![1000; backlog]);
    steady(&m, 75);
    assert_eq!(queued(&m), before, "no audio was dropped");
}

#[test]
fn an_overfull_queue_drops_its_oldest_audio() {
    let m = Mixer::default();
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    m.push("TR_a", &vec![1; MAX_QUEUED]);
    m.push("TR_a", &vec![2; PRIME]);
    let state = lock(&m.0);
    let q = &state.queues["TR_a"];
    assert_eq!(q.samples.len(), PRIME);
    assert!(q.samples.iter().all(|&s| s == 2), "kept the newest");
}

#[test]
fn audio_for_an_unknown_or_removed_track_is_ignored() {
    let m = Mixer::default();
    m.push("TR_x", &[1000; PRIME]);
    m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
    m.remove("TR_a");
    m.push("TR_a", &[1000; PRIME]);
    assert!(mixed(&m, PRIME).iter().all(|&s| s == 0.0));
}

/// An integer device gets the f32 mix converted, and a pull larger than
/// the mix buffer is mixed in pieces with nothing lost between them.
#[test]
fn an_integer_device_plays_the_f32_mix_converted() {
    let frames = MIX_FRAMES + 30;
    let source = sine(8000.0, PRIME + frames);
    let (float, int) = (Mixer::default(), Mixer::default());
    for m in [&float, &int] {
        m.add("TR_a", "user-1", Some(Volume::Microphone), 1);
        m.push("TR_a", &source);
    }
    let mut want = vec![0.0; frames * 2];
    float.mix(&mut want, 2);
    let mut out = vec![0i16; frames * 2];
    let mut scratch = vec![0.0; MIX_FRAMES * 2];
    fill(&mut out, &mut scratch, 2, &int, &Mutex::new(None));
    let want: Vec<i16> = want.iter().map(|s| s.to_sample()).collect();
    assert_eq!(out, want);
    assert!(out.iter().any(|&s| s != 0), "the sine plays");
    // An unsigned device's silence is its midpoint, not zero.
    let mut out = vec![0u16; 4];
    fill(
        &mut out,
        &mut scratch,
        2,
        &Mixer::default(),
        &Mutex::new(None),
    );
    assert_eq!(out, [32768; 4]);
}

/// A one-shot plays its samples on the front pair, mono on both (the mean
/// on a mono device), then silence, and reports itself finished once the
/// last sample is out, whatever the pull sizes.
#[test]
fn a_one_shot_plays_its_samples_on_the_front_pair_then_silence_and_flags_done() {
    let samples = [0.1, 0.2, 0.3];
    let mut at = 0;
    // A 4-channel device: the pair carries the sound, the rest stays silent.
    let mut out = [9.0; 8];
    assert!(
        !write_once(&samples, &mut at, &mut out, 4),
        "one sample left"
    );
    assert_eq!(out, [0.1, 0.1, 0.0, 0.0, 0.2, 0.2, 0.0, 0.0]);
    let mut out = [9.0; 8];
    assert!(write_once(&samples, &mut at, &mut out, 4));
    assert_eq!(out, [0.3, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    // A mono device gets the pair's mean, and a later pull is silence.
    let mut at = 0;
    let mut out = [9.0; 5];
    assert!(write_once(&samples, &mut at, &mut out, 1));
    assert_eq!(out, [0.1, 0.2, 0.3, 0.0, 0.0]);
    assert!(write_once(&samples, &mut at, &mut out, 1));
    assert_eq!(out, [0.0; 5]);
}
