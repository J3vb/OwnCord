package auth

import (
	"strings"
	"testing"
)

// FuzzValidatePasswordStrength checks ValidatePasswordStrength against the
// rule its doc comment states: length (in bytes, since len() on a Go string
// is a byte count) between minPassLen and maxPassLen inclusive. On success
// (err == nil) that bound must hold for the exact input passed in.
func FuzzValidatePasswordStrength(f *testing.F) {
	seeds := []string{
		"",
		"a",
		strings.Repeat("a", minPassLen-1),
		strings.Repeat("a", minPassLen),
		strings.Repeat("a", maxPassLen),
		strings.Repeat("a", maxPassLen+1),
		strings.Repeat("a", maxPassLen*4),
		strings.Repeat("é", minPassLen), // multi-byte runes
		strings.Repeat("🔥", minPassLen), // 4-byte runes
		"password",
		"        ", // spaces only, exactly minPassLen
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, password string) {
		err := ValidatePasswordStrength(password)
		if err != nil {
			return
		}
		n := len(password)
		if n < minPassLen || n > maxPassLen {
			t.Fatalf("ValidatePasswordStrength(%q) = nil, but byte length %d outside [%d,%d]", password, n, minPassLen, maxPassLen)
		}
	})
}
