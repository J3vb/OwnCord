package db

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/owncord/server/db/dbgen"
)

// roleFromGen maps the sqlc-generated Role row to the domain Role model,
// narrowing the int64 position and converting the int64 is_default flag to a
// bool. Shared by all role reads that delegate to dbgen.
func roleFromGen(r dbgen.Role) *Role {
	return &Role{
		ID:          r.ID,
		Name:        r.Name,
		Color:       r.Color,
		Permissions: r.Permissions,
		Position:    int(r.Position),
		IsDefault:   r.IsDefault != 0,
	}
}

// GetRoleByID returns the role with the given ID, or nil if not found.
func (d *DB) GetRoleByID(id int64) (*Role, error) {
	r, err := d.q.GetRoleByID(dbCtx(), id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRoleByID: %w", err)
	}
	return roleFromGen(r), nil
}

// ListRoles returns all roles ordered by position descending.
func (d *DB) ListRoles() ([]*Role, error) {
	rows, err := d.q.ListRoles(dbCtx())
	if err != nil {
		return nil, fmt.Errorf("ListRoles: %w", err)
	}
	roles := make([]*Role, 0, len(rows))
	for _, r := range rows {
		roles = append(roles, roleFromGen(r))
	}
	return roles, nil
}

// GetRoleForUser returns only the role for a given user via a single JOIN.
// Unlike GetUserWithRole, this does not fetch sensitive user columns (password,
// TOTP secret). Use this on hot paths like permission checks.
// Returns (nil, nil) when the user is not found.
func (d *DB) GetRoleForUser(userID int64) (*Role, error) {
	r, err := d.q.GetRoleForUser(dbCtx(), userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRoleForUser: %w", err)
	}
	return roleFromGen(r), nil
}

// GetUserWithRole returns the user and their role in a single query.
// Returns (nil, nil, nil) when the user is not found.
func (d *DB) GetUserWithRole(userID int64) (*User, *Role, error) {
	row := d.sqlDB.QueryRow(
		`SELECT u.id, u.username, u.password, u.avatar, u.role_id,
		        u.totp_secret, u.status, u.created_at, u.last_seen,
		        u.banned, u.ban_reason, u.ban_expires,
		        r.id, r.name, r.color, r.permissions, r.position, r.is_default
		 FROM users u
		 JOIN roles r ON u.role_id = r.id
		 WHERE u.id = ?`,
		userID,
	)

	u := &User{}
	r := &Role{}
	var banned, isDefault int
	err := row.Scan(
		&u.ID, &u.Username, &u.PasswordHash, &u.Avatar, &u.RoleID,
		&u.TOTPSecret, &u.Status, &u.CreatedAt, &u.LastSeen,
		&banned, &u.BanReason, &u.BanExpires,
		&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &isDefault,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("GetUserWithRole: %w", err)
	}
	u.Banned = banned != 0
	r.IsDefault = isDefault != 0
	return u, r, nil
}
