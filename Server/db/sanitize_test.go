package db

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSanitizeFTSQuery_UTF8Truncation(t *testing.T) {
	// BUG-090: sanitizeFTSQuery truncates at byte boundary, producing
	// invalid UTF-8 when the input contains multi-byte runes (CJK, emoji).

	// Build a 210-rune CJK string. Each CJK rune is 3 bytes → 630 bytes.
	input := strings.Repeat("漢", 210)

	got := sanitizeFTSQuery(input)

	if !utf8.ValidString(got) {
		t.Fatal("sanitizeFTSQuery produced invalid UTF-8 after truncation")
	}

	runeCount := utf8.RuneCountInString(got)
	if runeCount > 200 {
		t.Fatalf("expected at most 200 runes, got %d", runeCount)
	}
	if runeCount != 200 {
		t.Fatalf("expected exactly 200 runes for 210-rune input, got %d", runeCount)
	}
}

func TestSanitizeFTSQuery_ASCIIUnchanged(t *testing.T) {
	// ASCII-only input under 200 chars should pass through unchanged.
	input := "hello world search query"
	got := sanitizeFTSQuery(input)
	if got != input {
		t.Errorf("expected %q, got %q", input, got)
	}
}

func TestSanitizeFTSQuery_StripsOperators(t *testing.T) {
	input := `hello "world" AND (test) NOT foo*`
	got := sanitizeFTSQuery(input)
	// Should only contain letters, digits, spaces, hyphens.
	for _, r := range got {
		if r == '"' || r == '(' || r == ')' || r == '*' {
			t.Errorf("operator character %q not stripped", r)
		}
	}
}
