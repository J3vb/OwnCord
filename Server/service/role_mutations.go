package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// RoleUpdateResult reports what an update changed, from the pre-update row, so callers need no re-read.
type RoleUpdateResult struct {
	// PermsChanged is set when the mask moved: cached masks and every channel's audience for the role must be
	// re-derived.
	PermsChanged bool
	// Renamed is set when the name changed. Clients key a member's role by NAME, so members of a renamed role
	// lose color, grouping and gated affordances until reconnect unless sent a member_update.
	Renamed bool
	// ResyncedMembers lists members holding the role next to another whose top role was re-derived because the
	// position moved.
	ResyncedMembers []int64
}

// checkExpectedPermissions refuses an edit from a stale copy: nil skips, else it must equal the stored mask.
func checkExpectedPermissions(expected *int64, role *db.Role) error {
	if expected != nil && *expected != role.Permissions {
		return fmt.Errorf("%w: role permissions changed since it was loaded", ErrConflict)
	}
	return nil
}

func (s *RoleService) updateRoleLocked(ctx context.Context, actorID, roleID int64, in RoleInput) (updated *db.Role, res RoleUpdateResult, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	actor, err := s.actorRole(ctx, actorID)
	if err != nil {
		return nil, RoleUpdateResult{}, err
	}
	role, err := s.st.GetRoleByID(ctx, roleID)
	if err != nil {
		return nil, RoleUpdateResult{}, fmt.Errorf("%w: failed to fetch role: %w", ErrInternal, err)
	}
	if role == nil {
		return nil, RoleUpdateResult{}, fmt.Errorf("%w: role not found", ErrNotFound)
	}
	if err := requireBelowActor(actor, role); err != nil {
		return nil, RoleUpdateResult{}, err
	}
	// Compared under s.mu against the row just read, so two editors with the same copy cannot both win.
	if err := checkExpectedPermissions(in.ExpectedPermissions, role); err != nil {
		return nil, RoleUpdateResult{}, err
	}

	name := role.Name
	if in.Name != nil {
		if name, err = s.validateName(ctx, *in.Name, role.ID); err != nil {
			return nil, RoleUpdateResult{}, err
		}
	}
	color := role.Color
	if in.Color != nil {
		if color, err = validateColor(in.Color); err != nil {
			return nil, RoleUpdateResult{}, err
		}
	}
	perms := role.Permissions
	if in.Permissions != nil {
		perms = *in.Permissions & permissions.AllPerms
		if err := requireGrantable(actor, role.Permissions, perms); err != nil {
			return nil, RoleUpdateResult{}, err
		}
	}
	position := role.Position
	if in.Position != nil {
		position = *in.Position
		if err := validatePosition(actor, position); err != nil {
			return nil, RoleUpdateResult{}, err
		}
		// Positions stay unique (see CreateRole); moving onto another role's slot is refused.
		if position != role.Position {
			existing, err := s.st.ListRoles(ctx)
			if err != nil {
				return nil, RoleUpdateResult{}, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
			}
			for _, rl := range existing {
				if rl.ID != role.ID && rl.Position == position {
					return nil, RoleUpdateResult{}, fmt.Errorf("%w: position %d is already used by another role", ErrBadRequest, position)
				}
			}
		}
	}

	hoist, mentionable := in.flagsOver(role.Hoist, role.Mentionable)

	resynced, err := s.st.UpdateRole(ctx, role.ID, name, color, perms, position, hoist, mentionable)
	if err != nil {
		return nil, RoleUpdateResult{}, fmt.Errorf("%w: failed to update role: %w", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_update", "role", role.ID,
		fmt.Sprintf("updated role %s (permissions=%#x position=%d hoist=%t mentionable=%t)", name, perms, position, hoist, mentionable))
	slog.Info("role updated", "actor_id", actorID, "role_id", role.ID, "name", name)

	updated = &db.Role{
		ID:          role.ID,
		Name:        name,
		Color:       color,
		Permissions: perms,
		Position:    position,
		IsDefault:   role.IsDefault,
		Hoist:       hoist,
		Mentionable: mentionable,
	}
	res = RoleUpdateResult{
		PermsChanged:    perms != role.Permissions,
		Renamed:         name != role.Name,
		ResyncedMembers: resynced,
	}
	return updated, res, nil
}

// deleteRoleLocked removes a role below the actor's rank, moving its members to the default role. Returns the
// deleted role, the fallback and the moved member ids for the caller to invalidate and re-sync.
func (s *RoleService) deleteRoleLocked(ctx context.Context, actorID, roleID int64) (deleted, fallback *db.Role, movedUserIDs []int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	actor, err := s.actorRole(ctx, actorID)
	if err != nil {
		return nil, nil, nil, err
	}
	role, err := s.st.GetRoleByID(ctx, roleID)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: failed to fetch role: %w", ErrInternal, err)
	}
	if role == nil {
		return nil, nil, nil, fmt.Errorf("%w: role not found", ErrNotFound)
	}
	if err := requireBelowActor(actor, role); err != nil {
		return nil, nil, nil, err
	}
	// Belt and braces: the position rule already puts the owner out of reach, but naming the seeded owner keeps
	// hand-edited positions from making the server ownerless.
	if permissions.IsOwner(role.ID, role.Position) {
		return nil, nil, nil, fmt.Errorf("%w: the Owner role cannot be deleted", ErrBadRequest)
	}
	if role.IsDefault {
		return nil, nil, nil, fmt.Errorf("%w: the default role cannot be deleted — every member falls back to it", ErrBadRequest)
	}

	fallback, err = s.st.GetDefaultRole(ctx)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: failed to resolve the default role: %w", ErrInternal, err)
	}
	if fallback == nil {
		// Fail closed: without a fallback the members would be orphaned on a deleted role id.
		return nil, nil, nil, fmt.Errorf("%w: no default role is configured", ErrInternal)
	}
	if err := requireOwnerGrantOnlyAssign(actor, role.Permissions|fallback.Permissions); err != nil {
		return nil, nil, nil, err
	}

	movedUserIDs, err = s.st.DeleteRoleReassigning(ctx, role.ID, fallback.ID)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: failed to delete role: %w", ErrInternal, err)
	}
	if s.perms != nil {
		for _, uid := range movedUserIDs {
			s.perms.InvalidateUser(uid)
		}
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_delete", "role", role.ID,
		fmt.Sprintf("deleted role %s (%d members held it; those left with no role now have %s)", role.Name, len(movedUserIDs), fallback.Name))
	slog.Warn("role deleted", "actor_id", actorID, "role_id", role.ID, "name", role.Name,
		"members_affected", len(movedUserIDs))
	return role, fallback, movedUserIDs, nil
}

