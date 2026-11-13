//! App sounds on the chosen output (Linux).
//!
//! The webview sends a tone spec (`soundTables.ts`, the one source of
//! truth); `render` synthesizes it and each play opens its own
//! short-lived output stream on the device chosen in settings, in or out of a
//! call. Overlapping sounds are separate streams the sound server mixes, so
//! nothing here manages a shared mixer. `AppSounds` holds the live streams
//! (at most `MAX_SOUNDS`), so a ring burst can be cut by id.
//!
//! Lock rule: the registry's std mutex is never held while a stream is
//! opened or dropped, and never taken together with `NativeVoiceState`'s
//! `inner`.

use std::collections::VecDeque;
use std::f64::consts::TAU;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use cpal::traits::HostTrait as _;
use serde::Deserialize;

use super::playout::{open_once, output_devices, Role, WatchedHost, SAMPLE_RATE};
use super::session::{resolve_device, DeviceInfo};
use crate::sync::lock;

/// The most notes one sound may have.
const MAX_NOTES: usize = 32;
/// The most frequency steps one note may have.
const MAX_STEPS: usize = 8;
/// The longest sound, in seconds. Bounds the allocation from IPC input.
const MAX_SECONDS: f32 = 2.0;
/// The most sounds playing at once; the oldest is cut past it.
pub const MAX_SOUNDS: usize = 8;
/// How long past its end a sound's stream is kept, so the device drains it.
const DRAIN: Duration = Duration::from_millis(300);

/// One note of a tone spec: a sine whose frequency steps at the given offsets,
/// with an exponential fade from `gain` to `end_gain` over `duration`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToneNote {
    /// Seconds from the start of the sound.
    pub at: f32,
    pub duration: f32,
    pub gain: f32,
    pub end_gain: f32,
    /// `(offset from the note's start in seconds, hertz)`.
    pub freqs: Vec<(f32, f32)>,
    /// Seconds the gain takes to rise linearly from 0 to `gain`; the fade to
    /// `end_gain` then runs from there to `duration`.
    #[serde(default)]
    pub attack: f32,
    /// Seconds after `duration` over which the gain falls linearly from
    /// `end_gain` to 0.
    #[serde(default)]
    pub release: f32,
    /// Slide exponentially from each frequency point to the next instead of
    /// stepping; after the last point the frequency holds.
    #[serde(default)]
    pub glide: bool,
}

fn samples_of(seconds: f32) -> usize {
    (seconds * SAMPLE_RATE as f32).round() as usize
}

fn valid(note: &ToneNote) -> bool {
    let finite = [
        note.at,
        note.duration,
        note.gain,
        note.end_gain,
        note.attack,
        note.release,
    ]
    .iter()
    .all(|v| v.is_finite())
        && note
            .freqs
            .iter()
            .all(|(o, hz)| o.is_finite() && hz.is_finite());
    finite
        && note.at >= 0.0
        && note.duration > 0.0
        && (0.0..=1.0).contains(&note.gain)
        && note.gain > 0.0
        && (0.0..=1.0).contains(&note.end_gain)
        && note.end_gain > 0.0
        && note.attack >= 0.0
        && note.attack < note.duration
        && note.release >= 0.0
        && !note.freqs.is_empty()
        && note.freqs.len() <= MAX_STEPS
        && note.freqs.windows(2).all(|w| w[0].0 <= w[1].0)
        && note
            .freqs
            .iter()
            .all(|&(o, hz)| o >= 0.0 && hz > 0.0 && hz < SAMPLE_RATE as f32 / 2.0)
}

/// The note's gain at `t` seconds into it: a linear rise over `attack`, then
/// `gain * (end/gain)^((t - attack)/(duration - attack))` up to `duration`,
/// then a linear fall from `end_gain` to 0 over `release`.
fn envelope(note: &ToneNote, t: f32) -> f32 {
    if t < note.attack {
        return note.gain * t / note.attack;
    }
    if t <= note.duration || note.release <= 0.0 {
        let fade = (t - note.attack) / (note.duration - note.attack);
        return note.gain * (note.end_gain / note.gain).powf(fade);
    }
    (note.end_gain * (1.0 - (t - note.duration) / note.release)).max(0.0)
}

