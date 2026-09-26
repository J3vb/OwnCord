package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// The account-erasure transaction lives in erasure.go (EraseAccount, B4-9).
// This file keeps the pieces it shares with the anonymising deletion it
// replaced: the last-admin guard and the DM-channel snapshot/close steps.

// deleteAccountAdminGuard blocks the erasure when userID is the last
// remaining admin-class account, returning ErrLastAdmin.
func deleteAccountAdminGuard(ctx context.Context, tx *sql.Tx, userID int64) error {
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
			// notBannedClause is appended outside the Sprintf format string
			// (rather than joined into it) because it contains strftime
			// verbs like %Y and %H that fmt.Sprintf would otherwise try to
			// parse as its own format directives.
			query := fmt.Sprintf(`SELECT COUNT(*) FROM users WHERE role_id IN (%s) AND id != ? AND `,
				strings.Join(placeholders, ",")) + notBannedClause
			if err := tx.QueryRowContext(ctx, query,
				args...,
			).Scan(&adminCount); err != nil {
				return fmt.Errorf("DeleteAccount count admins: %w", err)
			}
			if adminCount == 0 {
				return ErrLastAdmin
			}
		}
	}
	return nil
}

// deleteAccountDMChannels snapshots the DM channels the user takes part in,
// before the dm_participants purge removes the rows that name them.
func deleteAccountDMChannels(ctx context.Context, tx *sql.Tx, userID int64) ([]int64, error) {
	// Snapshot the user's DM channels before the participant rows go away,
	// so channels left with zero participants can be removed below —
	// LeaveGroupDM's invariant: a participant-less DM channel is an
	// unreachable, undeletable row.
	var dmChannelIDs []int64
	dmRows, err := tx.QueryContext(ctx,
		`SELECT channel_id FROM dm_participants WHERE user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("DeleteAccount list dm channels: %w", err)
	}
	for dmRows.Next() {
		var chID int64
		if scanErr := dmRows.Scan(&chID); scanErr != nil {
			dmRows.Close() //nolint:errcheck
			return nil, fmt.Errorf("DeleteAccount scan dm channel: %w", scanErr)
		}
		dmChannelIDs = append(dmChannelIDs, chID)
	}
	dmRows.Close() //nolint:errcheck
	if dmRows.Err() != nil {
		return nil, fmt.Errorf("DeleteAccount dm channels rows: %w", dmRows.Err())
	}
	return dmChannelIDs, nil
}

// deleteAccountCloseDMChannels closes, and where the purge emptied them,
// removes the DM channels snapshotted by deleteAccountDMChannels.
func deleteAccountCloseDMChannels(ctx context.Context, tx *sql.Tx, userID int64, dmChannelIDs []int64) error {
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
	return nil
}
