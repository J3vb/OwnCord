//! Microphone capture with the web path's processing (Linux native voice).
//!
//! The SDK's audio device module hands its capture straight to the encoder,
//! with no hook for RNNoise, so the microphone is our own `cpal` input
//! stream. Each 10 ms of mono 48 kHz audio goes through libwebrtc's
//! standalone audio processing module (APM): echo cancellation against what
//! `playout.rs` actually plays, noise suppression, gain control and a
//! high-pass filter. With Enhanced Noise Suppression on it then goes through
//! RNNoise (`nnnoiseless`), and into a `Sink`: the published track's
//! `NativeAudioSource`, or the mic test's loopback queue. RNNoise runs after the APM, as on the web path, where
//! the browser's processing precedes the RNNoise worklet: the echo canceller
//! needs the linear echo path that RNNoise would break. Last, the
//! input-sensitivity gate (`VoiceGate`) and push-to-talk's gate decide
//! whether the frame goes out or silence does.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use futures_util::FutureExt;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::native::apm::AudioProcessingModule;
use nnnoiseless::DenoiseState;

use super::playout::{
    host_devices, pinned_listed, shared_default_host, Mixer, Role, Selected, WatchedHost, Watcher,
    FOLLOW_EVERY, LOOPBACK,
};
use super::session::{resolve_device, AudioOptions, DeviceInfo};
use super::stream_format::{pick_config, typed};
use crate::sync::lock;

pub const SAMPLE_RATE: u32 = 48_000;
/// One 10 ms frame: the APM's unit and RNNoise's (`nnnoiseless::FRAME_SIZE`).
pub const FRAME: usize = SAMPLE_RATE as usize / 100;

/// A value the audio threads follow while another thread replaces it. The
/// generation moves under the lock, so a follower that sees it unchanged has
/// nothing to read; one that sees it changed reads with `try_lock`, which
/// never waits: a set in progress is picked up on a later frame.
pub struct Shared<T> {
    generation: AtomicU64,
    value: Mutex<T>,
}

impl<T: Default> Default for Shared<T> {
    fn default() -> Self {
        Self::new(T::default())
    }
}

impl<T> Shared<T> {
    pub fn new(value: T) -> Self {
        Self {
            generation: AtomicU64::new(0),
            value: Mutex::new(value),
        }
    }
}

impl<T: Clone> Shared<T> {
    pub fn set(&self, value: T) {
        let mut held = lock(&self.value);
        *held = value;
        self.generation.fetch_add(1, Ordering::Release);
    }

    /// The value and the generation it belongs to.
    pub fn snapshot(&self) -> (u64, T) {
        let held = lock(&self.value);
        (self.generation.load(Ordering::Acquire), held.clone())
    }

    /// For the audio thread: the new value when the generation moved past
    /// `seen` and the lock is free right now, else None (retry next frame).
    pub fn poll(&self, seen: &mut u64) -> Option<T> {
        if self.generation.load(Ordering::Acquire) == *seen {
            return None;
        }
        let held = match self.value.try_lock() {
            Ok(held) => held,
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return None,
        };
        *seen = self.generation.load(Ordering::Acquire);
        Some(held.clone())
    }
}

/// libwebrtc's processing, shared by the capture (its forward stream) and the
/// playout (its reverse stream: the reference the echo canceller subtracts).
pub struct Apm(Mutex<AudioProcessingModule>);

impl Apm {
    pub fn new(opts: &AudioOptions) -> Arc<Self> {
        Arc::new(Self(Mutex::new(AudioProcessingModule::new(
            opts.echo_cancellation,
            opts.auto_gain_control,
            true,
            opts.noise_suppression,
        ))))
    }

    fn lock(&self) -> MutexGuard<'_, AudioProcessingModule> {
        lock(&self.0)
    }
}

fn to_i16(s: f32) -> i16 {
    (s * 32768.0).clamp(-32768.0, 32767.0) as i16
}

/// Collects mono samples into whole 10 ms frames.
struct Framer(Vec<i16>);

impl Default for Framer {
    fn default() -> Self {
        Self(Vec::with_capacity(FRAME))
    }
}

impl Framer {
    fn push(&mut self, samples: impl IntoIterator<Item = i16>, mut frame: impl FnMut(&mut [i16])) {
        for s in samples {
            self.0.push(s);
            if self.0.len() == FRAME {
                frame(&mut self.0);
                self.0.clear();
            }
        }
    }
}

/// One interleaved output frame as mono: the front pair's mean, since
/// playout writes nothing to a centre, LFE or surround channel.
fn front_mono(frame: &[f32]) -> f32 {
    match frame {
        [l, r, ..] => (l + r) / 2.0,
        [m] => *m,
        [] => 0.0,
    }
}

