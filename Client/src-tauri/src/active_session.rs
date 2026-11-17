//! The host of the session this process is currently connected to.
//!
//! Scopes credential and identity commands to the server the app is signed
//! into now. The proxy records the host only when it relays the server's
//! `auth_ok` over the pinned socket (no renderer command can set it), and
//! clears it when that connection ends, on `ws_disconnect` (logout, server
//! switch) or when the Linux page process ends.
//!
//! The same `auth_ok` records every host a login was verified for during this
//! app run. That set survives `ws_disconnect`, a dropped connection and a
//! credential removal — all renderer-reachable — so a renderer command can
//! clear the active slot but never widen the set.
//!
//! While the slot is empty, the saved-login commands follow two rules:
//!
//! - The stored session token is handed to the page as it is only for a host
//!   in the set, or before any login has been verified this app run (the set
//!   is empty and the first-run behaviour stands, so a restart can still
//!   auto-login from a saved credential). For any other saved host the native
//!   side signs in itself: the token goes to that host's own server over its
//!   pinned connection, and reaches the page only once that server accepts it
//!   (`saved_sign_in`, `SavedSignIn::AskServer`).
//! - The token-less commands (the connect-page prefill, which answers a
//!   username and whether a password is stored, and the saved-password login,
//!   which keeps the password in this process) run for any saved host
//!   (`ensure_no_other_session`).
//!
//! While a session is active, every one of them is refused for another host.
//! The identity-key and identity-pin commands never run pre-session and
//! require an exact active match. The pending-message commands require the
//! active host, or a verified host while no session is active, and never admit
//! a host before a verified login.

use std::collections::HashSet;
use std::sync::Mutex;

/// The host the current session is connected to, plus every host a login was
/// verified for during this app run (which outlives the connection). Both live
/// under one lock so a command never sees an active host cleared before it
/// was recorded as verified.
#[derive(Default)]
pub struct ActiveSession {
    state: Mutex<SessionState>,
}

#[derive(Default, Clone)]
struct SessionState {
    host: Option<String>,
    verified_hosts: HashSet<String>,
}

