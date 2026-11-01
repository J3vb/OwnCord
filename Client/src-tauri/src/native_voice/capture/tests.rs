use super::*;

fn opts(ec: bool, ns: bool) -> AudioOptions {
    AudioOptions {
        echo_cancellation: ec,
        noise_suppression: ns,
        auto_gain_control: false,
        enhanced_noise_suppression: false,
    }
}

/// Deterministic white noise in -amp..amp (xorshift).
fn noise(len: usize, amp: f32, seed: u32) -> Vec<f32> {
    let mut x = seed;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x as f32 / u32::MAX as f32 * 2.0 - 1.0) * amp
        })
        .collect()
}

fn energy(s: &[i16]) -> f64 {
    s.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>() / s.len().max(1) as f64
}

fn run(p: &mut Processor, input: &[f32]) -> Vec<i16> {
    let mut out = Vec::new();
    p.push(input.iter().copied(), |f| out.extend_from_slice(f));
    out
}

#[test]
fn frames_are_emitted_whole_and_only_whole() {
    let mut p = Processor::new(Apm::new(&opts(false, false)), false);
    let mut sizes = Vec::new();
    p.push(vec![0.0; FRAME * 2 + 7], |f| sizes.push(f.len()));
    assert_eq!(sizes, [FRAME, FRAME]);
    p.push(vec![0.0; FRAME - 7], |f| sizes.push(f.len()));
    assert_eq!(sizes, [FRAME, FRAME, FRAME]);
}

/// The noise-suppression energy test: steady white noise (no speech) is
/// what RNNoise exists to remove. With the APM's own suppressor off, the
/// difference is RNNoise alone.
#[test]
fn rnnoise_removes_most_of_steady_noise_and_is_off_by_default() {
    let input = noise(SAMPLE_RATE as usize * 2, 0.1, 7);
    let settled = FRAME * 50;
    let mut plain = Processor::new(Apm::new(&opts(false, false)), false);
    let mut denoised = Processor::new(Apm::new(&opts(false, false)), true);
    let before = energy(&run(&mut plain, &input)[settled..]);
    let after = energy(&run(&mut denoised, &input)[settled..]);
    assert!(before > 1.0e6, "the plain chain keeps the noise: {before}");
    assert!(
        after < before * 0.1,
        "RNNoise should remove over 90% of the noise energy: {after} vs {before}"
    );
}

/// The echo canceller subtracts what playout fed it: a capture that is
/// only the played signal (a perfect echo) is mostly removed once the
/// canceller has converged.
#[test]
fn the_played_mix_fed_as_reference_cancels_its_echo() {
    let played = noise(SAMPLE_RATE as usize * 6, 0.1, 11);
    let settled = FRAME * 500;
    let residual = |ec: bool| {
        let apm = Apm::new(&opts(ec, false));
        let mut reference = Reference::new(apm.clone());
        let mut capture = Processor::new(apm, false);
        let mut out = Vec::new();
        for chunk in played.chunks(FRAME) {
            reference.feed(chunk, 1);
            capture.push(chunk.iter().copied(), |f| out.extend_from_slice(f));
        }
        energy(&out[settled..])
    };
    let echo = residual(false);
    let cancelled = residual(true);
    assert!(echo > 1.0e6, "without cancellation the echo stays: {echo}");
    assert!(
        cancelled < echo * 0.1,
        "echo cancellation should remove over 90% (10 dB): {cancelled} vs {echo}"
    );
}

/// The watcher is built once, around the feed as it was then; a source
/// published later (a first publish that failed and was retried) must be
/// what its reopens feed, not the orphaned first one.
#[test]
fn the_watchers_feed_follows_the_captures_current_source() {
    let mut capture = Capture::default();
    let watchers = capture.feed.clone();
    capture.configure(
        Apm::new(&opts(false, false)),
        false,
        Arc::new(|_| {}),
        Arc::new(|_, _| {}),
    );
    assert!(!watchers.ready(), "no source yet");
    let source = NativeAudioSource::new(
        livekit::webrtc::audio_source::AudioSourceOptions::default(),
        SAMPLE_RATE,
        1,
        0,
    );
    *lock(&capture.feed.sink) = Some(Sink::Track(source));
    assert!(watchers.ready(), "the watcher sees the source set after it");
    *lock(&capture.feed.sink) = None;
    assert!(!watchers.ready());
}

