//! Microphone capture with the web path's processing (Linux native voice).
//!
//! The SDK's audio device module hands its capture straight to the encoder,
//! with no hook for RNNoise, so the microphone is our own `cpal` input
//! stream. Each 10 ms of mono 48 kHz audio goes through libwebrtc's
//! standalone audio processing module (APM): echo cancellation against what
//! `playout.rs` actually plays, noise suppression, gain control and a
//! high-pass filter. With Enhanced Noise Suppression on it then goes through
//! RNNoise (`nnnoiseless`), and into the published track's
//! `NativeAudioSource`. RNNoise runs after the APM, as on the web path, where
//! the browser's processing precedes the RNNoise worklet: the echo canceller
//! needs the linear echo path that RNNoise would break. Last, the
//! input-sensitivity gate (`VoiceGate`) and push-to-talk's gate decide
//! whether the frame goes out or silence does.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use futures_util::FutureExt;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::native::apm::AudioProcessingModule;
use nnnoiseless::DenoiseState;

use super::playout::{host_devices, pinned_listed, Selected, WatchedHost, Watcher, FOLLOW_EVERY};
use super::session::{resolve_device, AudioOptions, DeviceInfo};
use super::stream_format::{pick_config, typed};

/// A lock helper mirroring playout's, for the shared input-stream slot.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub const SAMPLE_RATE: u32 = 48_000;
/// One 10 ms frame: the APM's unit and RNNoise's (`nnnoiseless::FRAME_SIZE`).
pub const FRAME: usize = SAMPLE_RATE as usize / 100;

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
        self.0.lock().unwrap_or_else(|p| p.into_inner())
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
    apm: Arc<Apm>,
    framer: Framer,
}

impl Reference {
    pub fn new(apm: Arc<Apm>) -> Self {
        Self {
            apm,
            framer: Framer::default(),
        }
    }

    /// `out` is the interleaved buffer just filled for the device; playout
    /// uses only its first two (front) channels.
    pub fn feed(&mut self, out: &[f32], channels: usize) {
        let mono = out
            .chunks_exact(channels.max(1))
            .map(|f| to_i16(front_mono(f)));
        let apm = &self.apm;
        self.framer.push(mono, |frame| {
            // A failed frame only weakens the reference; nothing to recover.
            let _ = apm
                .lock()
                .process_reverse_stream(frame, SAMPLE_RATE as i32, 1);
        });
    }
}

/// The voice gate's timing, in 10 ms frames: vad-worklet.js's ~320 ms hold
/// below the threshold before closing, ~32 ms attack above it before
/// opening, and ~500 ms start-up grace.
const GATE_HOLD_FRAMES: u32 = 32;
const GATE_ATTACK_FRAMES: u32 = 3;
const GATE_GRACE_FRAMES: u32 = 50;
/// How far the voice runs behind the detector while the gate is on, so the
/// attack does not clip the start of a word (micProcessor's
/// GATE_LOOKAHEAD_S).
const GATE_LOOKAHEAD_FRAMES: usize = 5;

/// Told whether the voice gate is open after each change.
pub type GateSink = Arc<dyn Fn(bool) + Send + Sync>;

/// The input-sensitivity gate: the web path's voice detector
/// (vad-worklet.js) on the same level scale, the RMS (-1 to 1) of ~10 ms of
/// processed audio, so one slider position gates alike on both paths.
#[derive(Default)]
pub struct VoiceGate {
    /// The level that counts as speech; 0 runs no gate (sensitivity 100).
    threshold: f32,
    grace: u32,
    silent: u32,
    speech: u32,
    closed: bool,
    on_change: Option<GateSink>,
}

impl VoiceGate {
    pub fn report_to(&mut self, sink: GateSink) {
        self.on_change = Some(sink);
    }

    /// Restart the detector open at `threshold`, as the web path restarts its
    /// worklet on a slider move. Turning it off reopens without a report.
    pub fn set_threshold(&mut self, threshold: f32) {
        *self = Self {
            threshold: threshold.max(0.0),
            closed: self.closed,
            on_change: self.on_change.take(),
            ..Self::default()
        };
        if self.on() {
            self.set_closed(false);
        } else {
            self.closed = false;
        }
    }

