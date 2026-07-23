package db

import (
	"context"
	"fmt"
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
