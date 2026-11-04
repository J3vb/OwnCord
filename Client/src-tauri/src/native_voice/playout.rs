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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle as Thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use futures_util::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use tokio::task::JoinHandle;

use super::capture::{Apm, Reference, Shared};
use super::session::{resolve_device, DeviceInfo};
use super::stream_format::{pick_config, typed};
use crate::sync::lock;

pub const SAMPLE_RATE: u32 = 48_000;
/// The key, and identity, of the mic test's one queue in its own mixer.
pub const LOOPBACK: &str = "mic-test";
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
/// How often "System default" checks where the default device is. A default
/// changed in the system mixer raises no `devicechange`, so this poll is the
/// only thing that notices it, and it is also the interval at which a dead
/// stream is reopened.
pub(super) const FOLLOW_EVERY: Duration = Duration::from_secs(2);

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

    pub(super) fn add(&self, sid: &str, identity: &str, volume: Option<Volume>, channels: usize) {
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

    /// The mic test's queue: mono, on the microphone volume, under the
    /// fixed `LOOPBACK` key, so `set_gain(LOOPBACK, ..)` is its output gain.
    pub fn add_loopback(&self) {
        self.add(LOOPBACK, LOOPBACK, Some(Volume::Microphone), 1);
    }

    pub(super) fn remove(&self, sid: &str) {
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

pub(super) fn output_devices(host: &cpal::Host) -> Vec<(DeviceInfo, cpal::Device)> {
    host_devices(
        host.default_output_device(),
        host.output_devices().into_iter().flatten(),
    )
}

pub fn list_outputs() -> Vec<DeviceInfo> {
    output_devices(&shared_default_host(Role::Devices))
        .into_iter()
        .map(|(i, _)| i)
        .collect()
}

/// The open output stream and the id of the device it plays on.
type Output = Arc<Mutex<Option<(String, cpal::Stream)>>>;

/// The device id the caller last chose (empty: "System default"), shared
/// with the watcher so a later choice takes effect on its next tick.
pub(super) type Selected = Arc<Mutex<String>>;

/// Whether `target`, a pinned device the stream is not on (`current`), is
/// listed again. Nothing is pinned under "System default" (an empty
/// `target`), and `listed` is only walked while a pin is missing.
pub(super) fn pinned_listed(
    target: &str,
    current: Option<&str>,
    mut listed: impl Iterator<Item = impl AsRef<str>>,
) -> bool {
    !target.is_empty() && current != Some(target) && listed.any(|id| id.as_ref() == target)
}

/// Where a backend stands in cpal's own preference (PipeWire, PulseAudio,
/// then ALSA).
fn rank(id: cpal::HostId) -> usize {
    cpal::ALL_HOSTS
        .iter()
        .position(|h| *h == id)
        .unwrap_or(usize::MAX)
}

/// The best backend among `available` when it ranks above `current`, or is
/// `current` itself and `same_too` asks for a live one of it.
fn better_backend(
    current: cpal::HostId,
    available: &[cpal::HostId],
    same_too: bool,
) -> Option<cpal::HostId> {
    let best = available.iter().copied().min_by_key(|h| rank(*h))?;
    (rank(best) < rank(current) || (same_too && best == current)).then_some(best)
}

/// Process-wide hosts, one per backend. A PulseAudio host runs a reactor
/// thread that sleeps until the server sends something and only then notices
/// its handles are gone, so dropping an idle host leaves its server client,
/// thread and three fds behind until the process exits. Every caller therefore
/// shares one host per backend and role, and a host is replaced only after its
/// connection died (when the reactor has already exited, so dropping it frees
/// everything).
pub(super) struct HostPool<K, H> {
    slots: Mutex<Vec<(K, Arc<H>)>>,
}

impl<K, H> Default for HostPool<K, H> {
    fn default() -> Self {
        Self {
            slots: Mutex::new(Vec::new()),
        }
    }
}

impl<K: Copy + PartialEq, H> HostPool<K, H> {
    /// The pooled host for `id`, built when the slot is empty and rebuilt
    /// only when `alive` says its connection died. `None` when a build fails.
    /// `alive` is a server round trip, so it runs outside the lock; a caller
    /// that finds the slot changed meanwhile takes what another caller just
    /// stored, so racing callers build once and a live host is never dropped.
    pub(super) fn live(
        &self,
        id: K,
        build: impl FnOnce() -> Option<H>,
        alive: impl Fn(&H) -> bool,
    ) -> Option<Arc<H>> {
        let find =
            |slots: &[(K, Arc<H>)]| slots.iter().find(|(k, _)| *k == id).map(|(_, h)| h.clone());
        let seen = find(&lock(&self.slots));
        if let Some(host) = seen.as_ref().filter(|h| alive(h)) {
            return Some(host.clone());
        }
        let mut slots = lock(&self.slots);
        let stored = find(&slots);
        match (&stored, &seen) {
            (Some(now), Some(then)) if Arc::ptr_eq(now, then) => {}
            (Some(now), _) => return Some(now.clone()),
            (None, _) => {}
        }
        // Bounded by cpal's own connect timeout.
        let fresh = Arc::new(build()?);
        match slots.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = fresh.clone(),
            None => slots.push((id, fresh.clone())),
        }
        Some(fresh)
    }
}

/// Which pooled connection a caller shares. PulseAudio runs every stream's
/// callbacks on its connection's one reactor thread, so capture and playout
/// keep a connection each (as they had before the pool) and capture
/// processing never delays what is played; listings and the hot-plug poll
/// share a third.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Role {
    Devices,
    Capture,
    Playout,
}

