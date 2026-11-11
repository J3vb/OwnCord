package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Channel permission overrides: escalation and hierarchy guards, mask clamping, the
// write/clear/audit sequence and the invalidation and fan-out live here; handlers only
// decode and respond.

type channelOverridesStore interface {
	db.Auditor
	permissions.DB
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	ListUserIDsByRole(ctx context.Context, roleID int64) ([]int64, error)
	HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error)
	ListChannelRoleOverrides(ctx context.Context, channelID int64) ([]db.ChannelRoleOverride, error)
	ListChannelUserOverrides(ctx context.Context, channelID int64) ([]db.ChannelUserOverride, error)
	UpsertChannelOverride(ctx context.Context, channelID, roleID, allow, deny int64) error
	DeleteChannelOverride(ctx context.Context, channelID, roleID int64) error
	UpsertChannelUserOverride(ctx context.Context, channelID, userID, allow, deny int64) error
	DeleteChannelUserOverride(ctx context.Context, channelID, userID int64) error
}

type channelOverrides struct {
	st       channelOverridesStore
	cats     CategoryStore
	cperm    CategoryPermStore
	perms    *PermissionService
	notifier PermissionChangeNotifier
}

// requireGrantableChannelOverride refuses an override holding a bit the actor's role lacks;
// otherwise any MANAGE_CHANNELS holder could grant themselves e.g. MANAGE_SERVER.
// ADMINISTRATOR bypasses. Stricter than requireGrantable: it checks the UNION of bits
// written and already on the row, because clearing an existing deny is also a grant
// (EffectivePerms = (rolePerm &^ deny) | allow).
func requireGrantableChannelOverride(actorRole *db.Role, allow, deny int64) error {
	// An owner-grant-only bit (MOVE_MEMBERS) may be added or removed only by the owner or an
	// Administrator (the union below also covers clearing); an owner-tier bit needs the owner alone.
	changed := (allow | deny) & permissions.OwnerGrantOnly
	if ownerTier := changed & permissions.OwnerOnlyGrant; ownerTier != 0 &&
		!permissions.CanChangeOwnerOnlyGrant(actorRole.ID, actorRole.Position) {
		return fmt.Errorf("only the owner can change %s%.0w", permissions.Name(ownerTier&-ownerTier), ErrForbidden)
	}
	if changed != 0 &&
		!permissions.CanChangeOwnerGrantOnly(actorRole.Permissions, actorRole.ID, actorRole.Position) {
		return fmt.Errorf("only the owner can change %s%.0w", permissions.Name(changed&-changed), ErrForbidden)
	}
	if permissions.HasAdmin(actorRole.Permissions) {
		return nil
	}
	if escalated := (allow | deny) &^ actorRole.Permissions; escalated != 0 {
		return fmt.Errorf("cannot grant a permission your own role lacks (%s)%.0w",
			permissions.Name(escalated&-escalated), ErrForbidden)
	}
	return nil
}

// ChannelPermissions returns every role's override row (zero masks when none) and the
// existing per-user rows; the matrix editor adds a user by writing a row.
func (s *channelOverrides) ChannelPermissions(ctx context.Context, channelID int64) ([]db.ChannelRoleOverride, []db.ChannelUserOverride, error) {
	roles, err := s.st.ListChannelRoleOverrides(ctx, channelID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to list channel permissions: %w", ErrInternal, err)
	}
	users, err := s.st.ListChannelUserOverrides(ctx, channelID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to list channel user permissions: %w", ErrInternal, err)
	}
	return roles, users, nil
}

// OverrideResult carries an override mutation's response fields and who had cached
// permissions invalidated. AffectedAll means the narrow list could not be read and a
// full flush ran (a missed eviction is a stale grant).
type OverrideResult struct {
	Role          *db.Role
	User          *db.User
	Allow, Deny   int64
	AffectedUsers []int64
	AffectedAll   bool
}

func (s *channelOverrides) resolveOverrideRole(ctx context.Context, actorRole *db.Role, channelID, roleID, allow, deny int64) (*db.Role, error) {
	role, err := s.st.GetRoleByID(ctx, roleID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch role: %w", ErrInternal, err)
	}
	if role == nil {
		return nil, fmt.Errorf("role not found%.0w", ErrNotFound)
	}
	curAllow, curDeny, err := s.st.GetChannelPermissions(ctx, channelID, roleID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch channel permission: %w", ErrInternal, err)
	}
	if err := requireGrantableChannelOverride(actorRole, curAllow|allow, curDeny|deny); err != nil {
		return nil, err
	}
	if role.Position >= actorRole.Position {
		return nil, fmt.Errorf("cannot manage a role at or above your own rank%.0w", ErrForbidden)
	}
	return role, nil
}

// roleOverrideAffected names who to invalidate after a role-layer mutation: only the
// role's holders, since a full flush made every connected user repopulate inside the
// visibility refresh, a stampede growing with population.
func (s *channelOverrides) roleOverrideAffected(ctx context.Context, roleID int64) ([]int64, bool) {
	affected, err := s.st.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		return nil, true
	}
	return affected, false
}

