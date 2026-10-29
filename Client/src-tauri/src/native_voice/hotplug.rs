//! App-level audio device hot-plug watcher (Linux, WP LP-6a).
//!
//! The session watchers in `capture.rs`/`playout.rs` follow a moved default
//! only inside a call and never tell the webview. This watcher polls the
//! capture and playout lists for the whole life of the app once the webview
//! asks for it (`native_voice_watch_devices`) and emits `native-voice-devices`
//! when the lists change. The event is a trigger: the webview re-lists through
//! the existing code and applies its own fallback and restore rules.
//!
//! A sound-server restart is not an unplug: a tick where the server does not
//! answer lists nothing (`None`), so it is skipped and the baseline is kept.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle as Thread;
use std::time::Duration;

use cpal::traits::HostTrait as _;

use super::capture::input_devices;
use super::playout::{output_devices, Role, WatchedHost};
use super::session::Devices;
use crate::sync::lock;

/// The Tauri event a changed device list is delivered on.
pub const DEVICES_EVENT: &str = "native-voice-devices";

/// How often the production watch lists devices. PipeWire announces a plugged
/// node in several steps; one poll per 2 s coalesces the burst.
pub(super) const POLL_EVERY: Duration = Duration::from_secs(2);

/// Whether `next` differs from `prev` in ids, names or order. A new default is
/// listed first, so it counts.
pub(super) fn changed(prev: &Devices, next: &Devices) -> bool {
    prev != next
}

/// The polling thread. Dropping it stops and joins the thread.
pub(super) struct DevicesWatch {
    stop: mpsc::Sender<()>,
    thread: Option<Thread<()>>,
}

impl DevicesWatch {
    /// Take a baseline with `list` at once (emitting nothing), then poll every
    /// `every`. `list` returns `None` when the sound server did not answer; such
    /// a tick is skipped and the baseline kept. A server that comes back is
    /// often listed in stages (a partial list, a placeholder device first), so
    /// after any `None` the next `Some` is only pending: it is compared and
    /// emitted once a following tick returns the same lists. A differing,
    /// settled `Some` is passed to `emit` and becomes the new baseline.
    pub(super) fn start(
        every: Duration,
        mut list: impl FnMut() -> Option<Devices> + Send + 'static,
        mut emit: impl FnMut(&Devices) + Send + 'static,
    ) -> Self {
        let (stop, stopped) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut last = list();
            let mut settling = last.is_none();
            let mut pending: Option<Devices> = None;
            while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(every) {
                let Some(now) = list() else {
                    settling = true;
                    pending = None;
                    continue;
                };
                if settling {
                    if pending.as_ref() != Some(&now) {
                        pending = Some(now);
                        continue;
                    }
                    settling = false;
                    pending = None;
                }
                match &last {
                    Some(prev) if !changed(prev, &now) => {}
                    // No baseline yet (the server was down at the start): the
                    // first settled answer is the baseline, not a change.
                    None => last = Some(now),
                    Some(_) => {
                        emit(&now);
                        last = Some(now);
                    }
                }
            }
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }

    /// Whether the thread has ended on its own (it panicked).
    fn is_dead(&self) -> bool {
        self.thread.as_ref().is_some_and(Thread::is_finished)
    }
}

