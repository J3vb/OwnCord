//! The host of the session this process is currently connected to.
//!
//! Scopes credential and identity commands to the server the app is signed
//! into now. The proxy records the host only when it relays the server's
//! `auth_ok` over the pinned socket (no renderer command can set it), and
//! clears it when that connection ends or on `ws_disconnect` (logout, server
//! switch).
//!
//! The same `auth_ok` records every host a login was verified for during this
//! app run. That set survives `ws_disconnect`, a dropped connection and a
//! credential removal — all renderer-reachable — so a renderer command can
//! clear the active slot but never widen the set. While the slot is empty, the
//! pre-session flows (connect-page credential prefill, stored-token resume and
//! saved-password login) pass `allow_pre_session` and are admitted only for a
//! host in the set. Before any login has been verified this app run the set is
//! empty and the first-run behaviour stands, so a restart can still auto-login
//! from a saved credential. The identity-key and identity-pin commands never
//! run pre-session and require an exact active match.

use std::collections::HashSet;
use std::sync::Mutex;

/// The host the current session is connected to, plus every host a login was
/// verified for during this app run (which outlives the connection).
#[derive(Default)]
pub struct ActiveSession {
    host: Mutex<Option<String>>,
    verified_hosts: Mutex<HashSet<String>>,
}

impl ActiveSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the host a login was verified for. Set only from the relayed
    /// `auth_ok`; marks both the active session and a verified host.
    pub fn set(&self, host: &str) {
        let key = crate::tofu::cert_store_key(host);
        if let Ok(mut guard) = self.host.lock() {
            *guard = Some(key.clone());
        }
        if let Ok(mut guard) = self.verified_hosts.lock() {
            guard.insert(key);
        }
    }

    /// Clear the active host when the connection ends or on `ws_disconnect`.
    /// The verified hosts are deliberately kept.
    pub fn clear_active(&self) {
        if let Ok(mut guard) = self.host.lock() {
            *guard = None;
        }
    }

    /// The active host, normalized, or None when no session is established.
    fn active(&self) -> Option<String> {
        self.host
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every host a login was verified for during this app run, normalized.
    fn verified_hosts(&self) -> HashSet<String> {
        self.verified_hosts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Guard a credential command's `host`: allowed when it matches the active
    /// session, or — with no active session and for a pre-session flow — when
    /// it names a host verified this app run (any saved host before the first
    /// login). Returns the error the command reports otherwise.
    pub fn ensure(&self, host: &str, allow_pre_session: bool) -> Result<(), String> {
        if host_access_allowed(
            self.active().as_deref(),
            &self.verified_hosts(),
            host,
            allow_pre_session,
        ) {
            Ok(())
        } else {
            Err(format!("host {host} is not the active session host"))
        }
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
        if host_access_allowed(
            self.active().as_deref(),
            &self.verified_hosts(),
            scope_host(scope),
            allow_pre_session,
        ) {
            Ok(())
        } else {
            Err(format!("host {scope} is not the active session host"))
        }
    }
}

/// The bare host part of an identity scope. Identity-key commands receive
/// `{userId}@{host}` (see `lib/identity.ts::identityScopeKey`); a legacy host
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
/// empty and the first-login behaviour stands.
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
}
