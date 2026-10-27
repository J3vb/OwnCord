//! Global push to talk, mute and deafen keys on Wayland, through the
//! xdg-desktop-portal GlobalShortcuts interface.
//!
//! One thread (`portal-shortcuts`) owns one session-bus connection, as
//! `notification_bus.rs` does. It probes the interface's `version`, opens a
//! portal session, and binds the three shortcuts only when the webview asks:
//! GNOME and KDE show a dialog for shortcuts the app has not bound before.
//! `Activated` and `Deactivated` become the `ptt-state` and `voice-shortcut`
//! events the X11/Windows poller emits, so the webview never branches on the
//! platform. The desktop grabs a bound key, so the focused app no longer
//! receives it.
//!
//! The thread's decisions are a pure reducer (`Core`); the loop only does bus
//! I/O (behind the `Bus` trait) and turns each `Effect` into an emit.
//!
//! Lock order: `PORTAL`, then `Shared::status`, never the reverse. `status` is
//! a leaf, held only to copy or replace the snapshot.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use dbus::arg::{prop_cast, AppendAll, PropMap, RefArg, Variant};
use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
use dbus::blocking::Connection;
use dbus::channel::MatchingReceiver as _;
use dbus::message::MatchRule;
use dbus::Path;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::oneshot;

use crate::portal_app_id::{self, Ensured, APP_ID};
use crate::shortcuts::{
    backend, portal_ptt_allowed, Backend, GlobalKeysStatus, Triggers, PORTAL_PTT_DENY,
};
use crate::text;

const DESKTOP: &str = "org.freedesktop.portal.Desktop";
const DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS_IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REGISTRY_IFACE: &str = "org.freedesktop.host.portal.Registry";
const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
const SESSION_IFACE: &str = "org.freedesktop.portal.Session";
const REQUEST_PREFIX: &str = "/org/freedesktop/portal/desktop/request";

const ID_PTT: &str = "push-to-talk";
const ID_MUTE: &str = "toggle-mute";
const ID_DEAFEN: &str = "toggle-deafen";

/// A cold portal is started by D-Bus activation, so the probe gets longer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a status read waits for the first probe.
const WAIT_FOR_PROBE: Duration = Duration::from_millis(3500);
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// The bind dialog is the user's; nothing runs while they read it.
const BIND_TIMEOUT: Duration = Duration::from_secs(300);
const CLOSE_TIMEOUT: Duration = Duration::from_millis(500);
/// Portal-closed sessions replaced before the next successful bind.
const MAX_REOPENS: u8 = 3;
/// How long the loop blocks on the bus before it reads commands again.
const TICK: Duration = Duration::from_millis(50);
const RECONNECT: Duration = Duration::from_secs(2);
/// Extra Register attempts after a freshly written desktop entry, and the
/// pause between them: the portal's GIO may not have seen the file yet.
const REGISTER_RETRIES: u8 = 2;
const REGISTER_RETRY_WAIT: Duration = Duration::from_millis(300);
/// What exit waits for the thread before it lets go of it.
const JOIN_BUDGET: Duration = Duration::from_secs(2);

/// Sent to the webview's existing `ptt-error` handler when the portal path
/// that PTT was riding is gone.
const PTT_LOST: &str = "portal shortcuts lost";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// The Request object path the portal answers on, predicted from our unique
/// name and the handle token we passed.
fn request_path(unique_name: &str, token: &str) -> String {
    let sender = unique_name.trim_start_matches(':').replace('.', "_");
    format!("{REQUEST_PREFIX}/{sender}/{token}")
}

/// F1 to F24 only. The desktop consumes a portal trigger, so a PTT key that
/// other apps need (Space, Caps Lock) is never suggested; modifier-only keys
/// and mouse buttons cannot be portal triggers at all.
fn ptt_preferred_trigger(vk: i32) -> Option<String> {
    (0x70..=0x87)
        .contains(&vk)
        .then(|| format!("F{}", vk - 0x6F))
}

/// Ctrl+Shift plus the letter or digit `keyEventToVk` bound, as an xkb keysym
/// name in lowercase.
fn combo_preferred_trigger(vk: i32) -> Option<String> {
    let key = match vk {
        0x30..=0x39 | 0x41..=0x5A => char::from(u8::try_from(vk).ok()?).to_ascii_lowercase(),
        _ => return None,
    };
    Some(format!("CTRL+SHIFT+{key}"))
}

/// The triggers a portal reported, from `(shortcut id, trigger_description)`
/// pairs. A missing or empty description is unbound.
fn triggers_from(entries: &[(String, Option<String>)]) -> Triggers {
    let find = |id: &str| {
        entries
            .iter()
            .find(|(entry, _)| entry == id)
            .and_then(|(_, trigger)| trigger.clone())
            .filter(|trigger| !trigger.is_empty())
    };
    let listed = |id: &str| entries.iter().any(|(entry, _)| entry == id);
    let triggers = Triggers {
        ptt: find(ID_PTT),
        mute: find(ID_MUTE),
        deafen: find(ID_DEAFEN),
        unnamed: false,
    };
    // xdg-desktop-portal-hyprland lists our shortcuts with an empty trigger
    // every time: the keys live in the compositor's config.
    let unnamed = listed(ID_PTT)
        && listed(ID_MUTE)
        && listed(ID_DEAFEN)
        && triggers.ptt.is_none()
        && triggers.mute.is_none()
        && triggers.deafen.is_none();
    Triggers {
        unnamed,
        ..triggers
    }
}

/// Whether a failed Register means this connection already has an app id,
/// which is what we wanted.
fn already_registered(error: &str) -> bool {
    error.contains("already associated")
}

/// Run `attempt` (a Register call) and, when it fails after this run wrote the
/// desktop entry, up to `retries` more times `wait` apart. An error that says
/// the connection already has an id counts as success.
fn register_with(
    mut attempt: impl FnMut() -> Result<(), String>,
    ensured: Ensured,
    retries: u8,
    wait: Duration,
) -> Result<(), String> {
    let mut left = if ensured == Ensured::Written {
        retries
    } else {
        0
    };
    loop {
        match attempt() {
            Ok(()) => return Ok(()),
            Err(e) if already_registered(&e) => return Ok(()),
            Err(e) if left == 0 => return Err(e),
            Err(_) => {
                left -= 1;
                std::thread::sleep(wait);
            }
        }
    }
}

fn entries_from_props(shortcuts: &[(String, PropMap)]) -> Vec<(String, Option<String>)> {
    shortcuts
        .iter()
        .map(|(id, props)| {
            let trigger = prop_cast::<String>(props, "trigger_description").cloned();
            (id.clone(), trigger)
        })
        .collect()
}

/// The `shortcuts` result (`a(sa{sv})`) of a Response, which arrives as an
/// untyped variant.
fn entries_from_variant(shortcuts: &dyn RefArg) -> Option<Vec<(String, Option<String>)>> {
    let mut entries = Vec::new();
    for item in shortcuts.as_iter()? {
        let mut fields = item.as_iter()?;
        let id = fields.next()?.as_str()?.to_string();
        let mut dict = fields.next()?.as_iter()?;
        let mut trigger = None;
        while let (Some(key), Some(value)) = (dict.next(), dict.next()) {
            if key.as_str() == Some("trigger_description") {
                trigger = value.as_str().map(str::to_string);
            }
        }
        entries.push((id, trigger));
    }
    Some(entries)
}

/// CreateSession's `session_handle` is documented as `s` in some portal
/// versions and `o` in others.
fn session_handle(results: &PropMap) -> Option<String> {
    results
        .get("session_handle")
        .and_then(|v| v.0.as_str())
        .map(str::to_string)
}

