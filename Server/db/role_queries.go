package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/permissions"
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
		Hoist:       r.Hoist != 0,
		Mentionable: r.Mentionable != 0,
	}
}

// MemberRoles is every role a member holds: Top is the highest-position role
// (ties by lowest id, the one users.role_id mirrors), Perms the OR of all held
// permission masks, IDs the held role ids with the top role first.
type MemberRoles struct {
	Top   Role
	Perms int64
	IDs   []int64
	// Masks holds each held role's own permission mask, in the same order as
	// IDs, for the callers that must resolve a role's channel override against
	// that role's mask (Held).
	Masks []int64
}

// Held returns the held roles as permission grants carrying only the role id
// and mask (no override), top role first: the shape permissions.Checker.Subject
// takes.
func (m *MemberRoles) Held() []permissions.RoleGrant {
	out := make([]permissions.RoleGrant, len(m.IDs))
	for i, id := range m.IDs {
		out[i] = permissions.RoleGrant{RoleID: id, Perms: m.Masks[i]}
	}
	return out
}

// Effective collapses the held roles to one Role for the callers that carry a
// single *Role for an authority decision: the identity (ID, Name, Position) is
// the TOP role, which is what rank and ownership checks read, and Permissions
// is the OR of every held mask, which is what server-level permission checks
// read. It is not a real role row and must never be written back.
func (m *MemberRoles) Effective() *Role {
	r := m.Top
	if m.Top.Color != nil {
		c := *m.Top.Color
		r.Color = &c
	}
	r.Permissions = m.Perms
	return &r
}

// ErrLastRole is returned when removing a role would leave a member with none.
var ErrLastRole = errors.New("member must keep at least one role")

// syncTopRoleTx mirrors the member's top held role into users.role_id inside
// the caller's transaction. It is the only writer of users.role_id that
// follows a user_roles change.
func syncTopRoleTx(ctx context.Context, q *dbgen.Queries, userID int64) error {
	if err := q.SyncTopRole(ctx, userID); err != nil {
		return fmt.Errorf("syncTopRole: %w", err)
	}
	return nil
}

// GetMemberRoles returns every role userID holds, or (nil, nil) when the user
// holds none (unknown user included).
func (d *DB) GetMemberRoles(ctx context.Context, userID int64) (*MemberRoles, error) {
	rows, err := d.q.ListUserRoles(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("GetMemberRoles: %w", err)
	}
	if len(rows) == 0 {
		return nil, nil
	}
	m := &MemberRoles{Top: *roleFromGen(rows[0]), IDs: make([]int64, 0, len(rows))}
	for _, r := range rows {
		m.Perms |= r.Permissions
		m.IDs = append(m.IDs, r.ID)
		m.Masks = append(m.Masks, r.Permissions)
	}
	return m, nil
}

// AddUserRole grants roleID to userID (a no-op when already held) and
// re-mirrors the top role, in one writer transaction.
func (d *DB) AddUserRole(ctx context.Context, userID, roleID int64) error {
	_, err := d.GrantUserRole(ctx, userID, roleID)
	return err
}