    fn on(&self) -> bool {
        self.threshold > 0.0
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

    /// Take one frame's level; returns whether the gate is now closed.
    fn update(&mut self, rms: f32) -> bool {
        if self.grace < GATE_GRACE_FRAMES {
            self.grace += 1;
        } else if rms < self.threshold {
            self.speech = 0;
            self.silent = self.silent.saturating_add(1);
            if self.silent >= GATE_HOLD_FRAMES {
                self.set_closed(true);
            }
        } else {
            self.silent = 0;
            self.speech = self.speech.saturating_add(1);
            if self.speech >= GATE_ATTACK_FRAMES {
                self.set_closed(false);
            }
        }
        self.closed
    }
}

fn rms(frame: &[i16]) -> f32 {
    let power = frame.iter().map(|&s| f64::from(s).powi(2)).sum::<f64>() / frame.len() as f64;
    (power.sqrt() / 32768.0) as f32
}

/// The capture side: APM, then RNNoise when Enhanced Noise Suppression is on.
pub struct Processor {
    apm: Arc<Apm>,
    denoise: Option<Box<DenoiseState<'static>>>,
    /// Push-to-talk's gate: while set, every frame goes out as silence.
    gated: Arc<AtomicBool>,
    /// The input-sensitivity gate (the capture's shared one).
    voice: Arc<Mutex<VoiceGate>>,
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
            denoise: enhanced_noise_suppression.then(DenoiseState::new),
            gated: Arc::default(),
            voice: Arc::default(),
            lookahead: VecDeque::new(),
            framer: Framer::default(),
            input: Box::new([0.0; FRAME]),
            output: Box::new([0.0; FRAME]),
        }
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

