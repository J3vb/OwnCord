package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/owncord/server/permissions"
)

// DeleteAccount anonymises and disables a user account within a single
// transaction.  Because the messages, invites, and emoji tables
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
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("DeleteAccount begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// ── Guard: last admin/owner check ────────────────────────────────────
	// Resolve admin-class roles by the canonical criteria — the seeded
	// Owner/Admin role IDs plus any custom role holding the Administrator
	// bypass bit. Names are user-editable (the Owner can rename the seeded
	// Admin role), so a name lookup would silently disable the guard.
	adminRows, err := tx.QueryContext(ctx,
		`SELECT id FROM roles WHERE id IN (?, ?) OR (permissions & ?) != 0`,
		permissions.OwnerRoleID, permissions.AdminRoleID, permissions.Administrator,
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

		isAdminClass := slices.Contains(adminRoleIDs, userRoleID)

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

	// Snapshot the user's DM channels before the participant rows go away,
	// so channels left with zero participants can be removed below —
	// LeaveGroupDM's invariant: a participant-less DM channel is an
	// unreachable, undeletable row.
	var dmChannelIDs []int64
	dmRows, err := tx.QueryContext(ctx,
		`SELECT channel_id FROM dm_participants WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("DeleteAccount list dm channels: %w", err)
	}
	for dmRows.Next() {
		var chID int64
		if scanErr := dmRows.Scan(&chID); scanErr != nil {
			dmRows.Close() //nolint:errcheck
			return fmt.Errorf("DeleteAccount scan dm channel: %w", scanErr)
		}
		dmChannelIDs = append(dmChannelIDs, chID)
	}
	dmRows.Close() //nolint:errcheck
	if dmRows.Err() != nil {
		return fmt.Errorf("DeleteAccount dm channels rows: %w", dmRows.Err())
	}

	// ── Purge related data ───────────────────────────────────────────────
	stmts := []struct {
		label string
		query string
	}{
		{"sessions", `DELETE FROM sessions WHERE user_id = ?`},
		// API tokens authenticate independently of sessions; leaving them
		// active would keep the deleted account usable.
		{"api_tokens", `UPDATE api_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`},
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

	// Close and, where emptied, remove the deleted user's DM channels.
	for _, chID := range dmChannelIDs {
		var isGroup bool
		if err := tx.QueryRowContext(ctx,
			`SELECT is_group FROM channels WHERE id = ?`, chID,
		).Scan(&isGroup); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue // channel already gone
			}
			return fmt.Errorf("DeleteAccount dm channel is_group: %w", err)
		}

		if !isGroup {
			// The purge above removed only this user's dm_participants row, so
			// a 1:1 DM with a live other side is untouched: its dm_participants
			// row (and the channel) survive, but the survivor's own
			// dm_open_state row does too. Left alone that renders as a
			// sidebar entry with a blank, unnamed recipient (GetDMParticipantsForUser
			// skips the viewer's own row and this user has none left to
			// return) that the survivor can still open and send into. Closing
			// it for them removes it from their sidebar, same as if they had
			// closed it themselves.
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM dm_open_state WHERE channel_id = ? AND user_id != ?`,
				chID, userID,
			); err != nil {
				return fmt.Errorf("DeleteAccount close dm for survivor: %w", err)
			}
		}

		// Hard-delete DM channels the deletion left with zero participants
		// (always true for the last member of a group DM; true for a 1:1 DM
		// only when the other side had already deleted their own account).
		//
		// Unlink attachments first: messages.channel_id and
		// attachments.message_id both cascade ON DELETE (migrations/001), so
		// deleting the channel row destroys the attachment rows too. Those
		// rows are the only handle DeleteOrphanedAttachments (the periodic
		// sweep in main.go) has on the uploaded files — once the cascade
		// removes them the files are stranded on disk forever. Setting
		// message_id to NULL first turns them into ordinary orphaned
		// attachments the sweep already knows how to reclaim.
		if _, err := tx.ExecContext(ctx,
			`UPDATE attachments SET message_id = NULL
			   WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)
			     AND EXISTS (
			       SELECT 1 FROM channels
			        WHERE channels.id = ? AND channels.type = 'dm'
			          AND NOT EXISTS (SELECT 1 FROM dm_participants WHERE channel_id = channels.id)
			     )`,
			chID, chID,
		); err != nil {
			return fmt.Errorf("DeleteAccount unlink dm attachments: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM channels WHERE id = ? AND type = 'dm'
			   AND NOT EXISTS (SELECT 1 FROM dm_participants WHERE channel_id = channels.id)`,
			chID,
		); err != nil {
			return fmt.Errorf("DeleteAccount empty dm channel: %w", err)
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
	// ban_expires must be cleared: a stale lapsed temp-ban timestamp would
	// make banned=1 read as NOT banned (IsEffectivelyBanned), reviving the
	// deleted account for any credential that survives.
	const anonymise = `UPDATE users
		 SET username            = ?,
		     password            = '',
		     avatar              = NULL,
		     totp_secret         = NULL,
		     display_name        = NULL,
		     about               = NULL,
		     custom_status       = NULL,
		     identity_public_key = NULL,
		     status              = 'offline',
		     banned              = 1,
		     ban_expires         = NULL,
		     ban_reason          = 'account deleted'
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
