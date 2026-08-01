package service

import (
	"strings"
	"testing"
)

// FuzzValidateShortcode checks that ValidateShortcode never panics and that
// any shortcode it accepts is idempotent under re-validation and matches its
// own documented shape (^[a-z0-9_]{2,32}$).
func FuzzValidateShortcode(f *testing.F) {
	seeds := []string{
		"",
		"wave",
		":wave:",
		"  :WAVE:  ",
		"a",
		"::",
		strings.Repeat("x", MaxShortcodeLen),
		strings.Repeat("x", MaxShortcodeLen+1),
		strings.Repeat("x", 10000),
		"has space",
		"dash-not-allowed",
		"dot.not.allowed",
		"emojié",
		"semi;colon",
		"wave:extra:",
		"</script>",
		"\x00\x00",
		":::::::",
		"UPPER_lower_0123",
		"\U0001F600\U0001F600",
		"\u202ewave\u202e",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, raw string) {
		got, err := ValidateShortcode(raw)
		if err != nil {
			if got != "" {
				t.Fatalf("ValidateShortcode(%q) returned non-empty shortcode %q alongside error %v", raw, got, err)
			}
			return
		}

		if !shortcodeRe.MatchString(got) {
			t.Fatalf("ValidateShortcode(%q) accepted %q, which does not match %s", raw, got, shortcodeRe.String())
		}

		// Idempotence: re-validating an already-canonical shortcode must
		// return it unchanged and must not suddenly start erroring.
		again, err2 := ValidateShortcode(got)
		if err2 != nil {
			t.Fatalf("ValidateShortcode(%q) succeeded but re-validating its own output %q failed: %v", raw, got, err2)
		}
		if again != got {
			t.Fatalf("ValidateShortcode is not idempotent: ValidateShortcode(%q) = %q, but ValidateShortcode(%q) = %q", raw, got, got, again)
		}
	})
}
