package db

import "fmt"

// BlockUser adds a block from blocker to blocked. Idempotent — re-blocking
// a user that is already blocked is a no-op (INSERT OR IGNORE).
func (d *DB) BlockUser(blockerID, blockedID int64) error {
	_, err := d.sqlDB.Exec(
		`INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`,
		blockerID, blockedID,
	)
	if err != nil {
		return fmt.Errorf("BlockUser: %w", err)
	}
	return nil
}

// UnblockUser removes a block. Idempotent — unblocking a non-blocked user is
// a no-op.
func (d *DB) UnblockUser(blockerID, blockedID int64) error {
	_, err := d.sqlDB.Exec(
		`DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`,
		blockerID, blockedID,
	)
	if err != nil {
		return fmt.Errorf("UnblockUser: %w", err)
	}
	return nil
}

// IsBlocked returns true if blockerID has blocked blockedID.
func (d *DB) IsBlocked(blockerID, blockedID int64) (bool, error) {
	var exists int
	err := d.sqlDB.QueryRow(
		`SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ? LIMIT 1`,
		blockerID, blockedID,
	).Scan(&exists)
	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return false, nil
		}
		return false, fmt.Errorf("IsBlocked: %w", err)
	}
	return true, nil
}

// IsEitherBlocked returns true if either user has blocked the other.
// Used for DM authorization — if either party has blocked the other,
// messaging is denied.
func (d *DB) IsEitherBlocked(userA, userB int64) (bool, error) {
	var exists int
	err := d.sqlDB.QueryRow(
		`SELECT 1 FROM user_blocks
		 WHERE (blocker_id = ? AND blocked_id = ?)
		    OR (blocker_id = ? AND blocked_id = ?)
		 LIMIT 1`,
		userA, userB, userB, userA,
	).Scan(&exists)
	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return false, nil
		}
		return false, fmt.Errorf("IsEitherBlocked: %w", err)
	}
	return true, nil
}

// ListBlockedUsers returns the IDs of all users blocked by the given user.
func (d *DB) ListBlockedUsers(blockerID int64) ([]int64, error) {
	rows, err := d.sqlDB.Query(
		`SELECT blocked_id FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC`,
		blockerID,
	)
	if err != nil {
		return nil, fmt.Errorf("ListBlockedUsers: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("ListBlockedUsers scan: %w", err)
		}
		ids = append(ids, id)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListBlockedUsers rows: %w", rows.Err())
	}
	return ids, nil
}
