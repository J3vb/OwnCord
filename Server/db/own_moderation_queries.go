package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// OwnModerationAction is one row of the caller's own ledger read (GET
// /api/v1/users/me/moderation): no actor, no lifted_by, no report link.
// AppealID is the appeal's public id, nil when none was filed.
type OwnModerationAction struct {
	ID             int64
	Kind           string
	Reason         string
	CreatedAt      string
	ExpiresAt      *string
	LiftedAt       *string
	AcknowledgedAt *string
	AppealID       *string
	AppealState    *string
}

// ListOwnModerationActions returns userID's own warning, timeout, removal
// and ban rows, newest first, at most limit of them.
func (d *DB) ListOwnModerationActions(ctx context.Context, userID, limit int64) ([]OwnModerationAction, error) {
	rows, err := d.q.ListOwnModerationActions(ctx, dbgen.ListOwnModerationActionsParams{TargetID: userID, RowLimit: limit})
	if err != nil {
		return nil, fmt.Errorf("ListOwnModerationActions: %w", err)
	}
	out := make([]OwnModerationAction, 0, len(rows))
	for _, r := range rows {
		out = append(out, OwnModerationAction(r))
	}
	return out, nil
}