static HOSTS: LazyLock<HostPool<(cpal::HostId, Role), cpal::Host>> =
    LazyLock::new(HostPool::default);

/// The pooled host for backend `id`. Only a lost connection counts as dead: a
/// live host dropped over any other error would leak again. ALSA has no
/// connection to die.
fn pooled_host(id: cpal::HostId, role: Role) -> Option<Arc<cpal::Host>> {
    HOSTS.live(
        (id, role),
        || cpal::host_from_id(id).ok(),
        |host| {
            id != cpal::HostId::PulseAudio
                || host.devices().map_or_else(
                    |e| {
                        !matches!(
                            e.kind(),
                            cpal::ErrorKind::StreamInvalidated | cpal::ErrorKind::HostUnavailable
                        )
                    },
                    |_| true,
                )
        },
    )
}

/// What `cpal::default_host()` picks (the best backend that is up, in cpal's
/// own order), through the pool. Only when not even ALSA builds does it fall
/// back to cpal's own, unpooled pick.
pub(super) fn shared_default_host(role: Role) -> Arc<cpal::Host> {
    let mut up = cpal::available_hosts();
    up.sort_by_key(|h| rank(*h));
    up.into_iter()
        .find_map(|id| pooled_host(id, role))
        .unwrap_or_else(|| Arc::new(cpal::default_host()))
}

/// The sound-server host a watcher polls and reopens through. A sound-server
/// restart kills a host's connection for good, so it is rebuilt (once, in the
/// shared pool); but while the server is down cpal's default is ALSA, whose
/// constant `default` device would hide every later move of the real default,
/// so a rebuild never settles on a lower backend than the one in use, and a
/// lower one in use is replaced as soon as the preferred backend is back.
pub(super) struct WatchedHost(Mutex<Arc<cpal::Host>>, Role);

impl WatchedHost {
    pub(super) fn new(role: Role) -> Arc<Self> {
        Arc::new(Self(Mutex::new(shared_default_host(role)), role))
    }

    /// `f` over a live connection to the best backend up now, no lower than
    /// the one in use (rebuilt only if the old one died), which then serves
    /// the polls. `None` while only a lower backend answers (the sound server
    /// is still restarting).
    pub(super) fn reopen<R>(&self, f: impl FnOnce(&cpal::Host) -> R) -> Option<R> {
        let mut host = lock(&self.0);
        let id = better_backend(host.id(), &cpal::available_hosts(), true)?;
        let fresh = pooled_host(id, self.1)?;
        let result = f(&fresh);
        *host = fresh;
        Some(result)
    }

    /// `f` over the host in use.
    pub(super) fn with<R>(&self, f: impl FnOnce(&cpal::Host) -> R) -> R {
        f(&lock(&self.0))
    }

    /// The id of the default device per `default`. A host that does not
    /// answer is replaced by a live one so the next poll asks a live
    /// connection, and a fallback backend is replaced once the preferred one
    /// is back.
    pub(super) fn default_id(
        &self,
        default: impl Fn(&cpal::Host) -> Option<cpal::Device>,
    ) -> Option<String> {
        let mut host = lock(&self.0);
        let id = default(&host)
            .and_then(|d| d.id().ok())
            .map(|d| d.to_string());
        if let Some(better) = better_backend(host.id(), &cpal::available_hosts(), id.is_none()) {
            if let Some(fresh) = pooled_host(better, self.1) {
                *host = fresh;
            }
        }
        id
    }
}

