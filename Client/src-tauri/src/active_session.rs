//! The host of the session this process is currently connected to.
//!
//! Scopes credential and identity commands to the server the app is signed
//! into now. `ws_connect` records the host it dialled, and `ws_disconnect`
//! (logout, server switch) clears it.
//!
//! Some commands legitimately run before any session exists — the connect
//! page's credential prefill and the saved-password login. Those pass
//! `allow_pre_session` and are admitted while the slot is empty; the
//! identity-key and identity-pin commands never run pre-session and require an
//! exact host match.
//!
//! This scoping guards against accidental cross-host credential and identity
//! use. The host is set by `ws_connect` and cleared by `ws_disconnect`, both
//! callable from the renderer, so it is not a barrier against a compromised
//! renderer. Sourcing the active host from a native-side authenticated event is
//! a follow-up, not a property this module claims.

use std::sync::Mutex;

/// The single host the current session is connected to, if any.
#[derive(Default)]
pub struct ActiveSession {
    host: Mutex<Option<String>>,
}

impl ActiveSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the host a session connected to.
    pub fn set(&self, host: &str) {
        if let Ok(mut guard) = self.host.lock() {
            *guard = Some(crate::tofu::cert_store_key(host));
        }
    }

    /// Clear on logout or server switch.
    pub fn clear(&self) {
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

    /// Guard a credential command's `host`: allowed when it matches the active
    /// session, or when the slot is empty and the command's flow legitimately
    /// runs pre-session. Returns the error the command reports otherwise.
    pub fn ensure(&self, host: &str, allow_pre_session: bool) -> Result<(), String> {
        if host_access_allowed(self.active().as_deref(), host, allow_pre_session) {
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
fn host_access_allowed(active: Option<&str>, host: &str, allow_pre_session: bool) -> bool {
    match active {
        Some(a) => crate::tofu::cert_store_key(a) == crate::tofu::cert_store_key(host),
        None => allow_pre_session,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_session_is_allowed_only_for_pre_session_flows() {
        assert!(host_access_allowed(None, "chat.example.com", true));
        assert!(!host_access_allowed(None, "chat.example.com", false));
    }

    #[test]
    fn an_active_host_is_required_to_match() {
        assert!(host_access_allowed(
            Some("chat.example.com"),
            "chat.example.com",
            false
        ));
        assert!(!host_access_allowed(
            Some("chat.example.com"),
            "other.example",
            false
        ));
        // A matching host stays allowed even for a pre-session-capable command.
        assert!(host_access_allowed(
            Some("chat.example.com"),
            "chat.example.com",
            true
        ));
        // A different host is refused even when pre-session is allowed.
        assert!(!host_access_allowed(
            Some("chat.example.com"),
            "other.example",
            true
        ));
    }

    #[test]
    fn host_comparison_normalizes_default_port_and_case() {
        assert!(host_access_allowed(
            Some("chat.example.com"),
            "Chat.Example.COM:443",
            false
        ));
        assert!(host_access_allowed(
            Some("chat.example.com:8443"),
            "chat.example.com:8443",
            false
        ));
        // A non-default port is a distinct server and must not collapse.
        assert!(!host_access_allowed(
            Some("localhost:8443"),
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
        session.clear();
        // Back to pre-session: identity commands refuse again.
        assert!(session
            .ensure_identity_scope("42@chat.example.com", false)
            .is_err());
    }
}
