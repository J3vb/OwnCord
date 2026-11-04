//! The real portal bus: one session-bus connection, with a match rule per
//! signal the thread reads, behind the `Bus` trait the tests fake.

use super::*;
use dbus::arg::AppendAll;
use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
use dbus::blocking::Connection;
use dbus::channel::MatchingReceiver as _;
use dbus::message::MatchRule;
use dbus::Path;

pub(super) struct DbusBus {
    conn: Connection,
    incoming: Receiver<Incoming>,
}

impl DbusBus {
    pub(super) fn connect() -> Result<Self, String> {
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
