package db

import (
	"errors"
	"strings"
)

// Sentinel errors for the db package. Use errors.Is() to check.
var (
	// ErrNotFound indicates the requested resource does not exist.
	ErrNotFound = errors.New("not found")

	// ErrForbidden indicates the caller lacks permission for the operation.
	ErrForbidden = errors.New("forbidden")

	// ErrConflict indicates a uniqueness constraint violation (e.g., duplicate username).
	ErrConflict = errors.New("conflict")

	// ErrBanned indicates the user is banned.
	ErrBanned = errors.New("banned")

	// ErrLastAdmin indicates the operation was rejected because the user is
	// the only remaining admin/owner and deleting them would leave the server
	// without an administrator.
	ErrLastAdmin = errors.New("last admin cannot be deleted")
)

// IsUniqueConstraintError reports whether err is a SQLite UNIQUE constraint
// violation. This centralizes the fragile string check so callers don't
// scatter strings.Contains calls throughout the codebase.
func IsUniqueConstraintError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint")
}