    /// Feed mono samples (-1 to 1); each processed 10 ms frame goes to `out`.
    /// While the voice gate or push-to-talk's is closed the frame is zeroed
    /// after the APM and RNNoise ran, so their state stays warm for the next
    /// word or press.
    pub fn push(&mut self, samples: impl IntoIterator<Item = f32>, mut out: impl FnMut(&[i16])) {
        let Self {
            apm,
            denoise,
            gated,
            voice,
            lookahead,
            framer,
            input,
            output,
        } = self;
        framer.push(samples.into_iter().map(to_i16), |frame| {
            let _ = apm.lock().process_stream(frame, SAMPLE_RATE as i32, 1);
            if let Some(d) = denoise {
                // RNNoise takes 16-bit-range floats.
                input
                    .iter_mut()
                    .zip(frame.iter())
                    .for_each(|(i, s)| *i = f32::from(*s));
                d.process_frame(&mut output[..], &input[..]);
                frame
                    .iter_mut()
                    .zip(output.iter())
                    .for_each(|(s, o)| *s = o.clamp(-32768.0, 32767.0) as i16);
            }
            let (voiced, closed) = {
                let mut voice = lock(voice);
                (voice.on(), voice.on() && voice.update(rms(frame)))
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

fn input_devices(host: &cpal::Host) -> Vec<(DeviceInfo, cpal::Device)> {
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
    input_devices(&cpal::default_host())
        .into_iter()
        .map(|(i, _)| i)
        .collect()
}

/// The session's microphone: the selected device and, while unmuted, its
/// input stream feeding the published track's source.
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
type Processing = Arc<Mutex<Option<(Arc<Apm>, bool)>>>;

/// What an input stream feeds: the processing and the published track's
/// source, shared with the watcher so a reopen feeds the current ones.
#[derive(Default, Clone)]
struct Feed {
    processing: Processing,
    source: Arc<Mutex<Option<NativeAudioSource>>>,
    /// Push-to-talk's gate, followed by every stream opened from this feed.
    gated: Arc<AtomicBool>,
    /// The input-sensitivity gate, likewise.
    voice: Arc<Mutex<VoiceGate>>,
}

impl Feed {
    fn ready(&self) -> bool {
        lock(&self.processing).is_some() && lock(&self.source).is_some()
    }

    fn open(&self, device: &cpal::Device, dead: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
        let (apm, denoise) = lock(&self.processing)
            .clone()
            .ok_or("audio processing is not set up")?;
        let source = lock(&self.source).clone().ok_or("no microphone track")?;
        let processor = Processor::new(apm, denoise)
            .gated_by(self.gated.clone())
            .with_voice_gate(self.voice.clone());
        open_input(device, processor, source, dead)
    }
}

impl Capture {
    /// `on_voice_gate` is told each time the voice gate opens or closes.
    pub fn configure(
        &mut self,
        apm: Arc<Apm>,
        enhanced_noise_suppression: bool,
        on_voice_gate: GateSink,
    ) {
        *lock(&self.feed.processing) = Some((apm, enhanced_noise_suppression));
        lock(&self.feed.voice).report_to(on_voice_gate);
    }

    /// Set the input-sensitivity gate's threshold (0: no gate), on the web
    /// path's scale (`vadThreshold`).
    pub fn set_voice_gate(&self, threshold: f32) {
        lock(&self.feed.voice).set_threshold(threshold);
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

    /// Start capturing into `source` (the first unmute publishes it). A cached
    /// device that no longer opens (unplugged) is resolved again once.
    pub fn start(&mut self, source: NativeAudioSource) -> Result<(), String> {
        *lock(&self.feed.source) = Some(source);
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
        let listed = input_devices(&cpal::default_host());
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
        let (resolved, fell_back) = pick(id, input_devices(&cpal::default_host()))?;
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
        let host = WatchedHost::new();
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
    source: NativeAudioSource,
    dead: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let supported = device
        .supported_input_configs()
        .map_err(|e| format!("capture device configs: {e}"))?;
    let channels = device.default_input_config().ok().map(|c| c.channels());
    let (config, format) = pick_config(supported, SAMPLE_RATE, channels)
        .ok_or("the capture device offers no 48 kHz format")?;
    // Shared by the two build attempts; only the one that succeeds runs.
    let state = Arc::new(Mutex::new((processor, source)));
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
    state: Arc<Mutex<(Processor, NativeAudioSource)>>,
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
            let mut guard = state.lock().unwrap_or_else(|p| p.into_inner());
            let (processor, source) = &mut *guard;
            processor.push(to_mono(data, width), |frame| {
                // The source is unbuffered (queue 0), so this completes at once.
                let _ = source
                    .capture_frame(&AudioFrame {
                        data: frame.into(),
                        sample_rate: SAMPLE_RATE,
                        num_channels: 1,
                        samples_per_channel: FRAME as u32,
                    })
                    .now_or_never();
            });
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
        capture.configure(Apm::new(&opts(false, false)), false, Arc::new(|_| {}));
        assert!(!watchers.ready(), "no source yet");
        let source = NativeAudioSource::new(
            livekit::webrtc::audio_source::AudioSourceOptions::default(),
            SAMPLE_RATE,
            1,
            0,
        );
        *lock(&capture.feed.source) = Some(source);
        assert!(watchers.ready(), "the watcher sees the source set after it");
        *lock(&capture.feed.source) = None;
        assert!(!watchers.ready());
    }

    /// DP-30: push-to-talk's gate keeps the capture and its processing
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
        lock(&gate).set_threshold(threshold);
        (gate, reports)
    }

    /// The input-sensitivity gate on the web path's scale (vad-worklet.js):
    /// a level below the threshold closes it after the ~320 ms hold, one
    /// above opens it after the ~32 ms attack, and the voice runs 50 ms
    /// behind so that attack does not clip the start of the word. Each change
    /// is reported for the local speaking ring.
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

        let held: Vec<bool> = (0..45)
            .flat_map(|_| silent_frames(&mut p, &quiet))
            .collect();
        assert!(
            !held[..31].contains(&true),
            "the hold keeps it open: {held:?}"
        );
        assert!(
            held[33..].iter().all(|&s| s),
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
        lock(&gate).set_threshold(0.01);
        assert_eq!(*lock(&reports), [false, true]);
        // Turning it off reopens silently: the webview drops the verdict.
        run(&mut p, &noise(FRAME * 100, 0.001, 9));
        lock(&gate).set_threshold(0.0);
        assert_eq!(*lock(&reports), [false, true, false]);
    }

    /// The capture's gate is the one every stream it opens follows.
    #[test]
    fn the_voice_gate_is_shared_with_the_watchers_feed() {
        let capture = Capture::default();
        let watchers = capture.feed.clone();
        capture.set_voice_gate(0.03);
        assert_eq!(lock(&watchers.voice).threshold, 0.03);
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
}
