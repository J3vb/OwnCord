package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// UpdateUserProfile updates the username, avatar, display name and about text
// for the given user. All four are written unconditionally, so the caller is
// responsible for merging a partial PATCH against the current row.
// Returns ErrNotFound if the user does not exist. Returns an error wrapping
// a UNIQUE constraint violation if the username is already taken.
func (d *DB) UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about *string) error {
	result, err := d.q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		Username:    username,
		Avatar:      avatar,
		DisplayName: displayName,
		About:       about,
		ID:          userID,
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

// UpdateUserCustomStatus sets (or clears, with nil) the user's custom status
// line. Kept separate from UpdateUserProfile because it arrives on the
// presence path and must not overwrite a concurrent profile edit.
func (d *DB) UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error {
	if err := d.q.UpdateUserCustomStatus(ctx, dbgen.UpdateUserCustomStatusParams{
		CustomStatus: customStatus,
		ID:           userID,
	}); err != nil {
		return fmt.Errorf("UpdateUserCustomStatus: %w", err)
	}
	return nil
}

// IsAvatarFileURL reports whether url is currently some user's avatar. It is
// the authorization check that lets an uploaded avatar — an attachment with no
// channel, and therefore private to its uploader by default — be served to
// every authenticated user for exactly as long as it is in use.
func (d *DB) IsAvatarFileURL(ctx context.Context, url string) (bool, error) {
	n, err := d.q.CountUsersWithAvatar(ctx, &url)
	if err != nil {
		return false, fmt.Errorf("IsAvatarFileURL: %w", err)
	}
	return n > 0, nil
}

// UpdateUserPassword sets a new password hash for the given user.
func (d *DB) UpdateUserPassword(ctx context.Context, userID int64, newPasswordHash string) error {
	if err := d.q.UpdateUserPassword(ctx, dbgen.UpdateUserPasswordParams{
		Password: newPasswordHash,
		ID:       userID,
	}); err != nil {
		return fmt.Errorf("UpdateUserPassword: %w", err)
	}
	return nil
}

// ListUserSessions returns all sessions for the given user in a single query.
// Results are ordered by created_at descending (newest first).
func (d *DB) ListUserSessions(ctx context.Context, userID int64) ([]Session, error) {
	rows, err := d.q.ListUserSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("ListUserSessions: %w", err)
	}
	sessions := make([]Session, 0, len(rows))
	for _, s := range rows {
		sessions = append(sessions, sessionFromGen(s))
	}
	return sessions, nil
}

// MarkSessionsSeen acknowledges the account's new logins (B4-7): every
// session's unseen flag clears except the caller's own, since a listing from
// another device is what "seen" means. Returns how many rows changed.
func (d *DB) MarkSessionsSeen(ctx context.Context, userID, exceptSessionID int64) (int64, error) {
	res, err := d.q.MarkSessionsSeen(ctx, dbgen.MarkSessionsSeenParams{
		UserID: userID,
		ID:     exceptSessionID,
	})
	if err != nil {
		return 0, fmt.Errorf("MarkSessionsSeen: %w", err)
	}
	return res.RowsAffected()
}

// DeleteSessionByID removes a session by its ID, but only if it belongs to
// the specified user. Returns ErrNotFound if the session does not exist or
// does not belong to the user.
func (d *DB) DeleteSessionByID(ctx context.Context, sessionID, userID int64) error {
	result, err := d.q.DeleteSessionByID(ctx, dbgen.DeleteSessionByIDParams{
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

// DeleteUserSessions removes every session of the user — the caller's own
// included — and reports how many went. Sign-out-everywhere (B4-7).
func (d *DB) DeleteUserSessions(ctx context.Context, userID int64) (int64, error) {
	result, err := d.q.DeleteUserSessions(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("DeleteUserSessions: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("DeleteUserSessions rows: %w", err)
	}
	return rows, nil
}
