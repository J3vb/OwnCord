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
// The check is deliberately tag-scoped rather than a bare `\bon\w+\s*=`
// substring match, but it is scoped to a *tag-like* start specifically —
// `<` immediately followed by a letter or '/' — not just any `<`.
// sanitizeContent now unescapes bluemonday's output, so a literal '<' CAN
// survive into `out` as plain text a user actually typed (e.g. "5 > 3 && 2
// < 4" round-trips unchanged). But sanitizeToFixpoint reruns
// unescape-sanitize-unescape until the result stops changing, and a '<'
// followed by a letter (start-tag open) or '/' (end-tag open) is exactly
// the shape bluemonday's tokenizer treats as real markup and strips on the
// next pass — so that adjacency can never be present at a fixpoint. A '<'
// followed by anything else (space, digit, punctuation) isn't a tag
// production at all and is genuinely inert (e.g. a message that reads "use
// onClick= to bind a handler", or "on0=", confirmed via fuzzing to
// round-trip unexploitably) — not a live attribute, so requiring the
// tag-like start is what actually distinguishes "typed the word onclick="
// from "smuggled a live onclick attribute", now that plain '<' is no longer
// itself proof of nothing dangerous.
var onEventAttr = regexp.MustCompile(`(?i)<[a-z/][^>]*\bon\w+\s*=`)

// jsURLInTag matches a javascript: (or similar) pseudo-scheme living inside
// an actual surviving tag's attribute — the only shape that is an active
// sink. Like onEventAttr, this requires a tag-like start ('<' followed by a
// letter or '/'), not just any '<': since sanitizeContent's outer unescape
// can now leave a literal '<' in inert plain text, a bare '<[^>]*' scope
// would false-positive on typed text like "5 < 10, javascript:void(0)".
// sanitizeToFixpoint's repeated unescape-sanitize-unescape passes guarantee
// a '<' immediately followed by a letter or '/' cannot survive — that shape
// is real markup to bluemonday's tokenizer and gets stripped on the next
// pass — so this pattern only matches the still-impossible live-tag case.
// Fuzzing confirmed the bare-substring version false-positives on plain
// text (seed "jAvAsCript:0"), and the client's own markdown renderer
// independently refuses to autolink a javascript: pseudo-URL (see
// Client/tests/unit/content-markdown.test.ts, "does not autolink a
// javascript: pseudo-URL"), so plain-text "javascript:" is not exploitable
// through any known rendering path.
var jsURLInTag = regexp.MustCompile(`(?i)<[a-z/][^>]*\bjavascript:`)

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
		"\u200b\u200c\u200dzero-width",
		"\u202ereversed bidi text\u202c",
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