impl ActiveSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the host a login was verified for. Set only from the relayed
    /// `auth_ok`; marks both the active session and a verified host.
    #[cfg(test)]
    pub fn set(&self, host: &str) {
        self.set_if(host, || true);
    }

    /// `set`, but only if `still_current` holds. The check runs under the same
    /// lock `clear_active_unless` takes, so a connection claim that bumps the
    /// generation first makes this refuse, and one that bumps it after clears
    /// the host this just set: a superseded attempt can never leave its host
    /// active.
    pub fn set_if(&self, host: &str, still_current: impl FnOnce() -> bool) {
        let key = crate::tofu::cert_store_key(host);
        let mut state = self.lock();
        if !still_current() {
            return;
        }
        state.verified_hosts.insert(key.clone());
        state.host = Some(key);
    }

    /// Clear the active host when the connection ends or on `ws_disconnect`.
    /// The verified hosts are deliberately kept.
    pub fn clear_active(&self) {
        self.lock().host = None;
    }

    /// Clear the active host unless it is `host` (compared the way the cert
    /// store does). A reconnect to the same server keeps its session, so the
    /// identity-pin commands do not fail-close voice E2EE while the socket is
    /// redialled; switching to a different server still clears it.
    pub fn clear_active_unless(&self, host: &str) {
        let key = crate::tofu::cert_store_key(host);
        let mut state = self.lock();
        if state.host.as_deref() != Some(key.as_str()) {
            state.host = None;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SessionState> {
        crate::sync::lock(&self.state)
    }

    /// One consistent view of the active host and the verified hosts.
    fn snapshot(&self) -> SessionState {
        self.lock().clone()
    }

    /// Guard a credential command's `host`: allowed when it matches the active
    /// session, or — with no active session and for a pre-session flow — when
    /// it names a host verified this app run (any saved host before the first
    /// login). Returns the error the command reports otherwise.
    pub fn ensure(&self, host: &str, allow_pre_session: bool) -> Result<(), String> {
        let state = self.snapshot();
        if host_access_allowed(
            state.host.as_deref(),
            &state.verified_hosts,
            host,
            allow_pre_session,
        ) {
            Ok(())
        } else {
            Err(format!("host {host} is not the active session host"))
        }
    }

    /// How a stored session token for `host` may be used right now, or the
    /// error a command reports while another server's session is active.
    ///
    /// `Direct` is the rule `ensure(host, true)` states: the active host, a
    /// host verified this app run, or any saved host before the first verified
    /// login. Every other saved host is `AskServer` while no session is
    /// active.
    pub fn saved_sign_in(&self, host: &str) -> Result<SavedSignIn, String> {
        let state = self.snapshot();
        saved_sign_in_rule(state.host.as_deref(), &state.verified_hosts, host)
            .ok_or_else(|| format!("host {host} is not the active session host"))
    }

    /// Guard a saved-login command that hands the page no secret (the
    /// connect-page prefill, the saved-password login): allowed for the active
    /// session's host, and for any host while no session is active.
    pub fn ensure_no_other_session(&self, host: &str) -> Result<(), String> {
        self.saved_sign_in(host).map(|_| ())
    }

    /// Guard an identity command's `scope`. The identity-key commands take an
    /// opaque scope string (`{userId}@{host}`, or a bare legacy host), while
    /// the identity-pin commands take a bare host; both name the same server,
    /// so the host part is compared against the active session.
    pub fn ensure_identity_scope(
        &self,
        scope: &str,
        allow_pre_session: bool,
    ) -> Result<(), String> {
        let state = self.snapshot();
        if host_access_allowed(
            state.host.as_deref(),
            &state.verified_hosts,
            scope_host(scope),
            allow_pre_session,
        ) {
            Ok(())
        } else {
            Err(format!("host {scope} is not the active session host"))
        }
    }

    /// Guard a pending-message command's `host`: allowed when it matches the
    /// active session, or — while the connection is down (queued sends,
    /// logout discard) — when it names a host verified this app run. Unlike
    /// `ensure`, an empty verified set admits nothing: pending messages are
    /// only ever opened after a verified login.
    pub fn ensure_verified_host(&self, host: &str) -> Result<(), String> {
        let state = self.snapshot();
        if verified_host_allowed(state.host.as_deref(), &state.verified_hosts, host) {
            Ok(())
        } else {
            Err(format!("host {host} is not the active session host"))
        }
    }
}

/// How the native side may use a stored session token (see `saved_sign_in`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SavedSignIn {
    /// The token may be handed to the page as stored.
    Direct,
    /// The token leaves this process only for the host's own server, and
    /// reaches the page only after that server accepts it.
    AskServer,
}

/// The bare host part of an identity scope. Identity-key commands receive
/// `{userId}@{host}` (see `lib/net/identity.ts::identityScopeKey`); a legacy host
/// has no `@`. `isValidHost` forbids `@` in a real host, so splitting on the
/// last `@` is unambiguous.
fn scope_host(scope: &str) -> &str {
    match scope.rsplit_once('@') {
        Some((_, host)) => host,
        None => scope,
    }
}

/// Pure decision, so the rule is testable without a Tauri runtime. Hosts are
/// compared with the same normalization the cert store uses, so a
/// `:443`-suffixed profile host matches the port-less `wss://` host
/// `ws_connect` records for the same server.
///
/// With no active session, a pre-session flow is admitted only for a host
/// whose login was verified this app run; before any has been, the set is
/// empty and the first-login behaviour stands. For the stored session token
/// this is the "hand it over as stored" rule (`SavedSignIn::Direct`).
fn host_access_allowed(
    active: Option<&str>,
    verified_hosts: &HashSet<String>,
    host: &str,
    allow_pre_session: bool,
) -> bool {
    if let Some(a) = active {
        return crate::tofu::cert_store_key(a) == crate::tofu::cert_store_key(host);
    }
    if !allow_pre_session {
        return false;
    }
    if verified_hosts.is_empty() {
        return true;
    }
    verified_hosts.contains(&crate::tofu::cert_store_key(host))
}

/// Pure decision behind `saved_sign_in`. `None` while another host's session
/// is active.
fn saved_sign_in_rule(
    active: Option<&str>,
    verified_hosts: &HashSet<String>,
    host: &str,
) -> Option<SavedSignIn> {
    if host_access_allowed(active, verified_hosts, host, true) {
        return Some(SavedSignIn::Direct);
    }
    match active {
        Some(_) => None,
        None => Some(SavedSignIn::AskServer),
    }
}

