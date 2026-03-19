package db

import (
	"database/sql"
	"errors"
	"fmt"
)

// GetRoleByID returns the role with the given ID, or nil if not found.
func (d *DB) GetRoleByID(id int64) (*Role, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, name, color, permissions, position, is_default FROM roles WHERE id = ?`,
		id,
	)
	r := &Role{}
	var isDefault int
	err := row.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &isDefault)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRoleByID: %w", err)
	}
	r.IsDefault = isDefault != 0
	return r, nil
}

// ListRoles returns all roles ordered by position descending.
func (d *DB) ListRoles() ([]*Role, error) {
	rows, err := d.sqlDB.Query(
		`SELECT id, name, color, permissions, position, is_default FROM roles ORDER BY position DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("ListRoles: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var roles []*Role
	for rows.Next() {
		r := &Role{}
		var isDefault int
		if err := rows.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &isDefault); err != nil {
			return nil, fmt.Errorf("ListRoles scan: %w", err)
		}
		r.IsDefault = isDefault != 0
		roles = append(roles, r)
	}
	return roles, rows.Err()
}