/// The playout side: what the device is actually handed (after every gain
/// and the per-track queues' delay), mixed down to mono, becomes the echo
/// canceller's reverse stream.
pub struct Reference {
    apm: Option<Arc<Apm>>,
    /// Where a later processing arrives (the playout's shared one), and the
    /// generation `apm` came from.
    slot: Option<Arc<Shared<Option<Arc<Apm>>>>>,
    seen: u64,
    framer: Framer,
}

impl Reference {
    pub fn new(apm: Arc<Apm>) -> Self {
        Self {
            apm: Some(apm),
            slot: None,
            seen: 0,
            framer: Framer::default(),
        }
    }

    /// Feed whatever APM `slot` currently holds, and follow it when it is
    /// replaced (a live change of the audio processing).
    pub fn following(slot: Arc<Shared<Option<Arc<Apm>>>>) -> Self {
        let (seen, apm) = slot.snapshot();
        Self {
            apm,
            slot: Some(slot),
            seen,
            framer: Framer::default(),
        }
    }

    /// `out` is the interleaved buffer just filled for the device; playout
    /// uses only its first two (front) channels.
    pub fn feed(&mut self, out: &[f32], channels: usize) {
        if let Some(slot) = &self.slot {
            if let Some(apm) = slot.poll(&mut self.seen) {
                self.apm = apm;
            }
        }
        let mono = out
            .chunks_exact(channels.max(1))
            .map(|f| to_i16(front_mono(f)));
        let Some(apm) = &self.apm else {
            return;
        };
        self.framer.push(mono, |frame| {
            // A failed frame only weakens the reference; nothing to recover.
            let _ = apm
                .lock()
                .process_reverse_stream(frame, SAMPLE_RATE as i32, 1);
        });
    }
}

/// The voice gate's timing, in 10 ms frames: vad-worklet.js's ~500 ms hold
/// below the close level before closing, ~32 ms attack at the threshold
/// before opening, and ~500 ms start-up grace.
const GATE_HOLD_FRAMES: u32 = 50;
const GATE_ATTACK_FRAMES: u32 = 3;
const GATE_GRACE_FRAMES: u32 = 50;
/// Hysteresis, as vad-worklet.js's: the gate opens at the threshold and
/// closes only this far below it, so the quieter stretches of a word do not
/// count as silence and a voice at the line does not chatter.
const GATE_HYSTERESIS_DB: f32 = 6.0;
/// How far the voice runs behind the detector while the gate is on, so the
/// attack does not clip the start of a word (micProcessor's
/// GATE_LOOKAHEAD_S).
const GATE_LOOKAHEAD_FRAMES: usize = 5;
/// RNNoise's probability that a frame is a voice, as vad-worklet.js reads
/// it: at or above the first a frame counts toward opening, under the
/// second toward closing (automatic sensitivity's speech rule).
const SPEECH_OPEN_PROBABILITY: f32 = 0.5;
const SPEECH_CLOSE_PROBABILITY: f32 = 0.15;
/// Frames after RNNoise starts whose probability is not trusted: its state
/// settles in its first ~100 ms and reads as a voice (rnnoise-worklet.js
/// SPEECH_WARMUP_FRAMES).
const SPEECH_WARMUP_FRAMES: u32 = 15;

/// Told whether the voice gate is open after each change.
pub type GateSink = Arc<dyn Fn(bool) + Send + Sync>;

/// Told each level report: the loudest ~10 ms RMS since the last one, after
/// the input volume, and whether the voice gate is open.
pub type LevelSink = Arc<dyn Fn(f32, bool) + Send + Sync>;

/// Frames per level report: vad-worklet.js reports its loudest level every
/// ~50 ms, which the meter and automatic sensitivity both read.
const LEVEL_REPORT_FRAMES: u32 = 5;

/// The input volume's top: 200 %, as audioPipeline's `setInputVolume`.
const MAX_INPUT_GAIN: f32 = 2.0;

/// The input volume as a linear gain (0 to 2, `inputVolume` / 100 as on the
/// web path), shared by every stream a capture opens.
#[derive(Clone)]
pub struct InputGain(Arc<AtomicU32>);

impl Default for InputGain {
    fn default() -> Self {
        Self(Arc::new(AtomicU32::new(1.0_f32.to_bits())))
    }
}

impl InputGain {
    pub fn set(&self, gain: f32) {
        let gain = if gain.is_finite() {
            gain.clamp(0.0, MAX_INPUT_GAIN)
        } else {
            1.0
        };
        self.0.store(gain.to_bits(), Ordering::Relaxed);
    }

    fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
}

/// Scale `frame` by a gain that moves from `from` to `to` across it, so a
/// slider move does not click (micProcessor's GainNode ramps likewise).
fn apply_gain(frame: &mut [i16], from: f32, to: f32) {
    if from == 1.0 && to == 1.0 {
        return;
    }
    let step = (to - from) / frame.len() as f32;
    for (i, s) in frame.iter_mut().enumerate() {
        let gain = from + step * (i + 1) as f32;
        *s = (f32::from(*s) * gain).round().clamp(-32768.0, 32767.0) as i16;
    }
}

/// The input-sensitivity gate: the web path's voice detector
/// (vad-worklet.js) on the same level scale, the RMS (-1 to 1) of ~10 ms of
/// processed audio, so one slider position gates alike on both paths.
#[derive(Default)]
pub struct VoiceGate {
    /// The level that counts as speech; 0 runs no gate (sensitivity 100).
    threshold: f32,
    /// Automatic sensitivity's speech rule: a frame also needs RNNoise's
    /// verdict to count toward opening, and loses it toward closing.
    speech_gate: bool,
    grace: u32,
    silent: u32,
    /// Counts up on a frame at the threshold and down on one below it, so a
    /// single dip inside an onset does not start the attack over.
    speech: u32,
    closed: bool,
    on_change: Option<GateSink>,
    on_level: Option<LevelSink>,
    level_peak: f32,
    level_frames: u32,
}

impl VoiceGate {
    pub fn report_to(&mut self, sink: GateSink) {
        self.on_change = Some(sink);
    }

    pub fn report_levels_to(&mut self, sink: LevelSink) {
        self.on_level = Some(sink);
    }

    /// Restart the detector open at `threshold`, as the web path restarts its
    /// worklet on a slider move; `speech_gate` adds RNNoise's verdict
    /// (automatic sensitivity). Turning it off reopens without a report.
    pub fn set_threshold(&mut self, threshold: f32, speech_gate: bool) {
        *self = Self {
            threshold: threshold.max(0.0),
            speech_gate,
            closed: self.closed,
            on_change: self.on_change.take(),
            on_level: self.on_level.take(),
            ..Self::default()
        };
        if self.on() {
            self.set_closed(false);
        } else {
            self.closed = false;
        }
    }

    /// Move the threshold without restarting the detector, as automatic
    /// sensitivity moves the worklet's (its "threshold" message): the gate
    /// keeps its state and counts. Only a running gate moves: a retune sent
    /// before the gate was turned off (Push to Talk, sensitivity 100) must
    /// not turn it back on.
    pub fn retune(&mut self, threshold: f32) {
        if self.on() && threshold > 0.0 {
            self.threshold = threshold;
        }
    }

    fn on(&self) -> bool {
        self.threshold > 0.0
    }

    /// Whether the gate reads RNNoise's verdict, so the processor runs
    /// RNNoise for it even with Enhanced Noise Suppression off.
    pub fn wants_speech(&self) -> bool {
        self.on() && self.speech_gate
    }

    fn set_closed(&mut self, closed: bool) {
        if self.closed == closed {
            return;
        }
        self.closed = closed;
        if let Some(sink) = &self.on_change {
            sink(!closed);
        }
    }

    /// The level below which an open gate counts a frame as quiet.
    fn close_level(&self) -> f32 {
        self.threshold * 10f32.powf(-GATE_HYSTERESIS_DB / 20.0)
    }

    /// Take one frame's level and RNNoise's verdict on it (0 while RNNoise
    /// is not running, which only matters with the speech rule on); returns
    /// whether the gate is now closed.
    fn update(&mut self, rms: f32, probability: f32) -> bool {
        let voiced = !self.speech_gate || probability >= SPEECH_OPEN_PROBABILITY;
        let unvoiced = self.speech_gate && probability < SPEECH_CLOSE_PROBABILITY;
        if self.grace < GATE_GRACE_FRAMES {
            self.grace += 1;
        } else if self.closed {
            if rms >= self.threshold && voiced {
                self.speech = self.speech.saturating_add(1);
            } else {
                self.speech = self.speech.saturating_sub(1);
            }
            if self.speech >= GATE_ATTACK_FRAMES {
                self.speech = 0;
                self.silent = 0;
                self.set_closed(false);
            }
        } else if rms < self.close_level() || unvoiced {
            self.silent = self.silent.saturating_add(1);
            if self.silent >= GATE_HOLD_FRAMES {
                self.silent = 0;
                self.speech = 0;
                self.set_closed(true);
            }
        } else {
            self.silent = 0;
        }
        self.closed
    }

