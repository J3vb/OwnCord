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

// ValidateUsername checks that a (pre-trimmed) username meets naming rules:
//   - Length 2-32 runes (after trim)
//   - Only printable characters (no control chars, no zero-width chars)
//   - Not inside the "[deleted-…]" / "[denied-…]" / "[imported…]" namespaces reserved for anonymised rows and the hidden import account
//
// Returns a descriptive error on failure, nil on success.
func ValidateUsername(username string) error {
	username = strings.TrimSpace(username)
	// Account deletion once anonymised the row by renaming it to
	// "[deleted-<id>]" (random suffixes on collision), and older databases still
	// hold such rows. users.username is UNIQUE COLLATE NOCASE, so the whole
	// namespace stays reserved rather than letting a registration impersonate a
	// deleted account's marker. Erasure (db.EraseAccount) deletes the row.
	// "[denied-<id>]" is the same shape for a refused approval-mode application
	// (db.DenyPendingUser), reserved for the same reason.
	// "[imported]" (and "[imported-…]") is the hidden account that owns imported
	// Discord history; a registration must not take its name first.
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
// temporary ban expiry: u.Banned is true and u.BanExpires is nil (permanent) or
// in the future. A nil u returns false; an unparseable BanExpires is treated as
// an active ban (fail-safe: keep the user blocked).
func IsEffectivelyBanned(u *db.User) bool {
	if u == nil || !u.Banned {
		return false
	}
	// Permanent ban — no expiry set.
	if u.BanExpires == nil {
		return true
	}
	// Temporary ban — parse the expiry and compare to now.
	t, ok := dbtime.Parse(*u.BanExpires)
	if !ok {
		// Unparseable expiry — fail-safe: treat as still banned.
		return true
	}
	// Ban is still active if expiry is in the future.
	return time.Now().UTC().Before(t.UTC())
}

// IsSessionExpired reports whether the expiresAt timestamp string represents a
// time in the past, in either stored layout (dbtime.Parse). Any string that
// cannot be parsed is treated as expired for safety.
func IsSessionExpired(expiresAt string) bool {
	t, ok := dbtime.Parse(expiresAt)
	if !ok {
		// Unparseable expiry — treat as expired for safety.
		return true
	}
	return time.Now().UTC().After(t.UTC())
}
