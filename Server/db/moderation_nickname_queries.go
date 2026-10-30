package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// manageNicknamesOrAdmin is MANAGE_NICKNAMES (0x800000) | ADMINISTRATOR
// (0x40000000), the two masks that let an actor rename another member. The
// db package cannot import permissions, so the literal sits here and
// TestManageNicknamesMaskMatchesPermissions in db_test pins it.
const manageNicknamesOrAdmin = int64(8388608 | 1073741824)

// SetDisplayNameAsModerator writes targetID's display_name (nil clears it) on
// behalf of actorID and returns the replaced value; it is the moderator
// nickname route's one write. Authority is re-read live in the same write
// transaction, not trusted from the caller's cached check: the actor must hold
// MANAGE_NICKNAMES or ADMINISTRATOR in the OR of their roles and strictly
// outrank the target by top role position. Failing either, an actor that is
// not a real account, or a target that no longer exists returns ErrOutranked
// with nothing written. ErrNotFound is only the row vanishing between the rank
// read and the nickname read. The single writer connection means no other
// write can interleave between the checks and the UPDATE.
// change, the target's own profile edit) can interleave between the checks
// and the UPDATE.
func (d *DB) SetDisplayNameAsModerator(ctx context.Context, actorID, targetID int64, name *string) (old *string, err error) {
	if actorID <= 0 || actorID == targetID {
		return nil, fmt.Errorf("SetDisplayNameAsModerator: %w", ErrOutranked)
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("SetDisplayNameAsModerator begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if nicknamePreCheckHook != nil {
		nicknamePreCheckHook()
	}
	var holds bool
	if err := tx.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
		                 WHERE ur.user_id = ? AND (r.permissions & ?) != 0)`,
		actorID, manageNicknamesOrAdmin,
	).Scan(&holds); err != nil {
		return nil, fmt.Errorf("SetDisplayNameAsModerator actor bit: %w", err)
	}
	if !holds {
		return nil, fmt.Errorf("SetDisplayNameAsModerator: %w", ErrOutranked)
	}
	if !strictlyOutranks(ctx, tx, actorID, targetID) {
		return nil, fmt.Errorf("SetDisplayNameAsModerator: %w", ErrOutranked)
	}

	if err := tx.QueryRowContext(ctx, `SELECT display_name FROM users WHERE id = ?`, targetID).Scan(&old); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("SetDisplayNameAsModerator: %w", ErrNotFound)
		}
		return nil, fmt.Errorf("SetDisplayNameAsModerator read: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET display_name = ? WHERE id = ?`, name, targetID); err != nil {
		return nil, fmt.Errorf("SetDisplayNameAsModerator write: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("SetDisplayNameAsModerator commit: %w", err)
	}
	return old, nil
}

// nicknamePreCheckHook, when non-nil, runs inside SetDisplayNameAsModerator's
// transaction before the authority re-read. Test-only (nil in production).
var nicknamePreCheckHook func()
