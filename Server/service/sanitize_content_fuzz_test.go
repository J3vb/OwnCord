package service

import (
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

// onEventAttr matches an on-event handler attribute (onerror=, onload=, etc.)
// living inside an actual surviving tag, case-insensitively, tolerating
// whitespace around the '='.
//
// The check is deliberately tag-scoped (requires a preceding unclosed '<')
// rather than a bare `\bon\w+\s*=` substring match: bluemonday's
// StrictPolicy strips every tag, so the only way "onerror=" et al. can
// survive into `out` is as inert plain text a user actually typed (e.g. a
// message that reads "use onClick= to bind a handler") — that text renders
// as a text node, not as a live attribute, so it is not an active-content
// sink. A bare substring match flags that benign case as a false positive
// (confirmed via fuzzing: seed "on0=" round-trips unchanged through
// sanitizeContent and is not exploitable). Requiring tag context is what
// actually distinguishes "typed the word onclick=" from "smuggled a live
// onclick attribute".
var onEventAttr = regexp.MustCompile(`(?i)<[^>]*\bon\w+\s*=`)

// jsURLInTag matches a javascript: (or similar) pseudo-scheme living inside
// an actual surviving tag's attribute — the only shape that is an active
// sink. Like onEventAttr, this is tag-scoped rather than a bare substring
// match: bluemonday's StrictPolicy strips every tag (and HTML-escapes any
// stray '<'), so "javascript:" surviving into `out` at all means it arrived
// as inert plain text (e.g. a message that reads "the demo used
// javascript:void(0) links") — not as a live href. Fuzzing confirmed the
// bare-substring version false-positives on exactly that case (seed
// "jAvAsCript:0"), and the client's own markdown renderer independently
// refuses to autolink a javascript: pseudo-URL (see
// tauri-client/tests/unit/content-markdown.test.ts, "does not autolink a
// javascript: pseudo-URL"), so plain-text "javascript:" is not exploitable
// through any known rendering path.
var jsURLInTag = regexp.MustCompile(`(?i)<[^>]*\bjavascript:`)

// FuzzSanitizeContent hammers sanitizeContent with untrusted message content
// looking for a case where the "strip everything" bluemonday policy still
// lets an active-content sink survive (a real XSS in every client that
// renders message content), or where the length/idempotency contract the
// function documents (implicitly, via maxMessageLen and repeated calls in
// the edit path) breaks.
func FuzzSanitizeContent(f *testing.F) {
	seeds := []string{
		"",
		"hello world",
		"<script>alert(1)</script>",
		"<SCRIPT>alert(1)</SCRIPT>",
		"<scr<script>ipt>alert(1)</scr</script>ipt>",
		`<img src=x onerror="alert(1)">`,
		`<img src=x OnError = alert(1)>`,
		`<a href="javascript:alert(1)">click</a>`,
		`<a href="JaVaScRiPt:alert(1)">click</a>`,
		`<a href="  javascript:alert(1)">click</a>`,
		`<div onclick=alert(1)>hi</div>`,
		`<svg onload=alert(1)>`,
		`<body onload=alert(1)>`,
		"<iframe src=javascript:alert(1)></iframe>",
		"plain <b>bold</b> and <i>italic</i>",
		strings.Repeat("a", maxMessageLen*4-1),
		strings.Repeat("a", maxMessageLen*4+1),
		strings.Repeat("é", maxMessageLen+10),
		"​‌‍zero-width",
		"‮reversed bidi text‬",
		"<<script>script>alert(1)<</script>/script>",
		"&lt;script&gt;alert(1)&lt;/script&gt;",
		"<script src=//evil.example/x.js></script>",
		"\x00\x01\x02 control chars",
		"line1\nline2\r\nline3",
		strings.Repeat("<img onerror=alert(1) src=x>", 50),
	}
	for _, s := range seeds {
		f.Add(s, true)
		f.Add(s, false)
	}

	f.Fuzz(func(t *testing.T, raw string, allowEmpty bool) {
		out, err := sanitizeContent(raw, allowEmpty)
		if err != nil {
			// sanitizeContent may legitimately reject input (too long, or
			// empty when not allowed); nothing further to check.
			return
		}

		lower := strings.ToLower(out)
		if strings.Contains(lower, "<script") {
			t.Fatalf("sanitizeContent(%q, %v) = %q: contains an active <script sink", raw, allowEmpty, out)
		}
		if jsURLInTag.MatchString(out) {
			t.Fatalf("sanitizeContent(%q, %v) = %q: contains a javascript: URL sink inside a surviving tag", raw, allowEmpty, out)
		}
		if onEventAttr.MatchString(out) {
			t.Fatalf("sanitizeContent(%q, %v) = %q: contains an on-event handler attribute", raw, allowEmpty, out)
		}
		if n := utf8.RuneCountInString(out); n > maxMessageLen {
			t.Fatalf("sanitizeContent(%q, %v) = %q: %d runes exceeds maxMessageLen %d", raw, allowEmpty, out, n, maxMessageLen)
		}

		// Idempotency: re-sanitizing already-sanitized output must be a
		// no-op. allowEmpty=true so a legitimately-empty `out` doesn't
		// spuriously error on the second pass.
		out2, err2 := sanitizeContent(out, true)
		if err2 != nil {
			t.Fatalf("sanitizeContent(%q, %v) = %q, but re-sanitizing it failed: %v", raw, allowEmpty, out, err2)
		}
		if out2 != out {
			t.Fatalf("sanitizeContent not idempotent: sanitizeContent(%q,true) = %q, sanitizing that again gave %q", raw, out, out2)
		}
	})
}
