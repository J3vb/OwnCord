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
//! needs the linear echo path that RNNoise would break.
use std::sync::{Arc, Mutex, MutexGuard};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::FutureExt;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::native::apm::AudioProcessingModule;
use nnnoiseless::DenoiseState;

use super::playout::host_devices;
use super::session::{resolve_device, AudioOptions, DeviceInfo};

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

/// The capture side: APM, then RNNoise when Enhanced Noise Suppression is on.
pub struct Processor {
    apm: Arc<Apm>,
    denoise: Option<Box<DenoiseState<'static>>>,
    framer: Framer,
    input: Box<[f32; FRAME]>,
    output: Box<[f32; FRAME]>,
}

impl Processor {
    pub fn new(apm: Arc<Apm>, enhanced_noise_suppression: bool) -> Self {
        Self {
            apm,
            denoise: enhanced_noise_suppression.then(DenoiseState::new),
            framer: Framer::default(),
            input: Box::new([0.0; FRAME]),
            output: Box::new([0.0; FRAME]),
        }
    }

    /// Feed mono samples (-1 to 1); each processed 10 ms frame goes to `out`.
    pub fn push(&mut self, samples: impl IntoIterator<Item = f32>, mut out: impl FnMut(&[i16])) {
        let Self {
            apm,
            denoise,
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
            out(frame);
        });
    }
}

fn input_devices(host: &cpal::Host) -> Vec<(DeviceInfo, cpal::Device)> {
    host_devices(
        host.default_input_device(),
        host.input_devices().into_iter().flatten(),
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
    /// The selected id (empty: the default).
    selected: String,
    /// The device `selected` last resolved to (its id and handle), reused on
    /// unmute so a push-to-talk press does not enumerate devices.
    resolved: Option<(String, cpal::Device)>,
    stream: Option<cpal::Stream>,
    processing: Option<(Arc<Apm>, bool)>,
    source: Option<NativeAudioSource>,
}

impl Capture {
    pub fn configure(&mut self, apm: Arc<Apm>, enhanced_noise_suppression: bool) {
        self.processing = Some((apm, enhanced_noise_suppression));
    }

    pub fn streams(&self) -> usize {
        usize::from(self.stream.is_some())
    }

    /// Start capturing into `source` (the first unmute publishes it). A cached
    /// device that no longer opens (unplugged) is resolved again once.
    pub fn start(&mut self, source: NativeAudioSource) -> Result<(), String> {
        self.source = Some(source);
        if self.stream.is_some() {
            return Ok(());
        }
        if let Some((_, device)) = &self.resolved {
            if let Ok(stream) = self.open(device) {
                self.stream = Some(stream);
                return Ok(());
            }
        }
        let listed = input_devices(&cpal::default_host());
        let (resolved, fell_back) = pick(&self.selected, listed)?;
        if fell_back {
            log::warn!(
                "[native_voice] capture device {} not found; using the default",
                self.selected
            );
        }
        self.stream = Some(self.open(&resolved.1)?);
        self.resolved = Some(resolved);
        Ok(())
    }

    /// Stop the input stream (mute), so the system's in-use indicator goes out.
    pub fn stop(&mut self) {
        self.stream = None;
    }

    /// Select device `id` (empty: the default), switching a running stream
    /// when it resolves to another device (the new stream opens before the
    /// old one closes, so a device that fails to open leaves capture
    /// running). Re-applying "" after a hot-plug so moves capture to a new
    /// default. An unknown id selects the default and reports the fallback as
    /// an error.
    pub fn set_device(&mut self, id: &str) -> Result<(), String> {
        let (resolved, fell_back) = pick(id, input_devices(&cpal::default_host()))?;
        let moved = self.resolved.as_ref().map(|(r, _)| r) != Some(&resolved.0);
        if self.stream.is_some() && moved {
            self.stream = Some(self.open(&resolved.1)?);
        }
        self.resolved = Some(resolved);
        self.selected = if fell_back {
            String::new()
        } else {
            id.to_string()
        };
        if fell_back {
            return Err(format!(
                "capture device {id} not found; switched to the default"
            ));
        }
        Ok(())
    }

    fn open(&self, device: &cpal::Device) -> Result<cpal::Stream, String> {
        let (apm, denoise) = self
            .processing
            .clone()
            .ok_or("audio processing is not set up")?;
        let source = self.source.clone().ok_or("no microphone track")?;
        open_input(device, Processor::new(apm, denoise), source)
    }
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
) -> Result<cpal::Stream, String> {
    let channels = device
        .default_input_config()
        .map_err(|e| format!("capture device config: {e}"))?
        .channels();
    let width = usize::from(channels.max(1));
    // Shared by the two build attempts; only the one that succeeds runs.
    let state = Arc::new(Mutex::new((processor, source)));
    let build = |buffer_size| {
        let state = state.clone();
        device.build_input_stream::<f32, _, _>(
            cpal::StreamConfig {
                channels,
                sample_rate: SAMPLE_RATE,
                buffer_size,
            },
            move |data, _| {
                let mut guard = state.lock().unwrap_or_else(|p| p.into_inner());
                let (processor, source) = &mut *guard;
                let mono = data
                    .chunks_exact(width)
                    .map(|f| f.iter().sum::<f32>() / width as f32);
                processor.push(mono, |frame| {
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
            |e| log::warn!("[native_voice] capture stream: {e}"),
            None,
        )
    };
    let stream = build(cpal::BufferSize::Fixed(FRAME as u32))
        .or_else(|_| build(cpal::BufferSize::Default))
        .map_err(|e| format!("opening the capture stream: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("starting the capture stream: {e}"))?;
    Ok(stream)
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

    #[test]
    fn the_reference_is_the_front_pair_mixed_to_mono() {
        assert_eq!(front_mono(&[0.2, 0.6]), 0.4);
        assert_eq!(front_mono(&[0.2, 0.6, 1.0, 1.0, 1.0, 1.0]), 0.4);
        assert_eq!(front_mono(&[0.3]), 0.3);
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