/// A session's playout: the mixer, its readers and the output stream.
#[derive(Default)]
pub struct Playout {
    mixer: Arc<Mixer>,
    readers: Readers,
    /// Shared with the watcher, which reopens it when the default moves or
    /// the stream dies.
    output: Output,
    /// The processing whose echo canceller hears what is played.
    /// Shared with every output stream, so a replacement reaches the one
    /// playing.
    reference: Arc<Shared<Option<Arc<Apm>>>>,
    /// Set by the output stream's error callback when the sound server tears
    /// the stream down. The watcher polls it and reopens.
    dead: Arc<AtomicBool>,
    /// The device the caller last chose (empty: the default). A reopen
    /// re-pins it; the empty id re-resolves the current default.
    selected: Selected,
    /// Reopens a dead stream and, while "System default" is selected,
    /// follows the default sink. Always-on so a stream torn down by the sound
    /// server reopens even when a concrete device is pinned.
    watcher: Option<Watcher>,
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

    /// Feed what is played to `apm`'s echo canceller. A playing stream
    /// follows the change on a later buffer.
    pub fn set_reference(&mut self, apm: Arc<Apm>) {
        self.reference.set(Some(apm));
    }

    /// Open the output stream on device `id` (empty: the default), unless it
    /// already plays there. An unknown id opens the default and reports the
    /// fallback as an error, the same contract as the capture switch. A
    /// device that fails to open leaves the current stream playing.
    ///
    /// One watcher starts on the first call and stays for the playout's life.
    /// It reopens a stream the sound server tore down (the stream's error
    /// callback sets `dead`) and, while the empty "System default" id is
    /// selected, follows the default sink as it moves. A concrete id is
    /// re-pinned to that id on reopen; the empty id re-resolves the default.
    pub fn set_device(&mut self, id: &str) -> Result<(), String> {
        *lock(&self.selected) = id.to_string();
        let result = self.switch(id);
        if self.watcher.is_none() {
            self.watcher = Some(self.start_watcher());
        }
        result
    }

    /// Whether an echo canceller hears what is played (the mic test must
    /// never have one).
    #[cfg(test)]
    pub(super) fn reference_is_set(&self) -> bool {
        self.reference.snapshot().1.is_some()
    }

    /// The current stream's device id, or None when nothing plays.
    pub(super) fn playing(&self) -> Option<String> {
        lock(&self.output).as_ref().map(|(id, _)| id.clone())
    }

    /// Open/reopen the stream for `id` (empty re-resolves the default).
    fn switch(&self, id: &str) -> Result<(), String> {
        let host = shared_default_host(Role::Playout);
        let reference = self.reference.clone();
        let fell_back = switch_output(
            &mut lock(&self.output),
            id,
            false,
            output_devices(&host),
            |device| {
                open_output(
                    device,
                    self.mixer.clone(),
                    Some(Reference::following(reference)),
                    self.dead.clone(),
                )
            },
        )?;
        if fell_back {
            return Err(format!(
                "playout device {id} not found; switched to the default"
            ));
        }
        Ok(())
    }

    fn start_watcher(&self) -> Watcher {
        let host = WatchedHost::new(Role::Playout);
        let poll_host = host.clone();
        let output = self.output.clone();
        let mixer = self.mixer.clone();
        let reference = self.reference.clone();
        let dead = self.dead.clone();
        let selected = self.selected.clone();
        let follow_dead = dead.clone();
        let pinned_returned = {
            let (host, output, selected) =
                (host.clone(), self.output.clone(), self.selected.clone());
            move || {
                let target = lock(&selected).clone();
                let playing = lock(&output).as_ref().map(|(id, _)| id.clone());
                host.with(|h| {
                    let listed = std::iter::once(h).flat_map(output_devices);
                    pinned_listed(&target, playing.as_deref(), listed.map(|(d, _)| d.id))
                })
            }
        };
        let follow = move || {
            let target = lock(&selected).clone();
            // Always reopen: a dead stream is usually still on the same
            // sink, so "already plays there" must not skip it.
            let Some(result) = host.reopen(|fresh| {
                switch_output(
                    &mut lock(&output),
                    &target,
                    true,
                    output_devices(fresh),
                    |device| {
                        open_output(
                            device,
                            mixer.clone(),
                            Some(Reference::following(reference.clone())),
                            follow_dead.clone(),
                        )
                    },
                )
            }) else {
                log::warn!("[native_voice] reopening the playout stream: no sound server yet");
                return false;
            };
            match result {
                Ok(fell_back) => {
                    if fell_back {
                        log::warn!(
                            "[native_voice] playout device {target} not found; using the default"
                        );
                    }
                    true
                }
                Err(e) => {
                    log::warn!("[native_voice] reopening the playout stream: {e}");
                    false
                }
            }
        };
        Watcher::start(
            FOLLOW_EVERY,
            self.playing(),
            dead,
            self.selected.clone(),
            move || poll_host.default_id(|h| h.default_output_device()),
            pinned_returned,
            follow,
        )
    }
}

