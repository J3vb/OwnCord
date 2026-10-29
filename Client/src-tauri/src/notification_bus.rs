//! Linux message notifications over the freedesktop notification D-Bus API.
//!
//! One thread owns one session-bus connection: it sends every popup and
//! listens for every click on it. Some servers deliver `ActionInvoked` only to
//! the connection that sent the popup, so the popups and the listener must
//! share it. That replaces `notify-rust`'s thread per popup, which had to be
//! capped (16) and so dropped the click on a busy day.
//!
//! The thread also remembers each ringing call's popup id by its tag, so
//! `close` can withdraw it when the ring ends.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use dbus::arg::{PropMap, RefArg, Variant};
use dbus::blocking::Connection;
use dbus::message::MatchRule;
use tauri::{AppHandle, Emitter, Runtime};

use crate::message_notification::{focus_main_window_with, MessageTarget};
use crate::sync::lock;
use crate::text;

const BUS_NAME: &str = "org.freedesktop.Notifications";
const OBJECT_PATH: &str = "/org/freedesktop/Notifications";
const INTERFACE: &str = BUS_NAME;
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the thread blocks on commands before reading signals again.
const POLL: Duration = Duration::from_millis(100);
/// Popups whose click is still remembered. Past this the oldest is forgotten;
/// a notification centre rarely keeps that many.
const MAX_REMEMBERED: usize = 256;

/// One popup to show.
pub struct Popup {
    pub title: String,
    pub body: String,
    pub target: MessageTarget,
    /// A ringing call's tag: a redial replaces the popup, `close` removes it.
    pub tag: Option<String>,
    pub app_name: String,
}

enum Command {
    Show {
        popup: Popup,
        reply: Sender<Result<(), String>>,
        /// The caller stops waiting here; a Show still queued past it is
        /// dropped, so a slow server cannot pop it up after the renderer has
        /// fallen back to its own notification.
        deadline: Instant,
    },
    Close {
        tag: String,
    },
}

static BUS: OnceLock<Sender<Command>> = OnceLock::new();

/// Show `popup`; a click focuses the main window and emits
/// `notification-click` with its target.
pub fn show<R: Runtime>(app: &AppHandle<R>, popup: Popup) -> Result<(), String> {
    let (reply, answer) = mpsc::channel();
    let wait = CALL_TIMEOUT + POLL;
    bus(app)
        .send(Command::Show {
            popup,
            reply,
            deadline: Instant::now() + wait,
        })
        .map_err(|_| "notification thread stopped".to_string())?;
    answer
        .recv_timeout(wait)
        .map_err(|_| "notification server did not answer".to_string())?
}

/// Withdraw the popup tagged `tag`, if one is still up. Nothing to do when no
/// popup was ever shown.
pub fn close(tag: String) {
    if let Some(bus) = BUS.get() {
        let _ = bus.send(Command::Close { tag });
    }
}

fn bus<R: Runtime>(app: &AppHandle<R>) -> &'static Sender<Command> {
    BUS.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let app = app.clone();
        let on_click = move |target: MessageTarget, token: Option<String>| {
            focus_main_window_with(&app, token);
            let _ = app.emit("notification-click", target);
        };
        if let Err(e) = std::thread::Builder::new()
            .name("notification-bus".into())
            .spawn(move || run(rx, on_click))
        {
            log::warn!("[notify] cannot start the notification thread: {e}");
        }
        tx
    })
}

/// How a session on one bus connection ended.
enum Ended {
    /// Every sender is gone: the app is exiting.
    Closed,
    /// The bus connection failed. A popup it was about to show is handed
    /// back to retry once on a new connection; a close is not, since the
    /// popups of the old connection went with it.
    BusLost(Option<Command>),
}

