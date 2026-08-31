package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── Channel permission overrides (B3-8 channel family, part 2) ─────────────
//
// The override policy the admin handlers used to hold: escalation and
// hierarchy guards, mask clamping, the write/clear/audit sequence, and who
// must be invalidated afterwards. Handlers decode and fan out; every
// permission decision lives here.

// requireGrantableChannelOverride refuses an override whose allow or deny
// mask contains a bit the actor's own role does not hold. Without this, any
// MANAGE_CHANNELS holder could grant themselves or another user a permission
// (e.g. MANAGE_SERVER) they were never assigned by writing a channel-scoped
// override. ADMINISTRATOR bypasses.
//
// Deliberately stricter than requireGrantable (role.go), which checks only
// ADDED bits: for overrides the guard runs against the UNION of the bits
// being written and the bits already on the row, because clearing an
// existing deny is also a grant (EffectivePerms = (rolePerm &^ deny) |
// allow) — an all-zero write over a deny the actor's role lacks must not
// slip past just because the new mask alone is empty.
func requireGrantableChannelOverride(actorRole *db.Role, allow, deny int64) error {
	if permissions.HasAdmin(actorRole.Permissions) {
		return nil
	}
	if escalated := (allow | deny) &^ actorRole.Permissions; escalated != 0 {
		return fmt.Errorf("cannot grant a permission your own role lacks (%s)%.0w",
			permissions.Name(escalated&-escalated), ErrForbidden)
	}
	return nil
}

// ChannelPermissions returns every role's override row (zero masks when a
// role carries none) and the per-user override rows that actually exist —
// every member is not a sensible list to ship; the matrix editor adds one by
// writing one.
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

// OverrideResult carries what the caller fans out after an override
// mutation: the response row fields and who must have cached permissions
// invalidated. AffectedAll means the narrow list could not be read — the
// fail-safe is a full flush, because a missed eviction is a stale grant.
type OverrideResult struct {
	Role          *db.Role
	User          *db.User
	Allow, Deny   int64
	AffectedUsers []int64
	AffectedAll   bool
}

// resolveOverrideRole loads the target role for a role-layer override
// mutation and applies both guards shared by write and clear: the escalation
// guard over the union of written and existing bits, and the hierarchy rule
// (a role override can only target a role strictly below the actor's own
// position, mirroring requireBelowActor).
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

// roleOverrideAffected names who to invalidate after a role-layer mutation:
// only users actually holding the role — a role-scoped override cannot
// change any other user's verdict, and a full flush made every connected
// user repopulate synchronously inside the visibility refresh, a stampede
// that grows with total population rather than the role's size.
func (s *ChannelService) roleOverrideAffected(ctx context.Context, roleID int64) ([]int64, bool) {
	affected, err := s.st.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		return nil, true
	}
	return affected, false
}

// PutRoleOverride validates and writes a role-layer override, audits it, and
// reports who to invalidate. allow/deny are clamped to defined bits so
// garbage input cannot persist undefined perms.
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
	return OverrideResult{Role: role, Allow: allow, Deny: deny, AffectedUsers: affected, AffectedAll: all}, nil
}

// DeleteRoleOverride clears a role-layer override. Clearing is a permission
// mutation with the same authority as writing one — removing a deny row
// restores exactly the access the PUT path refuses to grant — so it is
// gated identically, checked against the bits the deleted row carries.
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
	return OverrideResult{Role: role, AffectedUsers: affected, AffectedAll: all}, nil
}

// resolveOverrideUser loads the target user for a user-layer override
// mutation and applies both guards: the escalation guard over the union of
// written and existing bits, and the user-hierarchy rule — a per-user
// override may not target a member whose role sits at or above the actor's
// own rank (the per-user layer is last in the resolution order and beats
// that member's role allow). ADMINISTRATOR bypasses the hierarchy rule.
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
	if !permissions.HasAdmin(actorRole.Permissions) {
		targetRole, err := s.st.GetRoleByID(ctx, user.RoleID)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to fetch target role: %w", ErrInternal, err)
		}
		if targetRole != nil && targetRole.Position >= actorRole.Position {
			return nil, fmt.Errorf("cannot manage a user ranked at or above your own%.0w", ErrForbidden)
		}
	}
	return user, nil
}

// PutUserOverride validates and writes a per-user override, audits it, and
// reports the one user to invalidate — a per-user override cannot change
// anyone else's verdict.
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

	return OverrideResult{User: user, Allow: allow, Deny: deny, AffectedUsers: []int64{userID}}, nil
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

	return OverrideResult{User: user, AffectedUsers: []int64{userID}}, nil
}
