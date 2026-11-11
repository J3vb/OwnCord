package db

import (
	"errors"
	"strings"
)

var (
	// ErrAccountErasing is returned when a session or message cannot be written because
	// the account's deletion is being completed.
	ErrAccountErasing = errors.New("account deletion in progress")

	// ErrNotFound indicates the requested resource does not exist.
	ErrNotFound = errors.New("not found")
	// ErrReactionLimit means a new emoji was refused because the message already holds
	// MaxDistinctReactions.
	ErrReactionLimit = errors.New("reaction limit reached")

	// ErrForbidden indicates the caller lacks permission for the operation.
	ErrForbidden = errors.New("forbidden")

	// ErrConflict indicates a uniqueness constraint violation (e.g., duplicate username).
	ErrConflict = errors.New("conflict")

	// ErrBanned indicates the user is banned.
	ErrBanned = errors.New("banned")

	// ErrLastAdmin indicates the operation was rejected because the user is the only remaining
	// admin/owner.
	ErrLastAdmin = errors.New("last admin cannot be deleted")

	// ErrSelfReview indicates the acting moderator took the action under review and
	// another eligible moderator exists. AssignAppealTx and forceReassignGuarded's
	// appeal path check it fresh in their transaction, as DecideAppealTx does.
	ErrSelfReview = errors.New("self-review")
)

// IsUniqueConstraintError reports whether err is a SQLite UNIQUE constraint violation.
func IsUniqueConstraintError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint")
}