/// The mic test's sink hands every processed frame to the loopback
/// queue, which plays once it holds its prime.
#[test]
fn a_loopback_sink_delivers_processed_frames_to_the_mixer() {
    let mixer = Arc::new(Mixer::default());
    mixer.add_loopback();
    let sink = Sink::Loopback(mixer.clone());
    let frame: Vec<i16> = (0..FRAME).map(|i| ((i % 40) as i16 - 20) * 400).collect();
    for _ in 0..3 {
        sink.deliver(&frame);
    }
    let mut out = vec![0.0f32; FRAME * 3];
    mixer.mix(&mut out, 1);
    assert!(out.iter().any(|s| s.abs() > 0.01), "the audio is present");
}

/// Push-to-talk's gate keeps the capture and its processing
/// running but sends exact silence while closed, so a press needs no
/// device reopen and nothing of the room leaks while the key is up.
#[test]
fn a_closed_ptt_gate_sends_silence_and_an_open_one_the_processed_audio() {
    let input = noise(FRAME * 20, 0.1, 3);
    let capture = Capture::default();
    let mut p =
        Processor::new(Apm::new(&opts(false, false)), true).gated_by(capture.feed.gated.clone());
    capture.set_ptt_gated(true);
    let gated = run(&mut p, &input);
    assert_eq!(gated.len(), input.len(), "frames keep flowing");
    assert!(
        gated.iter().all(|&s| s == 0),
        "a closed gate sends only zeros"
    );
    capture.set_ptt_gated(false);
    assert!(
        energy(&run(&mut p, &input)) > 1.0e5,
        "an open gate passes audio"
    );
}

/// Each 10 ms frame's output: whether it is all zeros.
fn silent_frames(p: &mut Processor, input: &[f32]) -> Vec<bool> {
    run(p, input)
        .chunks(FRAME)
        .map(|f| f.iter().all(|&s| s == 0))
        .collect()
}

fn reporting_gate(threshold: f32) -> (Arc<Mutex<VoiceGate>>, Arc<Mutex<Vec<bool>>>) {
    let reports = Arc::new(Mutex::new(Vec::new()));
    let sink = reports.clone();
    let gate = Arc::new(Mutex::new(VoiceGate::default()));
    lock(&gate).report_to(Arc::new(move |open| lock(&sink).push(open)));
    lock(&gate).set_threshold(threshold, false);
    (gate, reports)
}

/// The input-sensitivity gate on the web path's scale (vad-worklet.js):
/// a level under the close level (6 dB below the threshold) closes it
/// after the ~500 ms hold, one at the threshold opens it after the
/// ~32 ms attack, and the voice runs 50 ms behind so that attack does not
/// clip the start of the word. Each change is reported for the local
/// speaking ring.
#[test]
fn the_voice_gate_closes_below_the_threshold_and_opens_above_it() {
    let (gate, reports) = reporting_gate(0.02);
    let mut p = Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
    let loud = noise(FRAME, 0.2, 5);
    let quiet = noise(FRAME, 0.005, 9);

    // The start-up grace (~500 ms) never closes it.
    for _ in 0..50 {
        silent_frames(&mut p, &quiet);
    }
    assert!(lock(&reports).is_empty(), "no verdict during the grace");

    let held: Vec<bool> = (0..65)
        .flat_map(|_| silent_frames(&mut p, &quiet))
        .collect();
    assert!(
        !held[..49].contains(&true),
        "the hold keeps it open: {held:?}"
    );
    assert!(
        held[51..].iter().all(|&s| s),
        "then it sends silence: {held:?}"
    );
    assert_eq!(*lock(&reports), [false]);

    let spoke: Vec<bool> = (0..10).flat_map(|_| silent_frames(&mut p, &loud)).collect();
    assert_eq!(*lock(&reports), [false, true]);
    // The lookahead delays the voice five frames: the first loud frame
    // out is the first one spoken, already behind an open gate.
    assert!(spoke[..2].iter().all(|&s| s), "closed until the attack");
    assert!(
        !spoke[5..].contains(&true),
        "the whole word goes out: {spoke:?}"
    );
}

