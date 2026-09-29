package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ListInvites returns invites ordered by creation time descending.
// M-12: Limited to 200 rows to prevent unbounded result sets.
func (d *DB) ListInvites(ctx context.Context) ([]*Invite, error) {
	rows, err := d.q.ListInvites(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListInvites: %w", err)
	}
	invites := make([]*Invite, 0, len(rows))
	for _, r := range rows {
		invites = append(invites, &Invite{
			ID:        r.ID,
			Code:      r.Code,
			CreatedBy: r.CreatedBy,
			Uses:      int(r.UseCount),
			MaxUses:   ptrI64toI(r.MaxUses),
			ExpiresAt: r.ExpiresAt,
			Revoked:   r.Revoked != 0,
			CreatedAt: r.CreatedAt,
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
