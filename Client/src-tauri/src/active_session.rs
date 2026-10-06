//! The host of the session this process is currently connected to.
//!
//! Scopes credential and identity commands to the server the app is signed
//! into now. The proxy records the host only when it relays the server's
//! `auth_ok` over the pinned socket (no renderer command can set it), and
//! clears it when that connection ends or on `ws_disconnect` (logout, server
//! switch).
//!
//! The same `auth_ok` records a native-side last-verified host that survives
//! `ws_disconnect` and a dropped connection: a renderer command can clear the
//! active slot but not the verified one. While the slot is empty, the
//! pre-session flows (connect-page credential prefill, stored-token resume and
//! saved-password login) pass `allow_pre_session` and are admitted only for
//! that last verified host. It is forgotten when its credential is removed (an
//! explicit logout), after which first-login behaviour applies again. The
//! identity-key and identity-pin commands never run pre-session and require an
//! exact active match.

use std::sync::Mutex;

/// The host the current session is connected to, plus the last host a login
/// was verified for (which outlives the connection).
#[derive(Default)]
pub struct ActiveSession {
    host: Mutex<Option<String>>,
    verified: Mutex<Option<String>>,
}

impl ActiveSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the host a login was verified for. Set only from the relayed
    /// `auth_ok`; marks both the active session and the last verified host.
    pub fn set(&self, host: &str) {
        let key = crate::tofu::cert_store_key(host);
        if let Ok(mut guard) = self.host.lock() {
            *guard = Some(key.clone());
        }
        if let Ok(mut guard) = self.verified.lock() {
            *guard = Some(key);
        }
    }

    /// Clear the active host when the connection ends or on `ws_disconnect`.
    /// The last verified host is deliberately kept.
    pub fn clear_active(&self) {
        if let Ok(mut guard) = self.host.lock() {
            *guard = None;
        }
    }

    /// Forget the last verified host when its credential is removed; a removal
    /// for another host leaves it in place.
    pub fn credential_removed(&self, host: &str) {
        let key = crate::tofu::cert_store_key(host);
        if let Ok(mut guard) = self.verified.lock() {
            if guard.as_deref() == Some(key.as_str()) {
                *guard = None;
            }
        }
    }

    /// The active host, normalized, or None when no session is established.
    fn active(&self) -> Option<String> {
        self.host
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The last host a login was verified for, normalized, or None.
    fn verified(&self) -> Option<String> {
        self.verified
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Guard a credential command's `host`: allowed when it matches the active
    /// session, or — with no active session and for a pre-session flow — when
    /// it matches the last verified host (any saved host on a first run).
    /// Returns the error the command reports otherwise.
    pub fn ensure(&self, host: &str, allow_pre_session: bool) -> Result<(), String> {
        if host_access_allowed(
            self.active().as_deref(),
            self.verified().as_deref(),
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
            self.verified().as_deref(),
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
/// With no active session, a pre-session flow is admitted only for the last
/// verified host; a first run with none keeps the first-login behaviour.
fn host_access_allowed(
    active: Option<&str>,
    verified: Option<&str>,
    host: &str,
    allow_pre_session: bool,
) -> bool {
    if let Some(a) = active {
        return crate::tofu::cert_store_key(a) == crate::tofu::cert_store_key(host);
    }
    if !allow_pre_session {
        return false;
    }
    match verified {
        Some(v) => crate::tofu::cert_store_key(v) == crate::tofu::cert_store_key(host),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_session_is_allowed_only_for_pre_session_flows() {
        // First run: no verified host, so pre-session flows are admitted.
        assert!(host_access_allowed(None, None, "chat.example.com", true));
        assert!(!host_access_allowed(None, None, "chat.example.com", false));
    }

    #[test]
    fn a_verified_host_fences_pre_session_reads() {
        // After a verified login, a pre-session flow for any other host is
        // refused even though no session is active.
        assert!(host_access_allowed(
            None,
            Some("chat.example.com"),
            "chat.example.com",
            true
        ));
        assert!(!host_access_allowed(
            None,
            Some("chat.example.com"),
            "other.example",
            true
        ));
    }

    #[test]
    fn an_active_host_is_required_to_match() {
        assert!(host_access_allowed(
            Some("chat.example.com"),
            None,
            "chat.example.com",
            false
        ));
        assert!(!host_access_allowed(
            Some("chat.example.com"),
            None,
            "other.example",
            false
        ));
        // A matching host stays allowed even for a pre-session-capable command.
        assert!(host_access_allowed(
            Some("chat.example.com"),
            None,
            "chat.example.com",
            true
        ));
        // A different host is refused even when pre-session is allowed.
        assert!(!host_access_allowed(
            Some("chat.example.com"),
            None,
            "other.example",
            true
        ));
    }

    #[test]
    fn host_comparison_normalizes_default_port_and_case() {
        assert!(host_access_allowed(
            Some("chat.example.com"),
            None,
            "Chat.Example.COM:443",
            false
        ));
        assert!(host_access_allowed(
            Some("chat.example.com:8443"),
            None,
            "chat.example.com:8443",
            false
        ));
        // A non-default port is a distinct server and must not collapse.
        assert!(!host_access_allowed(
            Some("localhost:8443"),
            None,
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
    fn disconnect_keeps_the_last_verified_host() {
        let session = ActiveSession::new();
        session.set("chat.example.com");
        session.clear_active();
        // No session, but a pre-session flow may read only the verified host.
        assert!(session.ensure("chat.example.com", true).is_ok());
        assert!(session.ensure("other.example", true).is_err());
    }

    #[test]
    fn a_new_verified_login_moves_the_fence_to_the_new_host() {
        let session = ActiveSession::new();
        session.set("chat.example.com");
        session.clear_active();
        // Switching servers through a real login: the new auth_ok verifies and
        // activates the new host.
        session.set("other.example");
        assert!(session.ensure("other.example", true).is_ok());
        assert!(session.ensure("chat.example.com", true).is_err());
    }

    #[test]
    fn credential_removal_forgets_only_the_matching_verified_host() {
        let session = ActiveSession::new();
        session.set("chat.example.com");
        session.clear_active();
        session.credential_removed("other.example");
        assert!(session.ensure("chat.example.com", true).is_ok());
        session.credential_removed("chat.example.com");
        // Back to first-run: any saved host may be read pre-session again.
        assert!(session.ensure("other.example", true).is_ok());
    }
}
