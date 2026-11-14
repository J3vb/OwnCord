package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// ModerationCoverage is who can work the report queue: the active accounts that can, and
// the roles below Owner that carry the ModerateMembers bit themselves.
type ModerationCoverage struct {
	// Moderators counts approved, not banned, non-system accounts, not under erasure, that
	// hold any role whose permissions include Administrator or ModerateMembers.
	Moderators int
	// ModerateRoles counts non-owner roles whose own permissions include ModerateMembers;
	// Administrator does not count here.
	ModerateRoles int
}

// ReadModerationCoverage reads both counts in one statement. The Moderators arm mirrors
// permissions.CanModerate (Administrator or ModerateMembers on the OR of the held role
// masks); the two bits are independent, so "any held role has either bit" is the same test.
// The owner role is the seeded OwnerRoleID or any role at OwnerRolePosition, the same two
// arms permissions.IsOwner accepts, and is left out of the role count.
func (d *DB) ReadModerationCoverage(ctx context.Context) (ModerationCoverage, error) {
	var c ModerationCoverage
	err := d.reader.QueryRowContext(ctx,
		`SELECT
		   (SELECT COUNT(*) FROM users
		     WHERE registration_status = 'active'
		       AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
		                    WHERE ur.user_id = users.id AND (r.permissions & ?) != 0)
		       AND `+notBannedClause+underErasureClause+`),
		   (SELECT COUNT(*) FROM roles
		     WHERE id <> ? AND position < ? AND (permissions & ?) != 0)`,
		permissions.Administrator|permissions.ModerateMembers,
		permissions.OwnerRoleID, permissions.OwnerRolePosition, permissions.ModerateMembers,
	).Scan(&c.Moderators, &c.ModerateRoles)
	if err != nil {
		return ModerationCoverage{}, fmt.Errorf("ReadModerationCoverage: %w", err)
	}
	return c, nil
}