/// Serve commands until the app exits. A session bus that cannot be reached
/// or is lost is retried on the next command, so one bus restart does not end
/// notifications for the rest of the run.
fn run(
    commands: Receiver<Command>,
    on_click: impl Fn(MessageTarget, Option<String>) + Send + Sync + 'static,
) {
    let on_click: Arc<OnClick> = Arc::new(on_click);
    let mut retry: Option<Command> = None;
    loop {
        let retrying = retry.is_some();
        let first = match retry.take() {
            Some(command) => command,
            None => match commands.recv() {
                Ok(command) => command,
                Err(_) => return,
            },
        };
        let conn = match Connection::new_session() {
            Ok(conn) => conn,
            Err(e) => {
                let error = format!("no session bus for notifications: {e}");
                log::warn!("[notify] {error}");
                if let Command::Show { reply, .. } = first {
                    let _ = reply.send(Err(error));
                }
                continue;
            }
        };
        match serve(&conn, first, &commands, Arc::clone(&on_click)) {
            Ended::Closed => return,
            // Once only, so a bus that keeps dropping cannot spin this loop.
            Ended::BusLost(left) if !retrying => retry = left,
            Ended::BusLost(_) => {}
        }
    }
}

fn serve(
    conn: &Connection,
    first: Command,
    commands: &Receiver<Command>,
    on_click: Arc<OnClick>,
) -> Ended {
    let popups: Arc<Mutex<Popups<MessageTarget>>> =
        Arc::new(Mutex::new(Popups::new(MAX_REMEMBERED)));
    watch_signals(conn, &popups, on_click);

    let mut next = Some(first);
    loop {
        // Read queued signals before each command: a NotificationClosed for
        // a dismissed ring must land before a redial reuses its id.
        loop {
            match conn.process(Duration::ZERO) {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => {
                    log::warn!("[notify] session bus lost: {e}");
                    let show = next.take().filter(|c| matches!(c, Command::Show { .. }));
                    return Ended::BusLost(show);
                }
            }
        }
        match next.take() {
            Some(Command::Show {
                popup,
                reply,
                deadline,
            }) => {
                // Wait no longer than the caller does, so a popup cannot
                // appear after the caller has given up and shown its own.
                let left = deadline.saturating_duration_since(Instant::now());
                if !left.is_zero() {
                    let _ = reply.send(send_popup(conn, &popups, popup, left));
                }
            }
            Some(Command::Close { tag }) => {
                let id = lock(&popups).take_tag(&tag);
                if let Some(id) = id {
                    let closed: Result<(), dbus::Error> = conn
                        .with_proxy(BUS_NAME, OBJECT_PATH, CALL_TIMEOUT)
                        .method_call(INTERFACE, "CloseNotification", (id,));
                    if let Err(e) = closed {
                        log::debug!("[notify] cannot close popup {id}: {e}");
                    }
                }
            }
            None => {}
        }
        match commands.recv_timeout(POLL) {
            Ok(command) => next = Some(command),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ended::Closed,
        }
    }
}

/// Clicks open their target, closed popups are forgotten, and a restarted
/// notification server (which numbers its popups from 1 again) clears every
/// remembered id.
fn watch_signals(
    conn: &Connection,
    popups: &Arc<Mutex<Popups<MessageTarget>>>,
    on_click: Arc<OnClick>,
) {
    // Notification spec 1.2 sends `ActivationToken` just before the
    // `ActionInvoked` it belongs to; one slot is enough.
    let token: Arc<Mutex<Option<(u32, String)>>> = Arc::new(Mutex::new(None));
    let announced = Arc::clone(&token);
    let watched = conn.add_match(
        MatchRule::new_signal(INTERFACE, "ActivationToken")
            .with_sender(BUS_NAME)
            .with_path(OBJECT_PATH),
        move |(id, token): (u32, String), _: &Connection, _: &dbus::Message| {
            *lock(&announced) = (!token.is_empty()).then_some((id, token));
            true
        },
    );
    let clicked = Arc::clone(popups);
    let watched = watched.and_then(|_| {
        conn.add_match(
            MatchRule::new_signal(INTERFACE, "ActionInvoked")
                .with_sender(BUS_NAME)
                .with_path(OBJECT_PATH),
            move |(id, action): (u32, String), _: &Connection, _: &dbus::Message| {
                let token = take_token(&mut lock(&token), id);
                if action == "default" {
                    let target = lock(&clicked).activated(id);
                    if let Some(target) = target {
                        on_click(target, token);
                    }
                }
                true
            },
        )
    });
    let gone = Arc::clone(popups);
    let watched = watched.and_then(|_| {
        conn.add_match(
            MatchRule::new_signal(INTERFACE, "NotificationClosed")
                .with_sender(BUS_NAME)
                .with_path(OBJECT_PATH),
            move |(id, _reason): (u32, u32), _: &Connection, _: &dbus::Message| {
                lock(&gone).closed(id);
                true
            },
        )
    });
    let restarted = Arc::clone(popups);
    let watched = watched.and_then(|_| {
        conn.add_match(
            MatchRule::new_signal("org.freedesktop.DBus", "NameOwnerChanged"),
            move |(name, old, _new): (String, String, String),
                  _: &Connection,
                  _: &dbus::Message| {
                // An empty old owner is the server's first start (often
                // started by our own first Notify): nothing to forget.
                if name == BUS_NAME && !old.is_empty() {
                    lock(&restarted).clear();
                }
                true
            },
        )
    });
    if let Err(e) = watched {
        log::warn!("[notify] cannot watch notification clicks: {e}");
    }
}