/// The note's frequency at sample `i`: the last point at or before it, or,
/// with `glide`, on the way from that point to the next,
/// `f0 * (f1/f0)^((t - o0)/(o1 - o0))`.
fn frequency(steps: &[(usize, f32, f64)], glide: bool, i: usize) -> f64 {
    let Some(k) = steps.iter().rposition(|(from, _, _)| *from <= i) else {
        return steps[0].2;
    };
    let (_, o0, f0) = steps[k];
    match steps.get(k + 1) {
        Some(&(_, o1, f1)) if glide && o1 > o0 => {
            let t = i as f32 / SAMPLE_RATE as f32;
            let x = f64::from(((t - o0) / (o1 - o0)).clamp(0.0, 1.0));
            f0 * (f1 / f0).powf(x)
        }
        _ => f0,
    }
}

/// Render `notes` to mono 48 kHz at `master` (the app-sounds volume). Each
/// note is a sine on a phase accumulator, so a frequency step or glide is
/// phase-continuous, cut at `at + duration + release`; the notes are summed
/// and clamped.
pub fn render(notes: &[ToneNote], master: f32) -> Result<Vec<f32>, String> {
    if notes.is_empty() || notes.len() > MAX_NOTES {
        return Err(format!("a sound has 1 to {MAX_NOTES} notes"));
    }
    if !(0.0..=1.0).contains(&master) {
        return Err("the sound volume is not a number from 0 to 1".into());
    }
    if !notes.iter().all(valid) {
        return Err("a note has a non-finite or out-of-range value".into());
    }
    let end = notes
        .iter()
        .map(|n| n.at + n.duration + n.release)
        .fold(0.0, f32::max);
    if end > MAX_SECONDS {
        return Err(format!("a sound is at most {MAX_SECONDS} s long"));
    }
    let mut out = vec![0.0f32; samples_of(end) + 1];
    for note in notes {
        let start = samples_of(note.at);
        let steps: Vec<(usize, f32, f64)> = note
            .freqs
            .iter()
            .map(|&(offset, hz)| (samples_of(offset), offset, f64::from(hz)))
            .collect();
        let mut phase = 0.0f64;
        for i in 0..samples_of(note.duration + note.release) {
            let hz = frequency(&steps, note.glide, i);
            let t = i as f32 / SAMPLE_RATE as f32;
            if let Some(o) = out.get_mut(start + i) {
                *o += (phase.sin() as f32) * envelope(note, t) * master;
            }
            phase = (phase + TAU * hz / f64::from(SAMPLE_RATE)) % TAU;
        }
    }
    out.iter_mut().for_each(|s| {
        *s = if s.is_finite() {
            s.clamp(-1.0, 1.0)
        } else {
            0.0
        }
    });
    Ok(out)
}

/// The live sounds, oldest first.
pub(super) struct Sounds<S> {
    next: u64,
    playing: VecDeque<(u64, S)>,
}

impl<S> Default for Sounds<S> {
    fn default() -> Self {
        Self {
            next: 1,
            playing: VecDeque::new(),
        }
    }
}

impl<S> Sounds<S> {
    /// Register `sound`; its id, and the oldest sounds cut to stay within
    /// `MAX_SOUNDS`, for the caller to drop outside the lock.
    pub(super) fn push(&mut self, sound: S) -> (u64, Vec<S>) {
        let id = self.next;
        self.next += 1;
        self.playing.push_back((id, sound));
        let mut cut = Vec::new();
        while self.playing.len() > MAX_SOUNDS {
            cut.extend(self.playing.pop_front().map(|(_, s)| s));
        }
        (id, cut)
    }

    /// Remove sound `id`; None when it is unknown or already gone.
    pub(super) fn take(&mut self, id: u64) -> Option<S> {
        let at = self.playing.iter().position(|(i, _)| *i == id)?;
        self.playing.remove(at).map(|(_, s)| s)
    }
}

/// The managed registry of live app-sound streams, and the sound-server host
/// they open on (built on the first play, off the async workers, and kept so
/// a play does not pay the host lookup and its round trips). Cloning shares both, so the
/// removal task of each play holds its own handle.
pub struct AppSounds<S = cpal::Stream> {
    sounds: Arc<Mutex<Sounds<S>>>,
    host: Arc<OnceLock<Arc<WatchedHost>>>,
}

impl<S> Default for AppSounds<S> {
    fn default() -> Self {
        Self {
            sounds: Arc::default(),
            host: Arc::default(),
        }
    }
}

impl<S> Clone for AppSounds<S> {
    fn clone(&self) -> Self {
        Self {
            sounds: self.sounds.clone(),
            host: self.host.clone(),
        }
    }
}

