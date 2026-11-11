package auth

import (
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// ValidateUsername checks length (2-32 runes after trim), printable characters
// only, and the reserved "[deleted-…]" / "[denied-…]" / "[imported…]" names.
func ValidateUsername(username string) error {
	username = strings.TrimSpace(username)
	// Older databases still hold "[deleted-<id>]" rows, and "[denied-<id>]" marks a
	// refused application; the namespaces stay reserved so a registration cannot
	// impersonate them. "[imported…]" is the hidden account owning imported history.
	if lower := strings.ToLower(username); strings.HasSuffix(lower, "]") &&
		(strings.HasPrefix(lower, "[deleted-") || strings.HasPrefix(lower, "[denied-") || strings.HasPrefix(lower, "[imported")) {
		return fmt.Errorf("username is reserved")
	}
	n := len([]rune(username))
	if n < minUsernameLength {
		return fmt.Errorf("username must be at least %d characters", minUsernameLength)
	}
	if n > maxUsernameLength {
		return fmt.Errorf("username must be at most %d characters", maxUsernameLength)
	}
	for _, r := range username {
		if unicode.IsControl(r) {
			return fmt.Errorf("username must not contain control characters")
		}
		// Block zero-width and other invisible formatting characters.
		if unicode.In(r, unicode.Cf) {
			return fmt.Errorf("username must not contain invisible characters")
		}
	}
	return nil
}

// ExtractBearerToken returns the token from the "Authorization: Bearer" header,
// or "", false if it is absent, another scheme, or empty. The scheme is matched case-insensitively.
func ExtractBearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") || parts[1] == "" {
		return "", false
	}
	return strings.TrimSpace(parts[1]), true
}

// IsEffectivelyBanned reports whether u is banned and any expiry is still in
// the future. A nil u is false; an unparseable BanExpires counts as an active
// ban (fail-safe).
func IsEffectivelyBanned(u *db.User) bool {
	if u == nil || !u.Banned {
		return false
	}
	if u.BanExpires == nil {
		return true
	}
	t, ok := dbtime.Parse(*u.BanExpires)
	if !ok {
		return true
	}
	return time.Now().UTC().Before(t.UTC())
}

// IsSessionExpired reports whether expiresAt is in the past in either stored
// layout; an unparseable value is expired, for safety.
func IsSessionExpired(expiresAt string) bool {
	t, ok := dbtime.Parse(expiresAt)
	if !ok {
		return true
	}
	return time.Now().UTC().After(t.UTC())
}
