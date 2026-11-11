package db

import (
	"errors"
	"strings"
)

var (
	// ErrAccountErasing is returned when a session or message cannot be written because
	// the account's deletion is being completed.
	ErrAccountErasing = errors.New("account deletion in progress")

	ErrNotFound = errors.New("not found")
	// ErrReactionLimit means a new emoji was refused because the message already holds
	// MaxDistinctReactions.
	ErrReactionLimit = errors.New("reaction limit reached")

	ErrForbidden = errors.New("forbidden")

	ErrConflict = errors.New("conflict")

	ErrBanned = errors.New("banned")

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