// GrantUserRole is AddUserRole that also reports whether a row was inserted:
// false means the member already held the role and nothing changed.
func (d *DB) GrantUserRole(ctx context.Context, userID, roleID int64) (bool, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("AddUserRole begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, userID, roleID)
	if err != nil {
		return false, fmt.Errorf("AddUserRole insert: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("AddUserRole rows: %w", err)
	}
	if err := syncTopRoleTx(ctx, d.q.WithTx(tx), userID); err != nil {
		return false, fmt.Errorf("AddUserRole: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("AddUserRole commit: %w", err)
	}
	return n > 0, nil
}

// RemoveUserRole revokes roleID from userID and re-mirrors the top role, in one
// writer transaction. It returns ErrLastRole, changing nothing, when the
// member holds roleID as their only role.
func (d *DB) RemoveUserRole(ctx context.Context, userID, roleID int64) error {
	_, err := d.RevokeUserRole(ctx, userID, roleID)
	return err
}

// RevokeUserRole is RemoveUserRole that also reports whether a row was
// deleted: false means the member did not hold the role (for example a
// concurrent duplicate request already removed it) and nothing changed.
func (d *DB) RevokeUserRole(ctx context.Context, userID, roleID int64) (bool, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("RemoveUserRole begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := d.q.WithTx(tx)
	n, err := q.CountUserRoles(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("RemoveUserRole count: %w", err)
	}
	if n <= 1 {
		held, err := q.ListRoleIDsByUser(ctx, userID)
		if err != nil {
			return false, fmt.Errorf("RemoveUserRole list: %w", err)
		}
		if slices.Contains(held, roleID) {
			return false, fmt.Errorf("RemoveUserRole: %w", ErrLastRole)
		}
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`, userID, roleID)
	if err != nil {
		return false, fmt.Errorf("RemoveUserRole delete: %w", err)
	}
	deleted, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("RemoveUserRole rows: %w", err)
	}
	if err := syncTopRoleTx(ctx, q, userID); err != nil {
		return false, fmt.Errorf("RemoveUserRole: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("RemoveUserRole commit: %w", err)
	}
	return deleted > 0, nil
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

// GetRoleForUser returns only the member's TOP role (the one users.role_id
// mirrors): fine for a name, colour or position, never for a permission mask,
// which is the OR over every held role (GetMemberRoles.Perms). Returns
// (nil, nil) when the user holds no role.
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
func (d *DB) CreateRole(ctx context.Context, name string, color *string, perms int64, position int, hoist, mentionable bool) (*Role, error) {
	r, err := d.q.CreateRole(ctx, dbgen.CreateRoleParams{
		Name:        name,
		Color:       color,
		Permissions: perms,
		Position:    int64(position),
		Hoist:       boolToInt64(hoist),
		Mentionable: boolToInt64(mentionable),
	})
	if err != nil {
		return nil, fmt.Errorf("CreateRole: %w", err)
	}
	return roleFromGen(r), nil
}

func boolToInt64(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// UpdateRole overwrites a role's mutable columns. is_default is deliberately
// not writable: which role is the fallback is a schema decision.
//
// A position change moves the top role of every member who holds this role
// next to another one, so the same transaction re-mirrors users.role_id for
// them (syncTopRoleTx). The returned ids are those multi-role holders, whose
// role order may have changed; nil when the position did not move.
func (d *DB) UpdateRole(ctx context.Context, id int64, name string, color *string, perms int64, position int, hoist, mentionable bool) ([]int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("UpdateRole begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := d.q.WithTx(tx)
	old, err := q.GetRolePosition(ctx, id)
	found := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("UpdateRole read position: %w", err)
	}
	if err := q.UpdateRole(ctx, dbgen.UpdateRoleParams{
		Name:        name,
		Color:       color,
		Permissions: perms,
		Position:    int64(position),
		Hoist:       boolToInt64(hoist),
		Mentionable: boolToInt64(mentionable),
		ID:          id,
	}); err != nil {
		return nil, fmt.Errorf("UpdateRole: %w", err)
	}
	var resynced []int64
	if found && old != int64(position) {
		if resynced, err = resyncMultiRoleHoldersTx(ctx, q, []int64{id}); err != nil {
			return nil, fmt.Errorf("UpdateRole: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("UpdateRole commit: %w", err)
	}
	return resynced, nil
}

// resyncMultiRoleHoldersTx re-mirrors users.role_id for every member who holds
// one of roleIDs and at least one other role, in the caller's transaction, and
// returns those members' ids in ascending order. A member with a single role
// has nothing to re-rank.
func resyncMultiRoleHoldersTx(ctx context.Context, q *dbgen.Queries, roleIDs []int64) ([]int64, error) {
	seen := make(map[int64]struct{})
	for _, rid := range roleIDs {
		holders, err := q.ListMultiRoleHoldersOfRole(ctx, rid)
		if err != nil {
			return nil, fmt.Errorf("list multi-role holders of %d: %w", rid, err)
		}
		for _, uid := range holders {
			seen[uid] = struct{}{}
		}
	}
	ids := slices.Sorted(maps.Keys(seen))
	for _, uid := range ids {
		if err := syncTopRoleTx(ctx, q, uid); err != nil {
			return nil, err
		}
	}
	return ids, nil
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
// The same transaction re-mirrors users.role_id for every member who holds a
// moved role next to another one, and returns those members' ids.
func (d *DB) SetRolePositions(ctx context.Context, positions map[int64]int) ([]int64, error) {
	if len(positions) == 0 {
		return nil, nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("SetRolePositions begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := d.q.WithTx(tx)
	// Sorted so concurrent reorders always take the rows in the same order.
	for _, id := range slices.Sorted(maps.Keys(positions)) {
		if err := q.SetRolePosition(ctx, dbgen.SetRolePositionParams{
			Position: int64(positions[id]),
			ID:       id,
		}); err != nil {
			return nil, fmt.Errorf("SetRolePositions update %d: %w", id, err)
		}
	}
	resynced, err := resyncMultiRoleHoldersTx(ctx, q, slices.Sorted(maps.Keys(positions)))
	if err != nil {
		return nil, fmt.Errorf("SetRolePositions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("SetRolePositions commit: %w", err)
	}
	return resynced, nil
}

// DeleteRoleReassigning deletes roleID, drops its channel_overrides rows and
// its user_roles rows, gives fallbackRoleID to every member left with no role,
// and re-mirrors users.role_id (syncTopRoleTx) for every member who held
// roleID, all in one writer transaction: a member must never be observable
// pointing at a role row that no longer exists or holding no role, and a stale
// override would silently apply to whichever role reused the id. A member who
// holds another role keeps it and is NOT given the fallback.
//
// Returns the ids of every member who held roleID so the caller can invalidate
// their cached permissions and re-sync their clients.
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
	// A member whose mirror still names the role but who has no user_roles row
	// for it (an inconsistent pre-067 write) is reassigned too.
	stale, err := d.usersMirroringRoleTx(ctx, tx, roleID)
	if err != nil {
		return nil, err
	}
	for _, id := range stale {
		if !slices.Contains(moved, id) {
			moved = append(moved, id)
		}
	}
	// channel_overrides and user_roles cascade on delete in the production
	// schema, but both deletes are explicit so the behaviour does not depend on
	// the foreign-key pragma being on for this connection.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM channel_overrides WHERE role_id = ?`, roleID,
	); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning drop overrides: %w", err)
	}
	// The category template rows of the role go the same way.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM category_overrides WHERE role_id = ?`, roleID,
	); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning drop category overrides: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM user_roles WHERE role_id = ?`, roleID,
	); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning drop holders: %w", err)
	}
	for _, uid := range moved {
		n, err := q.CountUserRoles(ctx, uid)
		if err != nil {
			return nil, fmt.Errorf("DeleteRoleReassigning count roles: %w", err)
		}
		if n == 0 {
			if err := q.AddUserRole(ctx, dbgen.AddUserRoleParams{UserID: uid, RoleID: fallbackRoleID}); err != nil {
				return nil, fmt.Errorf("DeleteRoleReassigning give fallback: %w", err)
			}
		}
		if err := syncTopRoleTx(ctx, q, uid); err != nil {
			return nil, fmt.Errorf("DeleteRoleReassigning: %w", err)
		}
	}
	if err := q.DeleteRole(ctx, roleID); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning delete: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning commit: %w", err)
	}
	return moved, nil
}

// usersMirroringRoleTx lists the users whose users.role_id mirror names roleID.
func (d *DB) usersMirroringRoleTx(ctx context.Context, tx *sql.Tx, roleID int64) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM users WHERE role_id = ?`, roleID)
	if err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning list mirrors: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("DeleteRoleReassigning scan mirror: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("DeleteRoleReassigning mirrors rows: %w", err)
	}
	return ids, nil
}
