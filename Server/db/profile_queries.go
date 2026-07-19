package db

import (
	"fmt"

	"github.com/owncord/server/db/dbgen"
)

// UpdateUserProfile updates the username and avatar for the given user.
// Returns ErrNotFound if the user does not exist. Returns an error wrapping
// a UNIQUE constraint violation if the username is already taken.
func (d *DB) UpdateUserProfile(userID int64, username string, avatar *string) error {
	result, err := d.q.UpdateUserProfile(dbCtx(), dbgen.UpdateUserProfileParams{
		Username: username,
		Avatar:   avatar,
		ID:       userID,
	})
	if err != nil {
		return fmt.Errorf("UpdateUserProfile: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("UpdateUserProfile rows: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("UpdateUserProfile: %w", ErrNotFound)
	}
	return nil
}

// UpdateUserPassword sets a new password hash for the given user.
func (d *DB) UpdateUserPassword(userID int64, newPasswordHash string) error {
	if err := d.q.UpdateUserPassword(dbCtx(), dbgen.UpdateUserPasswordParams{
		Password: newPasswordHash,
		ID:       userID,
	}); err != nil {
		return fmt.Errorf("UpdateUserPassword: %w", err)
	}
	return nil
}

// ListUserSessions returns all sessions for the given user in a single query.
// Results are ordered by created_at descending (newest first).
func (d *DB) ListUserSessions(userID int64) ([]Session, error) {
	rows, err := d.q.ListUserSessions(dbCtx(), userID)
	if err != nil {
		return nil, fmt.Errorf("ListUserSessions: %w", err)
	}
	sessions := make([]Session, 0, len(rows))
	for _, s := range rows {
		sessions = append(sessions, sessionFromGen(s))
	}
	return sessions, nil
}

// DeleteSessionByID removes a session by its ID, but only if it belongs to
// the specified user. Returns ErrNotFound if the session does not exist or
// does not belong to the user.
func (d *DB) DeleteSessionByID(sessionID, userID int64) error {
	result, err := d.q.DeleteSessionByID(dbCtx(), dbgen.DeleteSessionByIDParams{
		ID:     sessionID,
		UserID: userID,
	})
	if err != nil {
		return fmt.Errorf("DeleteSessionByID: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("DeleteSessionByID rows: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("DeleteSessionByID: %w", ErrNotFound)
	}
	return nil
}
