//! User-visible native text.
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

#[cfg(desktop)]
pub const TRAY_SHOW_HIDE: &str = "Show/Hide";
#[cfg(desktop)]
pub const TRAY_STATUS: &str = "Status";
#[cfg(desktop)]
pub const TRAY_STATUS_ONLINE: &str = "Online";
#[cfg(desktop)]
pub const TRAY_STATUS_IDLE: &str = "Idle";
#[cfg(desktop)]
pub const TRAY_STATUS_DND: &str = "Do Not Disturb";
// The app's status picker calls this "Invisible"; the tray must not say
// "Offline" for the same state (F24).
#[cfg(desktop)]
pub const TRAY_STATUS_OFFLINE: &str = "Invisible";
#[cfg(desktop)]
pub const TRAY_OPEN_LOGS: &str = "Open Log Folder";
#[cfg(desktop)]
pub const TRAY_MUTE: &str = "Mute / Unmute";
#[cfg(desktop)]
pub const TRAY_DEAFEN: &str = "Deafen / Undeafen";
#[cfg(desktop)]
pub const TRAY_QUIT: &str = "Quit";
#[cfg(desktop)]
pub const TRAY_TOOLTIP: &str = "OwnCord";
#[cfg(desktop)]
pub const TRAY_TOOLTIP_UNREAD_ONE: &str = "OwnCord — 1 unread mention";
#[cfg(desktop)]
pub const TRAY_TOOLTIP_UNREAD: &str = "OwnCord — {count} unread mentions";

/// The tray tooltip with the unread badge count; plain at 0.
#[cfg(desktop)]
pub fn tray_tooltip(count: u32) -> String {
    match count {
        0 => TRAY_TOOLTIP.to_string(),
        1 => TRAY_TOOLTIP_UNREAD_ONE.to_string(),
        n => TRAY_TOOLTIP_UNREAD.replace("{count}", &n.to_string()),
    }
}

// --- Message notifications -----------------------------------------------

/// The click action on a message or call notification (macOS, Linux).
#[cfg_attr(windows, allow(dead_code))]
#[cfg(desktop)]
pub const NOTIFICATION_OPEN: &str = "Open";

// --- Global shortcuts (Wayland portal) -------------------------------------

/// What the desktop's shortcut dialog and settings list for each shortcut.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const SHORTCUT_PTT: &str = "Push to Talk";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const SHORTCUT_MUTE: &str = "Toggle Mute";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const SHORTCUT_DEAFEN: &str = "Toggle Deafen";

// --- Close to tray notice --------------------------------------------------

/// Shown once, the first time the X button hides the window to the tray.
#[cfg(desktop)]
pub const TRAY_NOTICE_TITLE: &str = "OwnCord";
#[cfg(desktop)]
pub const TRAY_NOTICE_BODY: &str = "OwnCord is still running in the tray";

// --- Startup failure dialog ------------------------------------------------

// On Linux lib.rs shows it only when a display is set; a headless run keeps
// the stderr line alone.
#[cfg(desktop)]
pub const STARTUP_DIALOG_TITLE: &str = "OwnCord failed to start";
#[cfg(desktop)]
pub const STARTUP_DIALOG_BODY: &str =
    "The application encountered a startup error and cannot continue.\n\n{error}";

/// The startup dialog body with the raw error detail appended verbatim.
#[cfg(desktop)]
pub fn startup_dialog_body(error: &str) -> String {
    STARTUP_DIALOG_BODY.replace("{error}", error)
}

// --- Certificate / TOFU ----------------------------------------------------

pub const CERT_NOT_TRUSTED: &str =
    "certificate for {host} is not yet trusted; confirm the fingerprint to continue";

/// The fallback message a certificate refusal carries in its `TLS_CERT_UNVERIFIED`
/// JSON body. The webview shows its own catalog copy for that code; this is what
/// a caller that ignores the code still reads.
pub const CERT_UNVERIFIED: &str = "the server's certificate could not be verified";

/// The first-use refusal, with the host as a parameter.
pub fn cert_not_trusted(host: &str) -> String {
    CERT_NOT_TRUSTED.replace("{host}", host)
}