    /// Take one frame's level and RNNoise's verdict: the gate runs on them
    /// while on, and every `LEVEL_REPORT_FRAMES` the loudest level goes to
    /// the level sink. Returns whether the gate is now closed.
    fn observe(&mut self, rms: f32, probability: f32) -> bool {
        let closed = self.on() && self.update(rms, probability);
        if let Some(sink) = &self.on_level {
            self.level_peak = self.level_peak.max(rms);
            self.level_frames += 1;
            if self.level_frames >= LEVEL_REPORT_FRAMES {
                sink(self.level_peak, !closed);
                self.level_peak = 0.0;
                self.level_frames = 0;
            }
        }
        closed
    }
}

fn rms(frame: &[i16]) -> f32 {
    let power = frame.iter().map(|&s| f64::from(s).powi(2)).sum::<f64>() / frame.len() as f64;
    (power.sqrt() / 32768.0) as f32
}

/// RNNoise over the capture, and how many frames it has seen: its verdict is
/// trusted only past the warm-up.
struct Denoiser {
    state: Box<DenoiseState<'static>>,
    frames: u32,
}

impl Denoiser {
    fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            frames: 0,
        }
    }

    /// Denoise `input` into `output`; returns RNNoise's speech probability,
    /// 0 while it warms up.
    fn process(&mut self, output: &mut [f32], input: &[f32]) -> f32 {
        let probability = self.state.process_frame(output, input);
        self.frames = self.frames.saturating_add(1);
        if self.frames > SPEECH_WARMUP_FRAMES {
            probability
        } else {
            0.0
        }
    }
}

/// The capture side: APM, then RNNoise when Enhanced Noise Suppression is on
/// or the voice gate wants its verdict (then the audio goes around it).
pub struct Processor {
    apm: Arc<Apm>,
    enhanced: bool,
    denoise: Option<Denoiser>,
    /// Where a live change of the processing arrives, and the generation
    /// `apm` and `denoise` came from.
    follow: Option<Processing>,
    seen: u64,
    /// Push-to-talk's gate: while set, every frame goes out as silence.
    gated: Arc<AtomicBool>,
    /// The input-sensitivity gate (the capture's shared one).
    voice: Arc<Mutex<VoiceGate>>,
    /// The input volume (the capture's shared one) and the gain the last
    /// frame ended on, which the next ramps from.
    gain: InputGain,
    applied_gain: f32,
    /// The voice behind the gate's detector while the gate is on.
    lookahead: VecDeque<i16>,
    framer: Framer,
    input: Box<[f32; FRAME]>,
    output: Box<[f32; FRAME]>,
}

impl Processor {
    pub fn new(apm: Arc<Apm>, enhanced_noise_suppression: bool) -> Self {
        Self {
            apm,
            enhanced: enhanced_noise_suppression,
            denoise: enhanced_noise_suppression.then(Denoiser::new),
            follow: None,
            seen: 0,
            gated: Arc::default(),
            voice: Arc::default(),
            gain: InputGain::default(),
            applied_gain: 1.0,
            lookahead: VecDeque::new(),
            framer: Framer::default(),
            input: Box::new([0.0; FRAME]),
            output: Box::new([0.0; FRAME]),
        }
    }

    /// Follow `processing` (the capture's shared one), whose generation
    /// `seen` this processor was built from: a replacement is taken on the
    /// next frame whose read of it does not wait.
    fn following(mut self, processing: Processing, seen: u64) -> Self {
        self.follow = Some(processing);
        self.seen = seen;
        self
    }

    /// Follow push-to-talk gate `gated` (the capture's shared one).
    pub fn gated_by(mut self, gated: Arc<AtomicBool>) -> Self {
        self.gated = gated;
        self
    }

    /// Follow voice gate `voice` (the capture's shared one).
    pub fn with_voice_gate(mut self, voice: Arc<Mutex<VoiceGate>>) -> Self {
        self.voice = voice;
        self
    }

    /// Follow input volume `gain` (the capture's shared one).
    pub fn with_input_gain(mut self, gain: InputGain) -> Self {
        self.applied_gain = gain.get();
        self.gain = gain;
        self
    }

