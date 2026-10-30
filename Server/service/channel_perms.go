package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Channel permission overrides: the escalation and hierarchy guards, mask
// clamping, the write/clear/audit sequence and the invalidation and fan-out after
// it all live here; handlers only decode and respond.

// requireGrantableChannelOverride refuses an override whose allow or deny mask
// holds a bit the actor's own role lacks; otherwise any MANAGE_CHANNELS holder
// could grant themselves or another user a permission (e.g. MANAGE_SERVER) via a
// channel-scoped override. ADMINISTRATOR bypasses.
// Stricter than requireGrantable (role.go), which checks only ADDED bits: the guard
// runs against the UNION of the bits written and the bits already on the row,
// because clearing an existing deny is also a grant (EffectivePerms = (rolePerm
// &^ deny) | allow), so an all-zero write over a deny the actor lacks must not
// slip past.
func requireGrantableChannelOverride(actorRole *db.Role, allow, deny int64) error {
	// An owner-grant-only bit (MOVE_MEMBERS) may be added to or removed from an
	// override only by the owner or an Administrator; the union below also covers
	// clearing an existing one. An owner-tier bit needs the owner alone.
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

// ChannelPermissions returns every role's override row (zero masks when none) and
// the per-user rows that exist; listing every member is not sensible, so the
// matrix editor adds a user by writing a row.
func (s *ChannelService) ChannelPermissions(ctx context.Context, channelID int64) ([]db.ChannelRoleOverride, []db.ChannelUserOverride, error) {
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

// OverrideResult carries the response fields of an override mutation and who had
// cached permissions invalidated (done by the service). AffectedAll means the
// narrow list could not be read and a full flush ran, since a missed eviction is
// a stale grant.
type OverrideResult struct {
	Role          *db.Role
	User          *db.User
	Allow, Deny   int64
	AffectedUsers []int64
	AffectedAll   bool
}

// resolveOverrideRole loads the target role and applies both guards shared by
// write and clear: the escalation guard over the union of written and existing
// bits, and the hierarchy rule (strictly below the actor's position, as
// requireBelowActor).
func (s *ChannelService) resolveOverrideRole(ctx context.Context, actorRole *db.Role, channelID, roleID, allow, deny int64) (*db.Role, error) {
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

// roleOverrideAffected names who to invalidate after a role-layer mutation: only
// holders of the role, since a role override cannot change anyone else's verdict
// and a full flush made every connected user repopulate inside the visibility
// refresh, a stampede growing with total population.
func (s *ChannelService) roleOverrideAffected(ctx context.Context, roleID int64) ([]int64, bool) {
	affected, err := s.st.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		return nil, true
	}
	return affected, false
}

// PutRoleOverride validates and writes a role-layer override, audits it and
// reports who to invalidate. allow/deny are clamped to defined bits so garbage
// cannot persist undefined perms.
func (s *ChannelService) PutRoleOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, roleID, allowRaw, denyRaw int64) (OverrideResult, error) {
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

// DeleteRoleOverride clears a role-layer override. Clearing is a permission
// mutation: removing a deny row restores access the PUT path refuses to grant, so
// it is gated identically against the bits the deleted row carries.
func (s *ChannelService) DeleteRoleOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, roleID int64) (OverrideResult, error) {
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

// resolveOverrideUser loads the target user and applies both guards: the
// escalation guard over the union of written and existing bits, and the
// user-hierarchy rule, since a per-user override (last in resolution order, beats
// the member's role allow) may not target a member at or above the actor's rank.
// ADMINISTRATOR bypasses the hierarchy rule.
func (s *ChannelService) resolveOverrideUser(ctx context.Context, actorRole *db.Role, channelID, userID, allow, deny int64) (*db.User, error) {
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

// requireOutranks is the user-hierarchy rule: user's role must sit below the
// actor's own rank. ADMINISTRATOR bypasses it.
func (s *ChannelService) requireOutranks(ctx context.Context, actorRole *db.Role, user *db.User) error {
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

// PutUserOverride validates and writes a per-user override, audits it and reports
// the one user to invalidate.
func (s *ChannelService) PutUserOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, userID, allowRaw, denyRaw int64) (OverrideResult, error) {
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

// DeleteUserOverride clears a per-user override, gated identically to
// writing one and checked against the bits the deleted row carries.
func (s *ChannelService) DeleteUserOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, userID int64) (OverrideResult, error) {
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
