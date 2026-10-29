package db

import (
	"errors"
	"strings"
)

// Sentinel errors for the db package. Use errors.Is() to check.
var (
	// ErrAccountErasing is returned when a session or a message cannot be
	// written because the account's deletion is being completed.
	ErrAccountErasing = errors.New("account deletion in progress")

	// ErrNotFound indicates the requested resource does not exist.
	ErrNotFound = errors.New("not found")
	// ErrReactionLimit means a new emoji was refused because the message already
	// holds MaxDistinctReactions different ones.
	ErrReactionLimit = errors.New("reaction limit reached")

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

	// ErrSelfReview indicates the acting moderator took the action under
	// review and another eligible moderator exists (the
	// deciding-moderator rule). AssignAppealTx and
	// forceReassignGuarded's appeal path both check this fresh, inside
	// their own transaction, the same way DecideAppealTx's
	// AppealWriteSelfReview already does.
	ErrSelfReview = errors.New("self-review")
)

// IsUniqueConstraintError reports whether err is a SQLite UNIQUE constraint
// violation. This centralizes the fragile string check so callers don't
// scatter strings.Contains calls throughout the codebase.
func IsUniqueConstraintError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint")
}