/// A level between the close level and the threshold is neither quiet
/// nor speech: it keeps an open gate open and a closed gate closed.
#[test]
fn the_voice_gate_has_hysteresis_between_closing_and_opening() {
    let (gate, reports) = reporting_gate(0.02);
    // 0.014 is 3 dB under the threshold, inside the 6 dB hysteresis.
    for _ in 0..GATE_GRACE_FRAMES + 200 {
        lock(&gate).observe(0.014, 0.0);
    }
    assert!(lock(&reports).is_empty(), "the gate stays open");
    for _ in 0..GATE_HOLD_FRAMES {
        lock(&gate).observe(0.005, 0.0);
    }
    assert_eq!(*lock(&reports), [false], "8 dB under closes it");
    for _ in 0..200 {
        lock(&gate).observe(0.014, 0.0);
    }
    assert_eq!(
        *lock(&reports),
        [false],
        "and 3 dB under does not reopen it"
    );
    for _ in 0..GATE_ATTACK_FRAMES {
        lock(&gate).observe(0.02, 0.0);
    }
    assert_eq!(*lock(&reports), [false, true], "the threshold itself does");
}

/// The speech rule: a loud frame RNNoise does not call a voice does not
/// count toward opening, and an open gate closes after the hold once the
/// verdict goes away, loud or not.
#[test]
fn the_speech_rule_opens_only_on_rnnoises_verdict_and_closes_without_it() {
    let (gate, reports) = reporting_gate(0.02);
    lock(&gate).set_threshold(0.02, true);
    for _ in 0..GATE_GRACE_FRAMES + GATE_HOLD_FRAMES {
        lock(&gate).observe(0.005, 0.0);
    }
    assert_eq!(*lock(&reports), [false], "quiet closes it");
    for _ in 0..200 {
        lock(&gate).observe(0.2, 0.3);
    }
    assert_eq!(
        *lock(&reports),
        [false],
        "loud but not a voice stays closed"
    );
    for _ in 0..GATE_ATTACK_FRAMES {
        lock(&gate).observe(0.2, 0.9);
    }
    assert_eq!(*lock(&reports), [false, true], "a loud voice opens it");
    for _ in 0..GATE_HOLD_FRAMES - 1 {
        lock(&gate).observe(0.2, 0.1);
    }
    assert_eq!(*lock(&reports), [false, true], "the hold covers a pause");
    lock(&gate).observe(0.2, 0.1);
    assert_eq!(
        *lock(&reports),
        [false, true, false],
        "loud without the verdict closes it after the hold"
    );
    // A retune keeps the rule; a restart without it drops it.
    lock(&gate).retune(0.03);
    assert!(lock(&gate).wants_speech());
    lock(&gate).set_threshold(0.03, false);
    assert!(!lock(&gate).wants_speech());
}

/// With the speech rule on and Enhanced Noise Suppression off, RNNoise
/// runs for its verdict only: the audio goes out as a level-only gate's
/// (same lookahead delay, no denoising), and RNNoise is dropped once the
/// gate no longer wants it.
#[test]
fn rnnoise_runs_for_the_verdict_alone_and_leaves_the_audio_as_it_is() {
    let input = noise(FRAME * 20, 0.1, 7);
    let (level_only, _) = reporting_gate(0.02);
    let (gate, _) = reporting_gate(0.02);
    lock(&gate).set_threshold(0.02, true);
    let mut plain =
        Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(level_only);
    let mut detecting =
        Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
    let expected = run(&mut plain, &input);
    let out = run(&mut detecting, &input);
    assert!(plain.denoise.is_none(), "a level-only gate runs no RNNoise");
    assert!(detecting.denoise.is_some(), "RNNoise runs for the verdict");
    assert!(!detecting.enhanced);
    assert!(expected.iter().any(|&s| s != 0), "the gate is open");
    assert_eq!(out, expected, "the audio is not denoised");

    lock(&gate).set_threshold(0.02, false);
    run(&mut detecting, &input[..FRAME]);
    assert!(detecting.denoise.is_none(), "and is dropped with the rule");
}

