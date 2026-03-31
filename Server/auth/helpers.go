package auth

import (
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/owncord/server/db"
)

// ValidateUsername checks that a (pre-trimmed) username meets naming rules:
//   - Length 2-32 runes (after trim)
//   - Only printable characters (no control chars, no zero-width chars)
//
// Returns a descriptive error on failure, nil on success.
func ValidateUsername(username string) error {
	username = strings.TrimSpace(username)
	n := len([]rune(username))
	if n < 2 {
		return fmt.Errorf("username must be at least 2 characters")
	}
	if n > 32 {
		return fmt.Errorf("username must be at most 32 characters")
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

// ExtractBearerToken parses the "Authorization: Bearer <token>" header from r
// and returns the token and true. Returns "", false if the header is absent,
// uses a scheme other than "bearer" (case-insensitive), or has an empty token.
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

// IsEffectivelyBanned reports whether u is currently banned, accounting for
// temporary ban expiry. A user is effectively banned when:
//   - u.Banned is true, AND
//   - u.BanExpires is nil (permanent ban), OR the expiry is in the future.
//
// If u is nil the function returns false without panicking.
// If BanExpires holds an unparseable string the ban is treated as active
// (fail-safe: keep user blocked rather than silently unblocking them).
func IsEffectivelyBanned(u *db.User) bool {
	if u == nil || !u.Banned {
		return false
	}
	// Permanent ban — no expiry set.
	if u.BanExpires == nil {
		return true
	}
	// Temporary ban — parse the expiry and compare to now.
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05Z"} {
		t, err := time.Parse(layout, *u.BanExpires)
		if err == nil {
			// Ban is still active if expiry is in the future.
			return time.Now().UTC().Before(t.UTC())
		}
	}
	// Unparseable expiry — fail-safe: treat as still banned.
	return true
}

// IsSessionExpired reports whether the expiresAt timestamp string represents a
// time in the past. It accepts both the SQLite space-separated format
// ("2006-01-02 15:04:05") and the ISO-8601 UTC format ("2006-01-02T15:04:05Z").
// Any string that cannot be parsed is treated as expired for safety.
func IsSessionExpired(expiresAt string) bool {
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05Z"} {
		t, err := time.Parse(layout, expiresAt)
		if err == nil {
			return time.Now().UTC().After(t.UTC())
		}
	}
	// Unparseable expiry — treat as expired for safety.
	return true
}
