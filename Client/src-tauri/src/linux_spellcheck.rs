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
/// the languages from the locale environment (`LANGUAGE`, `LC_ALL`,
/// `LC_MESSAGES`, `LANG`).
pub fn enable_spell_checking(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("linux_spellcheck: main window not found; spell checking stays off");
        return;
    };
    let env = |name| std::env::var(name).unwrap_or_default();
    let langs = spell_languages(
        &env("LANGUAGE"),
        &env("LC_ALL"),
        &env("LC_MESSAGES"),
        &env("LANG"),
    );
    let result = window.with_webview(move |webview| {
        use webkit2gtk::{WebContextExt, WebViewExt};

        let webview = webview.inner();
        match webview.context() {
            Some(ctx) => {
                ctx.set_spell_checking_enabled(true);
                let refs: Vec<&str> = langs.iter().map(String::as_str).collect();
                ctx.set_spell_checking_languages(&refs);
                log::info!(
                    "linux_spellcheck: spell checking enabled ({})",
                    refs.join(", ")
                );
            }
            None => log::warn!("linux_spellcheck: webview has no web context"),
        }
    });
    if let Err(e) = result {
        log::warn!("linux_spellcheck: failed to configure spell checking: {e}");
    }
}

/// The spell-check languages in GNU gettext order: the colon-separated
/// `LANGUAGE` list first, then the locale from [`spell_language`], without
/// duplicates. As in gettext, `LANGUAGE` is ignored when the locale is `C` or
/// `POSIX` (the result is then `en_US` alone).
pub fn spell_languages(language: &str, lc_all: &str, lc_messages: &str, lang: &str) -> Vec<String> {
    let locale = spell_language(lc_all, lc_messages, lang);
    let locale_is_c = [lc_all, lc_messages, lang]
        .into_iter()
        .find(|v| !v.is_empty())
        .is_none_or(|v| strip_locale(v).is_empty() || matches!(strip_locale(v), "C" | "POSIX"));
    let mut out: Vec<String> = Vec::new();
    if !locale_is_c {
        for entry in language.split(':').map(strip_locale) {
            if !entry.is_empty()
                && entry != "C"
                && entry != "POSIX"
                && !out.iter().any(|l| l == entry)
            {
                out.push(entry.to_string());
            }
        }
    }
    if !out.contains(&locale) {
        out.push(locale);
    }
    out
}

fn strip_locale(raw: &str) -> &str {
    &raw[..raw.find(['.', '@']).unwrap_or(raw.len())]
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
    let base = strip_locale(raw);
    if base.is_empty() || base == "C" || base == "POSIX" {
        return "en_US".to_string();
    }
    base.to_string()
}

#[cfg(test)]
mod tests {
    use super::{spell_language, spell_languages};

    #[test]
    fn spell_languages_language_list_comes_first() {
        assert_eq!(
            spell_languages("fr_FR:en", "", "", "en_US.UTF-8"),
            ["fr_FR", "en", "en_US"]
        );
    }

    #[test]
    fn spell_languages_without_language_is_the_locale() {
        assert_eq!(spell_languages("", "", "", "nl_BE.UTF-8"), ["nl_BE"]);
    }

    #[test]
    fn spell_languages_drops_duplicates_and_empty_entries() {
        assert_eq!(
            spell_languages("nl_BE.UTF-8::nl_BE", "", "", "nl_BE.UTF-8"),
            ["nl_BE"]
        );
    }

    #[test]
    fn spell_languages_ignores_language_under_a_c_locale() {
        assert_eq!(spell_languages("fr_FR:en", "", "", "C.UTF-8"), ["en_US"]);
        assert_eq!(spell_languages("fr_FR", "", "", ""), ["en_US"]);
    }

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