impl<S> AppSounds<S> {
    /// Register a started stream. Its id, and the sounds it displaced, which
    /// the caller releases with `release` once the lock is gone.
    pub(super) fn register(&self, sound: S) -> (u64, Vec<S>) {
        lock(&self.sounds).push(sound)
    }

    /// Remove sound `id` for the caller to release; an unknown or finished id
    /// gives None.
    pub(super) fn take(&self, id: u64) -> Option<S> {
        lock(&self.sounds).take(id)
    }
}

/// Drop `sound` on a blocking thread: closing a cpal stream joins the sound
/// server's worker threads, which must not stall an async worker.
fn release<S: Send + 'static>(sound: S) {
    drop(tokio::task::spawn_blocking(move || drop(sound)));
}

/// Stop sound `id`; an unknown or finished id is a no-op.
pub fn stop(sounds: &AppSounds, id: u64) {
    if let Some(sound) = sounds.take(id) {
        release(sound);
    }
}

/// Render `notes` and open a stream for them on `device_id` (an unknown id
/// plays on the default). Blocking: it talks to the sound server. Returns the
/// stream and how long it should be kept.
fn start(
    host: &OnceLock<Arc<WatchedHost>>,
    notes: &[ToneNote],
    device_id: &str,
    master: f32,
) -> Result<(cpal::Stream, Duration), String> {
    let samples = render(notes, master)?;
    let keep = Duration::from_secs_f64(samples.len() as f64 / f64::from(SAMPLE_RATE)) + DRAIN;
    let host = host.get_or_init(|| WatchedHost::new(Role::Playout));
    // A host the sound server dropped is rebuilt before it is listed.
    host.default_id(cpal::Host::default_output_device);
    let listed = host.with(output_devices);
    let infos: Vec<DeviceInfo> = listed.iter().map(|(i, _)| i.clone()).collect();
    let (index, _) = resolve_device(device_id, &infos);
    let (_, device) = index
        .and_then(|i| listed.into_iter().find(|(d, _)| d.index == i))
        .ok_or("no playout device")?;
    let stream = open_once(&device, samples.into())?;
    Ok((stream, keep))
}

