//! The live call's controls that must not wait behind the session lock.
//!
//! Every native voice command takes `NativeVoiceState::inner`, a tokio mutex,
//! and a publish keeps it while the SFU answers (up to its 10 s timeout, more
//! during a reconnect). Push-to-talk, input gain, the voice gate and the
//! per-user volumes only touch shared settings, so they go through this slot
//! instead. A mute or leave holds the microphone silent here the moment it is
//! asked for, and a leave or a new connect tells the session's pending SFU
//! waits to give up, so its own turn at the lock comes at once.
//!
//! Lock order: `inner` (when held) before either mutex here; `requests`
//! before `live`. Neither is ever held across an await.
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use super::{capture, playout};
use crate::sync::lock;

/// One session's quick controls.
#[derive(Clone)]
pub(super) struct Quick {
    session: u64,
    pub capture: capture::Controls,
    pub playout: playout::Controls,
    /// Set once the session is being closed; SFU waits end on it.
    closing: Arc<watch::Sender<bool>>,
}

#[derive(Default)]
pub(super) struct QuickSlot {
    live: Mutex<Option<Quick>>,
    /// Microphone requests in arrival order: an unmute lifts the hold only
    /// while no later request (a mute) arrived.
    requests: Mutex<u64>,
}

fn not_current(session: u64) -> String {
    format!("native voice session {session} is not current")
}

impl QuickSlot {
    /// Make `session` the live one. Call with `inner` held, as the session is
    /// installed.
    pub fn install(&self, session: u64, capture: capture::Controls, playout: playout::Controls) {
        let _requests = lock(&self.requests);
        let (closing, _) = watch::channel(false);
        let old = lock(&self.live).replace(Quick {
            session,
            capture,
            playout,
            closing: Arc::new(closing),
        });
        if let Some(old) = old {
            old.close();
        }
    }

    /// Forget `session` once it was taken out of `inner` (`None`: whichever
    /// is live). Its pending SFU waits end.
    pub fn remove(&self, session: Option<u64>) {
        let _requests = lock(&self.requests);
        let mut live = lock(&self.live);
        if live.as_ref().is_some_and(|q| matches(q, session)) {
            if let Some(old) = live.take() {
                old.close();
            }
        }
    }

    /// The controls of `session`, while it is the live one.
    pub fn get(&self, session: u64) -> Result<Quick, String> {
        lock(&self.live)
            .as_ref()
            .filter(|q| q.session == session)
            .cloned()
            .ok_or_else(|| not_current(session))
    }

    /// A leave or a new connect for `session` (`None`: whichever is live):
    /// silence the microphone and end the session's SFU waits now, before
    /// the command reaches `inner`.
    pub fn begin_close(&self, session: Option<u64>) {
        // Under `requests`, so an unmute's check-and-lift cannot straddle it.
        let _requests = lock(&self.requests);
        if let Some(q) = lock(&self.live).as_ref().filter(|q| matches(q, session)) {
            q.close();
        }
    }

    /// Record a microphone request for `session` and return its number. A
    /// mute holds the microphone silent at once. A request for a session that
    /// is not live counts for nothing (it fails on `inner` anyway).
    pub fn mic_request(&self, session: u64, enabled: bool) -> u64 {
        let mut requests = lock(&self.requests);
        let Ok(q) = self.get(session) else {
            return u64::MAX;
        };
        *requests += 1;
        if !enabled {
            q.capture.set_held(true);
        }
        *requests
    }

    /// An unmute (`request`) reached the session: lift the hold, unless a
    /// later microphone request arrived meanwhile or the session is closing.
    pub fn release_hold(&self, session: u64, request: u64) {
        let requests = lock(&self.requests);
        if *requests != request {
            return;
        }
        if let Ok(q) = self.get(session) {
            if !*q.closing.borrow() {
                q.capture.set_held(false);
            }
        }
        drop(requests);
    }

    /// What `session`'s SFU waits watch to give up on, or `None` when it is
    /// not live (the command then fails on `inner` anyway).
    pub fn closing(&self, session: u64) -> Option<watch::Receiver<bool>> {
        self.get(session).ok().map(|q| q.closing.subscribe())
    }
}

impl Quick {
    fn close(&self) {
        self.capture.set_held(true);
        self.closing.send_replace(true);
    }
}

fn matches(q: &Quick, session: Option<u64>) -> bool {
    session.is_none_or(|id| id == q.session)
}