    /// Feed mono samples (-1 to 1); each processed 10 ms frame goes to `out`.
    /// The input volume applies after the APM and RNNoise and before the
    /// voice gate, as on the web path (micProcessor's GainNode feeds the
    /// detector), so the gate and the level reports see what is sent.
    /// While the voice gate or push-to-talk's is closed the frame is zeroed
    /// after the APM and RNNoise ran, so their state stays warm for the next
    /// word or press.
    pub fn push(&mut self, samples: impl IntoIterator<Item = f32>, mut out: impl FnMut(&[i16])) {
        let Self {
            apm,
            enhanced,
            denoise,
            follow,
            seen,
            gated,
            voice,
            gain,
            applied_gain,
            lookahead,
            framer,
            input,
            output,
        } = self;
        framer.push(samples.into_iter().map(to_i16), |frame| {
            if let Some(follow) = follow {
                if let Some(Some((next, next_enhanced))) = follow.poll(seen) {
                    *apm = next;
                    *enhanced = next_enhanced;
                }
            }
            // RNNoise runs for the suppression, for the gate's verdict, or
            // both; it is dropped once neither wants it.
            let detect = lock(voice).wants_speech();
            let wanted = *enhanced || detect;
            if wanted != denoise.is_some() {
                *denoise = wanted.then(Denoiser::new);
            }
            let _ = apm.lock().process_stream(frame, SAMPLE_RATE as i32, 1);
            let mut probability = 0.0;
            if let Some(d) = denoise {
                // RNNoise takes 16-bit-range floats.
                input
                    .iter_mut()
                    .zip(frame.iter())
                    .for_each(|(i, s)| *i = f32::from(*s));
                probability = d.process(&mut output[..], &input[..]);
                if *enhanced {
                    frame
                        .iter_mut()
                        .zip(output.iter())
                        .for_each(|(s, o)| *s = o.clamp(-32768.0, 32767.0) as i16);
                }
            }
            let target = gain.get();
            apply_gain(frame, *applied_gain, target);
            *applied_gain = target;
            let (voiced, closed) = {
                let mut voice = lock(voice);
                (voice.on(), voice.observe(rms(frame), probability))
            };
            if voiced {
                if lookahead.is_empty() {
                    lookahead.resize(GATE_LOOKAHEAD_FRAMES * FRAME, 0);
                }
                lookahead.extend(frame.iter().copied());
                frame
                    .iter_mut()
                    .for_each(|s| *s = lookahead.pop_front().unwrap_or(0));
            } else {
                lookahead.clear();
            }
            if closed || gated.load(Ordering::Relaxed) {
                frame.fill(0);
            }
            out(frame);
        });
    }
}

/// A PulseAudio monitor source (`<sink>.monitor`) is the loopback of what a
/// sink plays, not a microphone; like the Pulse device module and Chrome, the
/// list leaves it out.
fn is_monitor(id: &str) -> bool {
    id.ends_with(".monitor")
}

pub(super) fn input_devices(host: &cpal::Host) -> Vec<(DeviceInfo, cpal::Device)> {
    let microphone = |d: &cpal::Device| d.id().is_ok_and(|id| !is_monitor(id.id()));
    host_devices(
        host.default_input_device().filter(microphone),
        host.input_devices()
            .into_iter()
            .flatten()
            .filter(microphone),
    )
}

pub fn list_inputs() -> Vec<DeviceInfo> {
    input_devices(&shared_default_host(Role::Devices))
        .into_iter()
        .map(|(i, _)| i)
        .collect()
}

/// Where processed 10 ms frames go. Lock order: the input callback's state
/// lock, then (Loopback) the mixer's; the playout callback takes the mixer's
/// alone.
#[derive(Clone)]
pub enum Sink {
    /// The published microphone track (a call).
    Track(NativeAudioSource),
    /// The mic test's own playout queue.
    Loopback(Arc<Mixer>),
}

impl Sink {
    fn deliver(&self, frame: &[i16]) {
        match self {
            Self::Track(source) => {
                // The source is unbuffered (queue 0), so this completes at once.
                let _ = source
                    .capture_frame(&AudioFrame {
                        data: frame.into(),
                        sample_rate: SAMPLE_RATE,
                        num_channels: 1,
                        samples_per_channel: FRAME as u32,
                    })
                    .now_or_never();
            }
            Self::Loopback(mixer) => mixer.push(LOOPBACK, frame),
        }
    }
}

/// The session's microphone: the selected device and, while unmuted, its
/// input stream feeding the published track's source (or the mic test's
/// loopback).
#[derive(Default)]
pub struct Capture {
    /// The selected id (empty: the default), shared with the watcher.
    selected: Selected,
    /// The device `selected` last resolved to (its id and handle), reused on
    /// unmute so a push-to-talk press does not enumerate devices. The watcher
    /// updates it when it re-resolves, so an unmute opens where it moved.
    resolved: Resolved,
    /// The open input stream, shared with the recovery watcher that replaces
    /// it after the sound server tears it down.
    stream: Input,
    feed: Feed,
    /// Set by the input stream's error callback when the sound server tears
    /// it down; the watcher reopens it.
    dead: Arc<AtomicBool>,
    /// Reopens a dead stream and, while "System default" is selected, follows
    /// the default source. Always-on so a torn-down stream recovers.
    watcher: Option<Watcher>,
}

