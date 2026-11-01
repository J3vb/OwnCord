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
/// second toward closing (the gate's speech rule).
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
    /// The speech rule, at either sensitivity: a frame also needs RNNoise's
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
    /// worklet on a slider move; `speech_gate` adds RNNoise's verdict.
    /// Turning it off reopens without a report.
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
    /// verdict to the rule on a restart.
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
mod tests;