fn send_popup(
    conn: &Connection,
    popups: &Mutex<Popups<MessageTarget>>,
    popup: Popup,
    timeout: Duration,
) -> Result<(), String> {
    let replaces = popup
        .tag
        .as_deref()
        .map_or(0, |tag| lock(popups).replaces(tag));
    let (id,): (u32,) = conn
        .with_proxy(BUS_NAME, OBJECT_PATH, timeout)
        .method_call(
            INTERFACE,
            "Notify",
            (
                popup.app_name.as_str(),
                replaces,
                notification_icon(),
                popup.title.as_str(),
                popup.body.as_str(),
                vec!["default", text::NOTIFICATION_OPEN],
                popup_hints(&popup.app_name),
                -1i32,
            ),
        )
        .map_err(|e| format!("failed to show notification: {e}"))?;
    lock(popups).shown(id, popup.target, popup.tag);
    Ok(())
}

/// The click handler: the popup's target and the activation token the server
/// announced for the click, if it sent one.
type OnClick = dyn Fn(MessageTarget, Option<String>) + Send + Sync;

/// Take the remembered activation token if it belongs to popup `id`. The slot
/// is emptied either way, so a token never outlives the click after it.
fn take_token(slot: &mut Option<(u32, String)>, id: u32) -> Option<String> {
    slot.take()
        .and_then(|(token_id, token)| (token_id == id).then_some(token))
}

/// `suppress-sound`: the app plays its own chime (`lib/notificationSound.ts`),
/// so the server must not add a second. `desktop-entry` lets it group the
/// popups under the app.
fn popup_hints(desktop_entry: &str) -> PropMap {
    let mut hints = PropMap::new();
    hints.insert(
        "suppress-sound".into(),
        Variant(Box::new(true) as Box<dyn RefArg>),
    );
    hints.insert(
        "desktop-entry".into(),
        Variant(Box::new(desktop_entry.to_string()) as Box<dyn RefArg>),
    );
    hints
}

/// The popup's icon. An AppImage installs no icon in the theme, so it points
/// at the AppImage's own `.DirIcon`; a .deb installs one named after the
/// binary.
fn notification_icon() -> String {
    let appdir = std::env::var_os("APPDIR").map(std::path::PathBuf::from);
    let exe = std::env::current_exe().unwrap_or_default();
    icon_for(appdir.as_deref(), &exe, |p| p.exists())
}

/// `APPDIR` counts only when this binary runs from it: another AppImage that
/// started this process leaves its own `APPDIR` behind.
fn icon_for(
    appdir: Option<&std::path::Path>,
    exe: &std::path::Path,
    exists: impl Fn(&std::path::Path) -> bool,
) -> String {
    let exe_stem = exe
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    appdir
        .filter(|dir| exe.starts_with(dir))
        .map(|dir| dir.join(".DirIcon"))
        .filter(|icon| exists(icon))
        .and_then(|icon| url::Url::from_file_path(icon).ok())
        .map_or(exe_stem, String::from)
}

