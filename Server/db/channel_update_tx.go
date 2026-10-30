package db

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// The in-transaction steps of adminUpdateChannel (admin_queries.go).

func sameCategory(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// applyPermissionSyncTx applies the sync rules of a channel update inside its
// transaction. Moving the channel to another category unsyncs it and keeps its
// own override rows; an update that asked for a sync instead replaces the rows
// with the target category's template and marks the channel synced. moved was
// read in this transaction, not from a snapshot the caller took earlier.
func applyPermissionSyncTx(ctx context.Context, q *dbgen.Queries, id int64, catID *int64, moved bool, u ChannelUpdate) error {
	if u.SyncGuard != nil {
		if catID == nil {
			return ErrUncategorized
		}
		plan, err := replaceWithTemplateTx(ctx, q, id, *catID, u.SyncGuard)
		if err != nil {
			return err
		}
		if u.SyncPlan != nil {
			*u.SyncPlan = plan
		}
		return nil
	}
	if moved {
		return q.UnsyncChannelPermissions(ctx, id)
	}
	return nil
}

// applyChannelPasswordTx writes a password change inside the update's
// transaction. A nil change writes nothing.
func applyChannelPasswordTx(ctx context.Context, q *dbgen.Queries, id int64, change *ChannelPasswordChange) error {
	if change == nil {
		return nil
	}
	if change.Clear {
		_, err := q.ClearChannelPassword(ctx, id)
		return err
	}
	_, err := q.SetChannelPassword(ctx, dbgen.SetChannelPasswordParams{PasswordHash: &change.Hash, ID: id})
	return err
}
