//! Input idle time from a Wayland compositor's `ext-idle-notify-v1`, for the
//! compositors with no Mutter or ScreenSaver idle source (KDE Plasma on
//! Wayland, wlroots-based desktops).
//!
//! The protocol reports transitions, not a clock: the compositor sends
//! `idled` once input has been quiet for the requested threshold and
//! `resumed` on the next input. A small background thread owns the
//! connection and records when the idle spell began; `idle_ms` turns that
//! into milliseconds. Below the threshold the answer is 0.

use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use wayland_client::globals::{registry_queue_init, GlobalList, GlobalListContents};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle};
use wayland_protocols::ext::idle_notify::v1::client::{
    ext_idle_notification_v1::{self, ExtIdleNotificationV1},
    ext_idle_notifier_v1::ExtIdleNotifierV1,
};

/// How long input must be quiet before the compositor says `idled`.
const THRESHOLD: Duration = Duration::from_secs(1);
/// How often the thread wakes from `poll` to look at its stop flag.
const POLL_MS: i32 = 250;

/// Milliseconds idle given when the current idle spell began, `None` when
/// input was seen within the threshold.
fn idle_ms_since(idle_since: Option<Instant>, now: Instant) -> u64 {
    idle_since.map_or(0, |since| {
        u64::try_from(now.saturating_duration_since(since).as_millis()).unwrap_or(u64::MAX)
    })
}

/// When the compositor's `idled` arrived, the spell began one threshold ago.
fn spell_start(now: Instant) -> Instant {
    now.checked_sub(THRESHOLD).unwrap_or(now)
}

struct State {
    idle_since: Arc<Mutex<Option<Instant>>>,
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for State {
    fn event(
        _: &mut Self,
        _: &wl_seat::WlSeat,
        _: wl_seat::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtIdleNotifierV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &ExtIdleNotifierV1,
        _: <ExtIdleNotifierV1 as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtIdleNotificationV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &ExtIdleNotificationV1,
        event: ext_idle_notification_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let mut since = crate::sync::lock(&state.idle_since);
        match event {
            ext_idle_notification_v1::Event::Idled => *since = Some(spell_start(Instant::now())),
            ext_idle_notification_v1::Event::Resumed => *since = None,
            _ => {}
        }
    }
}

/// A running connection to the compositor and its dispatch thread.
pub struct IdleMonitor {
    idle_since: Arc<Mutex<Option<Instant>>>,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl IdleMonitor {
    /// Connect and subscribe; `None` when there is no Wayland session or the
    /// compositor lacks `ext-idle-notify-v1` or a seat.
    pub fn start() -> Option<Self> {
        let conn = Connection::connect_to_env().ok()?;
        let (globals, mut queue) = registry_queue_init::<State>(&conn).ok()?;
        let qh = queue.handle();
        let idle_since = Arc::new(Mutex::new(None));
        let mut state = State {
            idle_since: Arc::clone(&idle_since),
        };
        let subscription = subscribe(&globals, &qh)?;
        queue.roundtrip(&mut state).ok()?;

        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let thread = {
            let (stop, alive) = (Arc::clone(&stop), Arc::clone(&alive));
            std::thread::Builder::new()
                .name("wayland-idle".into())
                .spawn(move || {
                    // Held for the thread's life.
                    let _subscription = subscription;
                    if let Err(e) = run(&conn, &mut queue, &mut state, &stop) {
                        log::debug!("[idle] wayland idle monitor stopped: {e}");
                    }
                    alive.store(false, Ordering::Release);
                })
                .ok()?
        };
        Some(Self {
            idle_since,
            stop,
            alive,
            thread: Some(thread),
        })
    }

    /// False once the connection has failed; the caller drops the monitor.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn idle_ms(&self) -> u64 {
        let since = *crate::sync::lock(&self.idle_since);
        idle_ms_since(since, Instant::now())
    }
}

impl Drop for IdleMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn subscribe(
    globals: &GlobalList,
    qh: &QueueHandle<State>,
) -> Option<(ExtIdleNotificationV1, ExtIdleNotifierV1)> {
    let seat = globals.bind::<wl_seat::WlSeat, _, _>(qh, 1..=1, ()).ok()?;
    let notifier = globals
        .bind::<ExtIdleNotifierV1, _, _>(qh, 1..=2, ())
        .ok()?;
    let ms = u32::try_from(THRESHOLD.as_millis()).unwrap_or(u32::MAX);
    // Version 2 counts input only; version 1 also honours idle inhibitors
    // (a playing video), which is the best it can say.
    let notification = if notifier.version() >= 2 {
        notifier.get_input_idle_notification(ms, &seat, qh, ())
    } else {
        notifier.get_idle_notification(ms, &seat, qh, ())
    };
    Some((notification, notifier))
}

fn run(
    conn: &Connection,
    queue: &mut EventQueue<State>,
    state: &mut State,
    stop: &AtomicBool,
) -> Result<(), Box<dyn std::error::Error>> {
    while !stop.load(Ordering::Acquire) {
        queue.dispatch_pending(state)?;
        conn.flush()?;
        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let mut pfd = libc::pollfd {
            fd: guard.connection_fd().as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `pfd` is one live pollfd and the count says so.
        let ready = unsafe { libc::poll(&mut pfd, 1, POLL_MS) };
        if ready > 0 {
            match guard.read() {
                Err(wayland_client::backend::WaylandError::Io(e))
                    if e.kind() == std::io::ErrorKind::WouldBlock => {}
                other => {
                    other?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_idle_spell_reads_as_zero() {
        assert_eq!(idle_ms_since(None, Instant::now()), 0);
    }

    #[test]
    fn idle_spell_counts_from_its_start() {
        let now = Instant::now();
        let since = now - Duration::from_secs(90);
        assert_eq!(idle_ms_since(Some(since), now), 90_000);
    }

    #[test]
    fn a_spell_starting_in_the_future_is_zero_not_a_panic() {
        let now = Instant::now();
        assert_eq!(idle_ms_since(Some(now + Duration::from_secs(5)), now), 0);
    }

    #[test]
    fn idled_event_backdates_the_spell_by_one_threshold() {
        let now = Instant::now();
        let start = spell_start(now);
        assert_eq!(
            idle_ms_since(Some(start), now),
            THRESHOLD.as_millis() as u64
        );
    }
}