/// A thread that reopens a dead audio stream (the error callback set `dead`)
/// and, while `selected` is the empty "System default" id, calls `follow`
/// each time that default moves. `follow` reports whether it reopened; a
/// failed reopen of a dead stream (the sound server still restarting) is
/// retried on the next tick, as is a failed follow of a default move. A
/// reopen that fell back from a pinned device
/// (not listed yet after the restart) is followed again once
/// `pinned_returned` says that device is listed. `selected` is read on every tick, so a
/// device chosen after the watcher started is honoured. Dropping it stops
/// and joins the thread. Shared by the playout (default sink) and the
/// capture (default source).
pub(super) struct Watcher {
    stop: mpsc::Sender<()>,
    thread: Option<Thread<()>>,
}

impl Watcher {
    /// `playing` is the device the stream is on; `default_device` reports the
    /// current default's id (`None` when the sound server did not answer,
    /// which is never taken for a change).
    pub(super) fn start(
        every: Duration,
        playing: Option<String>,
        dead: Arc<AtomicBool>,
        selected: Selected,
        mut default_device: impl FnMut() -> Option<String> + Send + 'static,
        mut pinned_returned: impl FnMut() -> bool + Send + 'static,
        mut follow: impl FnMut() -> bool + Send + 'static,
    ) -> Self {
        let (stop, stopped) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut last = playing;
            while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(every) {
                if dead.swap(false, Ordering::Relaxed) {
                    if !follow() {
                        dead.store(true, Ordering::Relaxed);
                    }
                    continue;
                }
                if pinned_returned() {
                    follow();
                    continue;
                }
                // Tracked while pinned too, so returning to the default
                // does not take the move that happened meanwhile for a new
                // one.
                if let Some(now) = default_device() {
                    if last.as_ref() != Some(&now) {
                        last = Some(now);
                        if lock(&selected).is_empty() && !follow() {
                            dead.store(true, Ordering::Relaxed);
                        }
                    }
                }
            }
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// `Playout::set_device` over any listed devices and stream opener, and
/// whether `id` fell back to the default. `reopen` opens a new stream even
/// when `output` already plays on the resolved device (the watcher's path: a
/// dead stream stays on its sink).
fn switch_output<D, S>(
    output: &mut Option<(String, S)>,
    id: &str,
    reopen: bool,
    listed: Vec<(DeviceInfo, D)>,
    open: impl FnOnce(&D) -> Result<S, String>,
) -> Result<bool, String> {
    let infos: Vec<DeviceInfo> = listed.iter().map(|(i, _)| i.clone()).collect();
    let (index, fell_back) = resolve_device(id, &infos);
    let (info, device) = index
        .and_then(|i| listed.into_iter().find(|(d, _)| d.index == i))
        .ok_or("no playout device")?;
    if reopen || output.as_ref().map(|(opened, _)| opened) != Some(&info.id) {
        let stream = open(&device)?;
        *output = Some((info.id, stream));
    }
    Ok(fell_back)
}

impl Drop for Playout {
    fn drop(&mut self) {
        self.watcher = None;
        stop_readers(&self.readers, &self.mixer);
    }
}

fn open_output(
    device: &cpal::Device,
    mixer: Arc<Mixer>,
    reference: Option<Reference>,
    dead: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let mut reference = reference;
    open_stream(
        device,
        "playout",
        move |mixed: &mut [f32], channels| {
            mixer.mix(mixed, channels);
            if let Some(r) = reference.as_mut() {
                r.feed(mixed, channels);
            }
        },
        dead,
    )
}

/// Play `samples` (mono, 48 kHz) once on `device` through a stream of its own,
/// then silence. The stream outlives the sound until it is dropped, so the
/// owner drops it. App sounds use this: each play is its own stream, which the
/// sound server mixes with the others and with a call.
pub(super) fn open_once(
    device: &cpal::Device,
    samples: Arc<[f32]>,
) -> Result<cpal::Stream, String> {
    let mut at = 0;
    open_stream(
        device,
        "app sound",
        move |mixed: &mut [f32], channels| {
            write_once(&samples, &mut at, mixed, channels);
        },
        Arc::new(AtomicBool::new(false)),
    )
}

/// One pull of a one-shot: the next samples of `samples` (from `at`) on the
/// front pair of each frame (mono on both, the pair's mean on a mono device,
/// as `Mixer::mix` does), silence on every other channel and after the end.
/// Whether the sound has now been handed over in full.
fn write_once(samples: &[f32], at: &mut usize, out: &mut [f32], channels: usize) -> bool {
    out.fill(0.0);
    for frame in out.chunks_exact_mut(channels.max(1)) {
        let Some(&s) = samples.get(*at) else {
            break;
        };
        *at += 1;
        match frame {
            [o] => *o = (s + s) / 2.0,
            [l, r, ..] => {
                *l = s;
                *r = s;
            }
            [] => {}
        }
    }
    *at >= samples.len()
}

/// Open an f32 48 kHz output stream on `device` whose audio is whatever
/// `source` writes: it is handed a buffer of whole frames and the channel
/// count, and fills it. `dead` is set when the sound server tears the stream
/// down; `label` names the stream in that log line.
fn open_stream(
    device: &cpal::Device,
    label: &'static str,
    source: impl FnMut(&mut [f32], usize) + Send + 'static,
    dead: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let supported = device
        .supported_output_configs()
        .map_err(|e| format!("playout device configs: {e}"))?;
    let channels = device.default_output_config().ok().map(|c| c.channels());
    let (config, format) = pick_config(supported, SAMPLE_RATE, channels)
        .ok_or("the playout device offers no 48 kHz format")?;
    // Shared by the two build attempts; only the one that succeeds runs.
    let source = Arc::new(Mutex::new(source));
    let build = |buffer_size| {
        let config = cpal::StreamConfig {
            buffer_size,
            ..config
        };
        let (source, dead) = (source.clone(), dead.clone());
        typed!(format, build_output(device, config, label, source, dead))
    };
    let stream = build(cpal::BufferSize::Fixed(PERIOD_FRAMES))
        .or_else(|_| build(cpal::BufferSize::Default))
        .map_err(|e| format!("opening the playout stream: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("starting the playout stream: {e}"))?;
    Ok(stream)
}

/// The most of one device pull mixed at once: 100 ms. A larger pull is mixed
/// in pieces, so the mix buffer is allocated when the stream is built, never
/// in its callback.
const MIX_FRAMES: usize = SAMPLE_RATE as usize / 10;

/// Fill device buffer `out` (`channels` wide) with what `source` makes in f32
/// in `mixed` (a whole number of frames), converted to the device's format.
fn fill_with<T>(
    out: &mut [T],
    mixed: &mut [f32],
    channels: usize,
    source: &mut impl FnMut(&mut [f32], usize),
) where
    T: Sample + FromSample<f32>,
{
    for out in out.chunks_mut(mixed.len()) {
        let mixed = &mut mixed[..out.len()];
        source(mixed, channels);
        for (o, s) in out.iter_mut().zip(mixed.iter()) {
            *o = s.to_sample();
        }
    }
}

fn build_output<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    label: &'static str,
    source: Arc<Mutex<impl FnMut(&mut [f32], usize) + Send + 'static>>,
    dead: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels.max(1));
    let mut mixed = vec![0.0; MIX_FRAMES * channels];
    device.build_output_stream::<T, _, _>(
        config,
        move |out, _| fill_with(out, &mut mixed, channels, &mut *lock(&source)),
        // A stream the sound server tore down (suspend/resume, a
        // pulseaudio restart) is only reported here: flag it so the
        // watcher reopens it, or the call goes silently dead in this
        // direction (voice #3).
        move |e| {
            log::warn!("[native_voice] {label} stream: {e}");
            dead.store(true, Ordering::Relaxed);
        },
        None,
    )
}

#[cfg(test)]
mod tests;
