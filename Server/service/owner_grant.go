package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// requireOwnerGrantOnly refuses a change to the bits in changed (already
// masked to permissions.OwnerGrantOnly, added or removed) unless the actor is
// the owner or an Administrator. The owner-tier subset (WP 8.4d,
// permissions.OwnerOnlyGrant) is stricter: only the owner may change it, so an
// Administrator cannot hand an owner-tier bit to a role and take the power the
// owner tier withholds from ADMINISTRATOR. It is a no-op for a zero mask.
func requireOwnerGrantOnly(actor *db.Role, changed int64) error {
	if err := requireOwnerOnlyGrant(actor, changed); err != nil {
		return err
	}
	if changed == 0 || permissions.CanChangeOwnerGrantOnly(actor.Permissions, actor.ID, actor.Position) {
		return nil
	}
	return fmt.Errorf("%w: only the owner can change %s", ErrForbidden, permissions.Name(changed&-changed))
}

// requireOwnerOnlyGrant is the owner-tier half of requireOwnerGrantOnly: a
// change touching a bit of permissions.OwnerOnlyGrant needs the owner,
// whatever else the actor holds. Same wording as the general refusal.
func requireOwnerOnlyGrant(actor *db.Role, changed int64) error {
	ownerTier := changed & permissions.OwnerOnlyGrant
	if ownerTier == 0 || permissions.CanChangeOwnerOnlyGrant(actor.ID, actor.Position) {
		return nil
	}
	return fmt.Errorf("%w: only the owner can change %s", ErrForbidden, permissions.Name(ownerTier&-ownerTier))
}

// requireOwnerGrantOnlyAssign is the assignment form of the rule: only the
// owner-grant-only bits of mask count. It guards a role being assigned,
// removed, replaced or deleted (deleting takes the bits from the role's
// members, and members left with no other role fall back to the default role,
// so its bits are checked too). Only the owner or an Administrator may,
// whatever bits the actor holds; MANAGE_ROLES alone is not enough.
func requireOwnerGrantOnlyAssign(actor *db.Role, mask int64) error {
	return requireOwnerGrantOnly(actor, mask&permissions.OwnerGrantOnly)
}

// requireHeldRolesReplaceable guards replacing all of a member's roles: the
// ones they hold now are cleared, so an owner-grant-only bit on any of them is
// a change only the owner or an Administrator may make.
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

// AuthorizeRoleChange runs every ChangeUserRole precondition — MANAGE_ROLES,
// target existence, the actor-outranks-target rule, role existence, and the
// assign-below-own-rank rule — without mutating anything, and in the same
// authorization-before-existence order as every other check in this file (see
// BanUser): an actor without MANAGE_ROLES learns nothing about which user ids
// exist. It exists so a caller that also performs another mutation in the
// same request (the admin PATCH /users/{id} handler, which can ban and
// role-change in one call) can authorize the role change *before* committing
// the other mutation: checking only at ChangeUserRole time means a refused
// role change is discovered only after the ban already landed, leaving a
// "failed" request half-applied (OC-0215). It returns the validated actor
// role, target user, and target role so callers that go on to commit (like
// ChangeUserRole) don't need to re-fetch any of them.
//
// Replacing the member's roles also clears the ones they hold now, so an
// owner-grant-only bit on any of them (WP 8.4a) is checked too;
// AddUserRole and RemoveUserRole leave the other roles in place and use
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