/// One quiet frame inside an onset costs the attack one count, not the
/// whole count, as the worklet's attack does.
#[test]
fn a_dip_inside_an_onset_does_not_restart_the_attack() {
    let (gate, reports) = reporting_gate(0.02);
    for _ in 0..GATE_GRACE_FRAMES + GATE_HOLD_FRAMES {
        lock(&gate).observe(0.005, 0.0);
    }
    assert_eq!(*lock(&reports), [false]);
    lock(&gate).observe(0.2, 0.0);
    lock(&gate).observe(0.2, 0.0);
    lock(&gate).observe(0.005, 0.0);
    assert_eq!(*lock(&reports), [false], "two loud and a dip: not yet");
    lock(&gate).observe(0.2, 0.0);
    lock(&gate).observe(0.2, 0.0);
    assert_eq!(*lock(&reports), [false, true], "two more open it");
}

/// Sensitivity 100 is threshold 0: no gate, no delay, nothing reported,
/// as the web path runs no detector there.
#[test]
fn a_zero_threshold_runs_no_voice_gate() {
    let (gate, reports) = reporting_gate(0.0);
    let mut p = Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate);
    let input = noise(FRAME * 100, 0.001, 4);
    let out = run(&mut p, &input);
    assert!(out[..FRAME].iter().any(|&s| s != 0), "no lookahead delay");
    assert!(!silent_frames(&mut p, &input).contains(&true));
    assert!(lock(&reports).is_empty());
}

/// A new threshold restarts the detector open, as the web path restarts
/// its worklet on a slider move, and says so.
#[test]
fn a_new_threshold_reopens_a_closed_gate() {
    let (gate, reports) = reporting_gate(0.02);
    let mut p = Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
    run(&mut p, &noise(FRAME * 100, 0.005, 9));
    assert_eq!(*lock(&reports), [false]);
    lock(&gate).set_threshold(0.01, false);
    assert_eq!(*lock(&reports), [false, true]);
    // Turning it off reopens silently: the webview drops the verdict.
    run(&mut p, &noise(FRAME * 100, 0.001, 9));
    lock(&gate).set_threshold(0.0, false);
    assert_eq!(*lock(&reports), [false, true, false]);
}

/// The capture's gate is the one every stream it opens follows.
#[test]
fn the_voice_gate_is_shared_with_the_watchers_feed() {
    let capture = Capture::default();
    let watchers = capture.feed.clone();
    capture.set_voice_gate(0.03, false, false);
    assert_eq!(lock(&watchers.voice).threshold, 0.03);
}

/// Automatic sensitivity's steps move the threshold without restarting
/// the detector: a closed gate stays closed and says nothing, as the
/// worklet's "threshold" message keeps its counts. It never turns the
/// gate on or off: that is a set_threshold.
#[test]
fn a_retune_moves_the_threshold_without_reopening_the_gate() {
    let (gate, reports) = reporting_gate(0.02);
    let mut p = Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
    run(&mut p, &noise(FRAME * 100, 0.005, 9));
    assert_eq!(*lock(&reports), [false]);
    lock(&gate).retune(0.03);
    assert_eq!(lock(&gate).threshold, 0.03);
    assert!(lock(&gate).closed, "still closed");
    assert_eq!(*lock(&reports), [false], "no restart, no report");
    lock(&gate).retune(0.0);
    assert_eq!(lock(&gate).threshold, 0.03, "a retune never turns it off");
    // A late retune after the gate was turned off leaves it off.
    lock(&gate).set_threshold(0.0, false);
    lock(&gate).retune(0.02);
    assert!(!lock(&gate).on(), "a retune never turns it on");
}

fn reported_levels(gate: &Arc<Mutex<VoiceGate>>) -> Arc<Mutex<Vec<(f32, bool)>>> {
    let levels = Arc::new(Mutex::new(Vec::new()));
    let sink = levels.clone();
    lock(gate).report_levels_to(Arc::new(move |rms, open| lock(&sink).push((rms, open))));
    levels
}

/// One level report per 50 ms, the loudest 10 ms frame in it, as
/// vad-worklet.js reports its peak: the meter and automatic sensitivity
/// read the same numbers on both paths. It reports with no gate too.
#[test]
fn level_reports_carry_the_loudest_frame_every_fifty_ms() {
    let gate = Arc::new(Mutex::new(VoiceGate::default()));
    let levels = reported_levels(&gate);
    for rms in [0.01, 0.04, 0.02, 0.0, 0.01, 0.03, 0.0, 0.0, 0.0] {
        lock(&gate).observe(rms, 0.0);
    }
    assert_eq!(*lock(&levels), [(0.04, true)], "one report so far");
    lock(&gate).observe(0.0, 0.0);
    assert_eq!(*lock(&levels), [(0.04, true), (0.03, true)]);
}

