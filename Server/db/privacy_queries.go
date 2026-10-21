package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// UserPrivacy is one user's direct message privacy choices (migration 070,
// WP 6.8b). It is private to its owner and is never part of a member, profile
// or DM payload.
type UserPrivacy struct {
	AllowMemberDMs  bool
	MessageRequests bool
}

// DefaultUserPrivacy is what a user with no stored row has: both settings on.
func DefaultUserPrivacy() UserPrivacy {
	return UserPrivacy{AllowMemberDMs: true, MessageRequests: true}
}

// GetUserPrivacy returns the user's privacy settings, or the defaults when the
// user has never saved any.
func (d *DB) GetUserPrivacy(ctx context.Context, userID int64) (UserPrivacy, error) {
	row, err := d.q.GetUserPrivacy(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultUserPrivacy(), nil
	}
	if err != nil {
		return UserPrivacy{}, fmt.Errorf("GetUserPrivacy: %w", err)
	}
	return UserPrivacy{AllowMemberDMs: row.AllowMemberDms != 0, MessageRequests: row.MessageRequests != 0}, nil
}

// SetUserPrivacy replaces the user's whole privacy row in one statement, so
// concurrent writers leave one complete body and never a mix.
func (d *DB) SetUserPrivacy(ctx context.Context, userID int64, p UserPrivacy) error {
	err := d.q.UpsertUserPrivacy(ctx, dbgen.UpsertUserPrivacyParams{
		UserID:          userID,
		AllowMemberDms:  b2i64(p.AllowMemberDMs),
		MessageRequests: b2i64(p.MessageRequests),
	})
	if err != nil {
		return fmt.Errorf("SetUserPrivacy: %w", err)
	}
	return nil
}
