package db

import "errors"

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
)
