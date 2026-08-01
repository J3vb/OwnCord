package api

import (
	"net/url"
	"strings"
	"testing"
	"unicode"
)

// FuzzValidateAvatarURL checks validateAvatarURL against the rule its doc
// comment states: avatar must be either empty, or a URL no longer than
// maxAvatarURLLen characters that parses with scheme "https" and a non-empty
// host. This is the prime target for an active-content escape — an accepted
// "avatar" URL that is actually javascript:, data:, or otherwise not a real
// https:// origin would let a client render/execute it wherever avatars are
// displayed.
func FuzzValidateAvatarURL(f *testing.F) {
	seeds := []string{
		"",
		"https://example.com/avatar.png",
		"https://example.com",
		"http://example.com/avatar.png",
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"data:image/png;base64,iVBORw0KGgo=",
		"vbscript:msgbox(1)",
		"https://",
		"https:///avatar.png",
		"https:example.com",
		"  https://example.com/avatar.png",
		"https://example.com/avatar.png  ",
		"//example.com/avatar.png",
		"file:///etc/passwd",
		"https://user:pass@example.com/avatar.png",
		"https://例え.com/avatar.png",
		strings.Repeat("a", 600),
		"https://" + strings.Repeat("a", 600) + ".com/x.png",
		"https:// evil.com",
		"ht!tp://bad url",
		"https:\t//example.com",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, avatar string) {
		err := validateAvatarURL(avatar)
		if err != nil {
			return
		}
		if avatar == "" {
			return
		}
		if len(avatar) > maxAvatarURLLen {
			t.Fatalf("validateAvatarURL(%q) = nil, but length %d exceeds maxAvatarURLLen %d", avatar, len(avatar), maxAvatarURLLen)
		}
		parsed, perr := url.Parse(avatar)
		if perr != nil {
			t.Fatalf("validateAvatarURL(%q) = nil, but url.Parse fails: %v", avatar, perr)
		}
		if parsed.Scheme != "https" {
			t.Fatalf("validateAvatarURL(%q) = nil, but parsed scheme is %q, not https (active-content/off-scheme escape)", avatar, parsed.Scheme)
		}
		if parsed.Host == "" {
			t.Fatalf("validateAvatarURL(%q) = nil, but parsed host is empty", avatar)
		}
	})
}

// FuzzValidateDisplayName checks validateDisplayName against the rule its
// doc comment states: no control characters and no invisible (Cf) formatting
// characters, since a display name renders wherever a username does and a
// bidi override or control character there is a spoofing vector.
func FuzzValidateDisplayName(f *testing.F) {
	seeds := []string{
		"",
		"Normal Name",
		"emoji😀name",
		"日本語",
		"name\x00null",
		"name\ttab",
		"name\nnewline",
		"zero\u200bwidth", // ZERO WIDTH SPACE
		"bidi\u202eoverride",
		"\u202ereversed\u202c",
		strings.Repeat("a", 1000),
		"\u200bname\u200b",
		"\u202eevil\u202c",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, name string) {
		err := validateDisplayName(name)
		if err != nil {
			return
		}
		for _, r := range name {
			if unicode.IsControl(r) {
				t.Fatalf("validateDisplayName(%q) = nil, but contains control rune %q", name, r)
			}
			if unicode.In(r, unicode.Cf) {
				t.Fatalf("validateDisplayName(%q) = nil, but contains invisible (Cf) rune %q", name, r)
			}
		}
	})
}
