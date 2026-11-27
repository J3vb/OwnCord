//! The text of a Linux desktop notification. The freedesktop notification
//! spec reads the body as markup when the server lists `body-markup` among its
//! capabilities, so message text must be escaped there to show as written.

/// The capability a notification server lists when it reads the body as
/// markup.
pub const BODY_MARKUP: &str = "body-markup";

/// Whether the body must be escaped for a server that answered
/// `GetCapabilities` with `capabilities`, or `None` when it did not answer.
/// Without an answer it is escaped: GNOME Shell, Plasma, dunst, mako and
/// xfce4-notifyd all read markup, and on a server that does not, an escaped
/// body only shows an entity where a raw one could show a link.
pub fn body_needs_escape<S: AsRef<str>>(capabilities: Option<&[S]>) -> bool {
    capabilities.is_none_or(|caps| caps.iter().any(|c| c.as_ref() == BODY_MARKUP))
}

/// `body` with `&`, `<` and `>` written as entities, so a markup-reading
/// server shows it as plain text.
pub fn escape_body_markup(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    for c in body.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_characters_are_written_as_entities() {
        assert_eq!(
            escape_body_markup(r#"<a href="https://x.example">Open</a>"#),
            r#"&lt;a href="https://x.example"&gt;Open&lt;/a&gt;"#
        );
        assert_eq!(escape_body_markup("fish & chips"), "fish &amp; chips");
        assert_eq!(escape_body_markup("&lt;"), "&amp;lt;");
        assert_eq!(
            escape_body_markup("plain text, ünïcode 🎉"),
            "plain text, ünïcode 🎉"
        );
        assert_eq!(escape_body_markup(""), "");
    }

    #[test]
    fn the_body_is_escaped_unless_the_server_says_it_reads_plain_text() {
        let markup = ["actions", "body", "body-markup", "persistence"];
        let plain = ["actions", "body"];
        let empty: [&str; 0] = [];
        assert!(body_needs_escape(Some(&markup[..])));
        assert!(!body_needs_escape(Some(&plain[..])));
        assert!(!body_needs_escape(Some(&empty[..])));
        assert!(body_needs_escape::<&str>(None), "no answer: escape");
    }
}