/// The popups the thread still remembers: each one's click target, in the
/// order shown, and each ringing call's id by tag.
struct Popups<T> {
    targets: HashMap<u32, T>,
    order: VecDeque<u32>,
    tags: HashMap<String, u32>,
    cap: usize,
}

impl<T> Popups<T> {
    fn new(cap: usize) -> Self {
        Self {
            targets: HashMap::new(),
            order: VecDeque::new(),
            tags: HashMap::new(),
            cap,
        }
    }

    /// The id a popup tagged `tag` should replace, or 0 for a new popup.
    fn replaces(&self, tag: &str) -> u32 {
        self.tags.get(tag).copied().unwrap_or(0)
    }

    fn shown(&mut self, id: u32, target: T, tag: Option<String>) {
        if self.targets.insert(id, target).is_some() {
            self.order.retain(|&known| known != id);
        }
        self.order.push_back(id);
        if let Some(tag) = tag {
            self.tags.insert(tag, id);
        }
        while self.order.len() > self.cap {
            if let Some(oldest) = self.order.pop_front() {
                self.forget(oldest);
            }
        }
    }

    /// The target of a clicked popup; the click ends it.
    fn activated(&mut self, id: u32) -> Option<T> {
        let target = self.targets.remove(&id);
        self.closed(id);
        target
    }

    fn closed(&mut self, id: u32) {
        self.order.retain(|&known| known != id);
        self.forget(id);
    }

    fn clear(&mut self) {
        self.targets.clear();
        self.order.clear();
        self.tags.clear();
    }

    fn take_tag(&mut self, tag: &str) -> Option<u32> {
        self.tags.remove(tag)
    }

