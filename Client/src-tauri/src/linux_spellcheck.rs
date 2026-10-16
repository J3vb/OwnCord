//! Linux-only WebKitGTK spell checking.
//!
//! WebKitGTK ships with spell checking switched off, so on Linux the message
//! composer shows no red underlines and the context menu offers no
//! suggestions. Windows (WebView2) and macOS (WKWebView) check spelling
//! themselves. This hook turns it on for the main window's web context, in
//! the system language, at startup.
//!
//! Checking goes through enchant, so a dictionary (for example hunspell's)
//! must be installed; without one nothing is underlined. Every failure here
//! only logs a warning — spell checking is a convenience and must never
//! block startup.

use tauri::{AppHandle, Manager};

/// Enable spell checking on the main window's WebKitGTK web context, using
/// the language from the locale environment (`LC_ALL`, `LC_MESSAGES`, `LANG`).
pub fn enable_spell_checking(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("linux_spellcheck: main window not found; spell checking stays off");
        return;
    };
    let lang = spell_language(
        &std::env::var("LC_ALL").unwrap_or_default(),
        &std::env::var("LC_MESSAGES").unwrap_or_default(),
        &std::env::var("LANG").unwrap_or_default(),
    );
    let result = window.with_webview(move |webview| {
        use webkit2gtk::{WebContextExt, WebViewExt};

        let webview = webview.inner();
        match webview.context() {
            Some(ctx) => {
                ctx.set_spell_checking_enabled(true);
                ctx.set_spell_checking_languages(&[lang.as_str()]);
                log::info!("linux_spellcheck: spell checking enabled ({lang})");
            }
            None => log::warn!("linux_spellcheck: webview has no web context"),
        }
    });
    if let Err(e) = result {
        log::warn!("linux_spellcheck: failed to configure spell checking: {e}");
    }
}

/// Pick the spell-check language from the locale variables, in POSIX
/// precedence order: the first non-empty of `LC_ALL`, `LC_MESSAGES`, `LANG`.
/// The encoding (`.UTF-8`) and modifier (`@euro`) are dropped. An empty
/// result, `C` or `POSIX` falls back to `en_US`.
pub fn spell_language(lc_all: &str, lc_messages: &str, lang: &str) -> String {
    let raw = [lc_all, lc_messages, lang]
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or("");
    let end = raw.find(['.', '@']).unwrap_or(raw.len());
    let base = &raw[..end];
    if base.is_empty() || base == "C" || base == "POSIX" {
        return "en_US".to_string();
    }
    base.to_string()
}

#[cfg(test)]
mod tests {
    use super::spell_language;

    #[test]
    fn spell_language_lc_all_wins() {
        assert_eq!(spell_language("de_DE", "fr_FR", "nl_NL"), "de_DE");
    }

    #[test]
    fn spell_language_empty_lc_all_falls_to_lc_messages() {
        assert_eq!(spell_language("", "fr_FR.UTF-8", "nl_NL"), "fr_FR");
    }

    #[test]
    fn spell_language_empty_lc_all_and_messages_falls_to_lang() {
        assert_eq!(spell_language("", "", "nl_NL.UTF-8"), "nl_NL");
    }

    #[test]
    fn spell_language_strips_encoding() {
        assert_eq!(spell_language("", "", "nl_BE.UTF-8"), "nl_BE");
    }

    #[test]
    fn spell_language_strips_modifier() {
        assert_eq!(spell_language("", "", "de_DE.UTF-8@euro"), "de_DE");
        assert_eq!(spell_language("", "", "sr_RS@latin"), "sr_RS");
    }

    #[test]
    fn spell_language_c_and_posix_default_to_en_us() {
        assert_eq!(spell_language("C", "", ""), "en_US");
        assert_eq!(spell_language("", "", "POSIX"), "en_US");
        assert_eq!(spell_language("", "", "C.UTF-8"), "en_US");
    }

    #[test]
    fn spell_language_all_empty_defaults_to_en_us() {
        assert_eq!(spell_language("", "", ""), "en_US");
    }

    #[test]
    fn spell_language_language_only_passes_through() {
        assert_eq!(spell_language("", "", "fr"), "fr");
    }
}
