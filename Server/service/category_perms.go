package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Category permission templates: a category carries override rows its synced channels
// follow. Writing a template row writes the same row on every synced channel in one
// transaction; it is copied, never inherited. Authorization is the channel override policy
// widened to everything written: the escalation guard runs over the bits written plus the
// bits already on the category row and every synced row overwritten (clearing a deny the
// actor lacks is a grant), and hierarchy rules apply to a role or member target. The guard
// runs inside the write transaction before any write, so a refusal leaves nothing written.

// CategoryPermStore is the persistence behind category permission templates; a Store
// that is not a *db.DB makes the operations answer ErrInternal. Kept beside Store
// because Store's surface is ratcheted (datastore_ratchet_test.go).
type CategoryPermStore interface {
	WriteCategoryRoleOverride(ctx context.Context, categoryID, roleID, allow, deny int64, guard db.CategoryOverrideGuard) ([]int64, error)
	ClearCategoryRoleOverride(ctx context.Context, categoryID, roleID int64, guard db.CategoryOverrideGuard) ([]int64, error)
	WriteCategoryUserOverride(ctx context.Context, categoryID, userID, allow, deny int64, guard db.CategoryOverrideGuard) ([]int64, error)
	ClearCategoryUserOverride(ctx context.Context, categoryID, userID int64, guard db.CategoryOverrideGuard) ([]int64, error)
	SyncChannelPermissions(ctx context.Context, channelID int64, guard db.ChannelSyncGuard) (db.ChannelSyncPlan, error)
	PreviewChannelSync(ctx context.Context, channelID, categoryID int64) (db.ChannelSyncPlan, error)
	ListCategoryRoleOverrides(ctx context.Context, categoryID int64) ([]db.ChannelRoleOverride, error)
	ListCategoryUserOverrides(ctx context.Context, categoryID int64) ([]db.ChannelUserOverride, error)
	ListSyncedChannelIDs(ctx context.Context) ([]int64, error)
	ChannelPermissionsSynced(ctx context.Context, channelID int64) (bool, error)
}

func (s *channelOverrides) catPermStore() (CategoryPermStore, error) {
	if s.cperm == nil || s.cats == nil {
		return nil, fmt.Errorf("%w: category storage unavailable", ErrInternal)
	}
	return s.cperm, nil
}

// AdminChannel is a channel as the admin list shows it: the row plus whether its
// overrides follow the category template. Admin-only.
type AdminChannel struct {
	db.Channel
	PermissionsSynced bool `json:"permissions_synced"`
}

// PermEffect is who had cached permissions dropped after override rows were copied or
// replaced. AffectedAll means the narrow list could not be read and a full flush ran (a
// missed eviction is a stale grant). Applied is false when no row changed.
type PermEffect struct {
	Applied       bool
	AffectedUsers []int64
	AffectedAll   bool
}

// CategoryOverrideResult is OverrideResult plus every synced channel the write rewrote,
// re-read after commit, already invalidated and visibility-refreshed.
type CategoryOverrideResult struct {
	OverrideResult
	Channels []db.Channel
}

// CategoryPermissions returns every role's template row on the category (zero masks when
// none) and the per-user rows; ErrNotFound when the category is gone.
func (s *channelOverrides) CategoryPermissions(ctx context.Context, categoryID int64) ([]db.ChannelRoleOverride, []db.ChannelUserOverride, error) {
	cp, err := s.catPermStore()
	if err != nil {
		return nil, nil, err
	}
	if _, err := s.requireCategory(ctx, categoryID); err != nil {
		return nil, nil, err
	}
	roles, err := cp.ListCategoryRoleOverrides(ctx, categoryID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to list category permissions: %w", ErrInternal, err)
	}
	users, err := cp.ListCategoryUserOverrides(ctx, categoryID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to list category user permissions: %w", ErrInternal, err)
	}
	return roles, users, nil
}

func (s *channelOverrides) requireCategory(ctx context.Context, id int64) (*db.ChannelCategory, error) {
	if id <= 0 {
		return nil, fmt.Errorf("invalid category id%.0w", ErrBadRequest)
	}
	cat, err := s.cats.GetChannelCategory(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch category: %w", ErrInternal, err)
	}
	if cat == nil {
		return nil, fmt.Errorf("category not found%.0w", ErrNotFound)
	}
	return cat, nil
}

// ChannelPermissionsSynced reports whether the channel's overrides follow its category's template.
func (s *channelOverrides) ChannelPermissionsSynced(ctx context.Context, channelID int64) (bool, error) {
	cp, err := s.catPermStore()
	if err != nil {
		return false, err
	}
	synced, err := cp.ChannelPermissionsSynced(ctx, channelID)
	if err != nil {
		return false, fmt.Errorf("%w: failed to read sync state: %w", ErrInternal, err)
	}
	return synced, nil
}

