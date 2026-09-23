//! Remote-audio playout with a gain per participant (per-user volume).
//!
//! The SDK's audio device module (ADM) mixes every remote track itself and
//! exposes no per-track gain, so the ADM is never acquired and its playout
//! stays in the synthetic mode that still pumps the decode pipeline every
//! 10 ms; playout happens here instead: each subscribed remote audio track is
//! read as PCM through a `NativeAudioStream` (microphones mono, screen-share
//! audio stereo), queued per track, and the output stream mixes the queues
//! with each participant's gain into the device's front pair. What it plays
//! is also the echo canceller's reference (`capture::Reference`).
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use tokio::task::JoinHandle;

use super::capture::{Apm, Reference};
use super::session::{resolve_device, DeviceInfo};

pub const SAMPLE_RATE: u32 = 48_000;
/// A queue starts (or restarts after running dry) only once it holds this
/// much, so the 10 ms pushes and the device's larger pulls do not alternate
/// between sound and silence.
const PRIME: usize = SAMPLE_RATE as usize * 30 / 1000;
/// A queue that outgrows this (the device clock running slower than the
/// sender's) drops its oldest audio back to `PRIME`.
const MAX_QUEUED: usize = SAMPLE_RATE as usize * 200 / 1000;
/// The latency trim: a queue still holding more than `PRIME` plus one device
/// period after every pull, for this long without a break, has kept a backlog
/// a stall left behind (the steady level after a pull stays under that bound),
/// so its oldest audio is dropped back to `PRIME`. Two seconds is
/// deliberately slow: a burst of network jitter refills the queue for a
/// moment and must not cost audio, while a backlog that persists costs
/// mouth-to-ear delay for the rest of the call.
const TRIM_AFTER: usize = SAMPLE_RATE as usize * 2;
/// The device callback period: 20 ms, so about 40 ms of output latency.
const PERIOD_FRAMES: u32 = SAMPLE_RATE / 50;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Which of a participant's volumes a queue follows, as on the web path: the
/// microphone's (`RemoteParticipant.setVolume`) or the screen-share audio's
/// (the stream tile's volume and mute). Other audio plays at unity.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Volume {
    Microphone,
    ScreenShare,
}

impl Volume {
    fn of(source: TrackSource) -> Option<Self> {
        match source {
            TrackSource::Microphone => Some(Self::Microphone),
            TrackSource::ScreenshareAudio => Some(Self::ScreenShare),
            _ => None,
        }
    }
}

struct Queue {
    identity: String,
    volume: Option<Volume>,
    /// 1 (mono) or 2 (interleaved stereo).
    channels: usize,
    samples: VecDeque<i16>,
    primed: bool,
    /// Frames pulled in a row with the queue left above the trim bound.
    over: usize,
}

impl Queue {
    fn frames(&self) -> usize {
        self.samples.len() / self.channels
    }

    /// Drop the oldest audio, keeping the newest `frames`.
    fn keep_newest(&mut self, frames: usize) {
        let excess = self.samples.len().saturating_sub(frames * self.channels);
        self.samples.drain(..excess);
    }
}

#[derive(Default)]
struct MixerState {
    queues: HashMap<String, Queue>,
    /// Per identity, indexed by `Volume`.
    gains: [HashMap<String, f32>; 2],
}

/// 48 kHz queues, one per remote audio track, mixed on demand.
#[derive(Default)]
pub struct Mixer(Mutex<MixerState>);

impl Mixer {
    /// `identity`'s `volume`, 1.0 is unity. Kept for the session, so a gain
    /// set before the track arrives still applies.
    pub fn set_gain(&self, identity: &str, volume: Volume, gain: f32) {
        lock(&self.0).gains[volume as usize].insert(identity.to_string(), gain.max(0.0));
    }

    fn add(&self, sid: &str, identity: &str, volume: Option<Volume>, channels: usize) {
        lock(&self.0).queues.insert(
            sid.to_string(),
            Queue {
                identity: identity.to_string(),
                volume,
                channels,
                samples: VecDeque::with_capacity(MAX_QUEUED * channels),
                primed: false,
                over: 0,
            },
        );
    }

    fn remove(&self, sid: &str) {
        lock(&self.0).queues.remove(sid);
    }

    fn clear(&self) {
        lock(&self.0).queues.clear();
    }

    pub fn push(&self, sid: &str, samples: &[i16]) {
        let mut state = lock(&self.0);
        let Some(q) = state.queues.get_mut(sid) else {
            return;
        };
        q.samples.extend(samples);
        if q.frames() > MAX_QUEUED {
            q.keep_newest(PRIME);
        }
    }

