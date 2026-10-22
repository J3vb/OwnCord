package db

import (
	"context"
	"database/sql"
)

// deciderAuthority reads userID's role permissions and ban state fresh,
// inside tx (P2 review): the shared re-read DecideAppealTx, AssignAppealTx
// and forceReassignGuarded's checkAuthority all use, so a bit revoked or a
// ban landed between a caller's earlier authorization and this write is
// caught here rather than trusted stale. ok=false means the user no longer
// holds a role at all (erased, or a dangling role).
func deciderAuthority(ctx context.Context, tx *sql.Tx, userID int64) (rolePerms int64, banned bool, banExpires *string, ok bool) {
	// The OR of every held role's mask: a bit granted by a lower-ranked role
	// still authorises the decision.
	rows, err := tx.QueryContext(ctx,
		`SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`, userID)
	if err != nil {
		return 0, false, nil, false
	}
	held := 0
	for rows.Next() {
		var p int64
		if scanErr := rows.Scan(&p); scanErr != nil {
			rows.Close() //nolint:errcheck
			return 0, false, nil, false
		}
		rolePerms |= p
		held++
	}
	rows.Close() //nolint:errcheck
	if rows.Err() != nil || held == 0 {
		return 0, false, nil, false
	}
	if err := tx.QueryRowContext(ctx,
		`SELECT banned, ban_expires FROM users WHERE id = ?`, userID,
	).Scan(&banned, &banExpires); err != nil {
		return 0, false, nil, false
	}
	return rolePerms, banned, banExpires, true
}