/// Pure decision behind `ensure_verified_host`.
fn verified_host_allowed(
    active: Option<&str>,
    verified_hosts: &HashSet<String>,
    host: &str,
) -> bool {
    let key = crate::tofu::cert_store_key(host);
    match active {
        Some(a) => crate::tofu::cert_store_key(a) == key,
        None => verified_hosts.contains(&key),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_of(hosts: &[&str]) -> HashSet<String> {
        hosts
            .iter()
            .map(|h| crate::tofu::cert_store_key(h))
            .collect()
    }

    #[test]
    fn first_run_admits_pre_session_reads() {
        // Before any login is verified this app run the set is empty, so the
        // first-run/startup path (connect-page prefill, stored-token resume)
        // can still read a saved host.
        assert!(host_access_allowed(
            None,
            &set_of(&[]),
            "chat.example.com",
            true
        ));
        assert!(!host_access_allowed(
            None,
            &set_of(&[]),
            "chat.example.com",
            false
        ));
    }

    #[test]
    fn a_verified_host_fences_pre_session_reads() {
        // After a verified login, a pre-session flow for any other host is
        // refused even though no session is active.
        assert!(host_access_allowed(
            None,
            &set_of(&["chat.example.com"]),
            "chat.example.com",
            true
        ));
        assert!(!host_access_allowed(
            None,
            &set_of(&["chat.example.com"]),
            "other.example",
            true
        ));
    }

    #[test]
    fn every_host_verified_this_app_run_stays_readable() {
        let verified = set_of(&["a.example", "b.example"]);
        assert!(host_access_allowed(None, &verified, "a.example", true));
        assert!(host_access_allowed(None, &verified, "b.example", true));
        assert!(!host_access_allowed(None, &verified, "c.example", true));
    }

    #[test]
    fn an_active_host_is_required_to_match() {
        assert!(host_access_allowed(
            Some("chat.example.com"),
            &set_of(&[]),
            "chat.example.com",
            false
        ));
        assert!(!host_access_allowed(
            Some("chat.example.com"),
            &set_of(&[]),
            "other.example",
            false
        ));
        // A matching host stays allowed even for a pre-session-capable command.
        assert!(host_access_allowed(
            Some("chat.example.com"),
            &set_of(&[]),
            "chat.example.com",
            true
        ));
        // A different host is refused even when pre-session is allowed.
        assert!(!host_access_allowed(
            Some("chat.example.com"),
            &set_of(&["other.example"]),
            "other.example",
            true
        ));
    }

    #[test]
    fn host_comparison_normalizes_default_port_and_case() {
        assert!(host_access_allowed(
            Some("chat.example.com"),
            &set_of(&[]),
            "Chat.Example.COM:443",
            false
        ));
        assert!(host_access_allowed(
            Some("chat.example.com:8443"),
            &set_of(&[]),
            "chat.example.com:8443",
            false
        ));
        // A non-default port is a distinct server and must not collapse.
        assert!(!host_access_allowed(
            Some("localhost:8443"),
            &set_of(&[]),
            "localhost:9443",
            false
        ));
    }

    #[test]
    fn identity_scope_hosts_are_extracted() {
        assert_eq!(scope_host("42@chat.example.com"), "chat.example.com");
        assert_eq!(scope_host("chat.example.com"), "chat.example.com");
        assert_eq!(scope_host("42@localhost:8443"), "localhost:8443");
    }

    #[test]
    fn load_credential_for_a_non_active_host_is_refused() {
        // With a live session on one host, a credential read for any other
        // host is refused.
        let session = ActiveSession::new();
        session.set("chat.example.com");
        assert!(session.ensure("other.example.com", true).is_err());
        assert!(session.ensure("chat.example.com", true).is_ok());
    }

    #[test]
    fn pre_session_commands_are_admitted_until_a_session_is_set() {
        // The connect page reads the credential and the saved-password login
        // runs before any ws_connect: both are admitted while the slot is
        // empty, and both stop reaching other hosts once a session exists.
        let session = ActiveSession::new();
        assert!(session.ensure("chat.example.com", true).is_ok());
        session.set("chat.example.com");
        assert!(session.ensure("other.example.com", true).is_err());
    }

    #[test]
    fn identity_commands_are_refused_without_a_session() {
        let session = ActiveSession::new();
        assert!(session
            .ensure_identity_scope("42@chat.example.com", false)
            .is_err());
        session.set("chat.example.com");
        assert!(session
            .ensure_identity_scope("42@chat.example.com", false)
            .is_ok());
        assert!(session
            .ensure_identity_scope("7@other.example", false)
            .is_err());
    }

    #[test]
    fn a_same_host_reconnect_keeps_the_session_and_a_switch_clears_it() {
        let session = ActiveSession::new();
        session.set("chat.example.com");
        session.clear_active_unless("Chat.Example.com:443");
        assert!(session.ensure("chat.example.com", false).is_ok());
        session.clear_active_unless("other.example.com");
        assert!(session.ensure("chat.example.com", false).is_err());
        // The verified host outlives the clear, as with clear_active.
        assert!(session.ensure("chat.example.com", true).is_ok());
    }

    #[test]
    fn a_non_pre_session_guard_refuses_without_a_session_or_for_another_host() {
        // get_identity_pin and store_identity_pin both call ensure(host, false).
        let session = ActiveSession::new();
        assert!(session.ensure("chat.example.com", false).is_err());
        session.set("chat.example.com");
        assert!(session.ensure("other.example.com", false).is_err());
        assert!(session.ensure("Chat.Example.com:443", false).is_ok());
    }

    #[test]
    fn set_if_checks_under_the_session_lock_and_refuses_a_superseded_attempt() {
        let session = ActiveSession::new();
        let mut held = false;
        session.set_if("chat.example.com", || {
            held = session.state.try_lock().is_err();
            true
        });
        assert!(held, "the currency check must run under the session lock");
        assert!(session.ensure("chat.example.com", false).is_ok());

        session.clear_active_unless("other.example.com");
        session.set_if("dead.example.com", || false);
        assert!(session.ensure("dead.example.com", false).is_err());
        assert!(session.ensure("dead.example.com", true).is_err());
    }

    #[test]
    fn disconnect_clears_the_active_host() {
        let session = ActiveSession::new();
        session.set("chat.example.com");
        session.clear_active();
        // Back to pre-session: identity commands refuse again.
        assert!(session
            .ensure_identity_scope("42@chat.example.com", false)
            .is_err());
    }

    #[test]
    fn disconnect_keeps_every_verified_host() {
        // A renderer-callable disconnect clears the active slot but must not
        // widen pre-session reads: only the verified host stays readable.
        let session = ActiveSession::new();
        session.set("chat.example.com");
        session.clear_active();
        assert!(session.ensure("chat.example.com", true).is_ok());
        assert!(session.ensure("other.example", true).is_err());
    }

    #[test]
    fn switching_back_to_a_host_signed_in_this_run_still_resumes() {
        // Quick switch away and back: both hosts were verified this app run, so
        // both saved credentials remain readable pre-session.
        let session = ActiveSession::new();
        session.set("a.example");
        session.clear_active();
        session.set("b.example");
        session.clear_active();
        assert!(session.ensure("a.example", true).is_ok());
        assert!(session.ensure("b.example", true).is_ok());
        assert!(session.ensure("c.example", true).is_err());
    }

    #[test]
    fn a_new_verified_login_activates_the_new_host() {
        let session = ActiveSession::new();
        session.set("chat.example.com");
        session.clear_active();
        // Switching servers through a real login: the new auth_ok verifies and
        // activates the new host.
        session.set("other.example");
        assert!(session.ensure("other.example", false).is_ok());
        // The earlier host is verified but no longer active.
        assert!(session.ensure("chat.example.com", false).is_err());
        // Both remain readable pre-session once the session ends.
        session.clear_active();
        assert!(session.ensure("chat.example.com", true).is_ok());
        assert!(session.ensure("other.example", true).is_ok());
    }

    #[test]
    fn a_saved_host_not_verified_this_run_signs_in_through_its_server() {
        // A was verified, then the session ended (a server switch). A's token
        // is handed over as stored; B's and C's only after their own server
        // accepts it.
        let session = ActiveSession::new();
        session.set("a.example");
        session.clear_active();
        assert_eq!(session.saved_sign_in("a.example"), Ok(SavedSignIn::Direct));
        assert_eq!(
            session.saved_sign_in("b.example"),
            Ok(SavedSignIn::AskServer)
        );
        // Asking for B changes nothing: no host is admitted on the page's word.
        assert_eq!(
            session.saved_sign_in("b.example"),
            Ok(SavedSignIn::AskServer)
        );
        assert!(session.ensure("b.example", true).is_err());
        // Once B's server answers the sign-in, B is verified like A, and C is
        // still not.
        session.set("b.example");
        session.clear_active();
        assert_eq!(session.saved_sign_in("b.example"), Ok(SavedSignIn::Direct));
        assert_eq!(
            session.saved_sign_in("c.example"),
            Ok(SavedSignIn::AskServer)
        );
        assert!(session.ensure("c.example", true).is_err());
    }

    #[test]
    fn an_active_session_refuses_a_saved_sign_in_for_another_host() {
        let session = ActiveSession::new();
        session.set("a.example");
        assert_eq!(
            session.saved_sign_in("A.Example:443"),
            Ok(SavedSignIn::Direct)
        );
        assert!(session.saved_sign_in("b.example").is_err());
        assert!(session.ensure_no_other_session("b.example").is_err());
        assert!(session.ensure_no_other_session("a.example").is_ok());
        // A verified host that is not the active one is refused as well.
        session.clear_active();
        session.set("b.example");
        assert!(session.saved_sign_in("a.example").is_err());
    }

    #[test]
    fn the_first_run_hands_a_saved_token_over_as_stored() {
        let session = ActiveSession::new();
        assert_eq!(
            session.saved_sign_in("chat.example.com"),
            Ok(SavedSignIn::Direct)
        );
    }

    #[test]
    fn token_less_saved_login_commands_run_for_any_host_without_a_session() {
        let session = ActiveSession::new();
        assert!(session.ensure_no_other_session("a.example").is_ok());
        session.set("a.example");
        session.clear_active();
        assert!(session.ensure_no_other_session("a.example").is_ok());
        assert!(session.ensure_no_other_session("b.example").is_ok());
    }

    #[test]
    fn the_saved_sign_in_rule_covers_every_state() {
        let none = set_of(&[]);
        let a = set_of(&["a.example"]);
        assert_eq!(
            saved_sign_in_rule(None, &none, "b.example"),
            Some(SavedSignIn::Direct)
        );
        assert_eq!(
            saved_sign_in_rule(None, &a, "a.example"),
            Some(SavedSignIn::Direct)
        );
        assert_eq!(
            saved_sign_in_rule(None, &a, "b.example"),
            Some(SavedSignIn::AskServer)
        );
        assert_eq!(
            saved_sign_in_rule(Some("a.example"), &a, "a.example"),
            Some(SavedSignIn::Direct)
        );
        assert_eq!(saved_sign_in_rule(Some("a.example"), &a, "b.example"), None);
        assert_eq!(saved_sign_in_rule(Some("b.example"), &a, "a.example"), None);
    }

    #[test]
    fn pending_messages_need_a_verified_host() {
        // Nothing is admitted before a verified login, not even pre-session.
        let session = ActiveSession::new();
        assert!(session.ensure_verified_host("chat.example.com").is_err());
        session.set("chat.example.com");
        assert!(session.ensure_verified_host("Chat.Example.com:443").is_ok());
        assert!(session.ensure_verified_host("other.example").is_err());
    }

    #[test]
    fn pending_messages_survive_a_dropped_connection_but_not_a_switch() {
        // A dropped connection clears the slot; queued sends and the logout
        // discard still reach the host that was verified.
        let session = ActiveSession::new();
        session.set("a.example");
        session.clear_active();
        assert!(session.ensure_verified_host("a.example").is_ok());
        assert!(session.ensure_verified_host("b.example").is_err());
        // With another server active, the earlier host is refused.
        session.set("b.example");
        assert!(session.ensure_verified_host("a.example").is_err());
        assert!(session.ensure_verified_host("b.example").is_ok());
    }
}
