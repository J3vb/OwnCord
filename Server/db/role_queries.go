package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
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
func (d *DB) GetRoleByID(ctx context.Context, id int64) (*Role, error) {
	r, err := d.q.GetRoleByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRoleByID: %w", err)
	}
	return roleFromGen(r), nil
}

// ListRoles returns all roles ordered by position descending.
func (d *DB) ListRoles(ctx context.Context) ([]*Role, error) {
	rows, err := d.q.ListRoles(ctx)
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
func (d *DB) GetRoleForUser(ctx context.Context, userID int64) (*Role, error) {
	r, err := d.q.GetRoleForUser(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRoleForUser: %w", err)
	}
	return roleFromGen(r), nil
}

// GetRoleByName returns the role whose name matches name case-insensitively,
// or nil if there is none. Case-insensitive because migration 023 enforces
// uniqueness under the same collation — the lookup and the constraint must
// agree, or "Moderator" and "moderator" become two roles the client (which
// matches names case-insensitively) cannot tell apart.
func (d *DB) GetRoleByName(ctx context.Context, name string) (*Role, error) {
	r, err := d.q.GetRoleByName(ctx, name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRoleByName: %w", err)
	}
	return roleFromGen(r), nil
}

// GetDefaultRole returns the role new members are created with and deleted
// roles' members fall back to. Returns (nil, nil) when no role is flagged
// default — callers must treat that as a configuration error, not a licence to
// leave members pointing at a deleted role.
func (d *DB) GetDefaultRole(ctx context.Context) (*Role, error) {
	r, err := d.q.GetDefaultRole(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetDefaultRole: %w", err)
	}
	return roleFromGen(r), nil
}

// CreateRole inserts a role and returns it. is_default is always 0: exactly one
// role is the default and it is seeded, never created through the API.
func (d *DB) CreateRole(ctx context.Context, name string, color *string, perms int64, position int) (*Role, error) {
	r, err := d.q.CreateRole(ctx, dbgen.CreateRoleParams{
		Name:        name,
		Color:       color,
		Permissions: perms,
		Position:    int64(position),
	})
	if err != nil {
		return nil, fmt.Errorf("CreateRole: %w", err)
	}
	return roleFromGen(r), nil
}

// UpdateRole overwrites a role's mutable columns. is_default is deliberately
// not writable: which role is the fallback is a schema decision.
func (d *DB) UpdateRole(ctx context.Context, id int64, name string, color *string, perms int64, position int) error {
	if err := d.q.UpdateRole(ctx, dbgen.UpdateRoleParams{
		Name:        name,
		Color:       color,
		Permissions: perms,
		Position:    int64(position),
		ID:          id,
	}); err != nil {
		return fmt.Errorf("UpdateRole: %w", err)
	}
	return nil
}

// ListUserIDsByRole returns the ids of every user currently holding roleID.
// Used to invalidate exactly the permission-cache entries a role change
// affects instead of dropping the whole cache.
func (d *DB) ListUserIDsByRole(ctx context.Context, roleID int64) ([]int64, error) {
	ids, err := d.q.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		return nil, fmt.Errorf("ListUserIDsByRole: %w", err)
	}
	return ids, nil
}

// CountRoleMembers returns member counts keyed by role id. Roles with no
// members are absent from the map rather than present with a zero.
func (d *DB) CountRoleMembers(ctx context.Context) (map[int64]int, error) {
	rows, err := d.q.CountRoleMembers(ctx)
	if err != nil {
		return nil, fmt.Errorf("CountRoleMembers: %w", err)
	}
	counts := make(map[int64]int, len(rows))
	for _, row := range rows {
		counts[row.RoleID] = int(row.MemberCount)
	}
	return counts, nil
}

// SetRolePositions writes new positions for several roles in one writer
// transaction, so a reader can never observe a half-applied reorder (which
// would briefly duplicate or invert the hierarchy the permission checks read).
func (d *DB) SetRolePositions(ctx context.Context, positions map[int64]int) error {
	if len(positions) == 0 {
		return nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("SetRolePositions begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := d.q.WithTx(tx)
	// Sorted so concurrent reorders always take the rows in the same order.
	for _, id := range slices.Sorted(maps.Keys(positions)) {
		if err := q.SetRolePosition(ctx, dbgen.SetRolePositionParams{
			Position: int64(positions[id]),
			ID:       id,
		}); err != nil {
			return fmt.Errorf("SetRolePositions update %d: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("SetRolePositions commit: %w", err)
	}
	return nil
}

// DeleteRoleReassigning deletes roleID after moving every member onto
// fallbackRoleID and dropping the role's channel_overrides rows, all in one
// writer transaction: a member must never be observable pointing at a role row
// that no longer exists, and a stale override would silently apply to whichever
// role reused the id.
//
// Returns the ids of the reassigned members so the caller can invalidate their
// cached permissions and re-sync their clients.
func (d *DB) DeleteRoleReassigning(ctx context.Context, roleID, fallbackRoleID int64) ([]int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := d.q.WithTx(tx)
	moved, err := q.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning list members: %w", err)
	}
	// One UPDATE for every member, not one per member.
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET role_id = ? WHERE role_id = ?`, fallbackRoleID, roleID,
	); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning reassign: %w", err)
	}
	// channel_overrides cascades on delete in the production schema, but the
	// delete is explicit so the behaviour does not depend on the foreign-key
	// pragma being on for this connection.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM channel_overrides WHERE role_id = ?`, roleID,
	); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning drop overrides: %w", err)
	}
	if err := q.DeleteRole(ctx, roleID); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning delete: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning commit: %w", err)
	}
	return moved, nil
}

// GetUserWithRole returns the user and their role in a single query.
// Returns (nil, nil, nil) when the user is not found.
func (d *DB) GetUserWithRole(ctx context.Context, userID int64) (*User, *Role, error) {
	row := d.reader.QueryRowContext(ctx,
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