// PutRoleOverride validates and writes a role-layer override, audits it and reports who
// to invalidate. allow/deny are clamped to defined bits.
func (s *channelOverrides) PutRoleOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, roleID, allowRaw, denyRaw int64) (OverrideResult, error) {
	allow := allowRaw & permissions.AllPerms
	deny := denyRaw & permissions.AllPerms

	role, err := s.resolveOverrideRole(ctx, actorRole, ch.ID, roleID, allow, deny)
	if err != nil {
		return OverrideResult{}, err
	}
	if err := s.st.UpsertChannelOverride(ctx, ch.ID, roleID, allow, deny); err != nil {
		return OverrideResult{}, fmt.Errorf("%w: failed to save channel permission: %w", ErrInternal, err)
	}

	slog.Info("channel permissions updated", "actor_id", actorID, "channel_id", ch.ID,
		"role_id", roleID, "allow", allow, "deny", deny)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "channel_perms_update", "channel", ch.ID,
		fmt.Sprintf("set overrides for role %s on #%s (allow=%#x deny=%#x)", role.Name, ch.Name, allow, deny))

	affected, all := s.roleOverrideAffected(ctx, roleID)
	res := OverrideResult{Role: role, Allow: allow, Deny: deny, AffectedUsers: affected, AffectedAll: all}
	s.applyOverrideEffects(res, ch)
	return res, nil
}

// DeleteRoleOverride clears a role-layer override. Removing a deny restores access PUT
// refuses to grant, so it is gated identically against the bits the deleted row carries.
func (s *channelOverrides) DeleteRoleOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, roleID int64) (OverrideResult, error) {
	role, err := s.resolveOverrideRole(ctx, actorRole, ch.ID, roleID, 0, 0)
	if err != nil {
		return OverrideResult{}, err
	}
	if err := s.st.DeleteChannelOverride(ctx, ch.ID, roleID); err != nil {
		return OverrideResult{}, fmt.Errorf("%w: failed to delete channel permission: %w", ErrInternal, err)
	}

	slog.Info("channel permissions cleared", "actor_id", actorID, "channel_id", ch.ID, "role_id", roleID)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "channel_perms_clear", "channel", ch.ID,
		fmt.Sprintf("cleared overrides for role %s on #%s", role.Name, ch.Name))

	affected, all := s.roleOverrideAffected(ctx, roleID)
	res := OverrideResult{Role: role, AffectedUsers: affected, AffectedAll: all}
	s.applyOverrideEffects(res, ch)
	return res, nil
}

// resolveOverrideUser loads the target user and applies the escalation guard over the
// union of bits and the user-hierarchy rule: a per-user override (last in resolution
// order) may not target a member at or above the actor's rank. ADMINISTRATOR bypasses.
func (s *channelOverrides) resolveOverrideUser(ctx context.Context, actorRole *db.Role, channelID, userID, allow, deny int64) (*db.User, error) {
	user, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch user: %w", ErrInternal, err)
	}
	if user == nil {
		return nil, fmt.Errorf("user not found%.0w", ErrNotFound)
	}
	curAllow, curDeny, err := s.st.GetUserChannelPermissions(ctx, channelID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch channel user permission: %w", ErrInternal, err)
	}
	if err := requireGrantableChannelOverride(actorRole, curAllow|allow, curDeny|deny); err != nil {
		return nil, err
	}
	if err := s.requireOutranks(ctx, actorRole, user); err != nil {
		return nil, err
	}
	return user, nil
}

func (s *channelOverrides) requireOutranks(ctx context.Context, actorRole *db.Role, user *db.User) error {
	if permissions.HasAdmin(actorRole.Permissions) {
		return nil
	}
	targetRole, err := s.st.GetRoleByID(ctx, user.RoleID)
	if err != nil {
		return fmt.Errorf("%w: failed to fetch target role: %w", ErrInternal, err)
	}
	if targetRole != nil && targetRole.Position >= actorRole.Position {
		return fmt.Errorf("cannot manage a user ranked at or above your own%.0w", ErrForbidden)
	}
	return nil
}

// PutUserOverride validates and writes a per-user override, audits it and reports the user to invalidate.
func (s *channelOverrides) PutUserOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, userID, allowRaw, denyRaw int64) (OverrideResult, error) {
	allow := allowRaw & permissions.AllPerms
	deny := denyRaw & permissions.AllPerms

	user, err := s.resolveOverrideUser(ctx, actorRole, ch.ID, userID, allow, deny)
	if err != nil {
		return OverrideResult{}, err
	}
	if err := s.st.UpsertChannelUserOverride(ctx, ch.ID, userID, allow, deny); err != nil {
		return OverrideResult{}, fmt.Errorf("%w: failed to save channel user permission: %w", ErrInternal, err)
	}

	slog.Info("channel user permissions updated", "actor_id", actorID, "channel_id", ch.ID,
		"user_id", userID, "allow", allow, "deny", deny)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "channel_user_perms_update", "channel", ch.ID,
		fmt.Sprintf("set overrides for user %s on #%s (allow=%#x deny=%#x)", user.Username, ch.Name, allow, deny))

	res := OverrideResult{User: user, Allow: allow, Deny: deny, AffectedUsers: []int64{userID}}
	s.applyOverrideEffects(res, ch)
	return res, nil
}

// DeleteUserOverride clears a per-user override, gated like a write against the bits the deleted row carries.
func (s *channelOverrides) DeleteUserOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, userID int64) (OverrideResult, error) {
	user, err := s.resolveOverrideUser(ctx, actorRole, ch.ID, userID, 0, 0)
	if err != nil {
		return OverrideResult{}, err
	}
	if err := s.st.DeleteChannelUserOverride(ctx, ch.ID, userID); err != nil {
		return OverrideResult{}, fmt.Errorf("%w: failed to delete channel user permission: %w", ErrInternal, err)
	}

	slog.Info("channel user permissions cleared", "actor_id", actorID, "channel_id", ch.ID, "user_id", userID)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "channel_user_perms_clear", "channel", ch.ID,
		fmt.Sprintf("cleared overrides for user %s on #%s", user.Username, ch.Name))

	res := OverrideResult{User: user, AffectedUsers: []int64{userID}}
	s.applyOverrideEffects(res, ch)
	return res, nil
}
