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
		"zero\u200bwidth",    // ZERO WIDTH SPACE (Cf)
		"bidi\u202eoverride", // RIGHT-TO-LEFT OVERRIDE (Cf)
		"emoji😀name",
		"日本語ユーザー",
		"\u00a0nbsp\u00a0",
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

// FuzzValidateNewUsername checks the strict register/rename check: whatever it
// accepts also passes the loose check, starts with a letter or digit, holds no
// space, is not a reserved mention name, and never has three marks in a row.
func FuzzValidateNewUsername(f *testing.F) {
	for _, s := range []string{"", "ab", "Je\u0301ro\u0302me", "a_b.c-d", "名前", "everyone", "HERE", "ae\u0301\u0302\u0303", "a b", "_ab", "ab😀"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, username string) {
		if ValidateNewUsername(username) != nil {
			return
		}
		if err := ValidateUsername(username); err != nil {
			t.Fatalf("ValidateNewUsername(%q) = nil, but the loose check fails: %v", username, err)
		}
		trimmed := strings.TrimSpace(username)
		for _, reserved := range reservedUsernames {
			if strings.EqualFold(trimmed, reserved) {
				t.Fatalf("ValidateNewUsername(%q) = nil, but %q is reserved", username, reserved)
			}
		}
		runes := []rune(trimmed)
		if first := runes[0]; !unicode.IsLetter(first) && !unicode.IsDigit(first) {
			t.Fatalf("ValidateNewUsername(%q) = nil, but starts with %q", username, first)
		}
		run := 0
		for _, r := range runes {
			if unicode.IsSpace(r) {
				t.Fatalf("ValidateNewUsername(%q) = nil, but contains a space", username)
			}
			if unicode.In(r, unicode.Mn, unicode.Mc) {
				if run++; run > maxCombiningRun {
					t.Fatalf("ValidateNewUsername(%q) = nil, but stacks %d marks", username, run)
				}
			} else {
				run = 0
			}
		}
	})
}

// FuzzValidateVisibleText checks that accepted text holds no control or
// invisible character other than an emoji-joining ZWJ, and no mark stack
// beyond the cap; and that CollapseSpaces output has no double space.
func FuzzValidateVisibleText(f *testing.F) {
	for _, s := range []string{"", "hi", "a\nb", "a\u200bb", "\U0001F468\u200d\U0001F469", "e\u0301\u0302\u0303", "a  b"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if c := CollapseSpaces(s); strings.Contains(c, "  ") || strings.HasPrefix(c, " ") || strings.HasSuffix(c, " ") {
			t.Fatalf("CollapseSpaces(%q) = %q, still has doubled or edge spaces", s, c)
		}
		if ValidateVisibleText(s) != nil {
			return
		}
		run := 0
		for _, r := range s {
			if unicode.IsControl(r) {
				t.Fatalf("ValidateVisibleText(%q) = nil, but contains control rune %q", s, r)
			}
			if unicode.In(r, unicode.Cf) && r != zwj {
				t.Fatalf("ValidateVisibleText(%q) = nil, but contains Cf rune %q", s, r)
			}
			if unicode.In(r, unicode.Mn, unicode.Me) {
				if run++; run > maxCombiningRun {
					t.Fatalf("ValidateVisibleText(%q) = nil, but stacks %d marks", s, run)
				}
			} else {
				run = 0
			}
		}
	})
}
