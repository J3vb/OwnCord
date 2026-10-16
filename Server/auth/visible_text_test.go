package auth_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

const (
	nfcE = "\u00e9"  // precomposed e-acute
	nfdE = "e\u0301" // e + combining acute
)

func TestValidateNewUsername(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		ok    bool
	}{
		{"nfc accented", "J" + nfcE + "r\u00f4me", true},
		{"nfd accented", "Je\u0301ro\u0302me", true},
		{"punctuation", "a_b.c-d", true},
		{"cjk", "名前", true},
		{"digits first", "1234abc", true},
		{"two marks", "e\u0301\u0302x", true},
		{"min length", "ab", true},
		{"max length", strings.Repeat("a", 32), true},
		{"hangul filler only", "\u3164\u3164", false},
		{"variation selector", "ada\ufe0f", false},
		{"grapheme joiner", "ada\u034f", false},
		{"mongolian selector", "ada\u180b", false},
		{"ideographic variation", "ada\U000e0100", false},
		{"space inside", "ab cd", false},
		{"emoji", "ab😀", false},
		{"leading underscore", "_abc", false},
		{"leading dot", ".abc", false},
		{"leading dash", "-abc", false},
		{"everyone", "everyone", false},
		{"EVERYONE", "EVERYONE", false},
		{"Here", "Here", false},
		{"three marks", "ae\u0301\u0302\u0303", false},
		{"mark after digit", "a1\u0301", false},
		{"mark after underscore", "a_\u0301b", false},
		{"length 1", "a", false},
		{"length 33", strings.Repeat("a", 33), false},
		{"zero width", "ab\u200bcd", false},
		{"deleted namespace", "[deleted-1]", false},
		{"at sign", "ab@cd", false},
		{"empty", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := auth.ValidateNewUsername(tc.input)
			if tc.ok && err != nil {
				t.Errorf("ValidateNewUsername(%q) = %v, want nil", tc.input, err)
			}
			if !tc.ok && err == nil {
				t.Errorf("ValidateNewUsername(%q) = nil, want error", tc.input)
			}
		})
	}
}

// The loose check login and recovery keep using must not have tightened.
func TestValidateUsername_StaysLoose(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"has space", "ab😀", "_abc", "everyone", "Here", "e\u0301\u0302\u0303̄x", "a.b"} {
		if err := auth.ValidateUsername(name); err != nil {
			t.Errorf("ValidateUsername(%q) = %v, want nil (loose check unchanged)", name, err)
		}
	}
	for _, name := range []string{"a", strings.Repeat("a", 33), "ab\u200bcd", "ab\ncd", "[denied-1]"} {
		if err := auth.ValidateUsername(name); err == nil {
			t.Errorf("ValidateUsername(%q) = nil, want error", name)
		}
	}
}

func TestValidateVisibleText(t *testing.T) {
	t.Parallel()
	family := "\U0001F468\u200d\U0001F469\u200d\U0001F467"
	tests := []struct {
		name  string
		input string
		ok    bool
	}{
		{"plain", "Hello there", true},
		{"empty", "", true},
		{"newline", "a\nb", false},
		{"tab", "a\tb", false},
		{"carriage return", "a\rb", false},
		{"rtl override", "a\u202eb", false},
		{"zero width space", "a\u200bb", false},
		{"emoji family zwj", family, true},
		{"heart fire zwj with selector", "❤\ufe0f\u200d\U0001F525", true},
		{"line separator", "a\u2028b", false},
		{"paragraph separator", "a\u2029b", false},
		{"hangul filler", "a\u3164b", false},
		{"combining grapheme joiner", "a\u034fb", false},
		{"mongolian selector", "a\u180bb", false},
		{"halfwidth hangul filler", "a\uffa0b", false},
		{"variation selector 17", "a\U000e0100b", false},
		{"text selector after letter", "a\ufe0eb", false},
		{"emoji selector after letter", "a\ufe0fb", false},
		{"fe00 after symbol", "\u2764\ufe00", false},
		{"heart with emoji selector", "\u2764\ufe0f", true},
		{"keycap one", "1\ufe0f\u20e3", true},
		{"keycap hash in text", "press #\ufe0f\u20e3 now", true},
		{"keycap selector without enclosing mark", "1\ufe0f", false},
		{"enclosing keycap after letter selector", "a\ufe0f\u20e3", false},
		{"heart fire", "\u2764\ufe0f\u200d\U0001F525", true},
		{"zwj between letters", "a\u200db", false},
		{"zwj at start", "\u200d\U0001F468", false},
		{"zwj at end", "\U0001F468\u200d", false},
		{"zalgo 3 marks", "e\u0301\u0302\u0303", false},
		{"two marks ok", "e\u0301\u0302", true},
		{"marks reset after base", "e\u0301\u0302e\u0301\u0302", true},
		{"nfc e-acute", nfcE, true},
		{"nfd e-acute", nfdE, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := auth.ValidateVisibleText(tc.input)
			if tc.ok && err != nil {
				t.Errorf("ValidateVisibleText(%q) = %v, want nil", tc.input, err)
			}
			if !tc.ok {
				if err == nil {
					t.Fatalf("ValidateVisibleText(%q) = nil, want error", tc.input)
				}
				if !errors.Is(err, auth.ErrVisibleText) {
					t.Errorf("error %v does not match ErrVisibleText", err)
				}
			}
		})
	}
}

func TestCollapseSpaces(t *testing.T) {
	t.Parallel()
	tests := []struct{ name, in, want string }{
		{"already clean", "a b", "a b"},
		{"run of spaces", "a    b", "a b"},
		{"trims ends", "  a b  ", "a b"},
		{"unicode spaces", "a\u00a0\u2003 b", "a b"},
		{"only spaces", "    ", ""},
		{"empty", "", ""},
		{"newline untouched", "a\nb", "a\nb"},
		{"tab untouched", "a\tb", "a\tb"},
		{"nfd untouched", "e\u0301  x", "e\u0301 x"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := auth.CollapseSpaces(tc.in); got != tc.want {
				t.Errorf("CollapseSpaces(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
