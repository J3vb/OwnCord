use super::*;
use crate::shortcuts::portal_ptt_allowed;
use dbus::blocking::Connection;
use dbus::message::MatchRule;
use dbus::Path;

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
                        let preferred = prop_cast::<String>(&props, "preferred_trigger").cloned();
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
