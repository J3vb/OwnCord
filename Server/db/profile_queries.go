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

// UpdateUserPresence writes a presence_update's status and custom status line
// in one transaction, so the two commit together or not at all (P5-O08).
func (d *DB) UpdateUserPresence(ctx context.Context, userID int64, status string, customStatus *string) error {
	return d.inWriteTx(ctx, "UpdateUserPresence", func(q *dbgen.Queries) error {
		if err := q.UpdateUserStatus(ctx, dbgen.UpdateUserStatusParams{Status: status, ID: userID}); err != nil {
			return err
		}
		return q.UpdateUserCustomStatus(ctx, dbgen.UpdateUserCustomStatusParams{CustomStatus: customStatus, ID: userID})
	})
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

// SignOutEverywhere revokes every session of the user — the caller's own
// included — and every live API token in one transaction, so either both go
// or neither does, and reports how many of each went (B4-7).
func (d *DB) SignOutEverywhere(ctx context.Context, userID int64) (sessions, tokens int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("SignOutEverywhere begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)

	tokRes, err := q.RevokeUserAPITokens(ctx, userID)
	if err != nil {
		return 0, 0, fmt.Errorf("SignOutEverywhere api tokens: %w", err)
	}
	if tokens, err = tokRes.RowsAffected(); err != nil {
		return 0, 0, fmt.Errorf("SignOutEverywhere api tokens rows: %w", err)
	}
	sessRes, err := q.DeleteUserSessions(ctx, userID)
	if err != nil {
		return 0, 0, fmt.Errorf("SignOutEverywhere sessions: %w", err)
	}
	if sessions, err = sessRes.RowsAffected(); err != nil {
		return 0, 0, fmt.Errorf("SignOutEverywhere sessions rows: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("SignOutEverywhere commit: %w", err)
	}
	return sessions, tokens, nil
}
