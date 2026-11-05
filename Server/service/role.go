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

// roleStore is what RoleService reads and writes. *db.DB satisfies it.
type roleStore interface {
	db.Auditor
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	ListRoles(ctx context.Context) ([]*db.Role, error)
	GetRoleByName(ctx context.Context, name string) (*db.Role, error)
	GetDefaultRole(ctx context.Context) (*db.Role, error)
	CreateRole(ctx context.Context, name string, color *string, perms int64, position int, hoist, mentionable bool) (*db.Role, error)
	UpdateRole(ctx context.Context, id int64, name string, color *string, perms int64, position int, hoist, mentionable bool) ([]int64, error)
	SetRolePositions(ctx context.Context, positions map[int64]int) ([]int64, error)
	DeleteRoleReassigning(ctx context.Context, roleID, fallbackRoleID int64) ([]int64, error)
	ListUserIDsByRole(ctx context.Context, roleID int64) ([]int64, error)
	CountRoleMembers(ctx context.Context) (map[int64]int, error)
}

// RoleService owns create/edit/delete/reorder of roles, the only writer of the
// roles table outside migrations. Every mutation is checked against the ACTOR's
// role position, not a bit alone: MANAGE_ROLES says "may manage roles", the
// hierarchy says "which ones". Without it any holder could edit the role above
// them or grant themselves ADMINISTRATOR through a role they create (the hole
// ChangeUserRole closed for assignment).
type RoleService struct {
	st    roleStore
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
func NewRoleService(st roleStore, perms *PermissionService) *RoleService {
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
