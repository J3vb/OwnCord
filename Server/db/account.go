package db

import (
	"context"
	"fmt"
)

// DeleteAccount anonymises and disables a user account within a single
// transaction.  Because the messages, invites, emoji, and sounds tables
// reference users(id) with no ON DELETE CASCADE, we cannot simply DELETE
// the row.  Instead we:
//
//  1. Verify the user is not the last admin/owner (return ErrLastAdmin).
//  2. Invalidate all sessions so existing tokens stop working.
//  3. Remove DM participation and open-state rows.
//  4. Remove reactions.
//  5. Remove read states.
//  6. Soft-delete all messages (mark deleted, clear content).
//  7. Anonymise the user row: clear password, avatar, TOTP, set
//     username to "[deleted-{id}]", status to "offline", banned to 1.
//
// After this the account is completely unusable and all personal data is
// removed while preserving referential integrity for historical records.
func (d *DB) DeleteAccount(ctx context.Context, userID int64) error {
	tx, err := d.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("DeleteAccount begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// ── Guard: last admin/owner check ────────────────────────────────────
	// Owner (role_id=1) and Admin (role_id=2) are both "admin-class" roles.
	var userRoleID int64
	if err := tx.QueryRowContext(ctx,
		`SELECT role_id FROM users WHERE id = ?`, userID,
	).Scan(&userRoleID); err != nil {
		return fmt.Errorf("DeleteAccount fetch role: %w", err)
	}

	const roleOwner, roleAdmin int64 = 1, 2
	if userRoleID == roleOwner || userRoleID == roleAdmin {
		var adminCount int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM users WHERE role_id IN (?, ?) AND id != ? AND banned = 0`,
			roleOwner, roleAdmin, userID,
		).Scan(&adminCount); err != nil {
			return fmt.Errorf("DeleteAccount count admins: %w", err)
		}
		if adminCount == 0 {
			return ErrLastAdmin
		}
	}

	// ── Purge related data ───────────────────────────────────────────────
	stmts := []struct {
		label string
		query string
	}{
		{"sessions", `DELETE FROM sessions WHERE user_id = ?`},
		{"dm_participants", `DELETE FROM dm_participants WHERE user_id = ?`},
		{"dm_open_state", `DELETE FROM dm_open_state WHERE user_id = ?`},
		{"reactions", `DELETE FROM reactions WHERE user_id = ?`},
		{"read_states", `DELETE FROM read_states WHERE user_id = ?`},
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s.query, userID); err != nil {
			return fmt.Errorf("DeleteAccount %s: %w", s.label, err)
		}
	}

	// Soft-delete messages: mark as deleted and clear content so the rows
	// remain for conversation continuity but contain no personal data.
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET deleted = 1, content = '' WHERE user_id = ?`,
		userID,
	); err != nil {
		return fmt.Errorf("DeleteAccount messages: %w", err)
	}

	// ── Anonymise user row ───────────────────────────────────────────────
	anonUsername := fmt.Sprintf("[deleted-%d]", userID)
	if _, err := tx.ExecContext(ctx,
		`UPDATE users
		 SET username    = ?,
		     password    = '',
		     avatar      = NULL,
		     totp_secret = NULL,
		     status      = 'offline',
		     banned      = 1,
		     ban_reason  = 'account deleted'
		 WHERE id = ?`,
		anonUsername, userID,
	); err != nil {
		return fmt.Errorf("DeleteAccount anonymise: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("DeleteAccount commit: %w", err)
	}
	return nil
}
