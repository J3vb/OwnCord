//! The settings tab's mic test on Linux: your own microphone, played back.
//!
//! A room-less [`Capture`] and [`Playout`] pair, the call's own code paths
//! with one difference: the capture's [`Sink`] is `Loopback`, so each
//! processed 10 ms frame goes into a fixed-key queue (`playout::LOOPBACK`) of
//! the test's own mixer instead of a published track. That queue keeps the
//! mixer's semantics (prime at 30 ms, cap at 200 ms, trim a long backlog), so
//! mouth-to-ear is about 80 ms.
//!
//! The echo canceller is deliberately never given a reference
//! (`Playout::set_reference` is not called): the only far-end signal in the
//! loop is the user's own voice, which AEC3 would treat as echo and garble.
//! With no render signal it passes audio through, so noise suppression, gain
//! control, RNNoise, the input volume and the gate sound as they will to
//! peers when nobody else is talking. Open speakers can howl, as on the web;
//! the tab tells the user to wear headphones.
//!
//! `monitor` is the same test without the playout: the capture and its level
//! reports only, which drives the settings tab's meter and the diagnostics
//! microphone check outside a call. It takes the test's slot, so it obeys the
//! same join rule and a real test replaces it.
//!
//! A test and a session never run together (`mod.rs`'s join rule).
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::capture::{Apm, Capture, GateSink, LevelSink, Sink};
use super::playout::{Playout, Volume, LOOPBACK};
use super::session::{processing_change, retire, AudioOptions, Event, ProcessingChange};

/// The Tauri event the test's level reports and end are delivered on. A
/// separate event from `native-voice`: a test id could equal a session id.
pub const MIC_TEST_EVENT: &str = "native-voice-mic-test";

/// The refusal a start reports during a call; the TS side matches it.
pub const MIC_TEST_IN_CALL: &str = "mic test unavailable during a call";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicTestOptions {
    pub input: String,
    pub output: String,
    pub audio: AudioOptions,
    /// The input volume, percent (0-200).
    pub input_gain: f32,
    /// The output volume, linear (0-1).
    pub output_gain: f32,
    /// The voice gate's threshold (0: no gate).
    pub threshold: f32,
    /// The voice gate also asks RNNoise's verdict (automatic sensitivity).
    #[serde(default)]
    pub speech: bool,
    /// Capture and report levels only: no output is opened or played.
    #[serde(default)]
    pub monitor: bool,
}

