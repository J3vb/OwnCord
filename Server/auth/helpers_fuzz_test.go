package auth

import (
	"strings"
	"testing"
	"unicode"
)

// FuzzValidateUsername checks ValidateUsername against the rules its own doc
// comment states: length 2-32 runes after trim, no control characters, no
// zero-width/invisible (Cf) characters, and never inside the reserved
// "[deleted-…]" namespace (case-insensitively). On success (err == nil) every
// one of those must hold for the *original* input (ValidateUsername trims
// internally but the caller passes the raw string).
func FuzzValidateUsername(f *testing.F) {
	seeds := []string{
		"",
		"a",
		"ab",
		strings.Repeat("a", 32),
		strings.Repeat("a", 33),
		strings.Repeat("a", 2),
		"  ab  ",
		"[deleted-123]",
		"[DELETED-123]",
		"[deleted-]",
		"[deleted-abc]",
		" [deleted-1] ",
		"normal_user",
		"user\x00name",
		"user\tname",
		"user\nname",
		"zero​width",    // ZERO WIDTH SPACE (Cf)
		"bidi‮override", // RIGHT-TO-LEFT OVERRIDE (Cf)
		"emoji😀name",
		"日本語ユーザー",
		" nbsp ",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, username string) {
		err := ValidateUsername(username)
		if err != nil {
			return
		}

		trimmed := strings.TrimSpace(username)
		n := len([]rune(trimmed))
		if n < minUsernameLength || n > maxUsernameLength {
			t.Fatalf("ValidateUsername(%q) = nil, but trimmed length %d outside [%d,%d]", username, n, minUsernameLength, maxUsernameLength)
		}

		if lower := strings.ToLower(trimmed); strings.HasPrefix(lower, "[deleted-") && strings.HasSuffix(lower, "]") {
			t.Fatalf("ValidateUsername(%q) = nil, but trimmed form %q is in the reserved [deleted-…] namespace", username, trimmed)
		}

		for _, r := range trimmed {
			if unicode.IsControl(r) {
				t.Fatalf("ValidateUsername(%q) = nil, but trimmed form contains control rune %q", username, r)
			}
			if unicode.In(r, unicode.Cf) {
				t.Fatalf("ValidateUsername(%q) = nil, but trimmed form contains invisible (Cf) rune %q", username, r)
			}
		}
	})
}