    /// Fill interleaved `out` (`channels` wide) with the gained sum of every
    /// primed queue. Everything plays on the front pair (channels 0 and 1;
    /// PulseAudio's order puts front left and right first in every layout),
    /// mono on both; a centre, LFE or surround channel stays silent, and a
    /// mono device gets the pair's mean.
    pub fn mix(&self, out: &mut [f32], channels: usize) {
        out.fill(0.0);
        let channels = channels.max(1);
        let frames = out.len() / channels;
        let mut state = lock(&self.0);
        let MixerState { queues, gains } = &mut *state;
        for q in queues.values_mut() {
            if !q.primed {
                if q.frames() < PRIME {
                    continue;
                }
                q.primed = true;
            }
            let gain = q
                .volume
                .and_then(|v| gains[v as usize].get(&q.identity).copied())
                .unwrap_or(1.0)
                / 32768.0;
            let n = frames.min(q.frames());
            let stereo = q.channels == 2;
            let mut taken = q.samples.drain(..n * q.channels);
            for frame in out.chunks_exact_mut(channels).take(n) {
                let l = f32::from(taken.next().unwrap_or(0)) * gain;
                let r = if stereo {
                    f32::from(taken.next().unwrap_or(0)) * gain
                } else {
                    l
                };
                match frame {
                    [o] => *o += (l + r) / 2.0,
                    [ol, or, ..] => {
                        *ol += l;
                        *or += r;
                    }
                    [] => {}
                }
            }
            drop(taken);
            if n < frames {
                q.primed = false;
            }
            if q.frames() > PRIME + frames {
                q.over += frames;
                if q.over >= TRIM_AFTER {
                    q.keep_newest(PRIME);
                    q.over = 0;
                }
            } else {
                q.over = 0;
            }
        }
        out.iter_mut().for_each(|o| *o = o.clamp(-1.0, 1.0));
    }
}

type Readers = Arc<Mutex<HashMap<String, JoinHandle<()>>>>;

/// The room-event side of playout: starts and stops the per-track readers.
pub struct Listener {
    mixer: Arc<Mixer>,
    readers: Readers,
}

impl Listener {
    pub fn observe(&self, event: &RoomEvent) {
        match event {
            RoomEvent::TrackSubscribed {
                track: RemoteTrack::Audio(track),
                publication,
                participant,
            } => {
                let sid = publication.sid().to_string();
                let volume = Volume::of(publication.source());
                // Screen-share audio keeps the publisher's stereo.
                let channels = if volume == Some(Volume::ScreenShare) {
                    2
                } else {
                    1
                };
                self.mixer
                    .add(&sid, participant.identity().as_str(), volume, channels);
                let reader = tokio::spawn(read_track(
                    self.mixer.clone(),
                    sid.clone(),
                    track.clone(),
                    channels,
                ));
                if let Some(old) = lock(&self.readers).insert(sid, reader) {
                    old.abort();
                }
            }
            RoomEvent::TrackUnsubscribed { publication, .. } => {
                let sid = publication.sid().to_string();
                if let Some(reader) = lock(&self.readers).remove(&sid) {
                    reader.abort();
                }
                self.mixer.remove(&sid);
            }
            RoomEvent::Disconnected { .. } => stop_readers(&self.readers, &self.mixer),
            _ => {}
        }
    }
}

async fn read_track(mixer: Arc<Mixer>, sid: String, track: RemoteAudioTrack, channels: usize) {
    let mut stream = NativeAudioStream::new(track.rtc_track(), SAMPLE_RATE as i32, channels as i32);
    while let Some(frame) = stream.next().await {
        mixer.push(&sid, &frame.data);
    }
}

fn stop_readers(readers: &Readers, mixer: &Mixer) {
    lock(readers).drain().for_each(|(_, r)| r.abort());
    mixer.clear();
}

/// A host's devices, its default first and each listed once — the order and
/// id convention `session::Devices` promises the webview.
pub(super) fn host_devices(
    default: Option<cpal::Device>,
    others: impl Iterator<Item = cpal::Device>,
) -> Vec<(DeviceInfo, cpal::Device)> {
    let info = |d: &cpal::Device, index: usize| -> Option<DeviceInfo> {
        Some(DeviceInfo {
            id: d.id().ok()?.to_string(),
            name: d.description().ok()?.name().to_string(),
            index: index as u16,
        })
    };
    let mut listed: Vec<(DeviceInfo, cpal::Device)> = Vec::new();
    for d in default.into_iter().chain(others) {
        if let Some(i) = info(&d, listed.len()) {
            if listed.iter().all(|(l, _)| l.id != i.id) {
                listed.push((i, d));
            }
        }
    }
    listed
}

fn output_devices(host: &cpal::Host) -> Vec<(DeviceInfo, cpal::Device)> {
    host_devices(
        host.default_output_device(),
        host.output_devices().into_iter().flatten(),
    )
}