// reorderRolesLocked rewrites the positions of every role the actor may manage. orderedIDs is
// highest-rank-first and must name exactly the roles strictly below the actor: a partial list is refused
// rather than leaving omitted roles in place.
func (s *RoleService) reorderRolesLocked(ctx context.Context, actorID int64, orderedIDs []int64) (updated []*db.Role, resynced []int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	actor, err := s.actorRole(ctx, actorID)
	if err != nil {
		return nil, nil, err
	}
	roles, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
	}

	manageable := make(map[int64]*db.Role, len(roles))
	for _, r := range roles {
		if r.Position < actor.Position {
			manageable[r.ID] = r
		}
	}
	if len(orderedIDs) != len(manageable) {
		return nil, nil, fmt.Errorf("%w: the order must list all %d roles below your own rank", ErrBadRequest, len(manageable))
	}
	seen := make(map[int64]bool, len(orderedIDs))
	for _, id := range orderedIDs {
		if seen[id] {
			return nil, nil, fmt.Errorf("%w: role %d listed twice", ErrBadRequest, id)
		}
		seen[id] = true
		if _, ok := manageable[id]; !ok {
			// Covers "unknown role" and "role at or above your rank"; deliberately indistinguishable.
			return nil, nil, fmt.Errorf("%w: role %d is not yours to reorder", ErrForbidden, id)
		}
	}
	if len(orderedIDs) >= actor.Position {
		return nil, nil, fmt.Errorf("%w: too many roles to place below your own rank", ErrBadRequest)
	}

	// Spread the roles through the whole range below the actor instead of a gapless block: CreateRole's default
	// placement takes the highest free slot below the actor and an N..1 block leaves none, wedging role
	// creation. Each role takes its proportional share, the k-th from the bottom at k/(N+1) of the actor's
	// position (a fixed stride collapses to 1 as N nears the actor's position). len(orderedIDs) < actor.Position
	// holds above, so positions are strictly decreasing, distinct, at least 1 and below the actor.
	positions := make(map[int64]int, len(orderedIDs))
	for i, id := range orderedIDs {
		positions[id] = actor.Position * (len(orderedIDs) - i) / (len(orderedIDs) + 1)
	}
	resynced, err = s.st.SetRolePositions(ctx, positions)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to reorder roles: %w", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_reorder", "role", 0,
		fmt.Sprintf("reordered %d roles", len(orderedIDs)))
	slog.Info("roles reordered", "actor_id", actorID, "count", len(orderedIDs))

	updated, err = s.st.ListRoles(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
	}
	return updated, resynced, nil
}
