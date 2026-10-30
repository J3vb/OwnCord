package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// Role mutations with their side effects: each exported mutation runs the locked
// write (role.go), then, AFTER the commit and OUTSIDE RoleService.mu, invalidates
// the cached permissions it moved and tells the PermissionChangeNotifier. Outside
// mu because the hub's worker re-reads the role list at send time, so holding the
// lock across the enqueue buys nothing and invites lock-order trouble.
// Invalidation always precedes the notifier call: the hub resolves visibility
// through the same cache.

// roleRevokeInline is how many moved members a role delete releases directly; the
// worker releases every affected member's held topics before their sidebar.
const roleRevokeInline = 32

// SetPermissionNotifier installs the live fan-out port. Call it before the
// server starts serving; nil leaves mutations without a live fan-out.
func (s *RoleService) SetPermissionNotifier(n PermissionChangeNotifier) { s.notifier = n }

func (s *RoleService) notifyRoles(f RoleFanout) {
	if s.notifier != nil {
		s.notifier.RoleChanged(f)
	}
}

// CreateRole creates a role strictly below the actor's rank. A new role has no
// members, so only the role list moved.
func (s *RoleService) CreateRole(ctx context.Context, actorID int64, in RoleInput) (*db.Role, error) {
	role, err := s.createRoleLocked(ctx, actorID, in)
	if err != nil {
		return nil, err
	}
	s.notifyRoles(RoleFanout{Roles: true})
	return role, nil
}

// UpdateRole applies a partial change to a role below the actor's rank and returns
// the role and what the change moved.
// Members are read before the update and again after, and both lists are evicted:
// a concurrent role assignment can land on either side of the write (an extra id
// is a wasted eviction, a missing one a stale grant). Any edit drops the members'
// cached snapshots, not only a permission change, because the cache also holds
// the role row (name, colour, position) that GetRoleForUser serves without a store
// read. When the member list was unreadable every cached mask is dropped and every
// connected user counts as affected.
// A rename re-keys every member (clients hold a role name, not an id), so members
// get a member_update. A permission edit may move READ_MESSAGES either way, so
// every channel's audience for this role is re-derived.
func (s *RoleService) UpdateRole(ctx context.Context, actorID, roleID int64, in RoleInput) (updated *db.Role, res RoleUpdateResult, err error) {
	affected, affectedOK := s.AffectedUserIDs(ctx, roleID)

	updated, res, err = s.updateRoleLocked(ctx, actorID, roleID, in)
	if err != nil {
		return nil, RoleUpdateResult{}, err
	}
	// A member assigned between the first read and the commit can have cached the
	// pre-edit mask after its own invalidation, so the holders are re-read and merged.
	// The write has committed: the re-read must not fail because the caller left.
	if affectedOK {
		after, afterOK := s.AffectedUserIDs(context.WithoutCancel(ctx), roleID)
		if afterOK {
			affected = mergeUserIDs(affected, after)
		} else {
			affectedOK = false
		}
	}

	if affectedOK {
		invalidateUsers(s.perms, affected)
	} else if s.perms != nil {
		s.perms.InvalidateAll()
	}

	fan := RoleFanout{Roles: true}
	if res.Renamed && affectedOK {
		fan.MemberUpdate = affected
	} else if len(res.ResyncedMembers) > 0 {
		// A moved position re-derived the top role of multi-role holders.
		fan.MemberUpdate = res.ResyncedMembers
	}
	if res.PermsChanged {
		if affectedOK {
			fan.Visibility = affected
		} else {
			fan.AllConnected = true
		}
	}
	s.notifyRoles(fan)
	return updated, res, nil
}

// DeleteRole removes a role below the actor's rank, moving its members onto the
// default role. Returns the deleted role, the fallback and the moved members' ids.
// Their cached masks are dropped inside the locked delete; this then releases the
// first roleRevokeInline members' unreadable topics directly and leaves the rest
// of the fan-out to the worker. The fallback role's name is read at send time.
func (s *RoleService) DeleteRole(ctx context.Context, actorID, roleID int64) (deleted, fallback *db.Role, movedUserIDs []int64, err error) {
	deleted, fallback, movedUserIDs, err = s.deleteRoleLocked(ctx, actorID, roleID)
	if err != nil {
		return nil, nil, nil, err
	}
	if s.notifier != nil {
		for _, uid := range movedUserIDs[:min(len(movedUserIDs), roleRevokeInline)] {
			s.notifier.RevokeUnreadable(uid)
		}
	}
	s.notifyRoles(RoleFanout{Visibility: movedUserIDs, MemberUpdate: movedUserIDs, Roles: true})
	return deleted, fallback, movedUserIDs, nil
}

// ReorderRoles rewrites the positions of every role the actor may manage.
// Positions carry no permission bits, so no channel changes visibility, but a
// cached role snapshot holds the old position the hierarchy checks read, so the
// whole cache is flushed.
func (s *RoleService) ReorderRoles(ctx context.Context, actorID int64, orderedIDs []int64) ([]*db.Role, error) {
	updated, resynced, err := s.reorderRolesLocked(ctx, actorID, orderedIDs)
	if err != nil {
		return nil, err
	}
	if s.perms != nil {
		s.perms.InvalidateAll()
	}
	// A multi-role member's top role can move with the positions; the mirror was
	// re-derived in the same transaction, so tell everyone the new top.
	s.notifyRoles(RoleFanout{Roles: true, MemberUpdate: resynced})
	return updated, nil
}

// mergeUserIDs returns the ids in a or b, each once, a's order first.
func mergeUserIDs(a, b []int64) []int64 {
	seen := make(map[int64]struct{}, len(a)+len(b))
	out := make([]int64, 0, len(a)+len(b))
	for _, list := range [][]int64{a, b} {
		for _, id := range list {
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			out = append(out, id)
		}
	}
	return out
}