    fn forget(&mut self, id: u32) {
        self.targets.remove(&id);
        self.tags.retain(|_, known| *known != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbus::arg::prop_cast;
    use std::path::Path;

    #[test]
    fn a_click_returns_its_target_once() {
        let mut popups = Popups::new(4);
        popups.shown(1, "a", None);
        popups.shown(2, "b", None);
        assert_eq!(popups.activated(2), Some("b"));
        assert_eq!(popups.activated(2), None);
        assert_eq!(popups.activated(1), Some("a"));
    }

    #[test]
    fn the_twentieth_popup_still_opens_on_click() {
        // The old per-popup waiters stopped at 16; every popup up to the cap
        // keeps its click now.
        let mut popups = Popups::new(MAX_REMEMBERED);
        for id in 1..=20 {
            popups.shown(id, id, None);
        }
        assert_eq!(popups.activated(20), Some(20));
        assert_eq!(popups.activated(1), Some(1));
    }

    #[test]
    fn past_the_cap_the_oldest_click_is_forgotten() {
        let mut popups = Popups::new(2);
        popups.shown(1, "a", Some("call-1".into()));
        popups.shown(2, "b", None);
        popups.shown(3, "c", None);
        assert_eq!(popups.activated(1), None);
        assert_eq!(popups.take_tag("call-1"), None);
        assert_eq!(popups.activated(3), Some("c"));
    }

    #[test]
    fn an_activation_token_reaches_only_its_own_click() {
        let mut slot = Some((7, "tok".to_string()));
        assert_eq!(take_token(&mut slot, 7).as_deref(), Some("tok"));
        assert_eq!(take_token(&mut slot, 7), None, "a token is used once");
        let mut other = Some((8, "tok".to_string()));
        assert_eq!(take_token(&mut other, 7), None, "another popup's token");
        assert!(other.is_none(), "a mismatched token is dropped too");
    }

    #[test]
    fn a_closed_popup_frees_its_slot() {
        let mut popups = Popups::new(2);
        for id in 1..=100 {
            popups.shown(id, id, None);
            popups.closed(id);
        }
        assert!(popups.order.is_empty() && popups.targets.is_empty());
    }

    #[test]
    fn a_ring_tag_is_replaced_by_a_redial_and_taken_when_the_ring_ends() {
        let mut popups = Popups::new(8);
        assert_eq!(popups.replaces("call-7"), 0);
        popups.shown(5, "ring", Some("call-7".into()));
        assert_eq!(popups.replaces("call-7"), 5);
        // A redial reuses id 5 (the server replaces in place).
        popups.shown(5, "ring again", Some("call-7".into()));
        assert_eq!(popups.order.len(), 1);
        assert_eq!(popups.take_tag("call-7"), Some(5));
        assert_eq!(popups.take_tag("call-7"), None);
    }

    #[test]
    fn a_dismissed_ring_has_nothing_left_to_close() {
        let mut popups = Popups::new(8);
        popups.shown(5, "ring", Some("call-7".into()));
        popups.closed(5);
        assert_eq!(popups.take_tag("call-7"), None);
    }

    #[test]
    fn popups_ask_the_server_for_no_sound_of_its_own() {
        let hints = popup_hints("OwnCord");
        assert_eq!(prop_cast::<bool>(&hints, "suppress-sound"), Some(&true));
        assert_eq!(
            prop_cast::<String>(&hints, "desktop-entry").map(String::as_str),
            Some("OwnCord")
        );
    }

    #[test]
    fn an_appimage_uses_its_own_icon_file() {
        let dir = Path::new("/tmp/.mount_Own Cord");
        let exe = Path::new("/tmp/.mount_Own Cord/usr/bin/owncord");
        assert_eq!(
            icon_for(Some(dir), exe, |_| true),
            "file:///tmp/.mount_Own%20Cord/.DirIcon"
        );
        assert_eq!(icon_for(Some(dir), exe, |_| false), "owncord");
        assert_eq!(icon_for(None, exe, |_| true), "owncord");
    }

    #[test]
    fn another_appimages_appdir_is_not_ours() {
        let deb = Path::new("/usr/bin/owncord");
        assert_eq!(
            icon_for(Some(Path::new("/tmp/.mount_Other")), deb, |_| true),
            "owncord"
        );
    }

    #[test]
    fn a_restarted_server_clears_every_remembered_popup() {
        let mut popups = Popups::new(8);
        popups.shown(1, "a", Some("call-1".into()));
        popups.clear();
        assert_eq!(popups.activated(1), None);
        assert_eq!(popups.replaces("call-1"), 0);
    }

    /// Needs a session bus: `dbus-run-session -- cargo test -- --ignored dbus`.
    /// A stand-in notification server answers `Notify`, records
    /// `CloseNotification`, and sends the click back only to the connection
    /// that showed the popup, as GNOME Shell does.
    #[test]
    #[ignore = "needs a session bus (dbus-run-session)"]
    fn dbus_popups_click_and_ring_close_round_trip() {
        use dbus::channel::{MatchingReceiver as _, Sender as _};
        use dbus::Message;
        use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

        let server = Connection::new_session().expect("session bus");
        server
            .request_name(BUS_NAME, false, true, true)
            .expect("own the notification name");
        let next_id = Arc::new(AtomicU32::new(40));
        let suppressed = Arc::new(AtomicBool::new(false));
        let closed = Arc::new(AtomicU32::new(0));
        let (ids, served) = (Arc::clone(&next_id), Arc::clone(&suppressed));
        let closes = Arc::clone(&closed);
        let client = Arc::new(Mutex::new(None::<String>));
        let notifier = Arc::clone(&client);
        let activated = AtomicBool::new(false);
        server.start_receive(
            MatchRule::new_method_call(),
            Box::new(move |msg: Message, conn: &Connection| {
                match msg.member().as_deref() {
                    Some("Notify") => {
                        let (_, replaces, _, _, _, actions, hints, _): (
                            String,
                            u32,
                            String,
                            String,
                            String,
                            Vec<String>,
                            PropMap,
                            i32,
                        ) = msg.read_all().expect("Notify arguments");
                        assert_eq!(actions, ["default", text::NOTIFICATION_OPEN]);
                        *lock(&notifier) = msg.sender().map(|s| s.to_string());
                        if prop_cast::<bool>(&hints, "suppress-sound") == Some(&true) {
                            served.store(true, Ordering::SeqCst);
                        }
                        // The bus starts a D-Bus-activated server for the
                        // first call and announces it before the reply.
                        if !activated.swap(true, Ordering::SeqCst) {
                            let started = Message::new_signal(
                                "/org/freedesktop/DBus",
                                "org.freedesktop.DBus",
                                "NameOwnerChanged",
                            )
                            .unwrap()
                            .append3(BUS_NAME, "", ":1.99");
                            let _ = conn.send(started);
                        }
                        let id = if replaces == 0 {
                            ids.fetch_add(1, Ordering::SeqCst) + 1
                        } else {
                            replaces
                        };
                        let _ = conn.send(msg.method_return().append1(id));
                    }
                    Some("CloseNotification") => {
                        let id: u32 = msg.read1().expect("CloseNotification id");
                        closes.store(id, Ordering::SeqCst);
                        let _ = conn.send(msg.method_return());
                    }
                    _ => {}
                }
                true
            }),
        );
        let stop = Arc::new(AtomicBool::new(false));
        let serving = Arc::clone(&stop);
        let (signal_tx, signal_rx) = mpsc::channel::<Message>();
        let server_thread = std::thread::spawn(move || {
            while !serving.load(Ordering::SeqCst) {
                let _ = server.process(Duration::from_millis(20));
                while let Ok(signal) = signal_rx.try_recv() {
                    let _ = server.send(signal);
                }
            }
        });

        let (tx, rx) = mpsc::channel();
        let (click_tx, click_rx) = mpsc::channel();
        std::thread::spawn(move || {
            run(rx, move |target, token| {
                click_tx.send((target, token)).unwrap()
            })
        });
        let show = |channel_id: i64, tag: Option<&str>| {
            let (reply, answer) = mpsc::channel();
            tx.send(Command::Show {
                popup: Popup {
                    title: "t".into(),
                    body: "b".into(),
                    target: MessageTarget {
                        host: "h".into(),
                        channel_id,
                        message_id: None,
                    },
                    tag: tag.map(String::from),
                    app_name: "OwnCord".into(),
                },
                reply,
                deadline: Instant::now() + Duration::from_secs(5),
            })
            .unwrap();
            answer.recv_timeout(Duration::from_secs(5)).unwrap()
        };

        for channel_id in 1..=20 {
            show(channel_id, None).expect("popup shown");
        }
        assert!(suppressed.load(Ordering::SeqCst));
        let showed_by = lock(&client).clone().expect("Notify came from the client");
        // The first popup (id 41) survives the server's start announcement,
        // and the 20th (id 60) still opens its target on click.
        for (id, channel_id) in [(41u32, 1), (60, 20)] {
            let mut click = Message::new_signal(OBJECT_PATH, INTERFACE, "ActionInvoked")
                .unwrap()
                .append2(id, "default");
            click.set_destination(Some(showed_by.clone().into()));
            signal_tx.send(click).unwrap();
            let (target, token) = click_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("click");
            assert_eq!(target.channel_id, channel_id);
            assert_eq!(token, None, "a click with no token still works");
        }

        // Spec 1.2: ActivationToken arrives just before its ActionInvoked.
        let mut announce = Message::new_signal(OBJECT_PATH, INTERFACE, "ActivationToken")
            .unwrap()
            .append2(42u32, "xdg-token-1");
        announce.set_destination(Some(showed_by.clone().into()));
        signal_tx.send(announce).unwrap();
        let mut click = Message::new_signal(OBJECT_PATH, INTERFACE, "ActionInvoked")
            .unwrap()
            .append2(42u32, "default");
        click.set_destination(Some(showed_by.clone().into()));
        signal_tx.send(click).unwrap();
        let (target, token) = click_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("click with token");
        assert_eq!(target.channel_id, 2);
        assert_eq!(token.as_deref(), Some("xdg-token-1"));

        // A ring, then a redial replacing it, then the ring ends.
        show(7, Some("call-7")).expect("ring shown");
        show(7, Some("call-7")).expect("redial shown");
        assert_eq!(
            next_id.load(Ordering::SeqCst),
            61,
            "redial replaced the ring"
        );
        tx.send(Command::Close {
            tag: "call-7".into(),
        })
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while closed.load(Ordering::SeqCst) != 61 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(closed.load(Ordering::SeqCst), 61);

        stop.store(true, Ordering::SeqCst);
        server_thread.join().unwrap();
    }
}
