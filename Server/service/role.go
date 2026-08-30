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

// RoleService owns create/edit/delete/reorder of roles. It is the only writer
// of the roles table outside migrations.
//
// Every mutation is checked against the ACTOR's role position rather than
// against a bit alone: MANAGE_ROLES says "may manage roles", the hierarchy says
// "which ones". Without the position rule any holder of the bit could edit the
// role above them — or grant themselves ADMINISTRATOR through a role they
// create — which is the same privilege-escalation hole ChangeUserRole closed
// for role *assignment*.
type RoleService struct {
	st    Store
	perms *PermissionService
	// mu serializes the read-check-write mutations: position uniqueness and
	// the role cap are enforced against a ListRoles snapshot, not by a DB
	// constraint, so two interleaved mutations can both see the same free
	// slot. Single-process server — one lock covers every writer.
	mu syncutil.Mutex
}

// NewRoleService creates a RoleService.
func NewRoleService(st Store, perms *PermissionService) *RoleService {
	return &RoleService{st: st, perms: perms}
}

const (
	// maxRoleNameLen bounds the name so a role label cannot be used to blow up
	// every member list and permission modal that renders it.
	maxRoleNameLen = 32
	// maxRoles bounds how many roles a server can hold. Reorder normalizes
	// positions into 1..N strictly below the actor, so N must stay well under
	// the owner position (100) for the hierarchy to remain expressible.
	maxRoles = 64
)

// hexColorRe matches the two CSS hex forms the client renders (#rgb, #rrggbb).
// Anything else — named colors, rgb(), a bare hex without the hash — is
// rejected rather than normalized: the value is written straight into a style
// attribute by the desktop client and the admin panel.
var hexColorRe = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

// RoleInput carries the mutable fields of a role. Pointer fields are "leave
// unchanged" on update; on create a nil Position means "just below the actor".
type RoleInput struct {
	Name        *string
	Color       *string // points at "" to clear the color
	Permissions *int64
	Position    *int
}

// RoleWithMembers is a role plus how many users currently hold it. The count
// is what makes the delete confirmation honest ("12 members move to Member").
type RoleWithMembers struct {
	db.Role
	MemberCount int `json:"member_count"`
}

// actorRole loads the actor's role through the permission cache and verifies
// MANAGE_ROLES (ADMINISTRATOR bypasses). Every failure is Forbidden: an
// unresolvable role must never authorize a role mutation.
func (s *RoleService) actorRole(ctx context.Context, actorID int64) (*db.Role, error) {
	if s.perms == nil {
		return nil, fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load actor role", ErrForbidden)
	}
	if !permissions.HasServerPerm(role.Permissions, permissions.ManageRoles) {
		return nil, fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(permissions.ManageRoles))
	}
	return role, nil
}

// requireBelowActor enforces the hierarchy rule shared by edit, delete and
// reorder: the target role must sit strictly below the actor's own position.
// Equality is refused too, so a peer cannot rewrite the role they both hold.
func requireBelowActor(actor *db.Role, target *db.Role) error {
	if target.Position >= actor.Position {
		return fmt.Errorf("%w: cannot manage a role at or above your own rank", ErrForbidden)
	}
	return nil
}

