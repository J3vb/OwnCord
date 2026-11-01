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
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use dbus::arg::{prop_cast, PropMap, RefArg, Variant};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::oneshot;

use crate::portal_app_id::{self, Ensured, APP_ID};
use crate::shortcuts::{
    backend, portal_ptt_allowed, Backend, GlobalKeysStatus, Triggers, PORTAL_PTT_DENY,
};
use crate::sync::lock;
use crate::text;

mod dbus_bus;
use dbus_bus::DbusBus;

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
mod tests;
