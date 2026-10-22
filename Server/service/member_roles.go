package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── Several roles per member (WP 6.3c) ──────────────────────────────────────

// ErrLastRole is returned by RemoveUserRole when the role is the member's
// only one: a member always keeps at least one role. It is a conflict (409).
var ErrLastRole = fmt.Errorf("%w: a member must keep at least one role", ErrConflict)

// MemberRoleStore is the slice of the store the multi-role assignment methods
// use. It is declared here, not on Store, so the Store surface does not grow;
// *db.DB satisfies it.
type MemberRoleStore interface {
	AddUserRole(ctx context.Context, userID, roleID int64) error
	RemoveUserRole(ctx context.Context, userID, roleID int64) error
}

func (s *ModerationService) memberRoleStore() (MemberRoleStore, error) {
	rs, ok := s.st.(MemberRoleStore)
	if !ok {
		return nil, fmt.Errorf("%w: member role store unavailable", ErrInternal)
	}
	return rs, nil
}

// AddUserRole grants roleID to the target next to the roles they already hold.
// The checks are ChangeUserRole's (AuthorizeRoleChange): MANAGE_ROLES, the actor
// outranks the target's top role, and the role sits below the actor's top role.
// Granting a role the target already holds is a no-op: no write, audit row or
// fan-out. The cached permissions are dropped before the live clients are told.
func (s *ModerationService) AddUserRole(ctx context.Context, actorID, targetID, roleID int64) (*db.Role, error) {
	_, target, role, err := s.AuthorizeRoleChange(ctx, actorID, targetID, roleID)
	if err != nil {
		return nil, err
	}
	rs, err := s.memberRoleStore()
	if err != nil {
		return nil, err
	}
	held, err := s.st.GetMemberRoles(ctx, targetID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read member roles: %w", ErrInternal, err)
	}
	if held != nil && slices.Contains(held.IDs, roleID) {
		return role, nil
	}
	if err := rs.AddUserRole(ctx, targetID, roleID); err != nil {
		return nil, fmt.Errorf("%w: failed to add role: %w", ErrInternal, err)
	}
	// Drop the cached snapshot first: the hub resolves visibility through it.
	s.perms.InvalidateUser(targetID)

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_add", "user", targetID,
		fmt.Sprintf("added role %s to %s", role.Name, target.Username))
	slog.Info("role added", "actor_id", actorID, "target_id", targetID, "role_id", roleID)
	s.roleAssigned(targetID)
	return role, nil
}

// RemoveUserRole revokes roleID from the target under the same checks as
// AddUserRole. Removing the member's only role answers ErrLastRole and changes
// nothing; the count and the delete share one write transaction, so two
// concurrent removals of a member's last two roles cannot both succeed.
// Removing a role the target does not hold is a no-op.
func (s *ModerationService) RemoveUserRole(ctx context.Context, actorID, targetID, roleID int64) (*db.Role, error) {
	_, target, role, err := s.AuthorizeRoleChange(ctx, actorID, targetID, roleID)
	if err != nil {
		return nil, err
	}
	rs, err := s.memberRoleStore()
	if err != nil {
		return nil, err
	}
	// The held check here only skips the audit row and fan-out of a no-op; the
	// last-role guard itself is the store's, inside its own transaction.
	if held, err := s.st.GetMemberRoles(ctx, targetID); err == nil && held != nil && !slices.Contains(held.IDs, roleID) {
		return role, nil
	}
	if err := rs.RemoveUserRole(ctx, targetID, roleID); err != nil {
		if errors.Is(err, db.ErrLastRole) {
			return nil, ErrLastRole
		}
		return nil, fmt.Errorf("%w: failed to remove role: %w", ErrInternal, err)
	}
	s.perms.InvalidateUser(targetID)

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_remove", "user", targetID,
		fmt.Sprintf("removed role %s from %s", role.Name, target.Username))
	slog.Info("role removed", "actor_id", actorID, "target_id", targetID, "role_id", roleID)
	s.roleAssigned(targetID)
	return role, nil
}
