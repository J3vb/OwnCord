package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
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
	// Dynamically resolve admin-class role IDs from the roles table.
	adminRows, err := tx.QueryContext(ctx,
		`SELECT id FROM roles WHERE name IN ('Owner', 'Admin')`,
	)
	if err != nil {
		return fmt.Errorf("DeleteAccount fetch admin roles: %w", err)
	}
	var adminRoleIDs []int64
	for adminRows.Next() {
		var rid int64
		if scanErr := adminRows.Scan(&rid); scanErr != nil {
			adminRows.Close() //nolint:errcheck
			return fmt.Errorf("DeleteAccount scan admin role: %w", scanErr)
		}
		adminRoleIDs = append(adminRoleIDs, rid)
	}
	adminRows.Close() //nolint:errcheck
	if adminRows.Err() != nil {
		return fmt.Errorf("DeleteAccount admin roles rows: %w", adminRows.Err())
	}

	if len(adminRoleIDs) == 0 {
		// No admin-class roles defined; skip the guard.
	} else {
		var userRoleID int64
		if err := tx.QueryRowContext(ctx,
			`SELECT role_id FROM users WHERE id = ?`, userID,
		).Scan(&userRoleID); err != nil {
			return fmt.Errorf("DeleteAccount fetch role: %w", err)
		}

		isAdminClass := false
		for _, rid := range adminRoleIDs {
			if userRoleID == rid {
				isAdminClass = true
				break
			}
		}

		if isAdminClass {
			// Build IN clause dynamically for the admin role IDs.
			placeholders := make([]string, len(adminRoleIDs))
			args := make([]any, 0, len(adminRoleIDs)+1)
			for i, rid := range adminRoleIDs {
				placeholders[i] = "?"
				args = append(args, rid)
			}
			args = append(args, userID)

			var adminCount int
			if err := tx.QueryRowContext(ctx,
				fmt.Sprintf(`SELECT COUNT(*) FROM users WHERE role_id IN (%s) AND id != ? AND banned = 0`,
					strings.Join(placeholders, ",")),
				args...,
			).Scan(&adminCount); err != nil {
				return fmt.Errorf("DeleteAccount count admins: %w", err)
			}
			if adminCount == 0 {
				return ErrLastAdmin
			}
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
	// users.username is UNIQUE COLLATE NOCASE, so a third party holding
	// "[deleted-<userID>]" would make this UPDATE fail, roll the whole
	// transaction back, and deny the victim their own account deletion
	// indefinitely. auth.ValidateUsername now reserves that namespace, but the
	// erasure path must not depend on it: on a collision, fall back to a random
	// suffix and retry. A SQLite constraint violation rolls back the statement,
	// not the enclosing transaction, so retrying in place is safe.
	if err := anonymiseUser(ctx, tx, userID); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("DeleteAccount commit: %w", err)
	}
	return nil
}

// anonymiseUserAttempts is how many names anonymiseUser will try: the canonical
// "[deleted-<id>]" plus randomly suffixed variants. Exhausting it means the
// generator collided repeatedly, which is not something an attacker can force.
const anonymiseUserAttempts = 4

// anonymiseUser strips the user's credentials and personal fields and renames
// the row out of the way. The first candidate is the canonical
// "[deleted-<id>]"; if that name is taken, later candidates append a random
// suffix so no third party can pin the account in place by squatting a
// predictable string.
func anonymiseUser(ctx context.Context, tx *sql.Tx, userID int64) error {
	const anonymise = `UPDATE users
		 SET username    = ?,
		     password    = '',
		     avatar      = NULL,
		     totp_secret = NULL,
		     status      = 'offline',
		     banned      = 1,
		     ban_reason  = 'account deleted'
		 WHERE id = ?`

	var lastErr error
	for attempt := range anonymiseUserAttempts {
		name := fmt.Sprintf("[deleted-%d]", userID)
		if attempt > 0 {
			suffix := make([]byte, 6)
			if _, err := rand.Read(suffix); err != nil {
				return fmt.Errorf("DeleteAccount anonymise suffix: %w", err)
			}
			name = fmt.Sprintf("[deleted-%d-%s]", userID, hex.EncodeToString(suffix))
		}
		_, lastErr = tx.ExecContext(ctx, anonymise, name, userID)
		if lastErr == nil {
			return nil
		}
		if !IsUniqueConstraintError(lastErr) {
			return fmt.Errorf("DeleteAccount anonymise: %w", lastErr)
		}
	}
	return fmt.Errorf("DeleteAccount anonymise: %w", lastErr)
}