func requireGrantableAcross(actorRole *db.Role, allow, deny int64, rows ...db.OverrideBits) error {
	for _, r := range rows {
		allow |= r.Allow
		deny |= r.Deny
	}
	return requireGrantableChannelOverride(actorRole, allow, deny)
}

// categoryOverrideGuard is the guard a category write passes into the write transaction.
// A refusal is also recorded in *refused because the db layer wraps errors with the
// operation name and the API answers the bare text.
func categoryOverrideGuard(actorRole *db.Role, allow, deny int64, refused *error) db.CategoryOverrideGuard {
	return func(sc db.CategoryOverrideScope) error {
		rows := make([]db.OverrideBits, 0, len(sc.Channels)+1)
		rows = append(rows, sc.Category)
		for _, c := range sc.Channels {
			rows = append(rows, db.OverrideBits{Allow: c.Allow, Deny: c.Deny})
		}
		if err := requireGrantableAcross(actorRole, allow, deny, rows...); err != nil {
			*refused = err
			return err
		}
		return nil
	}
}

// resolveCategoryRoleTarget loads the target role and applies the role-hierarchy rule
// (strictly below the actor); the escalation guard runs later in the write transaction.
func (s *channelOverrides) resolveCategoryRoleTarget(ctx context.Context, actorRole *db.Role, roleID int64) (*db.Role, error) {
	role, err := s.st.GetRoleByID(ctx, roleID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch role: %w", ErrInternal, err)
	}
	if role == nil {
		return nil, fmt.Errorf("role not found%.0w", ErrNotFound)
	}
	if role.Position >= actorRole.Position {
		return nil, fmt.Errorf("cannot manage a role at or above your own rank%.0w", ErrForbidden)
	}
	return role, nil
}

func (s *channelOverrides) resolveCategoryUserTarget(ctx context.Context, actorRole *db.Role, userID int64) (*db.User, error) {
	user, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch user: %w", ErrInternal, err)
	}
	if user == nil {
		return nil, fmt.Errorf("user not found%.0w", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorRole, user); err != nil {
		return nil, err
	}
	return user, nil
}

// PutCategoryRoleOverride writes a role's template row on the category and every synced channel.
func (s *channelOverrides) PutCategoryRoleOverride(ctx context.Context, actorID int64, actorRole *db.Role, categoryID, roleID, allowRaw, denyRaw int64) (CategoryOverrideResult, error) {
	return s.categoryRoleMutation(ctx, actorID, actorRole, categoryID, roleID, allowRaw&permissions.AllPerms, denyRaw&permissions.AllPerms, false)
}

// DeleteCategoryRoleOverride clears a role's template row and its synced rows; gated like a write.
func (s *channelOverrides) DeleteCategoryRoleOverride(ctx context.Context, actorID int64, actorRole *db.Role, categoryID, roleID int64) (CategoryOverrideResult, error) {
	return s.categoryRoleMutation(ctx, actorID, actorRole, categoryID, roleID, 0, 0, true)
}

func (s *channelOverrides) categoryRoleMutation(ctx context.Context, actorID int64, actorRole *db.Role, categoryID, roleID, allow, deny int64, clear bool) (CategoryOverrideResult, error) {
	cp, err := s.catPermStore()
	if err != nil {
		return CategoryOverrideResult{}, err
	}
	cat, err := s.requireCategory(ctx, categoryID)
	if err != nil {
		return CategoryOverrideResult{}, err
	}
	role, err := s.resolveCategoryRoleTarget(ctx, actorRole, roleID)
	if err != nil {
		return CategoryOverrideResult{}, err
	}
	var refused error
	guard := categoryOverrideGuard(actorRole, allow, deny, &refused)
	var ids []int64
	if clear {
		ids, err = cp.ClearCategoryRoleOverride(ctx, categoryID, roleID, guard)
	} else {
		ids, err = cp.WriteCategoryRoleOverride(ctx, categoryID, roleID, allow, deny, guard)
	}
	if err := mapCategoryOverrideErr(err, refused); err != nil {
		return CategoryOverrideResult{}, err
	}

	tail := context.WithoutCancel(ctx)
	action, verb := "category_perms_update", "set"
	if clear {
		action, verb = "category_perms_clear", "cleared"
	}
	slog.Info("category permissions "+verb, "actor_id", actorID, "category_id", categoryID,
		"role_id", roleID, "allow", allow, "deny", deny, "channels", len(ids))
	db.WriteAudit(tail, s.st, actorID, action, "category", categoryID,
		fmt.Sprintf("%s overrides for role %s on category %s and %d synced channel(s) (allow=%#x deny=%#x)",
			verb, role.Name, cat.Name, len(ids), allow, deny))

	affected, all := s.roleOverrideAffected(ctx, roleID)
	res := CategoryOverrideResult{Channels: s.rereadChannels(tail, ids)}
	res.Role, res.Allow, res.Deny = role, allow, deny
	res.AffectedUsers, res.AffectedAll = affected, all
	s.applyCategoryEffects(res)
	return res, nil
}