/// A report says whether the gate is open, for the meter's colour.
#[test]
fn a_level_report_says_the_gate_is_closed() {
    let (gate, _) = reporting_gate(0.02);
    let levels = reported_levels(&gate);
    let mut p = Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
    run(&mut p, &noise(FRAME * 100, 0.005, 9));
    let last = *lock(&levels).last().unwrap();
    assert!(!last.1, "closed after the hold: {last:?}");
    assert!(last.0 > 0.0 && last.0 < 0.02, "the quiet level: {last:?}");
}

/// The loudest reported level once the ramp has settled.
fn steady_level(gain: f32, input: &[f32]) -> f32 {
    let gate = Arc::new(Mutex::new(VoiceGate::default()));
    let levels = reported_levels(&gate);
    let input_gain = InputGain::default();
    input_gain.set(gain);
    let mut p = Processor::new(Apm::new(&opts(false, false)), false)
        .with_voice_gate(gate)
        .with_input_gain(input_gain);
    run(&mut p, input);
    let reports = lock(&levels).clone();
    reports[2..].iter().map(|r| r.0).fold(0.0, f32::max)
}

/// The input volume scales the voice before the gate and the level
/// reports see it, as micProcessor's GainNode feeds the web detector:
/// 200 % doubles the level, 50 % halves it, 0 % is silence.
#[test]
fn the_input_volume_scales_what_the_gate_and_meter_see() {
    let input = noise(FRAME * 50, 0.05, 3);
    let unity = steady_level(1.0, &input);
    assert!(unity > 0.0);
    let double = steady_level(2.0, &input);
    let half = steady_level(0.5, &input);
    assert!((double / unity - 2.0).abs() < 0.05, "{double} vs {unity}");
    assert!((half / unity - 0.5).abs() < 0.05, "{half} vs {unity}");
    assert_eq!(steady_level(0.0, &input), 0.0);
}

/// A volume change ramps across one frame instead of jumping, so a slider
/// move does not click; a frame at 100 % is left untouched.
#[test]
fn a_volume_change_ramps_across_one_frame() {
    let mut frame = [1000_i16; FRAME];
    apply_gain(&mut frame, 1.0, 2.0);
    assert!(
        frame[0] > 1000 && frame[0] < 1010,
        "starts near the old gain"
    );
    assert_eq!(frame[FRAME - 1], 2000, "ends on the new one");
    assert!(frame.windows(2).all(|w| w[0] <= w[1]), "no jump");
    let mut unity = [1234_i16; FRAME];
    apply_gain(&mut unity, 1.0, 1.0);
    assert!(unity.iter().all(|&s| s == 1234));
    let mut loud = [30000_i16; FRAME];
    apply_gain(&mut loud, 2.0, 2.0);
    assert!(loud.iter().all(|&s| s == 32767), "clipped, not wrapped");
}

/// The capture's input volume is the one every stream it opens follows,
/// held to 0-200 %; a stray non-number keeps 100 %.
#[test]
fn the_input_volume_is_shared_with_the_watchers_feed() {
    let capture = Capture::default();
    let watchers = capture.feed.clone();
    assert_eq!(watchers.gain.get(), 1.0, "100 % until set");
    capture.set_input_gain(0.5);
    assert_eq!(watchers.gain.get(), 0.5);
    capture.set_input_gain(3.0);
    assert_eq!(watchers.gain.get(), 2.0);
    capture.set_input_gain(f32::NAN);
    assert_eq!(watchers.gain.get(), 1.0);
}

/// A stream the watcher reopens (device loss, a default move) is built
/// from the shared feed, so it starts behind the same closed gate.
#[test]
fn the_ptt_gate_is_shared_with_the_watchers_feed() {
    let capture = Capture::default();
    let watchers = capture.feed.clone();
    capture.set_ptt_gated(true);
    assert!(watchers.gated.load(Ordering::Relaxed));
    capture.set_ptt_gated(false);
    assert!(!watchers.gated.load(Ordering::Relaxed));
}