fn sv(value: &str) -> Variant<Box<dyn RefArg>> {
    Variant(Box::new(value.to_string()))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/// Whether the webview has asked for each kind of event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Armed {
    ptt: bool,
    keys: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Event {
    /// The interface `version` read, or `None` when it did not.
    Probed(Option<u32>),
    SessionCreated(String),
    /// CreateSession failed or was refused.
    SessionRefused,
    /// A bind Response with code 0; its triggers when it carried any.
    BindDone(Option<Triggers>),
    TriggersChanged {
        session: String,
        triggers: Triggers,
    },
    Activated {
        session: String,
        id: String,
    },
    Deactivated {
        session: String,
        id: String,
    },
    /// The webview stopped push to talk.
    PttDisarmed,
    NameOwnerChanged {
        old: String,
        new: String,
    },
    SessionClosed {
        session: String,
    },
    BusLost,
}

#[derive(Debug, PartialEq, Eq)]
enum Effect {
    PttState(bool),
    VoiceShortcut(&'static str),
    PttError,
    StatusChanged,
    /// We hold no session while the portal is there (a new owner appeared,
    /// or it closed ours): probe, create one again and load what it
    /// remembers.
    Reestablish,
    /// Bind once more with the preferred triggers of the earlier bind.
    Rebind,
}

struct Core {
    version: Option<u32>,
    session: Option<String>,
    triggers: Triggers,
    ptt_held: bool,
    /// The portal refused to open our session; cleared by one that opens.
    refused: bool,
    /// A bind in this run succeeded, so a restarted portal gets one again.
    bound_this_run: bool,
    /// `establish` is running: the owner change our own probe causes is not
    /// a restart.
    establishing: bool,
    /// False on a desktop known not to send `Deactivated`.
    ptt_allowed: bool,
    /// Sessions the portal may still close before we stop replacing them, so
    /// a portal that closes every new session cannot spin this thread.
    reopens_left: u8,
}

impl Core {
    fn new(ptt_allowed: bool) -> Self {
        Self {
            establishing: false,
            ptt_allowed,
            version: None,
            session: None,
            refused: false,
            triggers: Triggers::default(),
            ptt_held: false,
            bound_this_run: false,
            reopens_left: MAX_REOPENS,
        }
    }

    fn status(&self) -> GlobalKeysStatus {
        GlobalKeysStatus::new(
            backend(true, false, self.version),
            self.version.unwrap_or(0),
            self.triggers.clone(),
        )
        .with_refused(self.refused)
    }

    fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }

    fn ours(&self, session: &str) -> bool {
        self.session.as_deref() == Some(session)
    }

    /// Everything bound is gone. A held PTT key is released and an armed one
    /// is reported lost, so the webview opens the mic gate it would otherwise
    /// leave closed.
    fn lost(&mut self, armed: Armed) -> Vec<Effect> {
        let mut effects = Vec::new();
        if std::mem::take(&mut self.ptt_held) {
            effects.push(Effect::PttState(false));
        }
        if armed.ptt {
            effects.push(Effect::PttError);
        }
        self.session = None;
        self.triggers = Triggers::default();
        effects.push(Effect::StatusChanged);
        effects
    }

    fn set_triggers(&mut self, triggers: Triggers, armed: Armed) -> Vec<Effect> {
        let ptt_dropped = self.triggers.ptt.is_some() && triggers.ptt.is_none();
        self.triggers = triggers;
        let mut effects = Vec::new();
        if ptt_dropped {
            if std::mem::take(&mut self.ptt_held) {
                effects.push(Effect::PttState(false));
            }
            if armed.ptt {
                effects.push(Effect::PttError);
            }
        }
        effects.push(Effect::StatusChanged);
        effects
    }

    fn on_event(&mut self, event: Event, armed: Armed, ptt_vk: i32) -> Vec<Effect> {
        match event {
            Event::Probed(version) => {
                self.version = version;
                if version.is_none() {
                    self.refused = false;
                }
                vec![Effect::StatusChanged]
            }
            Event::SessionCreated(session) => {
                self.session = Some(session);
                if std::mem::take(&mut self.refused) {
                    vec![Effect::StatusChanged]
                } else {
                    Vec::new()
                }
            }
            Event::SessionRefused => {
                if std::mem::replace(&mut self.refused, true) {
                    Vec::new()
                } else {
                    vec![Effect::StatusChanged]
                }
            }
            Event::BindDone(triggers) => {
                self.bound_this_run = true;
                self.reopens_left = MAX_REOPENS;
                match triggers {
                    Some(triggers) => self.set_triggers(triggers, armed),
                    None => Vec::new(),
                }
            }
            Event::TriggersChanged { session, triggers } => {
                if self.ours(&session) {
                    self.set_triggers(triggers, armed)
                } else {
                    Vec::new()
                }
            }
            Event::Activated { session, id } => {
                if !self.ours(&session) {
                    return Vec::new();
                }
                match id.as_str() {
                    ID_PTT if armed.ptt && self.ptt_allowed && ptt_vk != 0 && !self.ptt_held => {
                        self.ptt_held = true;
                        vec![Effect::PttState(true)]
                    }
                    ID_MUTE if armed.keys => vec![Effect::VoiceShortcut("mute")],
                    ID_DEAFEN if armed.keys => vec![Effect::VoiceShortcut("deafen")],
                    _ => Vec::new(),
                }
            }
            Event::Deactivated { session, id } => {
                if self.ours(&session) && id == ID_PTT && std::mem::take(&mut self.ptt_held) {
                    vec![Effect::PttState(false)]
                } else {
                    Vec::new()
                }
            }
            Event::PttDisarmed => {
                self.ptt_held = false;
                Vec::new()
            }
            Event::NameOwnerChanged { old, new } => {
                let mut effects = if old.is_empty() {
                    Vec::new()
                } else {
                    self.lost(armed)
                };
                if !new.is_empty() && self.session.is_none() && !self.establishing {
                    effects.push(Effect::Reestablish);
                    if self.bound_this_run {
                        effects.push(Effect::Rebind);
                    }
                }
                effects
            }
            Event::SessionClosed { session } => {
                if !self.ours(&session) {
                    return Vec::new();
                }
                self.bound_this_run = false;
                let mut effects = self.lost(armed);
                if !self.establishing && self.reopens_left > 0 {
                    self.reopens_left -= 1;
                    effects.push(Effect::Reestablish);
                }
                effects
            }
            Event::BusLost => {
                self.version = None;
                self.refused = false;
                self.lost(armed)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------

/// A Request's Response, reduced to what the thread reads.
#[derive(Debug)]
struct Response {
    path: String,
    code: u32,
    session_handle: Option<String>,
    triggers: Option<Triggers>,
}

fn parse_response(path: String, code: u32, results: &PropMap) -> Response {
    let triggers = results
        .get("shortcuts")
        .and_then(|v| entries_from_variant(&v.0))
        .map(|entries| triggers_from(&entries));
    Response {
        path,
        code,
        session_handle: session_handle(results),
        triggers,
    }
}

enum Incoming {
    Response(Response),
    Event(Event),
}

struct BindSpec {
    id: &'static str,
    description: &'static str,
    preferred: Option<String>,
}

/// The portal calls the thread makes. `DbusBus` is the real one; tests fake it.
/// A call that opens a Request returns every path its Response may arrive on.
trait Bus {
    /// Tell the portal which app this connection is, before any other call.
    fn register(&mut self) -> Result<(), String>;
    fn version(&mut self) -> Result<u32, String>;
    fn create_session(&mut self, token: u64) -> Result<Vec<String>, String>;
    fn bind(
        &mut self,
        session: &str,
        token: u64,
        specs: &[BindSpec],
    ) -> Result<Vec<String>, String>;
    fn list(&mut self, session: &str, token: u64) -> Result<Vec<String>, String>;
    fn configure(&mut self, session: &str) -> Result<(), String>;
    fn close_request(&mut self, path: &str);
    fn close_session(&mut self, session: &str);
    /// Wait up to `wait` for traffic and return what arrived. `Err` means the
    /// bus connection is gone.
    fn poll(&mut self, wait: Duration) -> Result<Vec<Incoming>, String>;
}

fn handle_token(token: u64) -> String {
    format!("owncord_{token}")
}

struct DbusBus {
    conn: Connection,
    incoming: Receiver<Incoming>,
}

impl DbusBus {
    fn connect() -> Result<Self, String> {
        let conn = Connection::new_session().map_err(|e| format!("no session bus: {e}"))?;
        let (tx, incoming) = mpsc::channel();
        watch(&conn, &tx).map_err(|e| format!("cannot watch the portal: {e}"))?;
        Ok(Self { conn, incoming })
    }

    fn call<R: dbus::arg::ReadAll, A: AppendAll>(
        &self,
        path: &str,
        iface: &str,
        member: &str,
        timeout: Duration,
        args: A,
    ) -> Result<R, String> {
        let path = Path::new(path).map_err(|e| format!("{member}: bad path {path}: {e}"))?;
        self.conn
            .with_proxy(DESKTOP, path, timeout)
            .method_call(iface, member, args)
            .map_err(|e| format!("{member}: {e}"))
    }

    /// Call a method that opens a Request and return its Response paths: the
    /// one predicted from the token and, when an old portal chose another, the
    /// one it returned.
    fn request<A: AppendAll>(
        &self,
        member: &str,
        token: &str,
        args: A,
    ) -> Result<Vec<String>, String> {
        let predicted = request_path(&self.conn.unique_name(), token);
        let (returned,): (Path<'static>,) =
            self.call(DESKTOP_PATH, SHORTCUTS_IFACE, member, CALL_TIMEOUT, args)?;
        let mut paths = vec![predicted];
        let returned = returned.to_string();
        if paths[0] != returned {
            paths.push(returned);
        }
        Ok(paths)
    }

    fn options(token: &str) -> PropMap {
        let mut options = PropMap::new();
        options.insert("handle_token".to_string(), sv(token));
        options
    }
}

/// The signals the thread reads. A single Response match, filtered by path in
/// the loop, leaves no gap between the call and its match.
fn watch(conn: &Connection, tx: &Sender<Incoming>) -> Result<(), dbus::Error> {
    let out = tx.clone();
    conn.add_match(
        MatchRule::new_signal(REQUEST_IFACE, "Response").with_sender(DESKTOP),
        move |(code, results): (u32, PropMap), _: &Connection, msg: &dbus::Message| {
            if let Some(path) = msg.path() {
                let _ = out.send(Incoming::Response(parse_response(
                    path.to_string(),
                    code,
                    &results,
                )));
            }
            true
        },
    )?;
    let out = tx.clone();
    conn.add_match(
        MatchRule::new_signal(SHORTCUTS_IFACE, "Activated").with_sender(DESKTOP),
        move |(session, id, _stamp, _options): (Path<'static>, String, u64, PropMap),
              _: &Connection,
              _: &dbus::Message| {
            let session = session.to_string();
            let _ = out.send(Incoming::Event(Event::Activated { session, id }));
            true
        },
    )?;
    let out = tx.clone();
    conn.add_match(
        MatchRule::new_signal(SHORTCUTS_IFACE, "Deactivated").with_sender(DESKTOP),
        move |(session, id, _stamp, _options): (Path<'static>, String, u64, PropMap),
              _: &Connection,
              _: &dbus::Message| {
            let session = session.to_string();
            let _ = out.send(Incoming::Event(Event::Deactivated { session, id }));
            true
        },
    )?;
    let out = tx.clone();
    conn.add_match(
        MatchRule::new_signal(SHORTCUTS_IFACE, "ShortcutsChanged").with_sender(DESKTOP),
        move |(session, shortcuts): (Path<'static>, Vec<(String, PropMap)>),
              _: &Connection,
              _: &dbus::Message| {
            let triggers = triggers_from(&entries_from_props(&shortcuts));
            let session = session.to_string();
            let _ = out.send(Incoming::Event(Event::TriggersChanged {
                session,
                triggers,
            }));
            true
        },
    )?;
    let out = tx.clone();
    conn.add_match(
        MatchRule::new_signal(SESSION_IFACE, "Closed").with_sender(DESKTOP),
        move |_: (PropMap,), _: &Connection, msg: &dbus::Message| {
            if let Some(path) = msg.path() {
                let session = path.to_string();
                let _ = out.send(Incoming::Event(Event::SessionClosed { session }));
            }
            true
        },
    )?;
    let out = tx.clone();
    // Only the portal's name: a string rule, since `MatchRule` has no arg0.
    conn.add_match_no_cb(&format!(
        "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',\
         member='NameOwnerChanged',arg0='{DESKTOP}'"
    ))?;
    conn.start_receive(
        MatchRule::new_signal("org.freedesktop.DBus", "NameOwnerChanged")
            .with_sender("org.freedesktop.DBus"),
        Box::new(move |msg: dbus::Message, _: &Connection| {
            if let Ok((name, old, new)) = msg.read3::<String, String, String>() {
                if name == DESKTOP {
                    let _ = out.send(Incoming::Event(Event::NameOwnerChanged { old, new }));
                }
            }
            true
        }),
    );
    Ok(())
}

impl Bus for DbusBus {
    fn register(&mut self) -> Result<(), String> {
        let ensured = portal_app_id::ensure_desktop_entry();
        register_with(
            || {
                self.call(
                    DESKTOP_PATH,
                    REGISTRY_IFACE,
                    "Register",
                    PROBE_TIMEOUT,
                    (APP_ID, PropMap::new()),
                )
            },
            ensured,
            REGISTER_RETRIES,
            REGISTER_RETRY_WAIT,
        )
    }

    fn version(&mut self) -> Result<u32, String> {
        self.conn
            .with_proxy(DESKTOP, DESKTOP_PATH, PROBE_TIMEOUT)
            .get::<u32>(SHORTCUTS_IFACE, "version")
            .map_err(|e| format!("version: {e}"))
    }

    fn create_session(&mut self, token: u64) -> Result<Vec<String>, String> {
        let request = handle_token(token);
        let mut options = Self::options(&request);
        options.insert(
            "session_handle_token".to_string(),
            sv(&format!("{request}_s")),
        );
        self.request("CreateSession", &request, (options,))
    }

    fn bind(
        &mut self,
        session: &str,
        token: u64,
        specs: &[BindSpec],
    ) -> Result<Vec<String>, String> {
        let request = handle_token(token);
        let shortcuts: Vec<(String, PropMap)> = specs
            .iter()
            .map(|spec| {
                let mut props = PropMap::new();
                props.insert("description".to_string(), sv(spec.description));
                if let Some(trigger) = &spec.preferred {
                    props.insert("preferred_trigger".to_string(), sv(trigger));
                }
                (spec.id.to_string(), props)
            })
            .collect();
        let session = Path::new(session).map_err(|e| format!("bad session {session}: {e}"))?;
        self.request(
            "BindShortcuts",
            &request,
            (session, shortcuts, "", Self::options(&request)),
        )
    }

    fn list(&mut self, session: &str, token: u64) -> Result<Vec<String>, String> {
        let request = handle_token(token);
        let session = Path::new(session).map_err(|e| format!("bad session {session}: {e}"))?;
        self.request(
            "ListShortcuts",
            &request,
            (session, Self::options(&request)),
        )
    }

    fn configure(&mut self, session: &str) -> Result<(), String> {
        let session = Path::new(session).map_err(|e| format!("bad session {session}: {e}"))?;
        self.call(
            DESKTOP_PATH,
            SHORTCUTS_IFACE,
            "ConfigureShortcuts",
            CALL_TIMEOUT,
            (session, "", PropMap::new()),
        )
    }

    fn close_request(&mut self, path: &str) {
        let closed: Result<(), String> = self.call(path, REQUEST_IFACE, "Close", CLOSE_TIMEOUT, ());
        if let Err(e) = closed {
            log::debug!("[portal] cannot close request: {e}");
        }
    }

    fn close_session(&mut self, session: &str) {
        let closed: Result<(), String> =
            self.call(session, SESSION_IFACE, "Close", CLOSE_TIMEOUT, ());
        if let Err(e) = closed {
            log::debug!("[portal] cannot close session: {e}");
        }
    }

    fn poll(&mut self, wait: Duration) -> Result<Vec<Incoming>, String> {
        let lost = |e: dbus::Error| format!("session bus lost: {e}");
        self.conn.process(wait).map_err(lost)?;
        while self.conn.process(Duration::ZERO).map_err(lost)? {}
        Ok(self.incoming.try_iter().collect())
    }
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/// What `shortcuts.rs` and `ptt.rs` flip when the webview starts or stops
/// push to talk or the global voice shortcuts.
#[derive(Clone, Copy)]
pub(crate) enum Flag {
    Ptt,
    Keys,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BindPrefs {
    pub ptt_vk: i32,
    pub mute_vk: i32,
    pub deafen_vk: i32,
}

fn bind_specs(prefs: BindPrefs) -> [BindSpec; 3] {
    [
        BindSpec {
            id: ID_PTT,
            description: text::SHORTCUT_PTT,
            preferred: ptt_preferred_trigger(prefs.ptt_vk),
        },
        BindSpec {
            id: ID_MUTE,
            description: text::SHORTCUT_MUTE,
            preferred: combo_preferred_trigger(prefs.mute_vk),
        },
        BindSpec {
            id: ID_DEAFEN,
            description: text::SHORTCUT_DEAFEN,
            preferred: combo_preferred_trigger(prefs.deafen_vk),
        },
    ]
}

type Reply<T> = oneshot::Sender<Result<T, String>>;

enum Cmd {
    Bind {
        prefs: BindPrefs,
        reply: Reply<GlobalKeysStatus>,
    },
    Configure {
        reply: Reply<()>,
    },
    Stop,
}

/// What the thread tells the app. The sink built at start turns each into an
/// `app.emit`.
enum Emit {
    PttState(bool),
    VoiceShortcut(&'static str),
    PttError,
    Changed(GlobalKeysStatus),
}

type Sink = Arc<dyn Fn(Emit) + Send + Sync>;

/// State shared between the thread and the commands that read it.
struct Shared {
    status: Mutex<GlobalKeysStatus>,
    probed: (Mutex<bool>, Condvar),
    ptt_armed: AtomicBool,
    keys_armed: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        Self {
            status: Mutex::new(GlobalKeysStatus::without_triggers(Backend::None)),
            probed: (Mutex::new(false), Condvar::new()),
            ptt_armed: AtomicBool::new(false),
            keys_armed: AtomicBool::new(false),
        }
    }

    fn status(&self) -> GlobalKeysStatus {
        lock(&self.status).clone()
    }

    fn mark_probed(&self) {
        *lock(&self.probed.0) = true;
        self.probed.1.notify_all();
    }

    fn wait_probed(&self, timeout: Duration) {
        let guard = lock(&self.probed.0);
        let _ = self
            .probed
            .1
            .wait_timeout_while(guard, timeout, |probed| !*probed)
            .unwrap_or_else(|e| e.into_inner());
    }

    fn flag(&self, flag: Flag) -> &AtomicBool {
        match flag {
            Flag::Ptt => &self.ptt_armed,
            Flag::Keys => &self.keys_armed,
        }
    }

    fn armed(&self) -> Armed {
        Armed {
            ptt: self.ptt_armed.load(Ordering::SeqCst),
            keys: self.keys_armed.load(Ordering::SeqCst),
        }
    }
}

/// How a serve loop ended.
enum End {
    /// `Stop` was sent, or every sender is gone.
    Stop,
    BusLost,
}

enum Wait {
    Done(Response),
    Timeout,
    /// The session went away while the request was open.
    Lost,
}

enum BindOutcome {
    Done,
    Cancelled,
    Failed(&'static str),
}

struct Worker {
    cmds: Receiver<Cmd>,
    /// Commands set aside while a session was being created.
    backlog: VecDeque<Cmd>,
    shared: Arc<Shared>,
    sink: Sink,
    ptt_vk: fn() -> i32,
    core: Core,
    tokens: u64,
    last_prefs: Option<BindPrefs>,
    ptt_was_armed: bool,
    bind_timeout: Duration,
}

fn run<B: Bus>(mut connect: impl FnMut() -> Result<B, String>, mut worker: Worker) {
    loop {
        match connect() {
            Ok(mut bus) => match worker.serve(&mut bus) {
                End::Stop => {
                    worker.shutdown(&mut bus);
                    return;
                }
                End::BusLost => worker.bus_lost(),
            },
            Err(e) => {
                log::warn!("[portal] {e}");
                worker.shared.mark_probed();
            }
        }
        if worker.idle_wait(RECONNECT) {
            return;
        }
    }
}

impl Worker {
    fn armed(&self) -> Armed {
        self.shared.armed()
    }

    fn next_token(&mut self) -> u64 {
        self.tokens += 1;
        self.tokens
    }

    fn next_cmd(&mut self) -> Option<Cmd> {
        if let Some(cmd) = self.backlog.pop_front() {
            return Some(cmd);
        }
        match self.cmds.try_recv() {
            Ok(cmd) => Some(cmd),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Cmd::Stop),
        }
    }

    /// Answer commands while there is no bus. True when asked to stop.
    fn idle_wait(&mut self, duration: Duration) -> bool {
        let until = Instant::now() + duration;
        while Instant::now() < until {
            match self.cmds.recv_timeout(TICK) {
                Ok(Cmd::Stop) | Err(RecvTimeoutError::Disconnected) => return true,
                Ok(Cmd::Bind { reply, .. }) => {
                    let _ = reply.send(Err("unsupported".to_string()));
                }
                Ok(Cmd::Configure { reply }) => {
                    let _ = reply.send(Err("unsupported".to_string()));
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        false
    }

    fn bus_lost(&mut self) {
        let effects = self
            .core
            .on_event(Event::BusLost, self.armed(), (self.ptt_vk)());
        self.emit_effects(&effects);
    }

    /// Close the session on the way out. A pending Request was already closed
    /// where it was waited on.
    fn shutdown<B: Bus>(&mut self, bus: &mut B) {
        if let Some(session) = self.core.session().map(str::to_string) {
            bus.close_session(&session);
        }
        while let Ok(cmd) = self.cmds.try_recv() {
            match cmd {
                Cmd::Bind { reply, .. } => {
                    let _ = reply.send(Err("stopped".to_string()));
                }
                Cmd::Configure { reply } => {
                    let _ = reply.send(Err("stopped".to_string()));
                }
                Cmd::Stop => {}
            }
        }
    }

    fn serve<B: Bus>(&mut self, bus: &mut B) -> End {
        if let Err(end) = self.establish(bus) {
            return end;
        }
        loop {
            let handled = match self.next_cmd() {
                Some(Cmd::Stop) => return End::Stop,
                Some(Cmd::Bind { prefs, reply }) => self.do_bind(bus, prefs, reply),
                Some(Cmd::Configure { reply }) => {
                    self.do_configure(bus, reply);
                    Ok(())
                }
                None => Ok(()),
            };
            if let Err(end) = handled {
                return end;
            }
            if let Err(end) = self.pump(bus, &[]) {
                return end;
            }
        }
    }

    /// Read the bus once and act on it. Returns the Response whose path is in
    /// `expect`, if one arrived.
    fn pump<B: Bus>(&mut self, bus: &mut B, expect: &[String]) -> Result<Option<Response>, End> {
        let incoming = bus.poll(TICK).map_err(|e| {
            log::warn!("[portal] {e}");
            End::BusLost
        })?;
        let mut found = None;
        for item in incoming {
            match item {
                Incoming::Response(response) => {
                    if expect.contains(&response.path) {
                        found = Some(response);
                    }
                }
                Incoming::Event(event) => self.dispatch(bus, event)?,
            }
        }
        self.sync_armed();
        Ok(found)
    }

    fn sync_armed(&mut self) {
        let armed = self.armed().ptt;
        if self.ptt_was_armed && !armed {
            self.core
                .on_event(Event::PttDisarmed, self.armed(), (self.ptt_vk)());
        }
        self.ptt_was_armed = armed;
    }

    fn dispatch<B: Bus>(&mut self, bus: &mut B, event: Event) -> Result<(), End> {
        let effects = self.core.on_event(event, self.armed(), (self.ptt_vk)());
        self.apply(bus, effects)
    }

    fn emit_effects(&self, effects: &[Effect]) {
        for effect in effects {
            match effect {
                Effect::PttState(pressed) => (self.sink)(Emit::PttState(*pressed)),
                Effect::VoiceShortcut(which) => (self.sink)(Emit::VoiceShortcut(which)),
                Effect::PttError => (self.sink)(Emit::PttError),
                Effect::StatusChanged => {
                    let status = self.core.status();
                    *lock(&self.shared.status) = status.clone();
                    (self.sink)(Emit::Changed(status));
                }
                Effect::Reestablish | Effect::Rebind => {}
            }
        }
    }

    fn apply<B: Bus>(&mut self, bus: &mut B, effects: Vec<Effect>) -> Result<(), End> {
        self.emit_effects(&effects);
        for effect in effects {
            match effect {
                Effect::Reestablish => self.establish(bus)?,
                Effect::Rebind => self.rebind(bus)?,
                _ => {}
            }
        }
        Ok(())
    }

    /// Probe the interface and open a session when it is there.
    fn establish<B: Bus>(&mut self, bus: &mut B) -> Result<(), End> {
        self.core.establishing = true;
        let result = self.establish_inner(bus);
        self.core.establishing = false;
        result
    }

    fn establish_inner<B: Bus>(&mut self, bus: &mut B) -> Result<(), End> {
        // First on the connection, and again after a portal restart: the new
        // portal instance has not seen this connection's app id. An old
        // portal has no Registry; a systemd scope may still name the app.
        if let Err(e) = bus.register() {
            log::info!("[portal] cannot register the app id: {e}");
        }
        let version = match bus.version() {
            Ok(version) => Some(version),
            Err(e) => {
                log::info!("[portal] GlobalShortcuts is not available: {e}");
                None
            }
        };
        self.dispatch(bus, Event::Probed(version))?;
        if version.is_some() {
            self.create_session(bus)?;
            // A new session lists the shortcuts the desktop kept from an
            // earlier run, before any bind.
            self.refresh(bus)?;
        }
        self.shared.mark_probed();
        Ok(())
    }

    fn create_session<B: Bus>(&mut self, bus: &mut B) -> Result<(), End> {
        let token = self.next_token();
        let paths = match bus.create_session(token) {
            Ok(paths) => paths,
            Err(e) => {
                log::warn!("[portal] {e}");
                return self.dispatch(bus, Event::SessionRefused);
            }
        };
        match self.wait(bus, &paths, CALL_TIMEOUT, false)? {
            Wait::Done(response) if response.code == 0 => match response.session_handle {
                Some(session) => self.dispatch(bus, Event::SessionCreated(session))?,
                None => log::warn!("[portal] CreateSession answered without a session"),
            },
            Wait::Done(response) => {
                log::warn!("[portal] CreateSession refused (code {})", response.code);
                self.dispatch(bus, Event::SessionRefused)?;
            }
            Wait::Timeout => {
                close_last(bus, &paths);
                log::warn!("[portal] CreateSession timed out");
            }
            Wait::Lost => {}
        }
        Ok(())
    }

    /// Pump until the Request at `paths` answers, `timeout` passes, or the
    /// session goes away. Commands keep being served: a stop ends the wait, a
    /// second bind is refused.
    fn wait<B: Bus>(
        &mut self,
        bus: &mut B,
        paths: &[String],
        timeout: Duration,
        needs_session: bool,
    ) -> Result<Wait, End> {
        let deadline = Instant::now() + timeout;
        let session = self.core.session.clone();
        loop {
            match self.next_cmd() {
                Some(Cmd::Stop) => return Err(End::Stop),
                Some(cmd @ Cmd::Bind { .. }) if !needs_session => self.backlog.push_back(cmd),
                Some(Cmd::Bind { reply, .. }) => {
                    let _ = reply.send(Err("bind_in_progress".to_string()));
                }
                Some(Cmd::Configure { reply }) => self.do_configure(bus, reply),
                None => {}
            }
            if let Some(response) = self.pump(bus, paths)? {
                return Ok(Wait::Done(response));
            }
            if needs_session && self.core.session != session {
                return Ok(Wait::Lost);
            }
            if Instant::now() >= deadline {
                return Ok(Wait::Timeout);
            }
        }
    }

    fn bind_once<B: Bus>(&mut self, bus: &mut B, prefs: BindPrefs) -> Result<BindOutcome, End> {
        if self.core.session().is_none() {
            self.create_session(bus)?;
        }
        let Some(session) = self.core.session().map(str::to_string) else {
            return Ok(BindOutcome::Failed("bind_failed"));
        };
        let token = self.next_token();
        let paths = match bus.bind(&session, token, &bind_specs(prefs)) {
            Ok(paths) => paths,
            Err(e) => {
                log::warn!("[portal] {e}");
                return Ok(BindOutcome::Failed("bind_failed"));
            }
        };
        match self.wait(bus, &paths, self.bind_timeout, true) {
            Ok(Wait::Done(response)) => match response.code {
                0 => {
                    self.last_prefs = Some(prefs);
                    self.dispatch(bus, Event::BindDone(response.triggers))?;
                    Ok(BindOutcome::Done)
                }
                1 => Ok(BindOutcome::Cancelled),
                code => {
                    log::warn!("[portal] BindShortcuts refused (code {code})");
                    Ok(BindOutcome::Failed("bind_failed"))
                }
            },
            Ok(Wait::Timeout) => {
                close_last(bus, &paths);
                Ok(BindOutcome::Failed("bind_timeout"))
            }
            Ok(Wait::Lost) => Ok(BindOutcome::Failed("portal_lost")),
            Err(end) => {
                if matches!(end, End::Stop) {
                    close_last(bus, &paths);
                }
                Err(end)
            }
        }
    }

    fn do_bind<B: Bus>(
        &mut self,
        bus: &mut B,
        prefs: BindPrefs,
        reply: Reply<GlobalKeysStatus>,
    ) -> Result<(), End> {
        match self.bind_once(bus, prefs) {
            Ok(BindOutcome::Done) => {
                let _ = reply.send(Ok(self.shared.status()));
                Ok(())
            }
            Ok(BindOutcome::Cancelled) => {
                let _ = reply.send(Err("bind_cancelled".to_string()));
                Ok(())
            }
            Ok(BindOutcome::Failed(code)) => {
                let _ = reply.send(Err(code.to_string()));
                Ok(())
            }
            Err(end) => {
                let code = match end {
                    End::Stop => "stopped",
                    End::BusLost => "portal_lost",
                };
                let _ = reply.send(Err(code.to_string()));
                Err(end)
            }
        }
    }

    /// After a portal restart: bind again with the earlier preferred triggers,
    /// then ask for the triggers the portal now holds.
    fn rebind<B: Bus>(&mut self, bus: &mut B) -> Result<(), End> {
        let Some(prefs) = self.last_prefs else {
            return Ok(());
        };
        match self.bind_once(bus, prefs)? {
            BindOutcome::Done => self.refresh(bus),
            BindOutcome::Failed(code) => {
                log::warn!("[portal] rebind failed: {code}");
                Ok(())
            }
            BindOutcome::Cancelled => Ok(()),
        }
    }

    fn refresh<B: Bus>(&mut self, bus: &mut B) -> Result<(), End> {
        let Some(session) = self.core.session().map(str::to_string) else {
            return Ok(());
        };
        let token = self.next_token();
        let paths = match bus.list(&session, token) {
            Ok(paths) => paths,
            Err(e) => {
                log::warn!("[portal] {e}");
                return Ok(());
            }
        };
        match self.wait(bus, &paths, CALL_TIMEOUT, true)? {
            Wait::Done(Response {
                code: 0,
                triggers: Some(triggers),
                ..
            }) => self.dispatch(bus, Event::TriggersChanged { session, triggers }),
            Wait::Timeout => {
                close_last(bus, &paths);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn do_configure<B: Bus>(&mut self, bus: &mut B, reply: Reply<()>) {
        let result = match self.core.session().map(str::to_string) {
            None => Err("no_session".to_string()),
            Some(session) => bus.configure(&session).map_err(|e| {
                log::warn!("[portal] {e}");
                "configure_failed".to_string()
            }),
        };
        let _ = reply.send(result);
    }
}

fn close_last<B: Bus>(bus: &mut B, paths: &[String]) {
    if let Some(path) = paths.last() {
        bus.close_request(path);
    }
}

struct Handle {
    tx: Sender<Cmd>,
    join: JoinHandle<()>,
    shared: Arc<Shared>,
}

fn spawn<B: Bus + 'static>(
    connect: impl FnMut() -> Result<B, String> + Send + 'static,
    sink: Sink,
    ptt_vk: fn() -> i32,
    ptt_allowed: bool,
    bind_timeout: Duration,
) -> std::io::Result<Handle> {
    let (tx, cmds) = mpsc::channel();
    let shared = Arc::new(Shared::new());
    let thread_shared = Arc::clone(&shared);
    let join = std::thread::Builder::new()
        .name("portal-shortcuts".into())
        .spawn(move || {
            let worker = Worker {
                cmds,
                backlog: VecDeque::new(),
                shared: Arc::clone(&thread_shared),
                sink: Arc::clone(&sink),
                ptt_vk,
                core: Core::new(ptt_allowed),
                tokens: 0,
                last_prefs: None,
                ptt_was_armed: false,
                bind_timeout,
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run(connect, worker);
            }));
            if result.is_err() {
                log::error!("[portal] shortcuts thread panicked; global keys are inactive");
                let status = GlobalKeysStatus::without_triggers(Backend::None);
                *lock(&thread_shared.status) = status.clone();
                if thread_shared.armed().ptt {
                    sink(Emit::PttError);
                }
                sink(Emit::Changed(status));
            }
            thread_shared.mark_probed();
        })?;
    Ok(Handle { tx, join, shared })
}

/// Ask the thread to stop and wait for it, up to `JOIN_BUDGET`; a portal that
/// hangs a call longer than that is let go of rather than blocking exit.
fn stop_handle(handle: Handle) {
    let _ = handle.tx.send(Cmd::Stop);
    let deadline = Instant::now() + JOIN_BUDGET;
    while !handle.join.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if handle.join.is_finished() {
        let _ = handle.join.join();
    } else {
        log::warn!("[portal] shortcuts thread did not stop in time; detaching it");
    }
}

// ---------------------------------------------------------------------------
// The app-wide thread
// ---------------------------------------------------------------------------

/// The one portal thread. Lock order: this, then `Shared::status`; `stop`
/// takes the handle out under it and joins outside it.
static PORTAL: Mutex<Option<Handle>> = Mutex::new(None);
/// Set at exit so a late call cannot start a thread nobody joins.
static STOPPED: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct Link {
    tx: Sender<Cmd>,
    shared: Arc<Shared>,
}

fn sink_for<R: Runtime>(app: &AppHandle<R>) -> Sink {
    let app = app.clone();
    Arc::new(move |emit| {
        // A thread detached at exit must not emit into a torn-down runtime.
        if STOPPED.load(Ordering::SeqCst) {
            return;
        }
        let _ = match emit {
            Emit::PttState(pressed) => app.emit("ptt-state", pressed),
            Emit::VoiceShortcut(which) => app.emit("voice-shortcut", which),
            Emit::PttError => app.emit("ptt-error", PTT_LOST),
            Emit::Changed(status) => app.emit("global-keys-changed", status),
        };
    })
}

/// The thread's link, starting the thread on first use. `None` once exit began
/// or the thread cannot be spawned.
fn link<R: Runtime>(app: &AppHandle<R>) -> Option<Link> {
    let mut guard = lock(&PORTAL);
    if STOPPED.load(Ordering::SeqCst) {
        return None;
    }
    if guard.is_none() {
        let spawned = spawn(
            DbusBus::connect,
            sink_for(app),
            crate::ptt::ptt_vk,
            portal_ptt_allowed(
                std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref(),
                PORTAL_PTT_DENY,
            ),
            BIND_TIMEOUT,
        );
        match spawned {
            Ok(handle) => *guard = Some(handle),
            Err(e) => {
                log::warn!("[portal] cannot start the shortcuts thread: {e}");
                return None;
            }
        }
    }
    guard.as_ref().map(|handle| Link {
        tx: handle.tx.clone(),
        shared: Arc::clone(&handle.shared),
    })
}

/// The backend and triggers; waits for the first probe.
pub(crate) fn status<R: Runtime>(app: &AppHandle<R>) -> GlobalKeysStatus {
    match link(app) {
        Some(link) => {
            link.shared.wait_probed(WAIT_FOR_PROBE);
            link.shared.status()
        }
        None => GlobalKeysStatus::without_triggers(Backend::None),
    }
}

/// The webview started push to talk or the voice shortcuts: let the portal's
/// edges through as events.
pub(crate) fn arm<R: Runtime>(app: &AppHandle<R>, flag: Flag) {
    if let Some(link) = link(app) {
        link.shared.flag(flag).store(true, Ordering::SeqCst);
    }
}

/// The webview stopped them. Does nothing if the thread never started.
pub(crate) fn disarm(flag: Flag) {
    if let Some(handle) = lock(&PORTAL).as_ref() {
        handle.shared.flag(flag).store(false, Ordering::SeqCst);
    }
}

/// Ask the portal to bind the three shortcuts. The returned receiver answers
/// when the desktop's dialog does.
pub(crate) fn bind<R: Runtime>(
    app: &AppHandle<R>,
    prefs: BindPrefs,
) -> Result<oneshot::Receiver<Result<GlobalKeysStatus, String>>, String> {
    if !crate::shortcuts::wayland_now() {
        return Err("unsupported".to_string());
    }
    let link = link(app).ok_or_else(|| "unsupported".to_string())?;
    link.shared.wait_probed(WAIT_FOR_PROBE);
    if link.shared.status().backend != Backend::Portal {
        return Err("unsupported".to_string());
    }
    let (reply, answer) = oneshot::channel();
    link.tx
        .send(Cmd::Bind { prefs, reply })
        .map_err(|_| "portal_lost".to_string())?;
    Ok(answer)
}

/// Ask the portal to open its shortcut settings (interface version 2+).
pub(crate) fn configure<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<oneshot::Receiver<Result<(), String>>, String> {
    if !crate::shortcuts::wayland_now() {
        return Err("unsupported".to_string());
    }
    let link = link(app).ok_or_else(|| "unsupported".to_string())?;
    link.shared.wait_probed(WAIT_FOR_PROBE);
    if !link.shared.status().can_configure {
        return Err("unsupported".to_string());
    }
    let (reply, answer) = oneshot::channel();
    link.tx
        .send(Cmd::Configure { reply })
        .map_err(|_| "portal_lost".to_string())?;
    Ok(answer)
}

/// Stop the thread and wait for it. Called from `RunEvent::Exit`; a second call
/// does nothing.
pub fn stop_internal() {
    STOPPED.store(true, Ordering::SeqCst);
    let taken = lock(&PORTAL).take();
    if let Some(handle) = taken {
        stop_handle(handle);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shortcuts::portal_ptt_allowed;

    const ARMED: Armed = Armed {
        ptt: true,
        keys: true,
    };
    const IDLE: Armed = Armed {
        ptt: false,
        keys: false,
    };
    const SESSION: &str = "/org/freedesktop/portal/desktop/session/1_9/owncord_1_s";

    fn bound_triggers() -> Triggers {
        Triggers {
            ptt: Some("F8".into()),
            mute: Some("Ctrl+Shift+M".into()),
            deafen: Some("Ctrl+Shift+D".into()),
            unnamed: false,
        }
    }

    /// A core holding a session with every shortcut bound.
    fn bound_core() -> Core {
        let mut core = Core::new(true);
        core.on_event(Event::Probed(Some(2)), ARMED, 0x77);
        core.on_event(Event::SessionCreated(SESSION.into()), ARMED, 0x77);
        core.on_event(Event::BindDone(Some(bound_triggers())), ARMED, 0x77);
        core
    }

    fn activated(id: &str) -> Event {
        Event::Activated {
            session: SESSION.into(),
            id: id.into(),
        }
    }

    fn deactivated(id: &str) -> Event {
        Event::Deactivated {
            session: SESSION.into(),
            id: id.into(),
        }
    }

    #[test]
    fn request_path_is_predicted_from_unique_name_and_token() {
        assert_eq!(
            request_path(":1.42", "owncord_3"),
            "/org/freedesktop/portal/desktop/request/1_42/owncord_3"
        );
    }

    #[test]
    fn ptt_preferred_trigger_is_function_keys_only() {
        assert_eq!(ptt_preferred_trigger(0x77).as_deref(), Some("F8"));
        assert_eq!(ptt_preferred_trigger(0x70).as_deref(), Some("F1"));
        assert_eq!(ptt_preferred_trigger(0x87).as_deref(), Some("F24"));
        assert_eq!(ptt_preferred_trigger(0x20), None, "Space");
        assert_eq!(ptt_preferred_trigger(0x11), None, "Ctrl");
        assert_eq!(ptt_preferred_trigger(0x14), None, "Caps Lock");
        assert_eq!(ptt_preferred_trigger(0x05), None, "Mouse 4");
        assert_eq!(ptt_preferred_trigger(0x88), None, "past F24");
    }

    #[test]
    fn combo_preferred_trigger_is_ctrl_shift_keysym() {
        assert_eq!(
            combo_preferred_trigger(0x4D).as_deref(),
            Some("CTRL+SHIFT+m")
        );
        assert_eq!(
            combo_preferred_trigger(0x44).as_deref(),
            Some("CTRL+SHIFT+d")
        );
        assert_eq!(
            combo_preferred_trigger(0x35).as_deref(),
            Some("CTRL+SHIFT+5")
        );
        assert_eq!(combo_preferred_trigger(0x20), None, "Space");
        assert_eq!(combo_preferred_trigger(0x70), None, "F1");
        assert_eq!(combo_preferred_trigger(0), None);
    }

    #[test]
    fn bind_response_triggers_parse_and_empty_means_unbound() {
        let entries = vec![
            (ID_PTT.to_string(), Some("F8".to_string())),
            (ID_MUTE.to_string(), Some(String::new())),
            (ID_DEAFEN.to_string(), None),
            ("other".to_string(), Some("F1".to_string())),
        ];
        assert_eq!(
            triggers_from(&entries),
            Triggers {
                ptt: Some("F8".into()),
                mute: None,
                deafen: None,
                unnamed: false,
            }
        );
        assert_eq!(triggers_from(&[]), Triggers::default());

        let mut props = PropMap::new();
        props.insert("trigger_description".into(), sv("Ctrl+Shift+M"));
        let typed = entries_from_props(&[
            (ID_MUTE.to_string(), props),
            (ID_PTT.into(), PropMap::new()),
        ]);
        assert_eq!(
            typed,
            vec![
                (ID_MUTE.to_string(), Some("Ctrl+Shift+M".to_string())),
                (ID_PTT.to_string(), None)
            ]
        );
    }

    /// A Response's results survive the wire: build the message the portal
    /// would send, read it back the way the match callback does, and parse.
    #[test]
    fn response_results_parse_from_a_wire_message() {
        let mut desc = PropMap::new();
        desc.insert("trigger_description".into(), sv("F8"));
        let mut empty = PropMap::new();
        empty.insert("trigger_description".into(), sv(""));
        let mut results = PropMap::new();
        results.insert(
            "shortcuts".into(),
            Variant(Box::new(vec![
                (ID_PTT.to_string(), desc),
                (ID_MUTE.to_string(), empty),
            ])),
        );
        results.insert(
            "session_handle".into(),
            Variant(Box::new(Path::new(SESSION).unwrap())),
        );
        let msg = dbus::Message::new_signal("/r", REQUEST_IFACE, "Response")
            .unwrap()
            .append2(0u32, results);
        let (code, read): (u32, PropMap) = msg.read2().expect("Response arguments");
        let parsed = parse_response("/r".into(), code, &read);
        assert_eq!(parsed.code, 0);
        assert_eq!(parsed.session_handle.as_deref(), Some(SESSION), "o variant");
        assert_eq!(
            parsed.triggers,
            Some(Triggers {
                ptt: Some("F8".into()),
                mute: None,
                deafen: None,
                unnamed: false,
            })
        );
        let mut as_string = PropMap::new();
        as_string.insert("session_handle".into(), sv(SESSION));
        assert_eq!(
            session_handle(&as_string).as_deref(),
            Some(SESSION),
            "s variant"
        );
        assert!(session_handle(&PropMap::new()).is_none());
    }

    #[test]
    fn portal_is_available_only_when_the_version_property_reads() {
        let mut core = Core::new(true);
        assert_eq!(core.status().backend, Backend::None, "not probed yet");
        core.on_event(Event::Probed(None), IDLE, 0);
        assert_eq!(core.status().backend, Backend::None, "property unreadable");
        assert_eq!(core.status().portal_version, 0);
        core.on_event(Event::Probed(Some(1)), IDLE, 0);
        let v1 = core.status();
        assert_eq!(v1.backend, Backend::Portal);
        assert!(!v1.can_configure, "version 1 has no ConfigureShortcuts");
        core.on_event(Event::Probed(Some(2)), IDLE, 0);
        assert!(core.status().can_configure);
    }

    #[test]
    fn ptt_edges_follow_activated_and_deactivated() {
        let mut core = bound_core();
        assert_eq!(
            core.on_event(activated(ID_PTT), ARMED, 0x77),
            vec![Effect::PttState(true)]
        );
        assert!(
            core.on_event(activated(ID_PTT), ARMED, 0x77).is_empty(),
            "a duplicate Activated collapses"
        );
        assert_eq!(
            core.on_event(deactivated(ID_PTT), ARMED, 0x77),
            vec![Effect::PttState(false)]
        );
        assert!(
            core.on_event(deactivated(ID_PTT), ARMED, 0x77).is_empty(),
            "a duplicate Deactivated collapses"
        );

        let mut core = bound_core();
        assert!(
            core.on_event(activated(ID_PTT), IDLE, 0x77).is_empty(),
            "disarmed"
        );
        assert!(
            core.on_event(activated(ID_PTT), ARMED, 0).is_empty(),
            "no PTT key set"
        );
    }

    #[test]
    fn a_disarm_releases_a_held_ptt_silently() {
        let mut core = bound_core();
        core.on_event(activated(ID_PTT), ARMED, 0x77);
        assert!(core.on_event(Event::PttDisarmed, IDLE, 0x77).is_empty());
        assert!(core.on_event(deactivated(ID_PTT), IDLE, 0x77).is_empty());
        assert_eq!(
            core.on_event(activated(ID_PTT), ARMED, 0x77),
            vec![Effect::PttState(true)],
            "a press after a re-arm is a fresh edge"
        );
    }

    #[test]
    fn mute_fires_on_every_activated_and_ignores_deactivated() {
        let mut core = bound_core();
        for _ in 0..3 {
            assert_eq!(
                core.on_event(activated(ID_MUTE), ARMED, 0x77),
                vec![Effect::VoiceShortcut("mute")]
            );
        }
        assert!(core.on_event(deactivated(ID_MUTE), ARMED, 0x77).is_empty());
        assert_eq!(
            core.on_event(activated(ID_DEAFEN), ARMED, 0x77),
            vec![Effect::VoiceShortcut("deafen")]
        );
        assert!(
            core.on_event(activated(ID_MUTE), IDLE, 0x77).is_empty(),
            "not armed"
        );
    }

    #[test]
    fn signals_from_another_session_are_ignored() {
        let mut core = bound_core();
        let other = |id: &str| Event::Activated {
            session: "/other/session".into(),
            id: id.into(),
        };
        assert!(core.on_event(other(ID_PTT), ARMED, 0x77).is_empty());
        assert!(core.on_event(other(ID_MUTE), ARMED, 0x77).is_empty());
        assert!(core
            .on_event(
                Event::Deactivated {
                    session: "/other/session".into(),
                    id: ID_PTT.into()
                },
                ARMED,
                0x77
            )
            .is_empty());
        assert!(core
            .on_event(
                Event::TriggersChanged {
                    session: "/other/session".into(),
                    triggers: Triggers::default()
                },
                ARMED,
                0x77
            )
            .is_empty());
        assert!(core
            .on_event(
                Event::SessionClosed {
                    session: "/other/session".into()
                },
                ARMED,
                0x77
            )
            .is_empty());
        assert_eq!(core.status().triggers, bound_triggers());
    }

    #[test]
    fn portal_restart_releases_a_held_ptt_and_reports_it_lost() {
        let mut core = bound_core();
        core.on_event(activated(ID_PTT), ARMED, 0x77);
        let effects = core.on_event(
            Event::NameOwnerChanged {
                old: ":1.5".into(),
                new: String::new(),
            },
            ARMED,
            0x77,
        );
        assert_eq!(
            effects,
            vec![
                Effect::PttState(false),
                Effect::PttError,
                Effect::StatusChanged
            ]
        );
        assert_eq!(core.status().triggers, Triggers::default());
        assert!(core.session().is_none());

        // The new owner re-establishes, and re-binds because this run bound.
        let effects = core.on_event(
            Event::NameOwnerChanged {
                old: String::new(),
                new: ":1.6".into(),
            },
            ARMED,
            0x77,
        );
        assert_eq!(effects, vec![Effect::Reestablish, Effect::Rebind]);
    }

    #[test]
    fn a_restart_before_any_bind_re_establishes_without_rebind() {
        let mut core = Core::new(true);
        core.on_event(Event::Probed(Some(1)), IDLE, 0);
        core.on_event(Event::SessionCreated(SESSION.into()), IDLE, 0);
        let effects = core.on_event(
            Event::NameOwnerChanged {
                old: ":1.5".into(),
                new: ":1.6".into(),
            },
            IDLE,
            0,
        );
        assert_eq!(effects, vec![Effect::StatusChanged, Effect::Reestablish]);
    }

    #[test]
    fn our_own_activation_of_the_portal_is_not_a_restart() {
        let mut core = Core::new(true);
        core.on_event(Event::SessionCreated(SESSION.into()), IDLE, 0);
        let effects = core.on_event(
            Event::NameOwnerChanged {
                old: String::new(),
                new: ":1.6".into(),
            },
            IDLE,
            0,
        );
        assert!(effects.is_empty(), "the session we just made stands");
    }

    #[test]
    fn session_closed_opens_a_new_session_without_rebind() {
        let mut core = bound_core();
        core.on_event(activated(ID_PTT), ARMED, 0x77);
        let effects = core.on_event(
            Event::SessionClosed {
                session: SESSION.into(),
            },
            ARMED,
            0x77,
        );
        assert_eq!(
            effects,
            vec![
                Effect::PttState(false),
                Effect::PttError,
                Effect::StatusChanged,
                Effect::Reestablish
            ]
        );
        assert_eq!(core.status().triggers, Triggers::default());
        assert!(!core.bound_this_run, "a later restart does not rebind");
    }

    #[test]
    fn a_portal_closing_every_session_is_replaced_only_a_few_times() {
        let mut core = Core::new(true);
        core.on_event(Event::Probed(Some(2)), IDLE, 0);
        let mut reopened = 0;
        for n in 0..10 {
            let session = format!("{SESSION}{n}");
            core.on_event(Event::SessionCreated(session.clone()), IDLE, 0);
            let effects = core.on_event(Event::SessionClosed { session }, IDLE, 0);
            if effects.contains(&Effect::Reestablish) {
                reopened += 1;
            }
        }
        assert_eq!(reopened, usize::from(MAX_REOPENS));

        core.on_event(Event::SessionCreated(SESSION.into()), IDLE, 0);
        core.on_event(Event::BindDone(Some(bound_triggers())), IDLE, 0);
        let effects = core.on_event(
            Event::SessionClosed {
                session: SESSION.into(),
            },
            IDLE,
            0,
        );
        assert!(effects.contains(&Effect::Reestablish), "a bind resets it");
    }

    #[test]
    fn a_ptt_trigger_cleared_in_system_settings_reports_ptt_lost() {
        let mut core = bound_core();
        core.on_event(activated(ID_PTT), ARMED, 0x77);
        let effects = core.on_event(
            Event::TriggersChanged {
                session: SESSION.into(),
                triggers: Triggers {
                    ptt: None,
                    ..bound_triggers()
                },
            },
            ARMED,
            0x77,
        );
        assert_eq!(
            effects,
            vec![
                Effect::PttState(false),
                Effect::PttError,
                Effect::StatusChanged
            ]
        );
        let effects = core.on_event(
            Event::TriggersChanged {
                session: SESSION.into(),
                triggers: Triggers {
                    mute: None,
                    ptt: None,
                    ..bound_triggers()
                },
            },
            ARMED,
            0x77,
        );
        assert_eq!(effects, vec![Effect::StatusChanged], "PTT was already gone");
    }

    #[test]
    fn three_listed_shortcuts_without_keys_are_unnamed() {
        let listed = |ptt: Option<&str>, mute: Option<&str>, deafen: Option<&str>| {
            vec![
                (ID_PTT.to_string(), ptt.map(str::to_string)),
                (ID_MUTE.to_string(), mute.map(str::to_string)),
                (ID_DEAFEN.to_string(), deafen.map(str::to_string)),
            ]
        };
        let all_empty = triggers_from(&listed(Some(""), None, Some("")));
        assert!(all_empty.unnamed);
        assert_eq!(all_empty.ptt, None);

        assert!(!triggers_from(&listed(Some("F8"), Some(""), Some(""))).unnamed);
        assert!(!triggers_from(&listed(Some(""), Some(""), Some("Ctrl+Shift+D"))).unnamed);
        let partial = vec![
            (ID_PTT.to_string(), Some(String::new())),
            (ID_MUTE.to_string(), Some(String::new())),
        ];
        assert!(!triggers_from(&partial).unnamed, "deafen is not listed");
        assert!(!triggers_from(&[]).unnamed, "nothing listed is not unnamed");
    }

    #[test]
    fn an_unnamed_portal_supports_ptt_but_not_the_in_app_stand_down() {
        let unnamed = Triggers {
            unnamed: true,
            ..Triggers::default()
        };
        let status = GlobalKeysStatus::new(Backend::Portal, 1, unnamed.clone());
        assert!(status.triggers_unnamed);
        assert!(status.ptt_supported(Some("Hyprland")));
        assert!(
            !status.keys_supported(),
            "an unbound key keeps working in-app"
        );
        let polling = GlobalKeysStatus::new(Backend::Polling, 0, unnamed);
        assert!(!polling.triggers_unnamed, "only the portal reports it");
    }

    #[test]
    fn activated_toggle_mute_reaches_the_webview_on_an_unnamed_portal() {
        let mut core = Core::new(true);
        core.on_event(Event::Probed(Some(1)), ARMED, 0x77);
        core.on_event(Event::SessionCreated(SESSION.into()), ARMED, 0x77);
        core.on_event(
            Event::BindDone(Some(Triggers {
                unnamed: true,
                ..Triggers::default()
            })),
            ARMED,
            0x77,
        );
        assert!(core.status().triggers_unnamed);
        assert_eq!(
            core.on_event(activated(ID_MUTE), ARMED, 0x77),
            vec![Effect::VoiceShortcut("mute")]
        );
        assert_eq!(
            core.on_event(activated(ID_PTT), ARMED, 0x77),
            vec![Effect::PttState(true)]
        );
    }

    #[test]
    fn a_refused_session_shows_in_the_status_until_one_opens() {
        let mut core = Core::new(true);
        core.on_event(Event::Probed(Some(1)), IDLE, 0);
        assert!(!core.status().session_refused);
        assert_eq!(
            core.on_event(Event::SessionRefused, IDLE, 0),
            vec![Effect::StatusChanged]
        );
        assert!(core.status().session_refused);
        assert!(
            core.on_event(Event::SessionRefused, IDLE, 0).is_empty(),
            "already known"
        );
        assert_eq!(
            core.on_event(Event::SessionCreated(SESSION.into()), IDLE, 0),
            vec![Effect::StatusChanged]
        );
        assert!(!core.status().session_refused);
        assert!(core
            .on_event(Event::SessionCreated(SESSION.into()), IDLE, 0)
            .is_empty());

        core.on_event(Event::SessionRefused, IDLE, 0);
        core.on_event(Event::BusLost, IDLE, 0);
        assert!(!core.status().session_refused, "a lost bus clears it");
        core.on_event(Event::Probed(Some(1)), IDLE, 0);
        core.on_event(Event::SessionRefused, IDLE, 0);
        core.on_event(Event::Probed(None), IDLE, 0);
        assert!(!core.status().session_refused, "no portal clears it");
    }

    #[test]
    fn register_retries_only_after_writing_the_entry() {
        let attempts = std::cell::Cell::new(0u8);
        let failing = || {
            attempts.set(attempts.get() + 1);
            Err("Register: Could not register app ID".to_string())
        };
        let none = Duration::ZERO;
        assert!(register_with(failing, Ensured::Present, 2, none).is_err());
        assert_eq!(
            attempts.get(),
            1,
            "no retry when the entry was already there"
        );

        attempts.set(0);
        assert!(register_with(failing, Ensured::Written, 2, none).is_err());
        assert_eq!(attempts.get(), 3, "one try and two retries");

        attempts.set(0);
        let second_works = || {
            attempts.set(attempts.get() + 1);
            if attempts.get() < 2 {
                Err("not yet".to_string())
            } else {
                Ok(())
            }
        };
        assert!(register_with(second_works, Ensured::Written, 2, none).is_ok());
        assert_eq!(attempts.get(), 2);

        let associated =
            || Err("Register: Connection already associated with an application ID".to_string());
        assert!(register_with(associated, Ensured::Failed, 2, none).is_ok());
    }

    #[test]
    fn ptt_supported_needs_a_bound_trigger_and_an_allowed_desktop() {
        let mut status = GlobalKeysStatus::new(Backend::Portal, 1, Triggers::default());
        assert!(!status.ptt_supported(Some("GNOME")), "unbound");
        status.triggers.ptt = Some("F8".into());
        assert!(status.ptt_supported(Some("GNOME")));
        assert!(status.ptt_supported(None));
        assert!(
            portal_ptt_allowed(Some("KDE"), &[]),
            "ships with an empty deny list"
        );
        assert!(!portal_ptt_allowed(Some("ubuntu:GNOME"), &["gnome"]));
        assert!(portal_ptt_allowed(Some("KDE"), &["GNOME"]));
        let none = GlobalKeysStatus::without_triggers(Backend::None);
        assert!(!none.ptt_supported(None));
    }

    #[test]
    fn voice_shortcuts_supported_needs_mute_and_deafen_bound() {
        let mut status = GlobalKeysStatus::new(Backend::Portal, 1, Triggers::default());
        assert!(!status.keys_supported());
        status.triggers.mute = Some("Ctrl+Shift+M".into());
        assert!(
            !status.keys_supported(),
            "mute alone would kill the in-app deafen key"
        );
        status.triggers.deafen = Some("Ctrl+Shift+D".into());
        assert!(status.keys_supported());
        assert!(GlobalKeysStatus::without_triggers(Backend::Polling).keys_supported());
        assert!(!GlobalKeysStatus::without_triggers(Backend::None).keys_supported());
    }

    // --- Thread tests over a fake bus ---------------------------------------

    #[derive(Clone, Default)]
    struct Script {
        calls: Arc<Mutex<Vec<String>>>,
        queue: Arc<Mutex<VecDeque<Incoming>>>,
        answer_bind: Arc<AtomicBool>,
        /// The bind answer's Response code.
        bind_code: Arc<std::sync::atomic::AtomicU32>,
        /// The portal announces itself while the session is being made, as
        /// D-Bus activation does.
        activate_on_create: Arc<AtomicBool>,
        /// ListShortcuts answers with the triggers the desktop remembered.
        answer_list: Arc<AtomicBool>,
        /// The error `register` fails with, when set.
        register_error: Arc<Mutex<Option<String>>>,
        /// CreateSession fails outright, as "An app id is required" does.
        create_error: Arc<AtomicBool>,
        /// ListShortcuts answers with all three shortcuts and no keys, as
        /// xdg-desktop-portal-hyprland does.
        list_unnamed: Arc<AtomicBool>,
    }

    impl Script {
        fn called(&self, what: &str) -> bool {
            lock(&self.calls).iter().any(|c| c.starts_with(what))
        }

        fn push(&self, item: Incoming) {
            lock(&self.queue).push_back(item);
        }
    }

    struct FakeBus(Script);

    fn answered(path: &str, session: Option<&str>, triggers: Option<Triggers>) -> Incoming {
        Incoming::Response(Response {
            path: path.into(),
            code: 0,
            session_handle: session.map(str::to_string),
            triggers,
        })
    }

    impl Bus for FakeBus {
        fn register(&mut self) -> Result<(), String> {
            lock(&self.0.calls).push("register".into());
            match lock(&self.0.register_error).clone() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }
        fn version(&mut self) -> Result<u32, String> {
            lock(&self.0.calls).push("version".into());
            Ok(2)
        }
        fn create_session(&mut self, token: u64) -> Result<Vec<String>, String> {
            let path = format!("/req/{token}");
            lock(&self.0.calls).push("create".into());
            if self.0.create_error.load(Ordering::SeqCst) {
                return Err("CreateSession: An app id is required".into());
            }
            if self.0.activate_on_create.load(Ordering::SeqCst) {
                self.0.push(Incoming::Event(Event::NameOwnerChanged {
                    old: String::new(),
                    new: ":1.1".into(),
                }));
            }
            let session = if token == 1 {
                SESSION.to_string()
            } else {
                format!("{SESSION}{token}")
            };
            self.0.push(answered(&path, Some(&session), None));
            Ok(vec![path])
        }
        fn bind(&mut self, _: &str, token: u64, specs: &[BindSpec]) -> Result<Vec<String>, String> {
            let path = format!("/req/{token}");
            lock(&self.0.calls).push(format!("bind {}", specs.len()));
            if self.0.answer_bind.load(Ordering::SeqCst) {
                let mut response = answered(&path, None, Some(bound_triggers()));
                if let Incoming::Response(r) = &mut response {
                    r.code = self.0.bind_code.load(Ordering::SeqCst);
                }
                self.0.push(response);
            }
            Ok(vec![path])
        }
        fn list(&mut self, session: &str, token: u64) -> Result<Vec<String>, String> {
            lock(&self.0.calls).push(format!("list {session}"));
            if !self.0.answer_list.load(Ordering::SeqCst) {
                return Err("no list".into());
            }
            let path = format!("/req/{token}");
            let triggers = if self.0.list_unnamed.load(Ordering::SeqCst) {
                triggers_from(&[
                    (ID_PTT.to_string(), Some(String::new())),
                    (ID_MUTE.to_string(), Some(String::new())),
                    (ID_DEAFEN.to_string(), Some(String::new())),
                ])
            } else {
                bound_triggers()
            };
            self.0.push(answered(&path, None, Some(triggers)));
            Ok(vec![path])
        }
        fn configure(&mut self, _: &str) -> Result<(), String> {
            lock(&self.0.calls).push("configure".into());
            Ok(())
        }
        fn close_request(&mut self, path: &str) {
            lock(&self.0.calls).push(format!("close_request {path}"));
        }
        fn close_session(&mut self, session: &str) {
            lock(&self.0.calls).push(format!("close_session {session}"));
        }
        fn poll(&mut self, wait: Duration) -> Result<Vec<Incoming>, String> {
            let items: Vec<Incoming> = lock(&self.0.queue).drain(..).collect();
            if items.is_empty() {
                std::thread::sleep(wait.min(Duration::from_millis(5)));
            }
            Ok(items)
        }
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn fake_handle(script: &Script, emitted: &Arc<Mutex<Vec<String>>>) -> Handle {
        let bus = script.clone();
        let log = Arc::clone(emitted);
        let sink: Sink = Arc::new(move |emit| {
            let line = match emit {
                Emit::PttState(pressed) => format!("ptt-state {pressed}"),
                Emit::VoiceShortcut(which) => format!("voice-shortcut {which}"),
                Emit::PttError => "ptt-error".to_string(),
                Emit::Changed(status) => format!("changed {:?}", status.triggers.ptt),
            };
            lock(&log).push(line);
        });
        spawn(
            move || Ok(FakeBus(bus.clone())),
            sink,
            || 0x77,
            true,
            Duration::from_secs(300),
        )
        .expect("spawn the portal thread")
    }

    fn bind_request(handle: &Handle) -> oneshot::Receiver<Result<GlobalKeysStatus, String>> {
        let (reply, answer) = oneshot::channel();
        handle
            .tx
            .send(Cmd::Bind {
                prefs: BindPrefs {
                    ptt_vk: 0x77,
                    mute_vk: 0x4D,
                    deafen_vk: 0x44,
                },
                reply,
            })
            .expect("send the bind");
        answer
    }

    #[test]
    fn the_app_id_is_registered_before_the_probe_and_again_after_a_restart() {
        let script = Script::default();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        {
            let calls = lock(&script.calls);
            assert_eq!(calls[0], "register");
            assert_eq!(calls[1], "version");
        }
        script.push(Incoming::Event(Event::NameOwnerChanged {
            old: ":1.1".into(),
            new: ":1.2".into(),
        }));
        // Wait for the call after the second registration too: the portal
        // thread records `register` before it sends the next call.
        wait_until("a second registration and the call after it", || {
            let calls = lock(&script.calls);
            calls.iter().filter(|c| c.starts_with("register")).count() == 2
                && calls
                    .iter()
                    .rposition(|c| c == "register")
                    .is_some_and(|i| i + 1 < calls.len())
        });
        let calls = lock(&script.calls).clone();
        let second = calls.iter().rposition(|c| c == "register").unwrap();
        assert_eq!(calls[second + 1], "version", "register stays first");
        drop(calls);
        stop_handle(handle);
    }

    #[test]
    fn a_register_error_does_not_stop_the_session() {
        let script = Script::default();
        *lock(&script.register_error) = Some("Register: no such interface".into());
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        assert_eq!(handle.shared.status().backend, Backend::Portal);
        assert!(script.called("create"));
        assert!(!handle.shared.status().session_refused);
        stop_handle(handle);
    }

    #[test]
    fn a_create_session_error_is_reported_as_refused() {
        let script = Script::default();
        script.create_error.store(true, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        assert!(handle.shared.status().session_refused);
        stop_handle(handle);
    }

    #[test]
    fn an_all_empty_listing_marks_the_triggers_unnamed() {
        let script = Script::default();
        script.answer_list.store(true, Ordering::SeqCst);
        script.list_unnamed.store(true, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        let status = handle.shared.status();
        assert!(status.triggers_unnamed);
        assert!(status.ptt_supported(Some("Hyprland")));
        assert!(!status.keys_supported());
        stop_handle(handle);
    }

    #[test]
    fn a_new_session_loads_the_triggers_the_desktop_remembered() {
        let script = Script::default();
        script.answer_list.store(true, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        assert_eq!(handle.shared.status().triggers, bound_triggers());
        assert!(!script.called("bind"), "no bind dialog at startup");
        stop_handle(handle);
    }

    #[test]
    fn a_session_the_portal_closes_is_replaced_and_listed_again() {
        let script = Script::default();
        script.answer_list.store(true, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        script.push(Incoming::Event(Event::SessionClosed {
            session: SESSION.into(),
        }));
        let replacement = format!("list {SESSION}");
        wait_until("the replacement session is listed", || {
            lock(&script.calls)
                .iter()
                .any(|c| c.starts_with(&replacement) && c != &replacement)
        });
        wait_until("the remembered triggers are back", || {
            handle.shared.status().triggers == bound_triggers()
        });
        assert!(!script.called("bind"), "closing is not a reason to rebind");
        stop_handle(handle);
    }

    #[test]
    fn a_bind_round_trip_reports_triggers_and_drives_events() {
        let script = Script::default();
        script.answer_bind.store(true, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        handle.shared.ptt_armed.store(true, Ordering::SeqCst);
        handle.shared.keys_armed.store(true, Ordering::SeqCst);

        let mut answer = bind_request(&handle);
        wait_until("the bind answer", || {
            answer.try_recv().is_ok_and(|r| {
                let status = r.expect("bound");
                assert_eq!(status.triggers, bound_triggers());
                assert_eq!(status.backend, Backend::Portal);
                true
            })
        });
        assert!(script.called("bind 3"), "all three shortcuts are requested");

        script.push(Incoming::Event(activated(ID_PTT)));
        script.push(Incoming::Event(deactivated(ID_PTT)));
        script.push(Incoming::Event(activated(ID_MUTE)));
        wait_until("the events", || {
            lock(&emitted).iter().any(|l| l == "voice-shortcut mute")
        });
        let lines = lock(&emitted).clone();
        let at = |needle: &str| lines.iter().position(|l| l == needle).unwrap();
        assert!(at("ptt-state true") < at("ptt-state false"));
        stop_handle(handle);
    }

    #[test]
    fn a_second_bind_while_one_is_pending_is_refused() {
        let script = Script::default();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        let mut first = bind_request(&handle);
        wait_until("the first bind to be sent", || script.called("bind"));
        let mut second = bind_request(&handle);
        let mut refused = None;
        wait_until("the second bind's answer", || {
            refused = second.try_recv().ok();
            refused.is_some()
        });
        assert_eq!(refused.unwrap(), Err("bind_in_progress".to_string()));
        assert!(first.try_recv().is_err(), "the first is still waiting");
        stop_handle(handle);
    }

    #[test]
    fn stop_with_a_pending_bind_closes_the_request_and_joins() {
        let script = Script::default();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        let mut pending = bind_request(&handle);
        wait_until("the bind to be sent", || script.called("bind"));

        let started = Instant::now();
        let tx = handle.tx.clone();
        stop_handle(handle);
        assert!(started.elapsed() < Duration::from_secs(1), "stop is prompt");
        assert_eq!(pending.try_recv().unwrap(), Err("stopped".to_string()));
        assert!(
            script.called("close_request"),
            "the dialog's Request is closed"
        );
        assert!(script.called("close_session"), "the session is closed");
        // A second stop finds nothing to do.
        assert!(tx.send(Cmd::Stop).is_err(), "the thread is gone");
        stop_internal();
        stop_internal();
        STOPPED.store(false, Ordering::SeqCst);
    }

    #[test]
    fn our_own_activation_while_establishing_opens_one_session() {
        let mut core = Core::new(true);
        core.establishing = true;
        let effects = core.on_event(
            Event::NameOwnerChanged {
                old: String::new(),
                new: ":1.1".into(),
            },
            IDLE,
            0,
        );
        assert!(effects.is_empty(), "no nested establish");

        let script = Script::default();
        script.activate_on_create.store(true, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(300));
        let creates = lock(&script.calls)
            .iter()
            .filter(|c| *c == "create")
            .count();
        assert_eq!(creates, 1, "one CreateSession on a cold portal");
        stop_handle(handle);
    }

    #[test]
    fn a_restart_during_a_bind_dialog_reports_the_portal_lost() {
        let script = Script::default();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        let mut pending = bind_request(&handle);
        wait_until("the bind to be sent", || script.called("bind"));
        script.push(Incoming::Event(Event::NameOwnerChanged {
            old: ":1.5".into(),
            new: ":1.6".into(),
        }));
        let mut answer = None;
        wait_until("the bind's answer", || {
            answer = pending.try_recv().ok();
            answer.is_some()
        });
        assert_eq!(answer.unwrap(), Err("portal_lost".to_string()));
        stop_handle(handle);
    }

    #[test]
    fn a_cancelled_bind_answers_bind_cancelled() {
        let script = Script::default();
        script.answer_bind.store(true, Ordering::SeqCst);
        script.bind_code.store(1, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        let mut pending = bind_request(&handle);
        let mut answer = None;
        wait_until("the answer", || {
            answer = pending.try_recv().ok();
            answer.is_some()
        });
        assert_eq!(answer.unwrap(), Err("bind_cancelled".to_string()));
        assert_eq!(handle.shared.status().triggers, Triggers::default());
        stop_handle(handle);
    }

    #[test]
    fn a_denied_desktop_gets_no_ptt_edges_but_keeps_mute() {
        let denied = !portal_ptt_allowed(Some("ubuntu:GNOME"), &["GNOME"]);
        assert!(denied);
        let mut core = Core::new(!denied);
        core.on_event(Event::SessionCreated(SESSION.into()), ARMED, 0x77);
        assert!(core.on_event(activated(ID_PTT), ARMED, 0x77).is_empty());
        assert_eq!(
            core.on_event(activated(ID_MUTE), ARMED, 0x77),
            vec![Effect::VoiceShortcut("mute")]
        );
    }

    #[test]
    fn a_lost_portal_while_ptt_is_held_opens_the_gate() {
        let script = Script::default();
        script.answer_bind.store(true, Ordering::SeqCst);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let handle = fake_handle(&script, &emitted);
        handle.shared.wait_probed(Duration::from_secs(5));
        handle.shared.ptt_armed.store(true, Ordering::SeqCst);
        let mut answer = bind_request(&handle);
        wait_until("the bind", || answer.try_recv().is_ok());
        script.push(Incoming::Event(activated(ID_PTT)));
        script.push(Incoming::Event(Event::NameOwnerChanged {
            old: ":1.5".into(),
            new: String::new(),
        }));
        wait_until("the loss", || {
            handle.shared.status().triggers == Triggers::default()
        });
        let lines = lock(&emitted).clone();
        let tail: Vec<&str> = lines.iter().rev().take(3).map(String::as_str).collect();
        assert_eq!(tail, ["changed None", "ptt-error", "ptt-state false"]);
        stop_handle(handle);
    }

    // --- The real bus against a fake portal -------------------------------

    /// A stand-in portal that owns `org.freedesktop.portal.Desktop` and
    /// answers the GlobalShortcuts calls, so the whole path (match rules,
    /// request-path prediction, variants on the wire) runs on a real bus.
    ///
    /// Needs a session bus: `dbus-run-session -- cargo test -- --ignored portal_fake`.
    #[test]
    #[ignore = "needs a session bus (dbus-run-session)"]
    fn portal_fake_round_trip() {
        use dbus::channel::{MatchingReceiver as _, Sender as _};
        use dbus::Message;

        let fake = Connection::new_session().expect("session bus");
        fake.request_name(DESKTOP, false, true, true)
            .expect("own the portal name");
        let client = Arc::new(Mutex::new(None::<String>));
        let seen = Arc::clone(&client);
        let bound_with = Arc::new(Mutex::new(Vec::<(String, String, Option<String>)>::new()));
        let recorded = Arc::clone(&bound_with);
        let respond = |msg: &Message, conn: &Connection, token: String, results: PropMap| {
            let sender = msg.sender().expect("sender").to_string();
            let path = request_path(&sender, &token);
            let _ = conn.send(
                msg.method_return()
                    .append1(Path::new(path.clone()).unwrap()),
            );
            let mut response = Message::new_signal(path, REQUEST_IFACE, "Response")
                .unwrap()
                .append2(0u32, results);
            response.set_destination(Some(sender.into()));
            let _ = conn.send(response);
        };
        fake.start_receive(
            MatchRule::new_method_call(),
            Box::new(move |msg: Message, conn: &Connection| {
                *lock(&seen) = msg.sender().map(|s| s.to_string());
                match msg.member().as_deref() {
                    Some("Get") => {
                        let _ = conn.send(msg.method_return().append1(Variant(2u32)));
                    }
                    Some("CreateSession") => {
                        let options: PropMap = msg.read1().expect("CreateSession options");
                        let token = prop_cast::<String>(&options, "handle_token")
                            .cloned()
                            .expect("handle_token");
                        let mut results = PropMap::new();
                        results.insert("session_handle".into(), sv(SESSION));
                        respond(&msg, conn, token, results);
                    }
                    Some("BindShortcuts") => {
                        let (session, shortcuts, parent, options): (
                            Path,
                            Vec<(String, PropMap)>,
                            String,
                            PropMap,
                        ) = msg.read4().expect("BindShortcuts arguments");
                        assert_eq!(&*session, SESSION);
                        assert_eq!(parent, "");
                        let token = prop_cast::<String>(&options, "handle_token")
                            .cloned()
                            .expect("handle_token");
                        let mut granted = Vec::new();
                        for (id, props) in shortcuts {
                            let description = prop_cast::<String>(&props, "description")
                                .cloned()
                                .unwrap_or_default();
                            let preferred =
                                prop_cast::<String>(&props, "preferred_trigger").cloned();
                            lock(&recorded).push((id.clone(), description, preferred));
                            let mut out = PropMap::new();
                            out.insert("trigger_description".into(), sv(&format!("granted {id}")));
                            granted.push((id, out));
                        }
                        let mut results = PropMap::new();
                        results.insert("shortcuts".into(), Variant(Box::new(granted)));
                        respond(&msg, conn, token, results);
                    }
                    _ => {}
                }
                true
            }),
        );
        let stop = Arc::new(AtomicBool::new(false));
        let serving = Arc::clone(&stop);
        let (signal_tx, signal_rx) = mpsc::channel::<Message>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            while !serving.load(Ordering::SeqCst) {
                let _ = fake.process(Duration::from_millis(20));
                while let Ok(signal) = signal_rx.try_recv() {
                    let _ = fake.send(signal);
                }
                if release_rx.try_recv().is_ok() {
                    let _ = fake.release_name(DESKTOP);
                }
            }
        });

        let emitted = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&emitted);
        let sink: Sink = Arc::new(move |emit| {
            let line = match emit {
                Emit::PttState(pressed) => format!("ptt-state {pressed}"),
                Emit::VoiceShortcut(which) => format!("voice-shortcut {which}"),
                Emit::PttError => "ptt-error".to_string(),
                Emit::Changed(_) => "changed".to_string(),
            };
            lock(&log).push(line);
        });
        let handle = spawn(
            DbusBus::connect,
            sink,
            || 0x77,
            true,
            Duration::from_secs(300),
        )
        .expect("spawn the portal thread");
        handle.shared.wait_probed(Duration::from_secs(5));
        assert_eq!(handle.shared.status().backend, Backend::Portal);
        assert_eq!(handle.shared.status().portal_version, 2);
        handle.shared.ptt_armed.store(true, Ordering::SeqCst);
        handle.shared.keys_armed.store(true, Ordering::SeqCst);

        let mut answer = bind_request(&handle);
        let mut status = None;
        wait_until("the bind answer", || {
            status = answer.try_recv().ok();
            status.is_some()
        });
        let status = status.unwrap().expect("bound");
        assert_eq!(status.triggers.ptt.as_deref(), Some("granted push-to-talk"));
        assert_eq!(status.triggers.mute.as_deref(), Some("granted toggle-mute"));
        assert_eq!(
            status.triggers.deafen.as_deref(),
            Some("granted toggle-deafen")
        );
        let asked = lock(&bound_with).clone();
        assert_eq!(
            asked,
            vec![
                (
                    ID_PTT.to_string(),
                    text::SHORTCUT_PTT.to_string(),
                    Some("F8".to_string())
                ),
                (
                    ID_MUTE.to_string(),
                    text::SHORTCUT_MUTE.to_string(),
                    Some("CTRL+SHIFT+m".to_string())
                ),
                (
                    ID_DEAFEN.to_string(),
                    text::SHORTCUT_DEAFEN.to_string(),
                    Some("CTRL+SHIFT+d".to_string())
                ),
            ]
        );

        let client_name = lock(&client).clone().expect("a call came from the client");
        let signal = |member: &str, id: &str| {
            let mut signal = Message::new_signal(DESKTOP_PATH, SHORTCUTS_IFACE, member)
                .unwrap()
                .append3(Path::new(SESSION).unwrap(), id, 1u64);
            signal = signal.append1(PropMap::new());
            signal.set_destination(Some(client_name.clone().into()));
            signal
        };
        signal_tx.send(signal("Activated", ID_PTT)).unwrap();
        signal_tx.send(signal("Deactivated", ID_PTT)).unwrap();
        wait_until("ptt-state false", || {
            lock(&emitted).iter().any(|l| l == "ptt-state false")
        });
        let lines = lock(&emitted).clone();
        let at = |needle: &str| lines.iter().position(|l| l == needle).unwrap();
        assert!(at("ptt-state true") < at("ptt-state false"));

        // The portal goes away: PTT is reported lost and every trigger unbound.
        release_tx.send(()).unwrap();
        wait_until("ptt-error", || {
            lock(&emitted).iter().any(|l| l == "ptt-error")
        });
        wait_until("unbound status", || {
            handle.shared.status().triggers == Triggers::default()
        });

        stop_handle(handle);
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
    }
}