pub fn list_outputs() -> Vec<DeviceInfo> {
    output_devices(&cpal::default_host())
        .into_iter()
        .map(|(i, _)| i)
        .collect()
}

/// A session's playout: the mixer, its readers and the output stream.
#[derive(Default)]
pub struct Playout {
    mixer: Arc<Mixer>,
    readers: Readers,
    /// The open output stream and the id of the device it plays on.
    output: Option<(String, cpal::Stream)>,
    /// The processing whose echo canceller hears what is played.
    reference: Option<Arc<Apm>>,
}

impl Playout {
    pub fn listener(&self) -> Listener {
        Listener {
            mixer: self.mixer.clone(),
            readers: self.readers.clone(),
        }
    }

    pub fn mixer(&self) -> &Arc<Mixer> {
        &self.mixer
    }

    pub fn readers(&self) -> usize {
        lock(&self.readers).len()
    }

    /// Feed what is played to `apm`'s echo canceller, from the next
    /// (re)opened output stream on.
    pub fn set_reference(&mut self, apm: Arc<Apm>) {
        self.reference = Some(apm);
    }

    /// Open the output stream on device `id` (empty: the default), unless it
    /// already plays there. An unknown id opens the default and reports the
    /// fallback as an error, the same contract as the capture switch. A
    /// device that fails to open leaves the current stream playing.
    pub fn set_device(&mut self, id: &str) -> Result<(), String> {
        let mixer = self.mixer.clone();
        let reference = self.reference.clone().map(Reference::new);
        switch_output(
            &mut self.output,
            id,
            output_devices(&cpal::default_host()),
            |device| open_output(device, mixer, reference),
        )
    }
}

/// `Playout::set_device` over any listed devices and stream opener.
fn switch_output<D, S>(
    output: &mut Option<(String, S)>,
    id: &str,
    listed: Vec<(DeviceInfo, D)>,
    open: impl FnOnce(&D) -> Result<S, String>,
) -> Result<(), String> {
    let infos: Vec<DeviceInfo> = listed.iter().map(|(i, _)| i.clone()).collect();
    let (index, fell_back) = resolve_device(id, &infos);
    let (info, device) = index
        .and_then(|i| listed.into_iter().find(|(d, _)| d.index == i))
        .ok_or("no playout device")?;
    if output.as_ref().map(|(opened, _)| opened) != Some(&info.id) {
        let stream = open(&device)?;
        *output = Some((info.id, stream));
    }
    if fell_back {
        return Err(format!(
            "playout device {id} not found; switched to the default"
        ));
    }
    Ok(())
}

impl Drop for Playout {
    fn drop(&mut self) {
        stop_readers(&self.readers, &self.mixer);
    }
}

fn open_output(
    device: &cpal::Device,
    mixer: Arc<Mixer>,
    reference: Option<Reference>,
) -> Result<cpal::Stream, String> {
    let channels = device
        .default_output_config()
        .map_err(|e| format!("playout device config: {e}"))?
        .channels();
    // Shared by the two build attempts; only the one that succeeds runs.
    let reference = Arc::new(Mutex::new(reference));
    let build = |buffer_size| {
        let mixer = mixer.clone();
        let reference = reference.clone();
        device.build_output_stream::<f32, _, _>(
            cpal::StreamConfig {
                channels,
                sample_rate: SAMPLE_RATE,
                buffer_size,
            },
            move |out, _| {
                mixer.mix(out, channels as usize);
                if let Some(r) = lock(&reference).as_mut() {
                    r.feed(out, channels as usize);
                }
            },
            // ponytail: a lost device only logs; the sound servers move the
            // stream to another sink themselves, and switching device reopens it.
            |e| log::warn!("[native_voice] playout stream: {e}"),
            None,
        )
    };
    let stream = build(cpal::BufferSize::Fixed(PERIOD_FRAMES))
        .or_else(|_| build(cpal::BufferSize::Default))
        .map_err(|e| format!("opening the playout stream: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("starting the playout stream: {e}"))?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        switch_output(&mut output, "", sinks(&["speakers"]), &mut open).unwrap();
        switch_output(
            &mut output,
            "",
            sinks(&["speakers", "headphones"]),
            &mut open,
        )
        .unwrap();
        // Headphones plugged in and made the default sink.
        switch_output(
            &mut output,
            "",
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
        let result = switch_output(&mut output, "usb", sinks(&["speakers", "usb"]), |_| {
            Err::<&str, _>("busy".to_string())
        });
        assert_eq!(result, Err("busy".to_string()));
        assert_eq!(output, Some(("speakers".to_string(), "speakers")));
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
}
