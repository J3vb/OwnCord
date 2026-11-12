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

func inviteFromListRow(id int64, code string, createdBy int64, creator string, maxUses *int64, useCount int64, expiresAt *string, revoked int64, createdAt string) *Invite {
	return &Invite{
		ID:              id,
		Code:            code,
		CreatedBy:       createdBy,
		CreatorUsername: creator,
		Uses:            int(useCount),
		MaxUses:         ptrI64toI(maxUses),
		ExpiresAt:       expiresAt,
		Revoked:         revoked != 0,
		CreatedAt:       createdAt,
	}
}

// ListInvites returns invites newest id first, with id below beforeID (0 starts from the newest). dead
// selects revoked, used-up and expired invites; otherwise those that can still be redeemed.
func (d *DB) ListInvites(ctx context.Context, dead bool, beforeID int64, limit int) ([]*Invite, error) {
	invites := make([]*Invite, 0)
	if dead {
		rows, err := d.q.ListDeadInvites(ctx, dbgen.ListDeadInvitesParams{BeforeID: beforeID, RowLimit: int64(limit)})
		if err != nil {
			return nil, fmt.Errorf("ListInvites dead: %w", err)
		}
		for _, r := range rows {
			invites = append(invites, inviteFromListRow(r.ID, r.Code, r.CreatedBy, r.CreatorUsername, r.MaxUses, r.UseCount, r.ExpiresAt, r.Revoked, r.CreatedAt))
		}
		return invites, nil
	}
	rows, err := d.q.ListLiveInvites(ctx, dbgen.ListLiveInvitesParams{BeforeID: beforeID, RowLimit: int64(limit)})
	if err != nil {
		return nil, fmt.Errorf("ListInvites live: %w", err)
	}
	for _, r := range rows {
		invites = append(invites, inviteFromListRow(r.ID, r.Code, r.CreatedBy, r.CreatorUsername, r.MaxUses, r.UseCount, r.ExpiresAt, r.Revoked, r.CreatedAt))
	}
	return invites, nil
}

// GetInviteByID returns the invite with the given id, or nil if not found.
func (d *DB) GetInviteByID(ctx context.Context, id int64) (*Invite, error) {
	r, err := d.q.GetInviteByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetInviteByID: %w", err)
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

// InviteRedemption is one recorded use of an invite. UserID is nil when the redeemer's
// account was since erased (migration 055): the history is kept, the link is cut.
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

// CreateInvite generates and persists a random code and returns it; maxUses=0 is
// unlimited, nil expiresAt never expires.
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

func generateInviteCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