#[test]
fn a_failed_move_leaves_the_record_on_the_running_device() {
    // After a restart the stream fell back to the default mic; the
    // pinned one is listed again but does not open yet.
    let stream = Mutex::new(Some("default-stream"));
    let resolved = Mutex::new(Some(("default".to_string(), "default")));
    let moved = move_stream(&stream, &resolved, ("bt".to_string(), "bt"), |_| {
        Err("busy".to_string())
    });
    assert_eq!(moved, Err("busy".to_string()));
    assert_eq!(*lock(&stream), Some("default-stream"));
    let current = lock(&resolved).as_ref().map(|(id, _)| id.clone());
    assert!(
        pinned_listed("bt", current.as_deref(), ["default", "bt"].iter()),
        "still missing its pin: the next tick retries"
    );
    // The next tick's open succeeds.
    move_stream(&stream, &resolved, ("bt".to_string(), "bt"), |d| {
        Ok(if *d == "bt" { "bt-stream" } else { "wrong" })
    })
    .unwrap();
    assert_eq!(*lock(&stream), Some("bt-stream"));
    assert_eq!(
        lock(&resolved).as_ref().map(|(id, _)| id.as_str()),
        Some("bt")
    );
}

#[test]
fn a_muted_move_only_records_where_the_next_unmute_opens() {
    let stream: Mutex<Option<&str>> = Mutex::new(None);
    let resolved = Mutex::new(Some(("default".to_string(), "default")));
    move_stream(&stream, &resolved, ("usb".to_string(), "usb"), |_| {
        panic!("muted: the mic must not open")
    })
    .unwrap();
    assert_eq!(*lock(&stream), None);
    assert_eq!(
        lock(&resolved).as_ref().map(|(id, _)| id.as_str()),
        Some("usb")
    );
}

#[test]
fn monitor_sources_are_not_microphones() {
    assert!(is_monitor(
        "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor"
    ));
    assert!(!is_monitor("alsa_input.pci-0000_00_1f.3.analog-stereo"));
    assert!(!is_monitor("bluez_input.00_11_22_33_44_55.monitor-mic"));
}

#[test]
fn the_reference_is_the_front_pair_mixed_to_mono() {
    assert_eq!(front_mono(&[0.2, 0.6]), 0.4);
    assert_eq!(front_mono(&[0.2, 0.6, 1.0, 1.0, 1.0, 1.0]), 0.4);
    assert_eq!(front_mono(&[0.3]), 0.3);
}

/// An integer device's samples reach the processing as the same mono
/// f32 a float device's would.
#[test]
fn integer_device_samples_are_mixed_to_mono_f32() {
    let mono = |data: &[f32]| to_mono(data, 2).collect::<Vec<_>>();
    let want = mono(&[0.5, -0.5, -1.0, 0.0, 0.25, 0.25]);
    assert_eq!(want, [0.0, -0.5, 0.25]);
    let i16s = [16384i16, -16384, -32768, 0, 8192, 8192];
    assert_eq!(to_mono(&i16s, 2).collect::<Vec<_>>(), want);
    let u16s = [49152u16, 16384, 0, 32768, 40960, 40960];
    assert_eq!(to_mono(&u16s, 2).collect::<Vec<_>>(), want);
    let i32s = [1i32 << 30, -(1 << 30), i32::MIN, 0, 1 << 29, 1 << 29];
    assert_eq!(to_mono(&i32s, 2).collect::<Vec<_>>(), want);
    let i24s =
        [1 << 22, -(1 << 22), -(1 << 23), 0, 1 << 21, 1 << 21].map(|s| cpal::I24::new(s).unwrap());
    assert_eq!(to_mono(&i24s, 2).collect::<Vec<_>>(), want);
}

/// Not a gate: the CPU cost the task asked to report. Run with
/// `cargo test --release --lib cpu_cost -- --ignored --nocapture`.
#[test]
#[ignore]
fn cpu_cost() {
    let input = noise(SAMPLE_RATE as usize * 20, 0.1, 3);
    let seconds = input.len() as f64 / f64::from(SAMPLE_RATE);
    for (label, ec, ns, rnnoise) in [
        ("APM only (AEC+NS)", true, true, false),
        ("RNNoise only", false, false, true),
        ("APM + RNNoise", true, true, true),
    ] {
        let apm = Apm::new(&opts(ec, ns));
        let mut reference = Reference::new(apm.clone());
        let mut p = Processor::new(apm, rnnoise);
        let start = std::time::Instant::now();
        for chunk in input.chunks(FRAME) {
            reference.feed(chunk, 1);
            p.push(chunk.iter().copied(), |_| {});
        }
        let elapsed = start.elapsed().as_secs_f64();
        println!(
            "{label}: {:.1} us per 10 ms frame, {:.2}% of one core",
            elapsed / (seconds * 100.0) * 1e6,
            elapsed / seconds * 100.0
        );
    }
}

