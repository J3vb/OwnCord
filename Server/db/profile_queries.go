package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// UpdateUserProfile writes username, avatar, display name, about text and banner
// unconditionally, so the caller merges a partial PATCH against the current row.
// ErrNotFound if the user does not exist; a UNIQUE violation error if the username is
// taken.
func (d *DB) UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string) error {
	return updateUserProfile(ctx, d.q, userID, username, avatar, displayName, about, bannerID, bannerColor)
}

// UpdateUserProfileAndIdentityKey is UpdateUserProfile plus the E2EE identity key in
// one transaction.
func (d *DB) UpdateUserProfileAndIdentityKey(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string, identityKey string) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("UpdateUserProfileAndIdentityKey begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)

	if err := updateUserProfile(ctx, q, userID, username, avatar, displayName, about, bannerID, bannerColor); err != nil {
		return err
	}
	if err := q.UpdateUserIdentityKey(ctx, dbgen.UpdateUserIdentityKeyParams{IdentityPublicKey: &identityKey, ID: userID}); err != nil {
		return fmt.Errorf("UpdateUserProfileAndIdentityKey identity key: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("UpdateUserProfileAndIdentityKey commit: %w", err)
	}
	return nil
}

func updateUserProfile(ctx context.Context, q *dbgen.Queries, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string) error {
	result, err := q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		Username:    username,
		Avatar:      avatar,
		DisplayName: displayName,
		About:       about,
		BannerID:    bannerID,
		BannerColor: bannerColor,
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

// UpdateUserCustomStatus sets (nil clears) the status line with no expiry. Separate
// from UpdateUserProfile: it arrives on the presence path and must not overwrite a
// concurrent profile edit.
func (d *DB) UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error {
	if err := d.q.UpdateUserCustomStatus(ctx, dbgen.UpdateUserCustomStatusParams{
		CustomStatus: customStatus,
		ID:           userID,
	}); err != nil {
		return fmt.Errorf("UpdateUserCustomStatus: %w", err)
	}
	return nil
}

// UpdateUserPresence writes status, status line and expiry (nil = none) in one transaction.
func (d *DB) UpdateUserPresence(ctx context.Context, userID int64, status string, customStatus, expiresAt *string) error {
	return d.inWriteTx(ctx, "UpdateUserPresence", func(q *dbgen.Queries) error {
		if err := q.UpdateUserStatus(ctx, dbgen.UpdateUserStatusParams{Status: status, ID: userID}); err != nil {
			return err
		}
		return q.UpdateUserCustomStatus(ctx, dbgen.UpdateUserCustomStatusParams{
			CustomStatus:          customStatus,
			CustomStatusExpiresAt: expiresAt,
			ID:                    userID,
		})
	})
}

// ExpiredCustomStatus is one custom status whose expiry has passed.
type ExpiredCustomStatus struct {
	UserID    int64
	ExpiresAt string
}

// NextCustomStatusExpiry returns the soonest pending expiry, or ok=false.
func (d *DB) NextCustomStatusExpiry(ctx context.Context) (next string, ok bool, err error) {
	v, err := d.q.NextCustomStatusExpiry(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("NextCustomStatusExpiry: %w", err)
	}
	if v == nil {
		return "", false, nil
	}
	return *v, true, nil
}

// ListExpiredCustomStatuses returns up to limit statuses expiring at or before now, oldest first.
func (d *DB) ListExpiredCustomStatuses(ctx context.Context, now string, limit int) ([]ExpiredCustomStatus, error) {
	rows, err := d.q.ListExpiredCustomStatuses(ctx, dbgen.ListExpiredCustomStatusesParams{
		CustomStatusExpiresAt: &now,
		Limit:                 int64(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("ListExpiredCustomStatuses: %w", err)
	}
	out := make([]ExpiredCustomStatus, 0, len(rows))
	for _, r := range rows {
		if r.CustomStatusExpiresAt == nil {
			continue
		}
		out = append(out, ExpiredCustomStatus{UserID: r.ID, ExpiresAt: *r.CustomStatusExpiresAt})
	}
	return out, nil
}

// ClearCustomStatusIfExpiry clears the status only while its stored expiry equals
// expiresAt, so a newer status is left alone.
func (d *DB) ClearCustomStatusIfExpiry(ctx context.Context, userID int64, expiresAt string) (bool, error) {
	n, err := d.q.ClearCustomStatusIfExpiry(ctx, dbgen.ClearCustomStatusIfExpiryParams{
		ID:                    userID,
		CustomStatusExpiresAt: &expiresAt,
	})
	if err != nil {
		return false, fmt.Errorf("ClearCustomStatusIfExpiry: %w", err)
	}
	return n == 1, nil
}

// IsBannerFile reports whether the attachment is currently a user's banner; like
// IsAvatarFileURL it lets an unlinked attachment be served to every authenticated user
// while a banner_id names it.
func (d *DB) IsBannerFile(ctx context.Context, fileID string) (bool, error) {
	n, err := d.q.IsBannerFile(ctx, &fileID)
	if err != nil {
		return false, fmt.Errorf("IsBannerFile: %w", err)
	}
	return n != 0, nil
}

// IsAvatarFileURL reports whether url is currently some user's avatar, which lets an
// uploaded avatar (an attachment with no channel, private to its uploader) be served
// to every authenticated user while in use.
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

// ListUserSessions returns all sessions for the user, newest first.
func (d *DB) ListUserSessions(ctx context.Context, userID int64) ([]Session, error) {
	rows, err := d.q.ListUserSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("ListUserSessions: %w", err)
	}
	sessions := make([]Session, 0, len(rows))
	for _, s := range rows {
		sessions = append(sessions, sessionFromColumns(s.ID, s.UserID, s.Token, s.Device, s.IpAddress, s.CreatedAt, s.LastUsed, s.ExpiresAt, s.Unseen))
	}
	return sessions, nil
}

// MarkSessionsSeen clears every unseen flag except the caller's own (a listing from
// another device is what "seen" means); returns rows changed.
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

// DeleteSessionByID removes a session only if it belongs to userID; ErrNotFound otherwise.
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

// SignOutEverywhere revokes every session (the caller's included) and live API token
// in one transaction, reporting both counts.
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

// SetSessionIdentityKey stores the device identity public key a WebSocket auth frame
// carried. A token hash matching no row is not an error: the session may have been
// revoked since.
func (d *DB) SetSessionIdentityKey(ctx context.Context, tokenHash, key string) error {
	if _, err := d.q.SetSessionIdentityKey(ctx, dbgen.SetSessionIdentityKeyParams{
		IdentityPublicKey: &key,
		Token:             tokenHash,
	}); err != nil {
		return fmt.Errorf("SetSessionIdentityKey: %w", err)
	}
	return nil
}