/// Title of the native dialog that confirms pinning a certificate. The dialog
/// is the trust boundary: `accept_cert_fingerprint` pins nothing until the user
/// answers it, so a compromised renderer cannot silently pin a host.
#[cfg_attr(feature = "e2e-auto-confirm", allow(dead_code))]
pub const CERT_ACCEPT_TITLE: &str = "Confirm server certificate";

/// Body of the native cert-confirmation dialog: the host and the fingerprint it
/// is being pinned to.
#[cfg_attr(feature = "e2e-auto-confirm", allow(dead_code))]
pub fn cert_accept_prompt(host: &str, fingerprint: &str) -> String {
    format!(
        "Trust this certificate for {host}?\n\n\
         Fingerprint:\n{fingerprint}\n\n\
         Only continue if this matches the fingerprint your server shows."
    )
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

// --- Linux .deb update -----------------------------------------
//
// The two `update …` strings are stable codes: the renderer matches their
// prefix (`platform/desktop/updater.ts`) to choose its own catalog text, so do
// not reword them. The polkit prompt's message is read by polkit from
// `packaging/linux/com.owncord.client.update.policy`, not from here.

/// pkexec reported the password prompt was dismissed (exit 126).
#[cfg(target_os = "linux")]
pub const UPDATE_CANCELLED: &str = "update cancelled";
/// pkexec could not authorize the update, or no polkit agent is running (127).
#[cfg(target_os = "linux")]
pub const UPDATE_NOT_AUTHORIZED: &str = "update not authorized";
/// Android may not install apps from OwnCord yet; the settings page that
/// allows it was opened instead of the installer.
#[cfg(target_os = "android")]
pub const UPDATE_INSTALL_PERMISSION: &str = "update install permission needed";
/// The root helper refused the package (exit 10 to 13).
#[cfg(target_os = "linux")]
pub const UPDATE_PACKAGE_CHECK_FAILED: &str = "download/install failed: package check failed";
/// apt-get, or anything else on the install path, failed.
#[cfg(target_os = "linux")]
pub const UPDATE_PACKAGE_MANAGER_FAILED: &str = "download/install failed: package manager failed";

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
    fn tray_tooltip_counts_unread_mentions() {
        assert_eq!(tray_tooltip(0), "OwnCord");
        assert_eq!(tray_tooltip(1), "OwnCord — 1 unread mention");
        assert_eq!(tray_tooltip(5), "OwnCord — 5 unread mentions");
        // The tooltip has room for the real number; only the overlay caps at 9+.
        assert_eq!(tray_tooltip(12), "OwnCord — 12 unread mentions");
    }

    #[test]
    fn certificate_messages_read_the_table() {
        assert_eq!(
            cert_not_trusted("example.com:8443"),
            "certificate for example.com:8443 is not yet trusted; confirm the fingerprint to continue"
        );
        assert_eq!(
            CERT_UNVERIFIED,
            "the server's certificate could not be verified"
        );
        assert_eq!(CERT_ACCEPT_TITLE, "Confirm server certificate");
        assert_eq!(
            cert_accept_prompt("example.com:8443", "aa:bb:cc"),
            "Trust this certificate for example.com:8443?\n\n\
             Fingerprint:\naa:bb:cc\n\n\
             Only continue if this matches the fingerprint your server shows."
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
            ("http_pool.rs", include_str!("http_pool.rs")),
            ("shortcuts.rs", include_str!("shortcuts.rs")),
            ("portal_shortcuts.rs", include_str!("portal_shortcuts.rs")),
            (
                "portal_shortcuts/dbus_bus.rs",
                include_str!("portal_shortcuts/dbus_bus.rs"),
            ),
        ];
        let quoted = [
            TRAY_SHOW_HIDE,
            TRAY_STATUS,
            TRAY_STATUS_ONLINE,
            TRAY_STATUS_IDLE,
            TRAY_STATUS_DND,
            TRAY_STATUS_OFFLINE,
            TRAY_OPEN_LOGS,
            TRAY_MUTE,
            TRAY_DEAFEN,
            TRAY_QUIT,
            TRAY_TOOLTIP,
            SHORTCUT_PTT,
            SHORTCUT_MUTE,
            SHORTCUT_DEAFEN,
            STARTUP_DIALOG_TITLE,
            CERT_UNVERIFIED,
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
