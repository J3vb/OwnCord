package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// ModerationCoverage is who can work the report queue: the active accounts that can, and
// the roles below Owner that carry the ModerateMembers bit themselves.
type ModerationCoverage struct {
	// Moderators counts approved, not banned, non-system accounts that are the owner, hold
	// the seeded Admin role (admin-class by id, as in CountAdminClassAccounts) or a role with
	// Administrator, or hold a role with ModerateMembers.
	Moderators int
	// ModerateRoles counts non-owner roles whose own permissions include ModerateMembers;
	// Administrator does not count here.
	ModerateRoles int
}

// ReadModerationCoverage reads both counts in one statement. The owner role is the seeded
// OwnerRoleID or any role at OwnerRolePosition, the same two arms permissions.IsOwner accepts.
func (d *DB) ReadModerationCoverage(ctx context.Context) (ModerationCoverage, error) {
	var c ModerationCoverage
	err := d.reader.QueryRowContext(ctx,
		`SELECT
		   (SELECT COUNT(*) FROM users
		     WHERE registration_status = 'active'
		       AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role_id IN
		             (SELECT id FROM roles
		               WHERE id IN (?, ?) OR position >= ? OR (permissions & ?) != 0 OR (permissions & ?) != 0))
		       AND `+notBannedClause+underErasureClause+`),
		   (SELECT COUNT(*) FROM roles
		     WHERE id <> ? AND position < ? AND (permissions & ?) != 0)`,
		permissions.OwnerRoleID, permissions.AdminRoleID, permissions.OwnerRolePosition, permissions.Administrator, permissions.ModerateMembers,
		permissions.OwnerRoleID, permissions.OwnerRolePosition, permissions.ModerateMembers,
	).Scan(&c.Moderators, &c.ModerateRoles)
	if err != nil {
		return ModerationCoverage{}, fmt.Errorf("ReadModerationCoverage: %w", err)
	}
	return c, nil
}
