package service

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// RoleService owns create/edit/delete/reorder of roles, the only writer of the
// roles table outside migrations. Every mutation is checked against the ACTOR's
// role position, not a bit alone: MANAGE_ROLES says "may manage roles", the
// hierarchy says "which ones". Without it any holder could edit the role above
// them or grant themselves ADMINISTRATOR through a role they create (the hole
// ChangeUserRole closed for assignment).
type RoleService struct {
	st    Store
	perms *PermissionService
	// notifier receives each committed mutation's fan-out; nil is a no-op. Always
	// called outside mu.
	notifier PermissionChangeNotifier
	// mu serializes the read-check-write mutations: position uniqueness and the role
	// cap are enforced against a ListRoles snapshot, not a DB constraint, so
	// interleaved mutations could both see the same free slot.
	mu syncutil.Mutex
}

// NewRoleService creates a RoleService.
func NewRoleService(st Store, perms *PermissionService) *RoleService {
	return &RoleService{st: st, perms: perms}
}

const (
	// maxRoleNameLen bounds the name so a label cannot blow up every member list and
	// permission modal.
	maxRoleNameLen = 32
	// maxRoles bounds how many roles a server holds. Reorder spreads positions
	// through the range below the actor, so N must stay under the owner position
	// (100) for every role to get a distinct slot.
	maxRoles = 64
)

// hexColorRe matches the CSS hex forms the client renders (#rgb, #rrggbb).
// Anything else is rejected, not normalized: the value is written straight into a
// style attribute.
var hexColorRe = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

// RoleInput carries a role's mutable fields. Pointer fields mean "leave unchanged"
// on update; on create a nil Position means "just below the actor".
type RoleInput struct {
	Name        *string
	Color       *string // points at "" to clear the color
	Permissions *int64
	Position    *int
	// Hoist and Mentionable are nil to leave unchanged (false on create).
	Hoist       *bool
	Mentionable *bool
	// ExpectedPermissions is the mask the caller loaded before editing. UpdateRole
	// refuses with ErrConflict and writes nothing if it differs; nil skips the check.
	ExpectedPermissions *int64
}

// flagsOver returns the requested hoist and mentionable flags, defaulting to the
// given current values.
func (in RoleInput) flagsOver(hoist, mentionable bool) (bool, bool) {
	if in.Hoist != nil {
		hoist = *in.Hoist
	}
	if in.Mentionable != nil {
		mentionable = *in.Mentionable
	}
	return hoist, mentionable
}

// RoleWithMembers is a role plus its holder count, which makes the delete
// confirmation honest.
type RoleWithMembers struct {
	db.Role
	MemberCount int `json:"member_count"`
}

// actorRole loads the actor's role through the permission cache and verifies
// MANAGE_ROLES (ADMINISTRATOR bypasses). Every failure is Forbidden: an
// unresolvable role must never authorize a mutation.
func (s *RoleService) actorRole(ctx context.Context, actorID int64) (*db.Role, error) {
	if s.perms == nil {
		return nil, fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load actor role", ErrForbidden)
	}
	if !permissions.HasServerPerm(role.Perms, permissions.ManageRoles) {
		return nil, fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(permissions.ManageRoles))
	}
	return role.Effective(), nil
}

// requireBelowActor enforces the edit/delete/reorder hierarchy rule: the target
// must sit strictly below the actor, equality included, so a peer cannot rewrite
// a role they both hold.
func requireBelowActor(actor *db.Role, target *db.Role) error {
	if target.Position >= actor.Position {
		return fmt.Errorf("%w: cannot manage a role at or above your own rank", ErrForbidden)
	}
	return nil
}

// requireGrantable enforces "you cannot hand out what you do not hold": every
// bit ADDED must be in the actor's mask. Removing a bit the actor lacks is
// allowed (de-escalation; refusing it would leave an over-permissioned role
// unwindable except by an admin). ADMINISTRATOR bypasses.
func requireGrantable(actor *db.Role, oldPerms, newPerms int64) error {
	if err := requireOwnerGrantOnly(actor, (oldPerms^newPerms)&permissions.OwnerGrantOnly); err != nil {
		return err
	}
	if permissions.HasAdmin(actor.Permissions) {
		return nil
	}
	added := newPerms &^ oldPerms
	if missing := added &^ actor.Permissions; missing != 0 {
		return fmt.Errorf("%w: cannot grant a permission your own role lacks (%s)",
			ErrForbidden, permissions.Name(missing&-missing))
	}
	return nil
}