/// A live change to a running test.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MicTestUpdate {
    Processing {
        audio: AudioOptions,
    },
    InputGain {
        percent: f32,
    },
    VoiceGate {
        threshold: f32,
        retune: bool,
        #[serde(default)]
        speech: bool,
    },
    OutputGain {
        gain: f32,
    },
    InputDevice {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    OutputDevice {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MicTestEvent {
    InputLevel { rms: f32, open: bool },
    Ended,
}

#[derive(Serialize, Clone)]
pub struct MicTestEnvelope {
    pub test: u64,
    pub event: MicTestEvent,
}

/// A running (or, for tests, device-free) mic test. Field order is drop
/// order: the capture goes before the playout it feeds.
pub struct MicTest {
    capture: Capture,
    playout: Playout,
    apm: Arc<Apm>,
    audio: AudioOptions,
    monitor: bool,
    retired: Vec<Arc<Apm>>,
    reports: tokio::task::JoinHandle<()>,
}

/// The level reports of `event`; the gate's edges and everything else are
/// not the test's to report.
pub fn level_event(event: Event) -> Option<MicTestEvent> {
    match event {
        Event::InputLevel { rms, open } => Some(MicTestEvent::InputLevel { rms, open }),
        _ => None,
    }
}

/// Drop `test` off the async runtime: dropping joins the watcher threads.
pub async fn release(test: Option<MicTest>) {
    if let Some(test) = test {
        let _ = tokio::task::spawn_blocking(move || drop(test)).await;
    }
}

impl MicTest {
    /// No streams yet: the processing and the slots only.
    fn idle(audio: AudioOptions, monitor: bool, reports: tokio::task::JoinHandle<()>) -> Self {
        Self {
            capture: Capture::default(),
            playout: Playout::default(),
            apm: Apm::new(&audio),
            audio,
            monitor,
            retired: Vec::new(),
            reports,
        }
    }

    #[cfg(test)]
    pub(super) fn idle_for_test(
        audio: AudioOptions,
        monitor: bool,
        reports: tokio::task::JoinHandle<()>,
    ) -> Self {
        Self::idle(audio, monitor, reports)
    }

    /// Open the output and the input and start looping. It blocks on the
    /// sound server: call it only inside `spawn_blocking`.
    pub fn start(
        opts: MicTestOptions,
        on_gate: GateSink,
        on_level: LevelSink,
        reports: tokio::task::JoinHandle<()>,
    ) -> Result<Self, String> {
        let mut test = Self::idle(opts.audio, opts.monitor, reports);
        if !opts.monitor {
            test.playout.mixer().add_loopback();
            test.playout
                .mixer()
                .set_gain(LOOPBACK, Volume::Microphone, opts.output_gain);
            if let Err(e) = test.playout.set_device(&opts.output) {
                if test.playout.playing().is_none() {
                    return Err(e);
                }
                // A fallback to the default output: it plays.
                log::warn!("[native_voice] mic test output: {e}");
            }
        }
        test.capture.configure(
            test.apm.clone(),
            opts.audio.enhanced_noise_suppression,
            on_gate,
            on_level,
        );
        test.capture
            .set_voice_gate(opts.threshold, false, opts.speech);
        test.capture.set_input_gain(opts.input_gain / 100.0);
        if let Err(e) = test.capture.set_device(&opts.input) {
            // A fallback has re-selected the default; with no device at all
            // the start below reports it.
            log::warn!("[native_voice] mic test input: {e}");
        }
        test.capture
            .start(Sink::Loopback(test.playout.mixer().clone()))?;
        Ok(test)
    }

    /// Apply a live change. A device fallback comes back as an error while
    /// the stream plays on the default.
    pub fn update(&mut self, update: MicTestUpdate) -> Result<(), String> {
        match update {
            MicTestUpdate::Processing { audio } => self.set_audio_processing(audio),
            MicTestUpdate::InputGain { percent } => self.capture.set_input_gain(percent / 100.0),
            MicTestUpdate::VoiceGate {
                threshold,
                retune,
                speech,
            } => {
                self.capture.set_voice_gate(threshold, retune, speech);
            }
            MicTestUpdate::OutputGain { .. } | MicTestUpdate::OutputDevice { .. }
                if self.monitor => {}
            MicTestUpdate::OutputGain { gain } => {
                self.playout
                    .mixer()
                    .set_gain(LOOPBACK, Volume::Microphone, gain);
            }
            MicTestUpdate::InputDevice { device_id } => {
                return self.capture.set_device(&device_id);
            }
            MicTestUpdate::OutputDevice { device_id } => {
                return self.playout.set_device(&device_id);
            }
        }
        Ok(())
    }

    /// The call's reroute-or-rebuild rule, with no reference to follow.
    fn set_audio_processing(&mut self, audio: AudioOptions) {
        match processing_change(true, Some(self.audio), audio) {
            ProcessingChange::Unchanged | ProcessingChange::Remember => {}
            ProcessingChange::Reroute => {
                self.capture
                    .set_processing(self.apm.clone(), audio.enhanced_noise_suppression);
            }
            ProcessingChange::Rebuild => {
                let apm = Apm::new(&audio);
                self.capture
                    .set_processing(apm.clone(), audio.enhanced_noise_suppression);
                retire(
                    &mut self.retired,
                    Some(std::mem::replace(&mut self.apm, apm)),
                );
            }
        }
        self.audio = audio;
    }
}

impl Drop for MicTest {
    fn drop(&mut self) {
        self.capture.stop();
        self.reports.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio(ec: bool, ens: bool) -> AudioOptions {
        AudioOptions {
            echo_cancellation: ec,
            noise_suppression: false,
            auto_gain_control: false,
            enhanced_noise_suppression: ens,
        }
    }

    fn idle(audio: AudioOptions) -> MicTest {
        MicTest::idle(audio, false, tokio::spawn(async {}))
    }

    #[tokio::test]
    async fn a_mic_test_reroutes_or_rebuilds_its_processing_like_a_call() {
        let mut test = idle(audio(true, false));
        let first = test.apm.clone();
        test.set_audio_processing(audio(true, false));
        assert!(
            Arc::ptr_eq(&first, &test.apm),
            "unchanged keeps the processing"
        );
        test.set_audio_processing(audio(true, true));
        assert!(
            Arc::ptr_eq(&first, &test.apm),
            "ENS alone keeps the processing"
        );
        assert!(test.retired.is_empty());
        test.set_audio_processing(audio(false, true));
        assert!(!Arc::ptr_eq(&first, &test.apm), "an EC change rebuilds it");
        assert_eq!(test.retired.len(), 1);
        assert!(
            !test.playout.reference_is_set(),
            "the echo canceller is never given a reference"
        );
    }

    #[tokio::test]
    async fn a_monitor_ignores_output_updates_and_opens_no_output() {
        let mut test = MicTest::idle(audio(true, false), true, tokio::spawn(async {}));
        test.update(MicTestUpdate::OutputGain { gain: 0.5 })
            .unwrap();
        test.update(MicTestUpdate::OutputDevice {
            device_id: "x".into(),
        })
        .unwrap();
        assert!(test.playout.playing().is_none(), "no output was opened");
    }

    #[test]
    fn mic_test_wire_format() {
        let monitor: MicTestOptions = serde_json::from_str(
            r#"{"input":"","output":"","audio":{"echoCancellation":true,"noiseSuppression":false,"autoGainControl":true},"inputGain":100,"outputGain":1,"threshold":0,"monitor":true}"#,
        )
        .unwrap();
        assert!(monitor.monitor);
        let plain: MicTestOptions = serde_json::from_str(
            r#"{"input":"","output":"","audio":{"echoCancellation":true,"noiseSuppression":false,"autoGainControl":true},"inputGain":100,"outputGain":1,"threshold":0}"#,
        )
        .unwrap();
        assert!(!plain.monitor, "absent means a full test");
        let level = serde_json::to_value(MicTestEvent::InputLevel {
            rms: 0.5,
            open: true,
        })
        .unwrap();
        assert_eq!(
            level,
            serde_json::json!({"type": "inputLevel", "rms": 0.5, "open": true})
        );
        assert_eq!(
            serde_json::to_value(MicTestEvent::Ended).unwrap(),
            serde_json::json!({"type": "ended"})
        );
        let envelope = serde_json::to_value(MicTestEnvelope {
            test: 3,
            event: MicTestEvent::Ended,
        })
        .unwrap();
        assert_eq!(
            envelope,
            serde_json::json!({"test": 3, "event": {"type": "ended"}})
        );
        let device: MicTestUpdate =
            serde_json::from_str(r#"{"kind":"outputDevice","deviceId":"x"}"#).unwrap();
        assert!(matches!(device, MicTestUpdate::OutputDevice { device_id } if device_id == "x"));
        let gain: MicTestUpdate =
            serde_json::from_str(r#"{"kind":"inputGain","percent":50}"#).unwrap();
        assert!(matches!(gain, MicTestUpdate::InputGain { percent } if percent == 50.0));
        let gate: MicTestUpdate =
            serde_json::from_str(r#"{"kind":"voiceGate","threshold":0.1,"retune":true}"#).unwrap();
        assert!(matches!(
            gate,
            MicTestUpdate::VoiceGate { retune: true, .. }
        ));
        let processing: MicTestUpdate = serde_json::from_str(
            r#"{"kind":"processing","audio":{"echoCancellation":true,"noiseSuppression":false,"autoGainControl":true}}"#,
        )
        .unwrap();
        assert!(matches!(processing, MicTestUpdate::Processing { .. }));
    }

    #[test]
    fn only_level_reports_become_mic_test_events() {
        assert_eq!(
            level_event(Event::InputLevel {
                rms: 0.1,
                open: false
            }),
            Some(MicTestEvent::InputLevel {
                rms: 0.1,
                open: false
            })
        );
        assert_eq!(level_event(Event::VoiceGate { open: true }), None);
    }

    /// Manual, on a box with a sound server:
    /// `cargo test --lib mic_test -- --ignored`.
    #[ignore = "needs a sound server and default audio devices"]
    #[tokio::test]
    async fn a_mic_test_opens_and_closes_its_streams() {
        let opts = MicTestOptions {
            input: String::new(),
            output: String::new(),
            audio: audio(false, false),
            input_gain: 100.0,
            output_gain: 0.5,
            threshold: 0.0,
            speech: false,
            monitor: false,
        };
        let test = tokio::task::spawn_blocking(move || {
            MicTest::start(
                opts,
                Arc::new(|_| {}),
                Arc::new(|_, _| {}),
                tokio::spawn(async {}),
            )
        })
        .await
        .unwrap()
        .expect("the default devices open");
        assert_eq!(test.capture.streams(), 1);
        assert!(test.playout.playing().is_some());
        release(Some(test)).await;
    }
}
