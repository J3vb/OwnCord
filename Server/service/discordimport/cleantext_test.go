package discordimport

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestCleanTextLongNestedEntitiesIsBounded(t *testing.T) {
	t.Parallel()
	in := "&" + strings.Repeat("amp;", 200000)
	start := time.Now()
	got := cleanText(in, 100, "fb")
	if d := time.Since(start); d > time.Second {
		t.Fatalf("cleanText took %v", d)
	}
	if n := utf8.RuneCountInString(got); n > 100 || n == 0 {
		t.Fatalf("rune count = %d", n)
	}
}

func TestCleanTextCutInsideMultiByteRuneIsValid(t *testing.T) {
	t.Parallel()
	// 3-byte runes with max 2 give an 8-byte cut that lands mid-rune.
	got := cleanText(strings.Repeat("€", 50), 2, "fb")
	if !utf8.ValidString(got) || got != "€€" {
		t.Fatalf("got %q", got)
	}
}

func TestCleanTextFallbackAndShortUnchanged(t *testing.T) {
	t.Parallel()
	if got := cleanText("   ", 10, "fb"); got != "fb" {
		t.Fatalf("got %q", got)
	}
	if got := cleanText("general", 10, "fb"); got != "general" {
		t.Fatalf("got %q", got)
	}
}