// PutCategoryUserOverride writes a member's template row on the category and every synced channel.
func (s *channelOverrides) PutCategoryUserOverride(ctx context.Context, actorID int64, actorRole *db.Role, categoryID, userID, allowRaw, denyRaw int64) (CategoryOverrideResult, error) {
	return s.categoryUserMutation(ctx, actorID, actorRole, categoryID, userID, allowRaw&permissions.AllPerms, denyRaw&permissions.AllPerms, false)
}

// DeleteCategoryUserOverride clears a member's template row and its synced rows; gated like a write.
func (s *channelOverrides) DeleteCategoryUserOverride(ctx context.Context, actorID int64, actorRole *db.Role, categoryID, userID int64) (CategoryOverrideResult, error) {
	return s.categoryUserMutation(ctx, actorID, actorRole, categoryID, userID, 0, 0, true)
}

func (s *channelOverrides) categoryUserMutation(ctx context.Context, actorID int64, actorRole *db.Role, categoryID, userID, allow, deny int64, clear bool) (CategoryOverrideResult, error) {
	cp, err := s.catPermStore()
	if err != nil {
		return CategoryOverrideResult{}, err
	}
	cat, err := s.requireCategory(ctx, categoryID)
	if err != nil {
		return CategoryOverrideResult{}, err
	}
	user, err := s.resolveCategoryUserTarget(ctx, actorRole, userID)
	if err != nil {
		return CategoryOverrideResult{}, err
	}
	var refused error
	guard := categoryOverrideGuard(actorRole, allow, deny, &refused)
	var ids []int64
	if clear {
		ids, err = cp.ClearCategoryUserOverride(ctx, categoryID, userID, guard)
	} else {
		ids, err = cp.WriteCategoryUserOverride(ctx, categoryID, userID, allow, deny, guard)
	}
	if err := mapCategoryOverrideErr(err, refused); err != nil {
		return CategoryOverrideResult{}, err
	}

	tail := context.WithoutCancel(ctx)
	action, verb := "category_user_perms_update", "set"
	if clear {
		action, verb = "category_user_perms_clear", "cleared"
	}
	slog.Info("category user permissions "+verb, "actor_id", actorID, "category_id", categoryID,
		"user_id", userID, "allow", allow, "deny", deny, "channels", len(ids))
	db.WriteAudit(tail, s.st, actorID, action, "category", categoryID,
		fmt.Sprintf("%s overrides for user %s on category %s and %d synced channel(s) (allow=%#x deny=%#x)",
			verb, user.Username, cat.Name, len(ids), allow, deny))

	res := CategoryOverrideResult{Channels: s.rereadChannels(tail, ids)}
	res.User, res.Allow, res.Deny = user, allow, deny
	res.AffectedUsers = []int64{userID}
	s.applyCategoryEffects(res)
	return res, nil
}

// applyCategoryEffects runs post-commit work: drop cached permissions of everyone
// affected first (visibility resolves through that cache), then re-derive each rewritten
// channel's audience.
func (s *channelOverrides) applyCategoryEffects(res CategoryOverrideResult) {
	s.invalidatePermEffect(PermEffect{AffectedUsers: res.AffectedUsers, AffectedAll: res.AffectedAll})
	for i := range res.Channels {
		s.notifyAudience(&res.Channels[i])
	}
}

func mapCategoryOverrideErr(err, refused error) error {
	switch {
	case err == nil:
		return nil
	case refused != nil:
		return refused
	case errors.Is(err, db.ErrNotFound):
		return fmt.Errorf("category not found%.0w", ErrNotFound)
	default:
		return fmt.Errorf("%w: failed to save category permission: %w", ErrInternal, err)
	}
}

func (s *channelOverrides) rereadChannels(ctx context.Context, ids []int64) []db.Channel {
	out := make([]db.Channel, 0, len(ids))
	for _, id := range ids {
		ch, err := s.st.GetChannel(ctx, id)
		if err != nil || ch == nil {
			continue
		}
		out = append(out, *ch)
	}
	return out
}

// effectOfRows names who to invalidate after override rows for the given roles and
// members changed: each role's holders and each member. An unreadable role widens to a full flush.
func (s *channelOverrides) effectOfRows(ctx context.Context, roleIDs, userIDs []int64) PermEffect {
	roleIDs = dedupe(roleIDs)
	users := dedupe(userIDs)
	if len(roleIDs) == 0 && len(users) == 0 {
		return PermEffect{}
	}
	for _, roleID := range roleIDs {
		holders, all := s.roleOverrideAffected(ctx, roleID)
		if all {
			return PermEffect{Applied: true, AffectedAll: true}
		}
		users = append(users, holders...)
	}
	return PermEffect{Applied: true, AffectedUsers: dedupe(users)}
}

func dedupe(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return slices.Compact(out)
}
