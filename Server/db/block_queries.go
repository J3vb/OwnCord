package db

import (
	"errors"
	"fmt"

	"database/sql"

	"github.com/owncord/server/db/dbgen"
)

// BlockUser adds a block from blocker to blocked. Idempotent — re-blocking
// a user that is already blocked is a no-op (INSERT OR IGNORE).
func (d *DB) BlockUser(blockerID, blockedID int64) error {
	if err := d.q.BlockUser(dbCtx(), dbgen.BlockUserParams{
		BlockerID: blockerID,
		BlockedID: blockedID,
	}); err != nil {
		return fmt.Errorf("BlockUser: %w", err)
	}
	return nil
}

// UnblockUser removes a block. Idempotent — unblocking a non-blocked user is
// a no-op.
func (d *DB) UnblockUser(blockerID, blockedID int64) error {
	if err := d.q.UnblockUser(dbCtx(), dbgen.UnblockUserParams{
		BlockerID: blockerID,
		BlockedID: blockedID,
	}); err != nil {
		return fmt.Errorf("UnblockUser: %w", err)
	}
	return nil
}

// IsBlocked returns true if blockerID has blocked blockedID.
func (d *DB) IsBlocked(blockerID, blockedID int64) (bool, error) {
	_, err := d.q.IsBlocked(dbCtx(), dbgen.IsBlockedParams{
		BlockerID: blockerID,
		BlockedID: blockedID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("IsBlocked: %w", err)
	}
	return true, nil
}

// IsEitherBlocked returns true if either user has blocked the other.
// Used for DM authorization — if either party has blocked the other,
// messaging is denied.
func (d *DB) IsEitherBlocked(userA, userB int64) (bool, error) {
	_, err := d.q.IsEitherBlocked(dbCtx(), dbgen.IsEitherBlockedParams{
		BlockerID:   userA,
		BlockedID:   userB,
		BlockerID_2: userB,
		BlockedID_2: userA,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("IsEitherBlocked: %w", err)
	}
	return true, nil
}

// ListBlockedUsers returns the IDs of all users blocked by the given user.
func (d *DB) ListBlockedUsers(blockerID int64) ([]int64, error) {
	ids, err := d.q.ListBlockedUsers(dbCtx(), blockerID)
	if err != nil {
		return nil, fmt.Errorf("ListBlockedUsers: %w", err)
	}
	return ids, nil
}