/// The open input stream, shared with the watcher that replaces it.
type Input = Arc<Mutex<Option<cpal::Stream>>>;

/// The resolved device, shared with the watcher that re-resolves it.
type Resolved = Arc<Mutex<Option<(String, cpal::Device)>>>;

/// The audio processing and whether RNNoise follows it, shared with the
/// watcher.
type Processing = Arc<Shared<Option<(Arc<Apm>, bool)>>>;

/// What an input stream feeds: the processing and the published track's
/// sink, shared with the watcher so a reopen feeds the current ones.
#[derive(Default, Clone)]
struct Feed {
    processing: Processing,
    sink: Arc<Mutex<Option<Sink>>>,
    /// Push-to-talk's gate, followed by every stream opened from this feed.
    gated: Arc<AtomicBool>,
    /// The input-sensitivity gate, likewise.
    voice: Arc<Mutex<VoiceGate>>,
    /// The input volume, likewise.
    gain: InputGain,
}

impl Feed {
    fn ready(&self) -> bool {
        self.processing.snapshot().1.is_some() && lock(&self.sink).is_some()
    }

    /// A processor on the latest processing, which keeps following it.
    fn processor(&self) -> Result<Processor, String> {
        let (seen, current) = self.processing.snapshot();
        let (apm, denoise) = current.ok_or("audio processing is not set up")?;
        Ok(Processor::new(apm, denoise)
            .following(self.processing.clone(), seen)
            .gated_by(self.gated.clone())
            .with_voice_gate(self.voice.clone())
            .with_input_gain(self.gain.clone()))
    }

    fn open(&self, device: &cpal::Device, dead: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
        let processor = self.processor()?;
        let sink = lock(&self.sink).clone().ok_or("no capture sink")?;
        open_input(device, processor, sink, dead)
    }
}

impl Capture {
    /// `on_voice_gate` is told each time the voice gate opens or closes,
    /// `on_level` each level report.
    pub fn configure(
        &mut self,
        apm: Arc<Apm>,
        enhanced_noise_suppression: bool,
        on_voice_gate: GateSink,
        on_level: LevelSink,
    ) {
        self.feed
            .processing
            .set(Some((apm, enhanced_noise_suppression)));
        let mut voice = lock(&self.feed.voice);
        voice.report_to(on_voice_gate);
        voice.report_levels_to(on_level);
    }

    /// Replace the audio processing, on a running stream too: the input
    /// callback takes it on a later frame, without waiting for this thread,
    /// and a stopped (muted) capture opens its next stream with it.
    pub fn set_processing(&self, apm: Arc<Apm>, enhanced_noise_suppression: bool) {
        self.feed
            .processing
            .set(Some((apm, enhanced_noise_suppression)));
    }

    /// Set the input-sensitivity gate's threshold (0: no gate), on the web
    /// path's scale (`vadThreshold`). `retune` moves it without restarting
    /// the detector (automatic sensitivity's steps); `speech` adds RNNoise's
    /// verdict to the rule (automatic sensitivity) on a restart.
    pub fn set_voice_gate(&self, threshold: f32, retune: bool, speech: bool) {
        let mut voice = lock(&self.feed.voice);
        if retune {
            voice.retune(threshold);
        } else {
            voice.set_threshold(threshold, speech);
        }
    }

    /// Set the input volume as a linear gain (0 to 2).
    pub fn set_input_gain(&self, gain: f32) {
        self.feed.gain.set(gain);
    }

    /// Close or open push-to-talk's gate. The input stream stays as it is:
    /// a closed gate sends silence from an open capture (D5), so a press
    /// never waits on the device. Only a mute (`stop`) closes the capture.
    pub fn set_ptt_gated(&self, gated: bool) {
        self.feed.gated.store(gated, Ordering::Relaxed);
    }

    pub fn streams(&self) -> usize {
        usize::from(self.stream().is_some())
    }