/// Run `work`, a session step that awaits the SFU, unless the session starts
/// closing first: then drop it and answer `closed()`. The session is about to
/// be closed, so the half-done step is released with it.
pub(super) async fn unless_closing<T, E>(
    closing: Option<watch::Receiver<bool>>,
    work: impl Future<Output = Result<T, E>>,
    closed: impl FnOnce() -> E,
) -> Result<T, E> {
    let Some(mut closing) = closing else {
        return work.await;
    };
    tokio::select! {
        biased;
        result = work => result,
        // A dropped sender (the slot moved on) is a close too.
        _ = closing.wait_for(|c| *c) => Err(closed()),
    }
}

/// The error a step cut short by a close reports.
pub(super) fn closing_error(session: u64) -> String {
    format!("native voice session {session} is closing")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot_with(session: u64) -> (QuickSlot, capture::Capture) {
        let slot = QuickSlot::default();
        let capture = capture::Capture::default();
        let playout = playout::Playout::default();
        slot.install(session, capture.controls(), playout.controls());
        (slot, capture)
    }

    #[test]
    fn a_stale_session_gets_no_controls() {
        let (slot, _capture) = slot_with(2);
        assert!(slot.get(2).is_ok());
        assert_eq!(slot.get(1).err(), Some(not_current(1)));
        slot.remove(Some(1));
        assert!(slot.get(2).is_ok(), "removing another id leaves it");
        slot.remove(Some(2));
        assert!(slot.get(2).is_err());
    }

    #[test]
    fn mute_unmute_mute_ends_held() {
        let (slot, capture) = slot_with(1);
        let mute = slot.mic_request(1, false);
        assert!(capture.held(), "a mute holds at once");
        let unmute = slot.mic_request(1, true);
        let mute_again = slot.mic_request(1, false);
        // The unmute reaches the session after the second mute was asked.
        slot.release_hold(1, unmute);
        assert!(capture.held(), "a later mute keeps the hold");
        slot.release_hold(1, mute);
        assert!(capture.held());
        let _ = mute_again;
        let last = slot.mic_request(1, true);
        slot.release_hold(1, last);
        assert!(!capture.held(), "the latest unmute lifts it");
    }

    #[test]
    fn a_closing_session_stays_held() {
        let (slot, capture) = slot_with(1);
        let unmute = slot.mic_request(1, true);
        slot.begin_close(Some(1));
        assert!(capture.held(), "a leave holds at once");
        slot.release_hold(1, unmute);
        assert!(
            capture.held(),
            "an unmute queued before the leave does not lift it"
        );
    }

    #[test]
    fn a_stale_session_request_does_not_block_the_live_unmute() {
        let (slot, capture) = slot_with(2);
        slot.mic_request(2, false);
        let unmute = slot.mic_request(2, true);
        let stale = slot.mic_request(1, false);
        assert_eq!(stale, u64::MAX);
        slot.release_hold(2, unmute);
        assert!(!capture.held());
    }

    #[test]
    fn begin_close_ignores_another_session() {
        let (slot, capture) = slot_with(2);
        slot.begin_close(Some(1));
        assert!(!capture.held());
        slot.begin_close(None);
        assert!(capture.held());
    }

    #[tokio::test]
    async fn a_close_ends_a_pending_sfu_wait() {
        let (slot, _capture) = slot_with(1);
        let closing = slot.closing(1);
        let waiting = tokio::spawn(unless_closing(
            closing,
            std::future::pending::<Result<(), String>>(),
            || closing_error(1),
        ));
        tokio::task::yield_now().await;
        slot.begin_close(Some(1));
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), waiting)
            .await
            .expect("the wait ends")
            .expect("no panic");
        assert_eq!(result, Err(closing_error(1)));
    }

    #[tokio::test]
    async fn removing_the_session_ends_a_pending_sfu_wait() {
        let (slot, _capture) = slot_with(1);
        let closing = slot.closing(1);
        slot.remove(None);
        let result = unless_closing(
            closing,
            std::future::pending::<Result<(), String>>(),
            || closing_error(1),
        )
        .await;
        assert_eq!(result, Err(closing_error(1)));
    }

    #[tokio::test]
    async fn finished_work_wins_when_nothing_closes() {
        let (slot, _capture) = slot_with(1);
        let result = unless_closing(slot.closing(1), async { Ok::<_, String>(7) }, || {
            closing_error(1)
        })
        .await;
        assert_eq!(result, Ok(7));
    }
}
