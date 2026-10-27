package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// UpdateUserProfile updates the username, avatar, display name, about text and
// banner (image id and colour) for the given user. All are written unconditionally, so the caller is
// responsible for merging a partial PATCH against the current row.
// Returns ErrNotFound if the user does not exist. Returns an error wrapping
// a UNIQUE constraint violation if the username is already taken.
func (d *DB) UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string) error {
	result, err := d.q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
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

// CustomStatusExpiryLayout is how users.custom_status_expires_at is written:
// UTC, second precision, the same shape SQLite's strftime renders, so the
// stored text compares correctly as a string.
const CustomStatusExpiryLayout = "2006-01-02T15:04:05Z"

// UpdateUserCustomStatus sets (or clears, with nil) the user's custom status
// line with no expiry, clearing any expiry the old text carried. Kept separate
// from UpdateUserProfile because it arrives on the presence path and must not
// overwrite a concurrent profile edit.
func (d *DB) UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error {
	if err := d.q.UpdateUserCustomStatus(ctx, dbgen.UpdateUserCustomStatusParams{
		CustomStatus: customStatus,
		ID:           userID,
	}); err != nil {
		return fmt.Errorf("UpdateUserCustomStatus: %w", err)
	}
	return nil
}

// UpdateUserPresence writes a presence_update's status, custom status line and
// the line's expiry (nil = none) in one transaction, so they commit together
// or not at all (P5-O08).
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

// NextCustomStatusExpiry returns the soonest pending custom-status expiry, or
// ok=false when none is pending.
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

// ListExpiredCustomStatuses returns up to limit statuses whose expiry is at or
// before now (CustomStatusExpiryLayout text), oldest first.
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

// ClearCustomStatusIfExpiry clears the user's custom status and expiry only
// while the stored expiry still equals expiresAt, and reports whether it did.
// A status set after the caller read the row carries a different expiry (or
// none), so it is left alone.
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

// IsBannerFile reports whether the attachment is currently some user's profile
// banner image. Like IsAvatarFileURL it lets an unlinked attachment be served to
// every authenticated user for exactly as long as a banner_id names it.
func (d *DB) IsBannerFile(ctx context.Context, fileID string) (bool, error) {
	n, err := d.q.IsBannerFile(ctx, &fileID)
	if err != nil {
		return false, fmt.Errorf("IsBannerFile: %w", err)
	}
	return n != 0, nil
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
		sessions = append(sessions, sessionFromColumns(s.ID, s.UserID, s.Token, s.Device, s.IpAddress, s.CreatedAt, s.LastUsed, s.ExpiresAt, s.Unseen))
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

// SetSessionIdentityKey stores the device identity public key a WebSocket
// auth frame carried on the session that authenticated it. A token hash that
// matches no row changes nothing and is not an error: the session may have
// been revoked between the handshake read and this write.
func (d *DB) SetSessionIdentityKey(ctx context.Context, tokenHash, key string) error {
	if _, err := d.q.SetSessionIdentityKey(ctx, dbgen.SetSessionIdentityKeyParams{
		IdentityPublicKey: &key,
		Token:             tokenHash,
	}); err != nil {
		return fmt.Errorf("SetSessionIdentityKey: %w", err)
	}
	return nil
}