// requireGrantable enforces "you cannot hand out what you do not hold": every
// bit being ADDED must be present in the actor's own mask. Removing a bit the
// actor lacks is allowed — that is a de-escalation, and refusing it would make
// an over-permissioned role impossible to wind down by anyone but an admin.
// ADMINISTRATOR bypasses, which is what lets the owner grant anything.
func requireGrantable(actor *db.Role, oldPerms, newPerms int64) error {
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

// validateName trims, bounds and uniqueness-checks a role name. excludeID is
// the role being renamed (0 on create) so a no-op rename is not a collision.
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

// validateColor normalizes an optional color. A nil pointer means "unset"; an
// empty string clears it.
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

// validatePosition bounds a requested position: non-negative and strictly below
// the actor's own rank.
func validatePosition(actor *db.Role, pos int) error {
	if pos < 0 {
		return fmt.Errorf("%w: position must not be negative", ErrBadRequest)
	}
	if pos >= actor.Position {
		return fmt.Errorf("%w: cannot place a role at or above your own rank", ErrForbidden)
	}
	return nil
}

// ListRoles returns every role, highest position first, with member counts.
// Gated on MANAGE_ROLES like the mutations — the panel section that shows it is.
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

// CreateRole creates a role strictly below the actor's own rank.
func (s *RoleService) CreateRole(ctx context.Context, actorID int64, in RoleInput) (*db.Role, error) {
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

	// Unknown bits are dropped rather than rejected, matching the channel
	// override handlers — a client sending a wider mask than this build knows
	// about must not be able to persist bits nothing enforces.
	perms := int64(0)
	if in.Permissions != nil {
		perms = *in.Permissions & permissions.AllPerms
	}
	// Every bit is "added" on create, so the grantable check runs against 0.
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

	// Positions must stay unique: every hierarchy comparison uses >=/<=, so two
	// roles sharing a position read as equal rank and can never manage each
	// other's members. Track the slots already taken.
	taken := make(map[int]bool, len(existing))
	for _, rl := range existing {
		taken[rl.Position] = true
	}

	// Default placement is the highest free slot below the actor — directly
	// below when that is free, which is what a manager creating a deputy role
	// expects, but stepping past any occupied position so a second create does
	// not collide with the first.
	position := actor.Position - 1
	if in.Position != nil {
		position = *in.Position
		// Rank first: an at/above-rank position is a hierarchy violation
		// (ErrForbidden) regardless of whether it also happens to be occupied.
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

	role, err := s.st.CreateRole(ctx, name, color, perms, position)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create role: %w", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_create", "role", role.ID,
		fmt.Sprintf("created role %s (permissions=%#x position=%d)", role.Name, role.Permissions, role.Position))
	slog.Info("role created", "actor_id", actorID, "role_id", role.ID, "name", role.Name)
	return role, nil
}

// UpdateRole applies a partial change to a role below the actor's rank.
// Returns the updated role and whether the permission mask actually moved —
// the caller uses that to decide between a cheap roles_update broadcast and a
// full visibility re-sync.
func (s *RoleService) UpdateRole(ctx context.Context, actorID, roleID int64, in RoleInput) (updated *db.Role, permsChanged bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	actor, err := s.actorRole(ctx, actorID)
	if err != nil {
		return nil, false, err
	}
	role, err := s.st.GetRoleByID(ctx, roleID)
	if err != nil {
		return nil, false, fmt.Errorf("%w: failed to fetch role: %w", ErrInternal, err)
	}
	if role == nil {
		return nil, false, fmt.Errorf("%w: role not found", ErrNotFound)
	}
	if err := requireBelowActor(actor, role); err != nil {
		return nil, false, err
	}

	name := role.Name
	if in.Name != nil {
		if name, err = s.validateName(ctx, *in.Name, role.ID); err != nil {
			return nil, false, err
		}
	}
	color := role.Color
	if in.Color != nil {
		if color, err = validateColor(in.Color); err != nil {
			return nil, false, err
		}
	}
	perms := role.Permissions
	if in.Permissions != nil {
		perms = *in.Permissions & permissions.AllPerms
		if err := requireGrantable(actor, role.Permissions, perms); err != nil {
			return nil, false, err
		}
	}
	position := role.Position
	if in.Position != nil {
		position = *in.Position
		if err := validatePosition(actor, position); err != nil {
			return nil, false, err
		}
		// Positions must stay unique (see CreateRole): tied positions read
		// as equal rank in every >=/<= hierarchy comparison. Moving onto a
		// slot another role holds is refused; re-stating our own is fine.
		if position != role.Position {
			existing, err := s.st.ListRoles(ctx)
			if err != nil {
				return nil, false, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
			}
			for _, rl := range existing {
				if rl.ID != role.ID && rl.Position == position {
					return nil, false, fmt.Errorf("%w: position %d is already used by another role", ErrBadRequest, position)
				}
			}
		}
	}

	if err := s.st.UpdateRole(ctx, role.ID, name, color, perms, position); err != nil {
		return nil, false, fmt.Errorf("%w: failed to update role: %w", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_update", "role", role.ID,
		fmt.Sprintf("updated role %s (permissions=%#x position=%d)", name, perms, position))
	slog.Info("role updated", "actor_id", actorID, "role_id", role.ID, "name", name)

	return &db.Role{
		ID:          role.ID,
		Name:        name,
		Color:       color,
		Permissions: perms,
		Position:    position,
		IsDefault:   role.IsDefault,
	}, perms != role.Permissions, nil
}

// DeleteRole removes a role below the actor's rank, moving its members onto the
// default role. Returns the deleted role, the fallback its members landed on,
// and the ids of those members so the caller can invalidate and re-sync them.
func (s *RoleService) DeleteRole(ctx context.Context, actorID, roleID int64) (deleted, fallback *db.Role, movedUserIDs []int64, err error) {
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
	// Belt and braces: the position rule already puts the owner role out of
	// reach (nothing is above position 100), but the seeded owner is named
	// explicitly so a database whose positions were edited by hand cannot make
	// the server ownerless.
	if role.ID == permissions.OwnerRoleID || role.Position >= permissions.OwnerRolePosition {
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
		// Fail closed: without a fallback the members would be orphaned on a
		// role id that no longer exists.
		return nil, nil, nil, fmt.Errorf("%w: no default role is configured", ErrInternal)
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
		fmt.Sprintf("deleted role %s (%d members reassigned to %s)", role.Name, len(movedUserIDs), fallback.Name))
	slog.Warn("role deleted", "actor_id", actorID, "role_id", role.ID, "name", role.Name,
		"members_reassigned", len(movedUserIDs))
	return role, fallback, movedUserIDs, nil
}

// ReorderRoles rewrites the positions of every role the actor may manage.
// orderedIDs is highest-rank-first and must name exactly the set of roles
// strictly below the actor — a partial list is refused rather than silently
// leaving the omitted roles wherever they were, which is how positions
// collided in the first place.
//
// Positions are normalized to N..1, so they stay unique, stay strictly below
// the actor (N < actor.Position, enforced by maxRoles), and never collide with
// the untouched roles above the actor.
func (s *RoleService) ReorderRoles(ctx context.Context, actorID int64, orderedIDs []int64) ([]*db.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	actor, err := s.actorRole(ctx, actorID)
	if err != nil {
		return nil, err
	}
	roles, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
	}

	manageable := make(map[int64]*db.Role, len(roles))
	for _, r := range roles {
		if r.Position < actor.Position {
			manageable[r.ID] = r
		}
	}
	if len(orderedIDs) != len(manageable) {
		return nil, fmt.Errorf("%w: the order must list all %d roles below your own rank", ErrBadRequest, len(manageable))
	}
	seen := make(map[int64]bool, len(orderedIDs))
	for _, id := range orderedIDs {
		if seen[id] {
			return nil, fmt.Errorf("%w: role %d listed twice", ErrBadRequest, id)
		}
		seen[id] = true
		if _, ok := manageable[id]; !ok {
			// Covers both "unknown role" and "role at or above your rank"; the
			// two are deliberately indistinguishable to the caller.
			return nil, fmt.Errorf("%w: role %d is not yours to reorder", ErrForbidden, id)
		}
	}
	if len(orderedIDs) >= actor.Position {
		return nil, fmt.Errorf("%w: too many roles to place below your own rank", ErrBadRequest)
	}

	positions := make(map[int64]int, len(orderedIDs))
	for i, id := range orderedIDs {
		positions[id] = len(orderedIDs) - i
	}
	if err := s.st.SetRolePositions(ctx, positions); err != nil {
		return nil, fmt.Errorf("%w: failed to reorder roles: %w", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_reorder", "role", 0,
		fmt.Sprintf("reordered %d roles", len(orderedIDs)))
	slog.Info("roles reordered", "actor_id", actorID, "count", len(orderedIDs))

	updated, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list roles: %w", ErrInternal, err)
	}
	return updated, nil
}

// AffectedUserIDs returns the ids of the users holding roleID, and whether the
// lookup succeeded. Handlers use it to invalidate exactly the permission-cache
// entries a role edit touches; on ok=false the caller must fall back to a
// blanket invalidation — a nil list treated as "nobody" silently leaves stale
// masks in place.
func (s *RoleService) AffectedUserIDs(ctx context.Context, roleID int64) ([]int64, bool) {
	ids, err := s.st.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		slog.Warn("role service: failed to list role members", "role_id", roleID, "err", err)
		return nil, false
	}
	return ids, true
}
