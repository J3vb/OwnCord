package service

import (
	"strings"
	"testing"
)

// TestSanitizeContent_PlainTextRoundTrip proves that plain-text punctuation
// survives sanitizeContent unchanged instead of coming back HTML-escaped.
// bluemonday's StrictPolicy writes text tokens through html.EscapeString, so
// without an outer html.UnescapeString, a stored/broadcast message would show
// literal &#39;/&gt;/&#34;/&amp; entities to every client — and a quoted line
// would no longer start with the literal ">" the markdown blockquote regex
// requires.
func TestSanitizeContent_PlainTextRoundTrip(t *testing.T) {
	cases := []string{
		`don't > quote "this" & that`,
		`a & b`,
		`5 > 3 && 2 < 4`,
		`> quoted`,
	}
	for _, in := range cases {
		out, err := sanitizeContent(in, false)
		if err != nil {
			t.Fatalf("sanitizeContent(%q) unexpected error: %v", in, err)
		}
		if out != in {
			t.Fatalf("sanitizeContent(%q) = %q, want unchanged plain text", in, out)
		}
	}
}

// TestSanitizeContent_EntitySmugglingBlocked is the security regression test
// for the inner html.UnescapeString: an attacker can encode markup as HTML
// entities so it reaches bluemonday as inert text (which StrictPolicy would
// leave alone), then rely on a naive outer-only unescape to turn it into live
// markup after sanitization. Unescaping BEFORE sanitizing means bluemonday
// sees real markup and strips it, so the smuggled payload must not survive as
// an active <script>/<img>/on-event sink.
func TestSanitizeContent_EntitySmugglingBlocked(t *testing.T) {
	cases := []string{
		"&lt;script&gt;alert(1)&lt;/script&gt;",
		"&lt;img src=x onerror=alert(1)&gt;",
		"&amp;lt;script&amp;gt;",
	}
	for _, in := range cases {
		// allowEmpty=true: some of these payloads sanitize down to nothing
		// (the whole point — the tag and its content are stripped), which is
		// not itself a failure.
		out, err := sanitizeContent(in, true)
		if err != nil {
			t.Fatalf("sanitizeContent(%q) unexpected error: %v", in, err)
		}
		lower := strings.ToLower(out)
		if strings.Contains(lower, "<script") {
			t.Fatalf("sanitizeContent(%q) = %q: live <script> sink survived", in, out)
		}
		if strings.Contains(lower, "<img") {
			t.Fatalf("sanitizeContent(%q) = %q: live <img> sink survived", in, out)
		}
		if strings.Contains(lower, "onerror=") {
			t.Fatalf("sanitizeContent(%q) = %q: live on-event attribute survived", in, out)
		}
	}
}