// validateName trims, bounds and uniqueness-checks a role name; excludeID is the
// role being renamed (0 on create) so a no-op rename is not a collision.
func (s *RoleService) validateName(ctx context.Context, raw string, excludeID int64) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: name is required", ErrBadRequest)
	}
	if len([]rune(name)) > maxRoleNameLen {
		return "", fmt.Errorf("%w: name must be at most %d characters", ErrBadRequest, maxRoleNameLen)
	}
	existing, err := s.st.GetRoleByName(ctx, name)
	if err != nil {
		return "", fmt.Errorf("%w: failed to check role name: %w", ErrInternal, err)
	}
	if existing != nil && existing.ID != excludeID {
		return "", fmt.Errorf("%w: a role named %q already exists", ErrBadRequest, existing.Name)
	}
	return name, nil
}

// validateColor normalizes an optional color: nil means unset, "" clears it.
func validateColor(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	c := strings.TrimSpace(*raw)
	if c == "" {
		return nil, nil
	}
	if !hexColorRe.MatchString(c) {
		return nil, fmt.Errorf("%w: color must be a hex value like #5865F2", ErrBadRequest)
	}
	c = strings.ToUpper(c)
	return &c, nil
}

// validatePosition bounds a position: non-negative and strictly below the actor.
func validatePosition(actor *db.Role, pos int) error {
	if pos < 0 {
		return fmt.Errorf("%w: position must not be negative", ErrBadRequest)
	}
	if pos >= actor.Position {
		return fmt.Errorf("%w: cannot place a role at or above your own rank", ErrForbidden)
	}
	return nil
}

// ListRoles returns every role, highest position first, with member counts,
// gated on MANAGE_ROLES like the mutations.
func (s *RoleService) ListRoles(ctx context.Context, actorID int64) ([]RoleWithMembers, error) {
	if _, err := s.actorRole(ctx, actorID); err != nil {
		return nil, err
	}
	roles, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
	}
	counts, err := s.st.CountRoleMembers(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to count role members: %w", ErrInternal, err)
	}
	out := make([]RoleWithMembers, 0, len(roles))
	for _, r := range roles {
		out = append(out, RoleWithMembers{Role: *r, MemberCount: counts[r.ID]})
	}
	return out, nil
}

// createRoleLocked creates a role strictly below the actor's rank.
func (s *RoleService) createRoleLocked(ctx context.Context, actorID int64, in RoleInput) (*db.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	actor, err := s.actorRole(ctx, actorID)
	if err != nil {
		return nil, err
	}
	if in.Name == nil {
		return nil, fmt.Errorf("%w: name is required", ErrBadRequest)
	}
	name, err := s.validateName(ctx, *in.Name, 0)
	if err != nil {
		return nil, err
	}
	color, err := validateColor(in.Color)
	if err != nil {
		return nil, err
	}

	// Unknown bits are dropped, not rejected (as the channel override handlers do): a
	// wider mask than this build knows must not persist bits nothing enforces.
	perms := int64(0)
	if in.Permissions != nil {
		perms = *in.Permissions & permissions.AllPerms
	}
	// Every bit is "added" on create, so check against 0.
	if err := requireGrantable(actor, 0, perms); err != nil {
		return nil, err
	}

	existing, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
	}
	if len(existing) >= maxRoles {
		return nil, fmt.Errorf("%w: server already has the maximum of %d roles", ErrBadRequest, maxRoles)
	}

	// Positions must stay unique: hierarchy comparisons use >=/<=, so roles sharing a
	// position read as equal rank and can never manage each other's members.
	taken := make(map[int]bool, len(existing))
	for _, rl := range existing {
		taken[rl.Position] = true
	}

	// Default placement is the highest free slot below the actor: directly below when
	// free, else stepping past occupied positions so a second create does not collide.
	position := actor.Position - 1
	if in.Position != nil {
		position = *in.Position
		// Rank first: an at/above-rank position is a hierarchy violation (ErrForbidden)
		// even if also occupied.
		if err := validatePosition(actor, position); err != nil {
			return nil, err
		}
		if taken[position] {
			return nil, fmt.Errorf("%w: position %d is already used by another role", ErrBadRequest, position)
		}
	} else {
		for position > 0 && taken[position] {
			position--
		}
		if position <= 0 {
			return nil, fmt.Errorf("%w: no free position below your rank — reorder existing roles first", ErrBadRequest)
		}
		if err := validatePosition(actor, position); err != nil {
			return nil, err
		}
	}

	hoist, mentionable := in.flagsOver(false, false)
	role, err := s.st.CreateRole(ctx, name, color, perms, position, hoist, mentionable)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create role: %w", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_create", "role", role.ID,
		fmt.Sprintf("created role %s (permissions=%#x position=%d hoist=%t mentionable=%t)", role.Name, role.Permissions, role.Position, role.Hoist, role.Mentionable))
	slog.Info("role created", "actor_id", actorID, "role_id", role.ID, "name", role.Name)
	return role, nil
}

