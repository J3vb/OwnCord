//! User-visible native text (B9-20, owner decision Q7).
//!
//! Rust owns a few surfaces the renderer never draws: the tray menu and
//! tooltip, the startup failure dialog, and the certificate/TOFU messages.
//! They live in ONE table here, and the extraction test below fails if a
//! user-visible literal reappears at a call site. English is the only shipped
//! language, matching the renderer catalogs (`Client/src/i18n/`).
//!
//! Rust errors returned to the renderer are classified as codes elsewhere; the
//! renderer maps them to catalog text and shows the raw text only as a fallback
//! detail. This table is only for text a user reads directly.

// --- Tray menu and tooltip -------------------------------------------------

pub const TRAY_SHOW_HIDE: &str = "Show/Hide";
pub const TRAY_STATUS: &str = "Status";
pub const TRAY_STATUS_ONLINE: &str = "Online";
pub const TRAY_STATUS_IDLE: &str = "Idle";
pub const TRAY_STATUS_DND: &str = "Do Not Disturb";
pub const TRAY_STATUS_OFFLINE: &str = "Offline";
pub const TRAY_QUIT: &str = "Quit";
pub const TRAY_TOOLTIP: &str = "OwnCord";

// --- Startup failure dialog (not Linux) ------------------------------------

pub const STARTUP_DIALOG_TITLE: &str = "OwnCord failed to start";
pub const STARTUP_DIALOG_BODY: &str =
    "The application encountered a startup error and cannot continue.\n\n{error}";

/// The startup dialog body with the raw error detail appended verbatim.
pub fn startup_dialog_body(error: &str) -> String {
    STARTUP_DIALOG_BODY.replace("{error}", error)
}

// --- Certificate / TOFU ----------------------------------------------------

pub const CERT_NOT_TRUSTED: &str =
    "certificate for {host} is not yet trusted; confirm the fingerprint to continue";

/// The first-use refusal, with the host as a parameter.
pub fn cert_not_trusted(host: &str) -> String {
    CERT_NOT_TRUSTED.replace("{host}", host)
}

/// The human-readable mismatch message. The frontend parses `Stored:` out of
/// it, so keep this exact shape stable (`/Stored:\s+(\S+)/` in `src/lib/ws.ts`).
pub fn cert_mismatch(host: &str, stored: &str, current: &str) -> String {
    format!(
        "Certificate fingerprint changed for {host}.\n\
         Stored:  {stored}\n\
         Current: {current}\n\
         This may indicate a man-in-the-middle attack or a server certificate rotation.\n\
         Use accept_cert_fingerprint to trust the new certificate."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every user-visible native literal must come from this table. The scan is
    /// the extraction test: it reads the call-site sources and fails when a
    /// literal defined here is hard-coded there again.
    #[test]
    fn user_visible_literals_live_only_in_this_table() {
        const CALL_SITES: &[(&str, &str)] = &[
            ("tray.rs", include_str!("tray.rs")),
            ("lib.rs", include_str!("lib.rs")),
            ("tofu.rs", include_str!("tofu.rs")),
            ("ws_proxy.rs", include_str!("ws_proxy.rs")),
            ("http_proxy.rs", include_str!("http_proxy.rs")),
        ];
        let extracted = [
            TRAY_SHOW_HIDE,
            TRAY_STATUS,
            TRAY_STATUS_ONLINE,
            TRAY_STATUS_IDLE,
            TRAY_STATUS_DND,
            TRAY_STATUS_OFFLINE,
            TRAY_QUIT,
            STARTUP_DIALOG_TITLE,
        ];
        for (name, source) in CALL_SITES {
            for literal in extracted {
                assert!(
                    !source.contains(&format!("\"{literal}\"")),
                    "{name} hard-codes the user-visible literal {literal:?}; \
                     it belongs in text.rs and must be referenced from there"
                );
            }
        }
    }

    #[test]
    fn parameterised_messages_keep_their_shape() {
        assert_eq!(
            cert_not_trusted("example.com:8443"),
            "certificate for example.com:8443 is not yet trusted; confirm the fingerprint to continue"
        );
        let msg = cert_mismatch("example.com:8443", "aa:bb", "cc:dd");
        assert!(msg.contains("Stored:  aa:bb"), "{msg}");
        assert!(msg.contains("Current: cc:dd"), "{msg}");
        assert!(msg.starts_with("Certificate fingerprint changed for example.com:8443."));
        assert!(startup_dialog_body("boom").ends_with("boom"));
    }
}