/// A toggle reaches a processor that is already running, on its next
/// frame: the new APM replaces the old and RNNoise starts (or stops).
#[test]
fn a_running_processor_takes_a_new_processing_on_the_next_frame() {
    let first = Apm::new(&opts(false, false));
    let slot: Processing = Arc::new(Shared::new(Some((first.clone(), false))));
    let (seen, _) = slot.snapshot();
    let mut p = Processor::new(first.clone(), false).following(slot.clone(), seen);
    let input = noise(FRAME * 3, 0.1, 7);
    run(&mut p, &input);
    assert!(Arc::ptr_eq(&p.apm, &first) && p.denoise.is_none());

    let second = Apm::new(&opts(true, true));
    slot.set(Some((second.clone(), true)));
    run(&mut p, &input[..FRAME]);
    assert!(Arc::ptr_eq(&p.apm, &second));
    assert!(p.denoise.is_some());

    // And back off: the denoiser is dropped, the APM replaced again.
    let third = Apm::new(&opts(false, false));
    slot.set(Some((third.clone(), false)));
    run(&mut p, &input[..FRAME]);
    assert!(Arc::ptr_eq(&p.apm, &third) && p.denoise.is_none());
}

/// The audio thread never waits on a set in progress: with the slot's
/// lock held the frame is processed with the old processing, and the
/// swap lands on the first frame after the lock is free.
#[test]
fn a_set_racing_the_callback_never_blocks_it_and_lands_later() {
    let first = Apm::new(&opts(false, false));
    let slot: Processing = Arc::new(Shared::new(Some((first.clone(), false))));
    let (seen, _) = slot.snapshot();
    let mut p = Processor::new(first.clone(), false).following(slot.clone(), seen);
    let second = Apm::new(&opts(true, true));
    let held = lock(&slot.value);
    // Move the generation as `set` does, while it still holds the lock.
    slot.generation.fetch_add(1, Ordering::Release);
    let frame = noise(FRAME, 0.1, 3);
    let out = run(&mut p, &frame);
    assert_eq!(out.len(), FRAME);
    assert!(Arc::ptr_eq(&p.apm, &first) && p.denoise.is_none());
    drop(held);
    *lock(&slot.value) = Some((second.clone(), true));
    run(&mut p, &frame);
    assert!(Arc::ptr_eq(&p.apm, &second) && p.denoise.is_some());
}

/// A set while the stream is stopped (muted) is what the next open uses.
#[test]
fn a_set_while_stopped_is_used_by_the_next_open() {
    let mut capture = Capture::default();
    let first = Apm::new(&opts(false, false));
    capture.configure(first.clone(), false, Arc::new(|_| {}), Arc::new(|_, _| {}));
    let before = capture.feed.processor().unwrap();
    assert!(Arc::ptr_eq(&before.apm, &first) && before.denoise.is_none());

    capture.stop();
    let second = Apm::new(&opts(true, true));
    capture.set_processing(second.clone(), true);
    let after = capture.feed.processor().unwrap();
    assert!(Arc::ptr_eq(&after.apm, &second));
    assert!(after.denoise.is_some());
}

/// The echo canceller's reference follows a replaced APM as well.
#[test]
fn the_reference_follows_a_replaced_apm() {
    let slot: Arc<Shared<Option<Arc<Apm>>>> = Arc::default();
    let mut reference = Reference::following(slot.clone());
    let buffer = vec![0.1_f32; FRAME];
    reference.feed(&buffer, 1);
    assert!(reference.apm.is_none());
    let apm = Apm::new(&opts(true, false));
    slot.set(Some(apm.clone()));
    reference.feed(&buffer, 1);
    assert!(reference.apm.as_ref().is_some_and(|a| Arc::ptr_eq(a, &apm)));
}