impl Drop for DevicesWatch {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Fill `slot` with `make()` when it is empty, or when its thread has died;
/// whether it did. Idempotent, so every webview load can ask.
pub(super) fn ensure_watch(
    slot: &Mutex<Option<DevicesWatch>>,
    make: impl FnOnce() -> DevicesWatch,
) -> bool {
    let mut slot = lock(slot);
    match slot.as_ref() {
        Some(watch) if !watch.is_dead() => return false,
        Some(_) => log::warn!("[native_voice] device watcher thread ended; restarting it"),
        None => {}
    }
    *slot = Some(make());
    true
}

/// One tick's snapshot: `None` when the sound server did not answer (neither
/// default device) or listed nothing at all, which is a restart, not an unplug.
fn snapshot(answered: bool, devices: impl FnOnce() -> Devices) -> Option<Devices> {
    if !answered {
        return None;
    }
    let devices = devices();
    (!(devices.inputs.is_empty() && devices.outputs.is_empty())).then_some(devices)
}

/// The production lister: its own `WatchedHost`, which rebuilds a dead host and
/// never settles on a lower backend, so a restarting server reads as `None`
/// rather than as every device unplugged (`session::list_devices` asks the shared
/// default host, which falls back to ALSA meanwhile). The host is built on
/// the first call, inside the watcher thread, since connecting can block.
pub(super) fn host_lister() -> impl FnMut() -> Option<Devices> + Send + 'static {
    let mut host: Option<Arc<WatchedHost>> = None;
    move || {
        let host = host.get_or_insert_with(|| WatchedHost::new(Role::Devices));
        // Either default answering proves the server is up: a machine whose
        // only output (or only input) was just unplugged has no default on that
        // side, and that is a real change, not an outage.
        let answered = host.default_id(cpal::Host::default_output_device).is_some()
            || host.default_id(cpal::Host::default_input_device).is_some();
        snapshot(answered, || {
            host.with(|h| Devices {
                inputs: input_devices(h).into_iter().map(|(i, _)| i).collect(),
                outputs: output_devices(h).into_iter().map(|(i, _)| i).collect(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::super::session::DeviceInfo;

    const QUIET: Duration = Duration::from_millis(50);
    const TICK: Duration = Duration::from_millis(2);

    fn dev(id: &str, index: u16) -> DeviceInfo {
        DeviceInfo {
            id: id.to_string(),
            name: id.to_string(),
            index,
        }
    }

    fn lists(outputs: &[&str]) -> Devices {
        Devices {
            inputs: vec![dev("mic", 0)],
            outputs: outputs
                .iter()
                .enumerate()
                .map(|(i, o)| dev(o, i as u16))
                .collect(),
        }
    }

    type Source = Arc<Mutex<Option<Devices>>>;

    fn watch(initial: Option<Devices>) -> (DevicesWatch, Source, mpsc::Receiver<Devices>) {
        let source: Source = Arc::new(Mutex::new(initial));
        let (sent, events) = mpsc::channel();
        let read = source.clone();
        let polls = Arc::new(AtomicUsize::new(0));
        let counted = polls.clone();
        let watch = DevicesWatch::start(
            TICK,
            move || {
                let now = lock(&read).clone();
                counted.fetch_add(1, Ordering::Relaxed);
                now
            },
            move |d| sent.send(d.clone()).unwrap(),
        );
        // The thread takes its baseline itself; a test changes the source only
        // once that snapshot is in hand.
        while polls.load(Ordering::Relaxed) == 0 {
            std::thread::sleep(TICK);
        }
        (watch, source, events)
    }

    #[test]
    fn the_first_snapshot_is_the_baseline_and_emits_nothing() {
        let (_watch, _source, events) = watch(Some(lists(&["speakers"])));
        assert!(events.recv_timeout(QUIET).is_err());
    }

    #[test]
    fn a_changed_list_emits_once_with_the_new_devices() {
        let (_watch, source, events) = watch(Some(lists(&["speakers"])));
        *lock(&source) = Some(lists(&["speakers", "usb"]));
        let got = events.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(got, lists(&["speakers", "usb"]));
        assert!(events.recv_timeout(QUIET).is_err(), "emitted once");
    }

    #[test]
    fn a_new_default_listed_first_counts_as_a_change() {
        let (_watch, source, events) = watch(Some(lists(&["speakers", "usb"])));
        *lock(&source) = Some(lists(&["usb", "speakers"]));
        events.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn a_sound_server_that_does_not_answer_is_not_an_unplug() {
        let before = lists(&["speakers", "usb"]);
        let (_watch, source, events) = watch(Some(before.clone()));
        *lock(&source) = None;
        assert!(events.recv_timeout(QUIET).is_err(), "no answer");
        *lock(&source) = Some(before);
        assert!(events.recv_timeout(QUIET).is_err(), "same lists again");
    }

    /// Run a watch over `script` (one answer per call, the last repeating) and
    /// return what it emitted once the script is spent and the thread joined.
    fn run_script(script: Vec<Option<Devices>>) -> Vec<Devices> {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let total = script.len();
        let (sent, events) = mpsc::channel();
        let watch = DevicesWatch::start(
            TICK,
            move || {
                let i = counted.fetch_add(1, Ordering::Relaxed);
                script[i.min(total - 1)].clone()
            },
            move |d| sent.send(d.clone()).unwrap(),
        );
        while calls.load(Ordering::Relaxed) < total + 3 {
            std::thread::sleep(TICK);
        }
        drop(watch);
        events.try_iter().collect()
    }

    #[test]
    fn a_server_down_at_the_start_leaves_the_first_answer_as_the_baseline() {
        let (x, y) = (lists(&["speakers"]), lists(&["usb"]));
        let emitted = run_script(vec![
            None,
            Some(x.clone()),
            Some(x),
            Some(y.clone()),
            Some(y.clone()),
        ]);
        assert_eq!(emitted, vec![y]);
    }

    #[test]
    fn a_server_coming_back_in_stages_emits_only_the_settled_lists() {
        let (base, partial, full) = (
            lists(&["speakers"]),
            lists(&["dummy"]),
            lists(&["speakers", "usb"]),
        );
        let emitted = run_script(vec![
            Some(base),
            None,
            Some(partial),
            Some(full.clone()),
            Some(full.clone()),
        ]);
        assert_eq!(emitted, vec![full]);
    }

    #[test]
    fn a_server_back_with_the_baseline_lists_emits_nothing() {
        let base = lists(&["speakers", "usb"]);
        let emitted = run_script(vec![
            Some(base.clone()),
            None,
            Some(lists(&["dummy"])),
            Some(base.clone()),
            Some(base),
        ]);
        assert!(emitted.is_empty());
    }

    #[test]
    fn no_answer_or_two_empty_lists_is_no_snapshot() {
        let listed = lists(&["speakers"]);
        assert_eq!(snapshot(false, || listed.clone()), None);
        assert_eq!(snapshot(true, Devices::default), None);
        assert_eq!(snapshot(true, || listed.clone()), Some(listed));
        let outputs_only = Devices {
            inputs: vec![],
            outputs: vec![dev("speakers", 0)],
        };
        assert_eq!(snapshot(true, || outputs_only.clone()), Some(outputs_only));
    }

    #[test]
    fn a_dead_watcher_thread_is_replaced() {
        let slot = Mutex::new(None);
        let dying = || DevicesWatch::start(TICK, || panic!("lister failed"), |_| {});
        assert!(ensure_watch(&slot, dying));
        while !lock(&slot).as_ref().unwrap().is_dead() {
            std::thread::sleep(TICK);
        }
        let live = || DevicesWatch::start(Duration::from_secs(60), || None, |_| {});
        assert!(ensure_watch(&slot, live));
        assert!(!lock(&slot).as_ref().unwrap().is_dead());
        assert!(!ensure_watch(&slot, live));
    }

    #[test]
    fn a_dropped_watch_stops_polling() {
        let polls = Arc::new(AtomicUsize::new(0));
        let counted = polls.clone();
        let watch = DevicesWatch::start(
            TICK,
            move || {
                counted.fetch_add(1, Ordering::Relaxed);
                Some(lists(&["speakers"]))
            },
            |_| {},
        );
        while polls.load(Ordering::Relaxed) < 3 {
            std::thread::sleep(TICK);
        }
        drop(watch);
        let after = polls.load(Ordering::Relaxed);
        std::thread::sleep(QUIET);
        assert_eq!(polls.load(Ordering::Relaxed), after);
    }

    #[test]
    fn watching_twice_keeps_one_watch() {
        let slot = Mutex::new(None);
        let starts = AtomicUsize::new(0);
        let make = || {
            starts.fetch_add(1, Ordering::Relaxed);
            DevicesWatch::start(Duration::from_secs(60), || None, |_| {})
        };
        assert!(ensure_watch(&slot, make));
        assert!(!ensure_watch(&slot, make));
        assert_eq!(starts.load(Ordering::Relaxed), 1);
        assert!(lock(&slot).is_some());
    }
}
