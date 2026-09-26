//! User-visible native text (B9-20, owner decision Q7).
//!
//! Rust owns a few surfaces the renderer never draws: the tray menu and
//! tooltip, the startup failure dialog, and the certificate/TOFU messages.
//! They live in ONE table here. English is the only shipped language, matching
//! the renderer catalogs (`Client/src/i18n/`).
//!
//! The certificate refusals also reach the renderer, which classifies them by
//! the `cert-tofu` event's `status` (`first_use`, `mismatch`) and shows its own
//! catalog text; it reads only the stored fingerprint out of the mismatch
//! message. Other Rust command errors are not classified as codes yet.

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

// The startup failure dialog is `#[cfg(not(target_os = "linux"))]` in lib.rs
// (Linux reports a fatal startup error to the console instead), so these are
// unused there outside the tests.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub const STARTUP_DIALOG_TITLE: &str = "OwnCord failed to start";
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub const STARTUP_DIALOG_BODY: &str =
    "The application encountered a startup error and cannot continue.\n\n{error}";

/// The startup dialog body with the raw error detail appended verbatim.
#[cfg_attr(target_os = "linux", allow(dead_code))]
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

    #[test]
    fn startup_dialog_reads_the_table() {
        assert_eq!(STARTUP_DIALOG_TITLE, "OwnCord failed to start");
        assert_eq!(
            startup_dialog_body("boom"),
            "The application encountered a startup error and cannot continue.\n\nboom"
        );
    }

    #[test]
    fn certificate_messages_read_the_table() {
        assert_eq!(
            cert_not_trusted("example.com:8443"),
            "certificate for example.com:8443 is not yet trusted; confirm the fingerprint to continue"
        );
        // The proxies build the mismatch message through tofu, so check it there.
        assert_eq!(
            crate::tofu::mismatch_message("example.com:8443", "aa:bb", "cc:dd"),
            "Certificate fingerprint changed for example.com:8443.\n\
             Stored:  aa:bb\n\
             Current: cc:dd\n\
             This may indicate a man-in-the-middle attack or a server certificate rotation.\n\
             Use accept_cert_fingerprint to trust the new certificate."
        );
    }

    /// Supplementary guard: the tests above and tray.rs's check what each
    /// surface shows; this one fails when a call site hard-codes the table's
    /// text again instead of referencing it.
    #[test]
    fn call_sites_do_not_repeat_the_table() {
        const CALL_SITES: &[(&str, &str)] = &[
            ("tray.rs", include_str!("tray.rs")),
            ("lib.rs", include_str!("lib.rs")),
            ("tofu.rs", include_str!("tofu.rs")),
            ("ws_proxy.rs", include_str!("ws_proxy.rs")),
            ("http_proxy.rs", include_str!("http_proxy.rs")),
        ];
        let quoted = [
            TRAY_SHOW_HIDE,
            TRAY_STATUS,
            TRAY_STATUS_ONLINE,
            TRAY_STATUS_IDLE,
            TRAY_STATUS_DND,
            TRAY_STATUS_OFFLINE,
            TRAY_QUIT,
            TRAY_TOOLTIP,
            STARTUP_DIALOG_TITLE,
        ]
        .map(|literal| format!("\"{literal}\""));
        let prose = [
            "startup error and cannot continue",
            "is not yet trusted; confirm the fingerprint",
            "Certificate fingerprint changed for",
            "man-in-the-middle attack",
        ];
        for (name, source) in CALL_SITES {
            for text in quoted.iter().map(String::as_str).chain(prose) {
                assert!(
                    !source.contains(text),
                    "{name} hard-codes the user-visible text {text:?}; \
                     it belongs in text.rs and must be referenced from there"
                );
            }
        }
    }
}