    /// Start capturing into `sink` (the first unmute publishes a track's
    /// source). A cached device that no longer opens (unplugged) is resolved
    /// again once.
    pub fn start(&mut self, sink: Sink) -> Result<(), String> {
        *lock(&self.feed.sink) = Some(sink);
        if self.stream().is_some() {
            return Ok(());
        }
        let cached = lock(&self.resolved).as_ref().map(|(_, d)| d.clone());
        if let Some(device) = cached {
            if let Ok(stream) = self.open(&device) {
                *lock(&self.stream) = Some(stream);
                self.ensure_watcher();
                return Ok(());
            }
        }
        let selected = lock(&self.selected).clone();
        let listed = input_devices(&shared_default_host(Role::Capture));
        let (resolved, fell_back) = pick(&selected, listed)?;
        if fell_back {
            log::warn!("[native_voice] capture device {selected} not found; using the default");
        }
        *lock(&self.stream) = Some(self.open(&resolved.1)?);
        *lock(&self.resolved) = Some(resolved);
        self.ensure_watcher();
        Ok(())
    }

    /// Stop the input stream (mute), so the system's in-use indicator goes out.
    pub fn stop(&mut self) {
        *lock(&self.stream) = None;
    }

    fn stream(&self) -> Option<()> {
        lock(&self.stream).as_ref().map(|_| ())
    }

    /// Select device `id` (empty: the default), switching a running stream
    /// when it resolves to another device (the new stream opens before the
    /// old one closes, so a device that fails to open leaves capture
    /// running). Re-applying "" after a hot-plug so moves capture to a new
    /// default. An unknown id selects the default and reports the fallback as
    /// an error.
    pub fn set_device(&mut self, id: &str) -> Result<(), String> {
        let (resolved, fell_back) = pick(id, input_devices(&shared_default_host(Role::Capture)))?;
        let moved = lock(&self.resolved).as_ref().map(|(r, _)| r) != Some(&resolved.0);
        if self.stream().is_some() && moved {
            *lock(&self.stream) = Some(self.open(&resolved.1)?);
        }
        *lock(&self.resolved) = Some(resolved);
        *lock(&self.selected) = if fell_back {
            String::new()
        } else {
            id.to_string()
        };
        self.ensure_watcher();
        if fell_back {
            return Err(format!(
                "capture device {id} not found; switched to the default"
            ));
        }
        Ok(())
    }

    /// Start the recovery watcher once. It reopens a stream the sound server
    /// tore down and, while the empty default id is selected, follows the
    /// default source as it moves (voice #3/#4). Muted, it only re-resolves,
    /// so the next unmute opens the device the selection now names.
    fn ensure_watcher(&mut self) {
        if self.watcher.is_some() || !self.feed.ready() {
            return;
        }
        let host = WatchedHost::new(Role::Capture);
        let poll_host = host.clone();
        let selected = self.selected.clone();
        let resolved = self.resolved.clone();
        let dead = self.dead.clone();
        let feed = self.feed.clone();
        let stream = self.stream.clone();
        let pinned_returned = {
            let (host, resolved, selected) =
                (host.clone(), self.resolved.clone(), self.selected.clone());
            move || {
                let target = lock(&selected).clone();
                let current = lock(&resolved).as_ref().map(|(id, _)| id.clone());
                host.with(|h| {
                    let listed = std::iter::once(h).flat_map(input_devices);
                    pinned_listed(&target, current.as_deref(), listed.map(|(d, _)| d.id))
                })
            }
        };
        let follow = move || {
            // The watcher owns recovery: re-resolve (the default may have
            // moved) and replace the dead stream in the shared slot.
            let id = lock(&selected).clone();
            // Muted (no stream) means the user is not publishing; a pending
            // dead flag from just before the mute must not reopen the mic.
            let muted = lock(&stream).is_none();
            let Some(Ok((picked, _))) = host.reopen(|fresh| pick(&id, input_devices(fresh))) else {
                log::warn!("[native_voice] reopening the capture stream: no device");
                return muted;
            };
            match move_stream(&stream, &resolved, picked, |device| {
                feed.open(device, dead.clone())
            }) {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("[native_voice] reopening the capture stream: {e}");
                    false
                }
            }
        };
        self.watcher = Some(Watcher::start(
            FOLLOW_EVERY,
            lock(&self.resolved).as_ref().map(|(id, _)| id.clone()),
            self.dead.clone(),
            self.selected.clone(),
            move || poll_host.default_id(|h| h.default_input_device()),
            pinned_returned,
            follow,
        ));
    }

    fn open(&self, device: &cpal::Device) -> Result<cpal::Stream, String> {
        self.feed.open(device, self.dead.clone())
    }
}

