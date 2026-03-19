package db

import "fmt"

// ListInvites returns all invites ordered by creation time descending.
func (d *DB) ListInvites() ([]*Invite, error) {
	rows, err := d.sqlDB.Query(
		`SELECT id, code, created_by, max_uses, use_count, expires_at, revoked, created_at
		 FROM invites ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("ListInvites: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var invites []*Invite
	for rows.Next() {
		inv := &Invite{}
		var revoked int
		if err := rows.Scan(
			&inv.ID, &inv.Code, &inv.CreatedBy, &inv.MaxUses,
			&inv.Uses, &inv.ExpiresAt, &revoked, &inv.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("ListInvites scan: %w", err)
		}
		inv.Revoked = revoked != 0
		invites = append(invites, inv)
	}
	return invites, rows.Err()
}
