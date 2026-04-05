package db

import (
	"fmt"
)

// UpdateUserProfile updates the username and avatar for the given user.
// Returns ErrNotFound if the user does not exist. Returns an error wrapping
// a UNIQUE constraint violation if the username is already taken.
func (d *DB) UpdateUserProfile(userID int64, username string, avatar *string) error {
	result, err := d.sqlDB.Exec(
		`UPDATE users SET username = ?, avatar = ? WHERE id = ?`,
		username, avatar, userID,
	)
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
	_, err := d.sqlDB.Exec(
		`UPDATE users SET password = ? WHERE id = ?`,
		newPasswordHash, userID,
	)
	if err != nil {
		return fmt.Errorf("UpdateUserPassword: %w", err)
	}
	return nil
}

// ListUserSessions returns all sessions for the given user in a single query.
// Results are ordered by created_at descending (newest first).
func (d *DB) ListUserSessions(userID int64) ([]Session, error) {
	rows, err := d.sqlDB.Query(
		`SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
		 FROM sessions
		 WHERE user_id = ?
		 ORDER BY created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("ListUserSessions: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var sessions []Session
	for rows.Next() {
		var s Session
		if err := rows.Scan(
			&s.ID, &s.UserID, &s.TokenHash, &s.Device, &s.IP,
			&s.CreatedAt, &s.LastUsed, &s.ExpiresAt,
		); err != nil {
			return nil, fmt.Errorf("ListUserSessions scan: %w", err)
		}
		sessions = append(sessions, s)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListUserSessions rows: %w", rows.Err())
	}
	if sessions == nil {
		sessions = []Session{}
	}
	return sessions, nil
}

// DeleteSessionByID removes a session by its ID, but only if it belongs to
// the specified user. Returns ErrNotFound if the session does not exist or
// does not belong to the user.
func (d *DB) DeleteSessionByID(sessionID, userID int64) error {
	result, err := d.sqlDB.Exec(
		`DELETE FROM sessions WHERE id = ? AND user_id = ?`,
		sessionID, userID,
	)
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