/// Record `picked` as the resolved device and, while a stream runs, move it
/// there. The record follows the stream: a failed open leaves both on the old
/// device, so the watcher's next tick retries, and a mute while the new one
/// opened drops it (the next unmute opens `picked`).
fn move_stream<D, S>(
    stream: &Mutex<Option<S>>,
    resolved: &Mutex<Option<(String, D)>>,
    picked: (String, D),
    open: impl FnOnce(&D) -> Result<S, String>,
) -> Result<(), String> {
    if lock(stream).is_some() {
        let reopened = open(&picked.1)?;
        let mut slot = lock(stream);
        if slot.is_some() {
            *slot = Some(reopened);
        }
    }
    *lock(resolved) = Some(picked);
    Ok(())
}

/// The listed device `id` resolves to (its id and handle), and whether that
/// was a fallback to the default.
fn pick(
    id: &str,
    listed: Vec<(DeviceInfo, cpal::Device)>,
) -> Result<((String, cpal::Device), bool), String> {
    let infos: Vec<DeviceInfo> = listed.iter().map(|(i, _)| i.clone()).collect();
    let (index, fell_back) = resolve_device(id, &infos);
    let (info, device) = index
        .and_then(|i| listed.into_iter().find(|(d, _)| d.index == i))
        .ok_or("no capture device")?;
    Ok(((info.id, device), fell_back))
}

fn open_input(
    device: &cpal::Device,
    processor: Processor,
    sink: Sink,
    dead: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let supported = device
        .supported_input_configs()
        .map_err(|e| format!("capture device configs: {e}"))?;
    let channels = device.default_input_config().ok().map(|c| c.channels());
    let (config, format) = pick_config(supported, SAMPLE_RATE, channels)
        .ok_or("the capture device offers no 48 kHz format")?;
    // Shared by the two build attempts; only the one that succeeds runs.
    let state = Arc::new(Mutex::new((processor, sink)));
    let build = |buffer_size| {
        let config = cpal::StreamConfig {
            buffer_size,
            ..config
        };
        let (state, dead) = (state.clone(), dead.clone());
        typed!(format, build_input(device, config, state, dead))
    };
    let stream = build(cpal::BufferSize::Fixed(FRAME as u32))
        .or_else(|_| build(cpal::BufferSize::Default))
        .map_err(|e| format!("opening the capture stream: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("starting the capture stream: {e}"))?;
    Ok(stream)
}

/// Interleaved device samples (`width` channels) as mono f32 (-1 to 1).
fn to_mono<T>(data: &[T], width: usize) -> impl Iterator<Item = f32> + '_
where
    T: Sample,
    f32: FromSample<T>,
{
    data.chunks_exact(width)
        .map(move |f| f.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / width as f32)
}

fn build_input<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    state: Arc<Mutex<(Processor, Sink)>>,
    dead: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let width = usize::from(config.channels.max(1));
    device.build_input_stream::<T, _, _>(
        config,
        move |data, _| {
            let mut guard = lock(&state);
            let (processor, sink) = &mut *guard;
            processor.push(to_mono(data, width), |frame| sink.deliver(frame));
        },
        // A stream the sound server tore down (suspend/resume, a
        // pulseaudio restart) is reported only here: flag it so the
        // watcher reopens it, or the user goes silent to peers with no
        // signal (voice #3).
        move |e| {
            log::warn!("[native_voice] capture stream: {e}");
            dead.store(true, Ordering::Relaxed);
        },
        None,
    )
}

#[cfg(test)]
mod tests {
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
        let mut p = Processor::new(Apm::new(&opts(false, false)), true)
            .gated_by(capture.feed.gated.clone());
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
        let mut p =
            Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
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

    /// Automatic sensitivity's speech rule: a loud frame RNNoise does not
    /// call a voice does not count toward opening, and an open gate closes
    /// after the hold once the verdict goes away, loud or not.
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
    /// runs for its verdict only: the audio goes out as the plain chain's,
    /// and RNNoise is dropped once the gate no longer wants it.
    #[test]
    fn rnnoise_runs_for_the_verdict_alone_and_leaves_the_audio_as_it_is() {
        let input = noise(FRAME * 20, 0.1, 7);
        let (gate, _) = reporting_gate(0.02);
        lock(&gate).set_threshold(0.02, true);
        let mut plain = Processor::new(Apm::new(&opts(false, false)), false);
        let mut detecting =
            Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
        let expected = run(&mut plain, &input);
        let out = run(&mut detecting, &input);
        assert!(detecting.denoise.is_some(), "RNNoise runs for the verdict");
        assert!(!detecting.enhanced);
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
        let mut p =
            Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
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
        let mut p =
            Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
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
        let mut p =
            Processor::new(Apm::new(&opts(false, false)), false).with_voice_gate(gate.clone());
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
        let i24s = [1 << 22, -(1 << 22), -(1 << 23), 0, 1 << 21, 1 << 21]
            .map(|s| cpal::I24::new(s).unwrap());
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
}