// RoleUpdateResult reports what an update changed, from the pre-update row
// already read, so callers need no re-read.
type RoleUpdateResult struct {
	// PermsChanged is set when the mask moved: cached masks and every channel's
	// audience for the role must be re-derived instead of the cheap roles_update
	// broadcast.
	PermsChanged bool
	// Renamed is set when the name changed. Clients key a member's role by NAME
	// (member_update, ready), so members of a renamed role lose their color,
	// member-list group and gated affordances until reconnect unless the caller sends
	// each a member_update.
	Renamed bool
	// ResyncedMembers lists members holding the role next to another whose top role
	// was re-derived because the position moved.
	ResyncedMembers []int64
}

// checkExpectedPermissions refuses an edit from a stale copy: nil skips, else it
// must equal the stored mask.
func checkExpectedPermissions(expected *int64, role *db.Role) error {
	if expected != nil && *expected != role.Permissions {
		return fmt.Errorf("%w: role permissions changed since it was loaded", ErrConflict)
	}
	return nil
}

// updateRoleLocked applies a partial change to a role below the actor's rank and
// returns what it moved.
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
	// Compared under s.mu against the row just read, so two editors with the same
	// copy cannot both win.
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
		// Positions stay unique (see CreateRole). Moving onto another role's slot is
		// refused; re-stating our own is fine.
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

// AllRoles is the unscoped role list (highest position first, no actor filter or
// member counts) behind the roles_update broadcast every mutation ends with.
// ListRoles is the actor-scoped admin view and not interchangeable.
func (s *RoleService) AllRoles(ctx context.Context) ([]*db.Role, error) {
	roles, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
	}
	return roles, nil
}

// deleteRoleLocked removes a role below the actor's rank, moving its members to
// the default role. Returns the deleted role, the fallback and the moved member
// ids for the caller to invalidate and re-sync.
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
	// Belt and braces: the position rule already puts the owner out of reach, but
	// naming the seeded owner keeps hand-edited positions from making the server
	// ownerless.
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
		// Fail closed: without a fallback the members would be orphaned on a role id
		// that no longer exists.
		return nil, nil, nil, fmt.Errorf("%w: no default role is configured", ErrInternal)
	}
	if err := requireOwnerGrantOnlyAssign(actor, role.Permissions|fallback.Permissions); err != nil {
		return nil, nil, nil, err
	}

	movedUserIDs, err = s.st.DeleteRoleReassigning(ctx, role.ID, fallback.ID)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: failed to delete role: %w", ErrInternal, err)
	}
	// The members' cached masks are the deleted role's until this drops them.
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

// reorderRolesLocked rewrites the positions of every role the actor may manage.
// orderedIDs is highest-rank-first and must name exactly the roles strictly below
// the actor: a partial list is refused rather than leaving omitted roles in place,
// which is how positions collided before.
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
			// Covers "unknown role" and "role at or above your rank"; deliberately
			// indistinguishable.
			return nil, nil, fmt.Errorf("%w: role %d is not yours to reorder", ErrForbidden, id)
		}
	}
	if len(orderedIDs) >= actor.Position {
		return nil, nil, fmt.Errorf("%w: too many roles to place below your own rank", ErrBadRequest)
	}

	// Spread the roles through the whole range below the actor instead of a gapless
	// block. CreateRole's default placement takes the highest free slot below the
	// actor and an N..1 block leaves none, wedging role creation (the "reorder
	// existing roles first" refusal re-compacted to the same block). Each role takes
	// its proportional share, the k-th from the bottom at k/(N+1) of the actor's
	// position: a fixed stride's integer division collapses to 1 as N nears the
	// actor's position (50 roles re-compacted to 50..1), while proportional spacing
	// uses the whole range (50 roles land on 98, 96, ... 2) and reproduces the
	// shipped 80/60/40/20 for four roles. len(orderedIDs) < actor.Position holds
	// above, so actor.Position/(N+1) >= 1: positions are strictly decreasing,
	// distinct, at least 1 and below the actor.
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

// AffectedUserIDs returns the users holding roleID and whether the lookup
// succeeded. Handlers use it to invalidate exactly the cache entries a role edit
// touches; on ok=false they must invalidate everything, since a nil list read as
// "nobody" leaves stale masks.
func (s *RoleService) AffectedUserIDs(ctx context.Context, roleID int64) ([]int64, bool) {
	ids, err := s.st.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		slog.Warn("role service: failed to list role members", "role_id", roleID, "err", err)
		return nil, false
	}
	return ids, true
}
