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

// The account-erasure transaction lives in erasure.go (EraseAccount). This
// file keeps the last-admin guard and the DM-channel snapshot/close steps.

// underErasureClause excludes accounts whose erasure is queued from a count
// of administrators: their sessions are gone and they are on their way out.
const underErasureClause = ` AND id NOT IN (SELECT user_id FROM erasure_jobs WHERE state = 'queued')`

// deleteAccountAdminGuard blocks the erasure when userID is the last
// remaining admin-class account, returning ErrLastAdmin.
func deleteAccountAdminGuard(ctx context.Context, tx *sql.Tx, userID int64) error {
	// An erasure already queued for the subject passed this guard then, and every
	// other account under erasure no longer counts as an administrator, so two
	// erasures cannot both pass.
	var queued int
	switch err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM erasure_jobs WHERE user_id = ? AND state = 'queued'`, userID).Scan(&queued); {
	case err == nil:
		return nil
	case !errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("DeleteAccount queued erasure: %w", err)
	}
	// Last admin/owner check. Admin-class roles are resolved by the canonical
	// criteria (the seeded Owner/Admin role IDs plus any custom role with the
	// Administrator bypass bit), because names are user-editable and a name lookup
	// would silently disable the guard.
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
		// Admin-class when any held role is: an Administrator role below the top
		// role still makes the account one of the last admins.
		isAdminClass, err := holdsAnyRole(ctx, tx, userID, adminRoleIDs)
		if err != nil {
			return err
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
			// notBannedClause is appended outside the Sprintf format string because its
			// strftime verbs (%Y, %H) would be parsed as format directives.
			query := fmt.Sprintf(`SELECT COUNT(*) FROM users WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role_id IN (%s)) AND id != ? AND `,
				strings.Join(placeholders, ",")) + notBannedClause + underErasureClause
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
	// Snapshot before the participant rows go, so channels left with zero
	// participants can be removed (LeaveGroupDM's invariant: a participant-less DM
	// channel is unreachable and undeletable).
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
			// The purge removed only this user's dm_participants row, so a 1:1 DM with a
			// live other side survives along with the survivor's dm_open_state row. Left
			// alone it renders as a sidebar entry with a blank recipient
			// (GetDMParticipantsForUser skips the viewer's own row) that the survivor can
			// still open and send into. Close it for them, as if they had.
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM dm_open_state WHERE channel_id = ? AND user_id != ?`,
				chID, userID,
			); err != nil {
				return fmt.Errorf("DeleteAccount close dm for survivor: %w", err)
			}
		}

		// Hard-delete DM channels left with zero participants (always for the last
		// member of a group DM; for a 1:1 only when the other side had already
		// deleted their account).
		//
		// Unlink attachments first: messages.channel_id and attachments.message_id
		// cascade on delete, so deleting the channel would destroy the attachment rows,
		// the only handle DeleteOrphanedAttachments has on the files, stranding them
		// on disk. Setting message_id to NULL makes them ordinary orphans the sweep
		// reclaims.
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

// holdsAnyRole reports whether the user holds at least one of roleIDs. The
// mirror role counts too, so a member with no user_roles row is judged by
// users.role_id instead of slipping past the guard. A missing user is an error.
func holdsAnyRole(ctx context.Context, tx *sql.Tx, userID int64, roleIDs []int64) (bool, error) {
	var mirror int64
	if err := tx.QueryRowContext(ctx,
		`SELECT role_id FROM users WHERE id = ?`, userID,
	).Scan(&mirror); err != nil {
		return false, fmt.Errorf("DeleteAccount fetch role: %w", err)
	}
	held := slices.Contains(roleIDs, mirror)
	heldRows, err := tx.QueryContext(ctx,
		`SELECT role_id FROM user_roles WHERE user_id = ?`, userID)
	if err != nil {
		return false, fmt.Errorf("DeleteAccount fetch roles: %w", err)
	}
	defer heldRows.Close() //nolint:errcheck
	for heldRows.Next() {
		var rid int64
		if scanErr := heldRows.Scan(&rid); scanErr != nil {
			return false, fmt.Errorf("DeleteAccount scan role: %w", scanErr)
		}
		held = held || slices.Contains(roleIDs, rid)
	}
	if err := heldRows.Err(); err != nil {
		return false, fmt.Errorf("DeleteAccount roles rows: %w", err)
	}
	return held, nil
}