/// Play a sound and return its id. The stream is released by `stop`, by the
/// cap, or once the sound has ended.
pub async fn play(
    sounds: &AppSounds,
    notes: Vec<ToneNote>,
    device_id: String,
    master: f32,
) -> Result<u64, String> {
    let host = sounds.host.clone();
    let (stream, keep) =
        tokio::task::spawn_blocking(move || start(&host, &notes, &device_id, master))
            .await
            .map_err(|e| e.to_string())??;
    let (id, cut) = sounds.register(stream);
    cut.into_iter().for_each(release);
    let owner = sounds.clone();
    tokio::spawn(async move {
        tokio::time::sleep(keep).await;
        stop(&owner, id);
    });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(at: f32, duration: f32, gain: f32, end_gain: f32, freqs: &[(f32, f32)]) -> ToneNote {
        ToneNote {
            at,
            duration,
            gain,
            end_gain,
            freqs: freqs.to_vec(),
            attack: 0.0,
            release: 0.0,
            glide: false,
        }
    }

    fn shaped(base: ToneNote, attack: f32, release: f32, glide: bool) -> ToneNote {
        ToneNote {
            attack,
            release,
            glide,
            ..base
        }
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0, |m, s| f32::max(m, s.abs()))
    }

    #[test]
    fn a_note_renders_its_length_and_peak_at_48k() {
        let out = render(&[note(0.0, 0.2, 0.3, 0.01, &[(0.0, 800.0)])], 1.0).unwrap();
        assert!((out.len() as i64 - 9600).abs() <= 1, "0.2 s at 48 kHz");
        let p = peak(&out);
        assert!(p > 0.28 && p <= 0.3, "peak {p} sits at the note's gain");
        // A later note leaves silence before it.
        let out = render(&[note(0.5, 0.1, 0.2, 0.01, &[(0.0, 440.0)])], 1.0).unwrap();
        assert!(out[..24_000].iter().all(|&s| s == 0.0));
        assert!(peak(&out[24_000..]) > 0.18);
    }

    #[test]
    fn the_envelope_decays_exponentially_to_the_end_gain() {
        let n = note(0.0, 0.2, 0.3, 0.01, &[(0.0, 800.0)]);
        assert!((envelope(&n, 0.0) - 0.3).abs() < 1e-6);
        assert!((envelope(&n, 0.2) - 0.01).abs() < 1e-5);
        // Half way is the geometric mean of the two gains.
        let mid = (0.3f32 * 0.01).sqrt();
        assert!((envelope(&n, 0.1) - mid).abs() < 1e-5);
        // And the rendered tail is quiet: the last 5 ms never exceed ~ 0.012.
        let out = render(&[n], 1.0).unwrap();
        assert!(peak(&out[out.len() - 240..]) < 0.013);
    }

    #[test]
    fn a_frequency_step_keeps_the_phase_continuous() {
        // 400 Hz is a quarter cycle after 30 samples, where the note steps to
        // 800 Hz: the sine goes on from its crest instead of restarting at 0.
        let flat = |at, hz| (at, hz);
        let out = render(
            &[note(
                0.0,
                0.05,
                1.0,
                1.0,
                &[flat(0.0, 400.0), flat(0.000625, 800.0)],
            )],
            1.0,
        )
        .unwrap();
        assert!((out[30] - 1.0).abs() < 1e-4, "the crest: {}", out[30]);
        let step = (std::f64::consts::TAU * 800.0 / 48_000.0).cos() as f32;
        assert!(
            (out[31] - step).abs() < 1e-3,
            "continues from the crest: {}",
            out[31]
        );
    }

    #[test]
    fn the_master_gain_scales_every_sample() {
        let notes = [
            note(0.0, 0.1, 0.3, 0.01, &[(0.0, 800.0), (0.05, 600.0)]),
            note(0.05, 0.1, 0.25, 0.01, &[(0.0, 660.0)]),
        ];
        let full = render(&notes, 1.0).unwrap();
        let half = render(&notes, 0.5).unwrap();
        assert_eq!(full.len(), half.len());
        for (f, h) in full.iter().zip(&half) {
            assert!((f * 0.5 - h).abs() < 1e-6);
        }
        assert!(render(&notes, 0.0).unwrap().iter().all(|&s| s == 0.0));
        // Overlapping notes are clamped, never wrapped.
        let loud = [
            note(0.0, 0.1, 1.0, 1.0, &[(0.0, 440.0)]),
            note(0.0, 0.1, 1.0, 1.0, &[(0.0, 440.0)]),
        ];
        assert!(peak(&render(&loud, 1.0).unwrap()) <= 1.0);
    }

    #[test]
    fn an_oversized_or_non_finite_sound_is_rejected() {
        let ok = note(0.0, 0.1, 0.2, 0.01, &[(0.0, 440.0)]);
        assert!(render(std::slice::from_ref(&ok), 1.0).is_ok());
        assert!(render(&[], 1.0).is_err(), "nothing to play");
        assert!(render(&vec![ok.clone(); MAX_NOTES + 1], 1.0).is_err());
        assert!(render(&vec![ok.clone(); MAX_NOTES], 1.0).is_ok());
        assert!(render(&[note(1.5, 0.6, 0.2, 0.01, &[(0.0, 440.0)])], 1.0).is_err());
        assert!(render(&[note(0.0, 2.0, 0.2, 0.01, &[(0.0, 440.0)])], 1.0).is_ok());
        for bad in [
            note(f32::NAN, 0.1, 0.2, 0.01, &[(0.0, 440.0)]),
            note(0.0, f32::INFINITY, 0.2, 0.01, &[(0.0, 440.0)]),
            note(0.0, 0.1, f32::NAN, 0.01, &[(0.0, 440.0)]),
            note(0.0, 0.1, 0.2, 0.0, &[(0.0, 440.0)]),
            note(0.0, 0.1, 0.2, 0.01, &[(0.0, f32::NAN)]),
            note(0.0, 0.1, 0.2, 0.01, &[(f32::INFINITY, 440.0)]),
            note(0.0, 0.1, 0.2, 0.01, &[(0.0, 0.0)]),
            note(0.0, 0.1, 0.2, 0.01, &[]),
            note(-1.0, 0.1, 0.2, 0.01, &[(0.0, 440.0)]),
            note(0.0, 0.1, f32::MAX, 0.01, &[(0.0, 440.0)]),
            note(0.0, 0.1, 0.2, f32::MAX, &[(0.0, 440.0)]),
            note(0.0, 0.1, 1.5, 0.01, &[(0.0, 440.0)]),
            note(0.0, 0.1, 0.2, 0.01, &[(0.05, 800.0), (0.0, 440.0)]),
        ] {
            assert!(render(&[bad], 1.0).is_err());
        }
        assert!(render(std::slice::from_ref(&ok), f32::NAN).is_err());
        assert!(render(std::slice::from_ref(&ok), -1.0).is_err());
        assert!(render(std::slice::from_ref(&ok), 1.5).is_err());
        assert!(render(&[ok], f32::MAX).is_err());
    }

    /// The renderer as it was before attack, release and glide existed.
    fn render_without_shaping(notes: &[ToneNote]) -> Vec<f32> {
        let end = notes.iter().map(|n| n.at + n.duration).fold(0.0, f32::max);
        let mut out = vec![0.0f32; samples_of(end) + 1];
        for note in notes {
            let start = samples_of(note.at);
            let steps: Vec<(usize, f64)> = note
                .freqs
                .iter()
                .map(|&(offset, hz)| (samples_of(offset), f64::from(hz)))
                .collect();
            let mut phase = 0.0f64;
            for i in 0..samples_of(note.duration) {
                let hz = steps
                    .iter()
                    .rev()
                    .find(|(from, _)| *from <= i)
                    .map_or(steps[0].1, |&(_, hz)| hz);
                let t = i as f32 / SAMPLE_RATE as f32;
                let env = note.gain * (note.end_gain / note.gain).powf(t / note.duration);
                if let Some(o) = out.get_mut(start + i) {
                    *o += (phase.sin() as f32) * env;
                }
                phase = (phase + TAU * hz / f64::from(SAMPLE_RATE)) % TAU;
            }
        }
        out.iter_mut().for_each(|s| *s = s.clamp(-1.0, 1.0));
        out
    }

    #[test]
    fn a_note_without_shaping_renders_exactly_as_before() {
        let json = r#"[
            {"at":0,"duration":0.2,"gain":0.3,"endGain":0.01,"freqs":[[0,800],[0.1,600]]},
            {"at":0.18,"duration":0.16,"gain":0.25,"endGain":0.01,"freqs":[[0,880]]}
        ]"#;
        let notes: Vec<ToneNote> = serde_json::from_str(json).unwrap();
        assert!(notes
            .iter()
            .all(|n| n.attack == 0.0 && n.release == 0.0 && !n.glide));
        let out = render(&notes, 1.0).unwrap();
        let before = render_without_shaping(&notes);
        assert_eq!(out.len(), before.len());
        assert!(out
            .iter()
            .zip(&before)
            .all(|(a, b)| a.to_bits() == b.to_bits()));
    }

    #[test]
    fn the_shaping_fields_arrive_in_camel_case_json() {
        let json = r#"{"at":0,"duration":0.16,"gain":0.42,"endGain":0.00042,
            "attack":0.004,"release":0.008,"glide":true,"freqs":[[0,420],[0.07,860]]}"#;
        let n: ToneNote = serde_json::from_str(json).unwrap();
        assert_eq!((n.attack, n.release, n.glide), (0.004, 0.008, true));
        assert!(render(&[n], 1.0).is_ok());
    }

    #[test]
    fn the_attack_rises_linearly_to_the_gain() {
        let n = shaped(note(0.0, 0.2, 0.4, 0.01, &[(0.0, 440.0)]), 0.01, 0.0, false);
        assert_eq!(envelope(&n, 0.0), 0.0);
        assert!((envelope(&n, 0.005) - 0.2).abs() < 1e-6, "half way up");
        assert!(
            (envelope(&n, 0.01) - 0.4).abs() < 1e-6,
            "the gain at the attack's end"
        );
        // The fade then runs from the attack's end to the duration.
        let mid = (0.4f32 * 0.01).sqrt();
        assert!((envelope(&n, 0.105) - mid).abs() < 1e-5);
        assert!((envelope(&n, 0.2) - 0.01).abs() < 1e-5);
        // Rendered, the first millisecond stays well under the gain.
        let out = render(&[n], 1.0).unwrap();
        assert!(
            peak(&out[..48]) < 0.05,
            "a soft start: {}",
            peak(&out[..48])
        );
        assert!(peak(&out[480..960]) > 0.3);
    }

    #[test]
    fn the_release_falls_linearly_to_silence_after_the_duration() {
        let n = shaped(note(0.0, 0.1, 0.5, 0.2, &[(0.0, 440.0)]), 0.0, 0.05, false);
        assert!((envelope(&n, 0.1) - 0.2).abs() < 1e-6);
        assert!((envelope(&n, 0.125) - 0.1).abs() < 1e-6, "half way down");
        assert!(envelope(&n, 0.15).abs() < 1e-6);
        let out = render(std::slice::from_ref(&n), 1.0).unwrap();
        assert!(
            (out.len() as i64 - 7200).abs() <= 1,
            "0.15 s with the release"
        );
        // Without a release the same note stops at its duration.
        let cut = render(&[shaped(n, 0.0, 0.0, false)], 1.0).unwrap();
        assert!((cut.len() as i64 - 4800).abs() <= 1);
        assert!(
            peak(&out[4800..5000]) > 0.15,
            "still sounding after the duration"
        );
        assert!(peak(&out[out.len() - 48..]) < 0.01, "silent at the end");
    }

    #[test]
    fn a_glide_passes_the_geometric_midpoint() {
        let steps = [(0usize, 0.0f32, 400.0f64), (4800, 0.1, 1600.0)];
        let mid = frequency(&steps, true, 2400);
        assert!((mid - 800.0).abs() < 1e-3, "sqrt(400 * 1600): {mid}");
        assert!((frequency(&steps, true, 0) - 400.0).abs() < 1e-9);
        assert!((frequency(&steps, true, 4800) - 1600.0).abs() < 1e-9);
        assert!(
            (frequency(&steps, true, 9000) - 1600.0).abs() < 1e-9,
            "holds"
        );
        // Without glide it steps.
        assert!((frequency(&steps, false, 4799) - 400.0).abs() < 1e-9);
        assert!((frequency(&steps, false, 4800) - 1600.0).abs() < 1e-9);
        // Rendered, a glide stays phase-continuous: no sample jumps further
        // than the highest frequency allows.
        let n = shaped(
            note(0.0, 0.2, 1.0, 1.0, &[(0.0, 400.0), (0.1, 1600.0)]),
            0.0,
            0.0,
            true,
        );
        let out = render(&[n], 1.0).unwrap();
        let max_step = (TAU * 1600.0 / 48_000.0) as f32 + 1e-3;
        assert!(out.windows(2).all(|w| (w[1] - w[0]).abs() <= max_step));
    }

    #[test]
    fn the_shaping_fields_are_validated() {
        let base = note(0.0, 0.1, 0.2, 0.01, &[(0.0, 440.0)]);
        let with = |attack, release| shaped(base.clone(), attack, release, false);
        assert!(render(&[with(0.05, 0.05)], 1.0).is_ok());
        for bad in [
            with(-0.01, 0.0),
            with(0.1, 0.0),
            with(0.2, 0.0),
            with(0.0, -0.01),
            with(f32::NAN, 0.0),
            with(0.0, f32::NAN),
            with(f32::INFINITY, 0.0),
            with(0.0, f32::INFINITY),
        ] {
            assert!(render(&[bad], 1.0).is_err());
        }
        // The release counts towards the longest sound.
        let long = note(0.0, 1.9, 0.2, 0.01, &[(0.0, 440.0)]);
        assert!(render(&[shaped(long.clone(), 0.0, 0.1, false)], 1.0).is_ok());
        assert!(render(&[shaped(long, 0.0, 0.2, false)], 1.0).is_err());
        // A ringtone of 28 partials fits.
        assert!(render(&vec![with(0.003, 0.008); 28], 1.0).is_ok());
        assert_eq!(MAX_NOTES, 32);
    }

    #[test]
    fn the_oldest_sound_is_dropped_past_the_cap() {
        let sounds = AppSounds::<u32>::default();
        let ids: Vec<u64> = (0..MAX_SOUNDS as u32 + 2)
            .map(|s| sounds.register(s).0)
            .collect();
        let mut ids_unique = ids.clone();
        ids_unique.dedup();
        assert_eq!(ids, ids_unique, "ids are never reused");
        let held = lock(&sounds.sounds);
        assert_eq!(held.playing.len(), MAX_SOUNDS);
        let kept: Vec<u32> = held.playing.iter().map(|(_, s)| *s).collect();
        assert_eq!(kept, (2..MAX_SOUNDS as u32 + 2).collect::<Vec<_>>());
    }

    #[test]
    fn stopping_an_unknown_or_finished_sound_is_a_noop() {
        let sounds = AppSounds::<u32>::default();
        assert_eq!(sounds.take(42), None);
        let a = sounds.register(1).0;
        let b = sounds.register(2).0;
        assert_eq!(sounds.take(a), Some(1));
        assert_eq!(sounds.take(a), None);
        assert_eq!(lock(&sounds.sounds).playing.len(), 1);
        assert_eq!(sounds.take(b), Some(2));
        assert_eq!(sounds.take(b), None);
        assert!(lock(&sounds.sounds).playing.is_empty());
    }
}
