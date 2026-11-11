//! The audio devices a [`super::NativeSession`] shares with the blocking
//! threads that open, switch and close them, and the steps that run there.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use livekit::webrtc::audio_source::native::NativeAudioSource;

use super::super::capture::{Capture, Sink};
use super::super::playout::Playout;
use crate::sync::lock;

/// Run driver work on a blocking thread.
pub(super) async fn off_runtime<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())
}

/// The two kinds of operation on one audio device, each ordered on its own.
#[derive(Clone, Copy)]
pub enum Class {
    /// Starting and stopping the stream (mute, unmute, close).
    Running,
    /// Choosing the device.
    Selection,
}

/// Orders blocking operations: tickets are taken under the session lock, in
/// the order the calls arrived, and an operation that finds a later ticket
/// already applied is skipped.
#[derive(Default)]
struct Line {
    issued: AtomicU64,
    applied: AtomicU64,
}

impl Line {
    fn ticket(&self) -> u64 {
        self.issued.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Whether `ticket` may run now. Called with the device's lock held,
    /// which is what makes the check and the update one step.
    fn admit(&self, ticket: u64) -> bool {
        if self.applied.load(Ordering::SeqCst) > ticket {
            return false;
        }
        self.applied.store(ticket, Ordering::SeqCst);
        true
    }
}

/// A capture or playout shared by the session and the blocking threads that
/// open, switch and close its device.
pub struct Audio<T> {
    pub(super) device: Mutex<T>,
    running: Line,
    selection: Line,
}

impl<T> Audio<T> {
    pub(super) fn new(device: T) -> Self {
        Self {
            device: Mutex::new(device),
            running: Line::default(),
            selection: Line::default(),
        }
    }

    fn line(&self, class: Class) -> &Line {
        match class {
            Class::Running => &self.running,
            Class::Selection => &self.selection,
        }
    }

    /// Take the next place in `class`'s line; call under the session lock.
    pub(super) fn ticket(&self, class: Class) -> u64 {
        self.line(class).ticket()
    }

    /// Run `op` on the device, unless a later ticket of `class` already ran.
    /// Blocks on the device's lock and on `op`.
    pub(super) fn apply<R>(
        &self,
        class: Class,
        ticket: u64,
        op: impl FnOnce(&mut T) -> R,
    ) -> Option<R> {
        let mut device = lock(&self.device);
        if !self.line(class).admit(ticket) {
            return None;
        }
        Some(op(&mut *device))
    }
}

/// What a microphone call needs the capture to do, made under the session
/// lock and run by [`MicStep::run`] without it.
pub enum MicStep {
    /// Nothing for the driver.
    Idle,
    Stop {
        capture: Arc<Audio<Capture>>,
        ticket: u64,
    },
    Start {
        capture: Arc<Audio<Capture>>,
        ticket: u64,
        /// Close the stream first, so it reopens on the new source.
        stop_first: bool,
        commit: MicCommit,
    },
}

/// What [`NativeSession::finish_microphone`] needs from a call whose capture
/// started.
pub struct MicCommit {
    pub(super) epoch: u64,
    pub(super) source: NativeAudioSource,
    /// Publish the source (with this bitrate; whether the server had
    /// withdrawn the old publication) rather than unmute the existing track.
    pub(super) publish: Option<(Option<u64>, bool)>,
}

impl MicStep {
    /// The start for a source about to be published for the first time. The
    /// stream is always closed first: an open stream stays bound to the
    /// source it was opened for, so this source needs a stream of its own.
    pub(super) fn first_publish(
        capture: &Arc<Audio<Capture>>,
        epoch: u64,
        source: NativeAudioSource,
        bitrate: Option<u64>,
        was_withdrawn: bool,
    ) -> Self {
        Self::Start {
            capture: capture.clone(),
            ticket: capture.ticket(Class::Running),
            stop_first: true,
            commit: MicCommit {
                epoch,
                source,
                publish: Some((bitrate, was_withdrawn)),
            },
        }
    }

    /// Open or close the capture's stream. Blocks on the audio driver.
    pub fn run(self) -> Result<Option<MicCommit>, String> {
        match self {
            Self::Idle => Ok(None),
            Self::Stop { capture, ticket } => {
                capture.apply(Class::Running, ticket, |c| c.stop());
                Ok(None)
            }
            Self::Start {
                capture,
                ticket,
                stop_first,
                commit,
            } => {
                let started = capture.apply(Class::Running, ticket, |c| {
                    if stop_first {
                        c.stop();
                    }
                    c.start(Sink::Track(commit.source.clone()))
                });
                // A start a later call superseded is not an error: that call
                // owns the capture now.
                started.unwrap_or(Ok(()))?;
                Ok(Some(commit))
            }
        }
    }
}

/// A capture or playout device switch, ready to run without the session.
pub enum DeviceSwitch {
    Output(Arc<Audio<Playout>>, u64),
    Input(Arc<Audio<Capture>>, u64),
}

impl DeviceSwitch {
    pub(super) fn output(playout: &Arc<Audio<Playout>>) -> Self {
        Self::Output(playout.clone(), playout.ticket(Class::Selection))
    }

    pub(super) fn input(capture: &Arc<Audio<Capture>>) -> Self {
        Self::Input(capture.clone(), capture.ticket(Class::Selection))
    }

    /// Select device `id` (a running stream moves to it; empty: the default).
    /// A switch a later one superseded does nothing. Blocks on the audio
    /// driver.
    pub fn apply(self, id: &str) -> Result<(), String> {
        match self {
            Self::Output(playout, ticket) => playout
                .apply(Class::Selection, ticket, |p| p.set_device(id))
                .unwrap_or(Ok(())),
            Self::Input(capture, ticket) => capture
                .apply(Class::Selection, ticket, |c| c.set_device(id))
                .unwrap_or(Ok(())),
        }
    }
}
