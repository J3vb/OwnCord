package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// requireOwnerGrantOnly refuses a change to the bits in changed (already masked to
// permissions.OwnerGrantOnly) unless the actor is the owner or an Administrator. The owner-tier subset
// (permissions.OwnerOnlyGrant) is stricter: only the owner, so an Administrator cannot hand an owner-tier bit
// to a role and take the power withheld from ADMINISTRATOR. A no-op for a zero mask.
func requireOwnerGrantOnly(actor *db.Role, changed int64) error {
	if err := requireOwnerOnlyGrant(actor, changed); err != nil {
		return err
	}
	if changed == 0 || permissions.CanChangeOwnerGrantOnly(actor.Permissions, actor.ID, actor.Position) {
		return nil
	}
	return fmt.Errorf("%w: only the owner can change %s", ErrForbidden, permissions.Name(changed&-changed))
}

// requireOwnerOnlyGrant is the owner-tier half: a change touching a bit of
// permissions.OwnerOnlyGrant needs the owner, whatever else the actor holds.
func requireOwnerOnlyGrant(actor *db.Role, changed int64) error {
	ownerTier := changed & permissions.OwnerOnlyGrant
	if ownerTier == 0 || permissions.CanChangeOwnerOnlyGrant(actor.ID, actor.Position) {
		return nil
	}
	return fmt.Errorf("%w: only the owner can change %s", ErrForbidden, permissions.Name(ownerTier&-ownerTier))
}

// requireOwnerGrantOnlyAssign is the assignment form: only the owner-grant-only bits of mask count. It guards
// a role being assigned, removed, replaced or deleted (deleting takes the bits from its members, who fall
// back to the default). Only the owner or an Administrator may; MANAGE_ROLES alone is not enough.
func requireOwnerGrantOnlyAssign(actor *db.Role, mask int64) error {
	return requireOwnerGrantOnly(actor, mask&permissions.OwnerGrantOnly)
}

// requireHeldRolesReplaceable guards replacing all of a member's roles: those they hold are cleared, so an
// owner-grant-only bit on any of them is a change only the owner or an Administrator may make.
func (s *ModerationService) requireHeldRolesReplaceable(ctx context.Context, actor *db.Role, targetID int64) error {
	held, err := s.st.GetMemberRoles(ctx, targetID)
	if err != nil {
		return fmt.Errorf("%w: failed to read the member's roles: %w", ErrInternal, err)
	}
	if held == nil {
		return nil
	}
	return requireOwnerGrantOnlyAssign(actor, held.Perms)
}

// AuthorizeRoleChange runs every ChangeUserRole precondition (MANAGE_ROLES, target existence,
// actor-outranks-target, role existence, assign-below-own-rank) without mutating, authorization before
// existence as in BanUser. It lets a caller that does another mutation in the same request (admin PATCH
// /users/{id}) authorize the role change BEFORE committing the other. Returns the validated actor role,
// target user and target role. Replacing the member's roles also clears those they hold, so an
// owner-grant-only bit on any of them is checked too; AddUserRole and RemoveUserRole use
// authorizeRoleAssignment alone.
func (s *ModerationService) AuthorizeRoleChange(ctx context.Context, actorID, targetID, newRoleID int64) (actorRole *db.Role, target *db.User, newRole *db.Role, err error) {
	actorRole, target, newRole, err = s.authorizeRoleAssignment(ctx, actorID, targetID, newRoleID)
	if err != nil {
		return nil, nil, nil, err
	}
	if err := s.requireHeldRolesReplaceable(ctx, actorRole, targetID); err != nil {
		return nil, nil, nil, err
	}
	return actorRole, target, newRole, nil
}
