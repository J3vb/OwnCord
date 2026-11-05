package db

import (
	"context"
	"fmt"

	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// ListInvites returns invites ordered by creation time descending.
// Limited to 200 rows to prevent unbounded result sets.
func (d *DB) ListInvites(ctx context.Context) ([]*Invite, error) {
	rows, err := d.q.ListInvites(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListInvites: %w", err)
	}
	invites := make([]*Invite, 0, len(rows))
	for _, r := range rows {
		invites = append(invites, &Invite{
			ID:              r.ID,
			Code:            r.Code,
			CreatedBy:       r.CreatedBy,
			CreatorUsername: r.CreatorUsername,
			Uses:            int(r.UseCount),
			MaxUses:         ptrI64toI(r.MaxUses),
			ExpiresAt:       r.ExpiresAt,
			Revoked:         r.Revoked != 0,
			CreatedAt:       r.CreatedAt,
		})
	}
	return invites, nil
}

// InviteRedemption is one recorded use of an invite. UserID is nil for a
// redeemer whose account has since been erased (migration 055): the history is
// kept, the link is cut.
type InviteRedemption struct {
	ID         int64
	UserID     *int64
	Username   string
	RedeemedAt string
}

// ListInviteRedemptions returns an invite's redemption history, newest first.
func (d *DB) ListInviteRedemptions(ctx context.Context, inviteID int64, limit int) ([]*InviteRedemption, error) {
	rows, err := d.q.ListInviteRedemptions(ctx, dbgen.ListInviteRedemptionsParams{
		InviteID: inviteID,
		Limit:    int64(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("ListInviteRedemptions: %w", err)
	}
	out := make([]*InviteRedemption, 0, len(rows))
	for _, r := range rows {
		out = append(out, &InviteRedemption{
			ID:         r.ID,
			UserID:     r.UserID,
			Username:   r.Username,
			RedeemedAt: r.RedeemedAt,
		})
	}
	return out, nil
}

// CreateInvite generates a random invite code, persists it, and returns the
// code. maxUses=0 means unlimited. expiresAt=nil means never expires.
func (d *DB) CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error) {
	code, err := generateInviteCode()
	if err != nil {
		return "", fmt.Errorf("CreateInvite generate code: %w", err)
	}

	var maxUsesVal *int
	if maxUses > 0 {
		maxUsesVal = &maxUses
	}
	var expiresStr *string
	if expiresAt != nil {
		s := expiresAt.UTC().Format(dbtime.ISOLayout)
		expiresStr = &s
	}

	if err := d.q.CreateInvite(ctx, dbgen.CreateInviteParams{
		Code:      code,
		CreatedBy: createdBy,
		MaxUses:   ptrItoI64(maxUsesVal),
		ExpiresAt: expiresStr,
	}); err != nil {
		return "", fmt.Errorf("CreateInvite insert: %w", err)
	}
	return code, nil
}

// GetInvite returns the invite for the given code, or nil if not found.
func (d *DB) GetInvite(ctx context.Context, code string) (*Invite, error) {
	r, err := d.q.GetInvite(ctx, code)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetInvite: %w", err)
	}
	return &Invite{
		ID:        r.ID,
		Code:      r.Code,
		CreatedBy: r.CreatedBy,
		Uses:      int(r.UseCount),
		MaxUses:   ptrI64toI(r.MaxUses),
		ExpiresAt: r.ExpiresAt,
		Revoked:   r.Revoked != 0,
		CreatedAt: r.CreatedAt,
	}, nil
}

// UseInviteAtomic validates and increments use_count in one statement,
// avoiding the TOCTOU race of GetInvite then UseInvite. The UPDATE matches
// only a code that exists, is not revoked, is within max_uses (NULL is
// unlimited) and is not expired; zero rows affected means missing, revoked,
// expired or exhausted, and returns an error.
func (d *DB) UseInviteAtomic(ctx context.Context, code string) error {
	result, err := d.q.UseInviteAtomic(ctx, code)
	if err != nil {
		return fmt.Errorf("UseInviteAtomic: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("UseInviteAtomic rows: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("UseInviteAtomic: invite not found, revoked, expired, or exhausted: %w", ErrNotFound)
	}
	return nil
}

// RevokeInvite marks an invite as revoked.
func (d *DB) RevokeInvite(ctx context.Context, code string) error {
	if err := d.q.RevokeInvite(ctx, code); err != nil {
		return fmt.Errorf("RevokeInvite: %w", err)
	}
	return nil
}

// generateInviteCode produces a random 8-byte (16-char hex) code.
func generateInviteCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
