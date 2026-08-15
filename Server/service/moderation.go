package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/telemetry"
)

// ModerationService handles user ban/unban operations.
type ModerationService struct {
	st    Store
	perms *PermissionService
}

// NewModerationService creates a ModerationService.
func NewModerationService(st Store, perms *PermissionService) *ModerationService {
	return &ModerationService{st: st, perms: perms}
}

// roleFor loads a principal's role through the permission cache. Every failure
// is Forbidden: an unresolvable role must never authorize a moderation action.
// The which argument names the principal in the error message ("actor" or
// "target").
func (s *ModerationService) roleFor(ctx context.Context, userID int64, which string) (*db.Role, error) {
	if s.perms == nil {
		// No permission service wired — fail closed rather than allow unchecked actions.
		return nil, fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load %s role", ErrForbidden, which)
	}
	return role, nil
}

// requirePerm verifies the actor holds perm (or the Administrator bypass) and
// returns the actor's role for follow-up hierarchy checks. It deliberately
// takes no target: it runs before any target lookup so an actor without
// authority always sees Forbidden and never NotFound — these paths cannot be
// used to enumerate user ids.
func (s *ModerationService) requirePerm(ctx context.Context, actorID, perm int64) (*db.Role, error) {
	actorRole, err := s.roleFor(ctx, actorID, "actor")
	if err != nil {
		return nil, err
	}
	if !permissions.HasServerPerm(actorRole.Permissions, perm) {
		return nil, fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(perm))
	}
	return actorRole, nil
}

// requireBanPermission verifies the actor holds BAN_MEMBERS. See requirePerm.
func (s *ModerationService) requireBanPermission(ctx context.Context, actorID int64) error {
	_, err := s.requirePerm(ctx, actorID, permissions.BanMembers)
	return err
}

// requireOutranks enforces the role hierarchy: the actor must strictly
// outrank the target so a user cannot moderate a peer or a higher-ranked user
// (e.g. the owner) — mirroring the position-based hierarchy used elsewhere.
// Runs after the permission and existence checks, so only callers that already
// hold authority reach it.
func (s *ModerationService) requireOutranks(ctx context.Context, actorID, targetID int64) error {
	actorRole, err := s.roleFor(ctx, actorID, "actor")
	if err != nil {
		return err
	}
	return s.requireOutranksRole(ctx, actorRole, targetID)
}

// requireOutranksRole is requireOutranks with the actor's role already loaded.
func (s *ModerationService) requireOutranksRole(ctx context.Context, actorRole *db.Role, targetID int64) error {
	targetRole, err := s.roleFor(ctx, targetID, "target")
	if err != nil {
		return err
	}
	if actorRole.Position <= targetRole.Position {
		return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
	}
	return nil
}

// BanUser bans a target user. Validates the target exists and
// prevents self-banning.
func (s *ModerationService) BanUser(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time) error {
	ctx, span := telemetry.GlobalTracer("service/moderation").Start(ctx, "ModerationService.BanUser",
		telemetry.Int64("actor_id", actorID),
		telemetry.Int64("target_id", targetID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "BanUser"))
		span.End()
	}()

	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot ban yourself", ErrBadRequest)
	}

	// Authorization before existence: an actor without ban authority learns
	// nothing about which user ids exist.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return err
	}

	if err := s.st.BanUser(ctx, targetID, reason, expires); err != nil {
		return fmt.Errorf("%w: failed to ban user: %v", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the ban committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_ban", "user", targetID, reason)

	slog.Info("user banned", "actor_id", actorID, "target_id", targetID, "reason", reason)
	return nil
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
func (s *ModerationService) AuthorizeRoleChange(ctx context.Context, actorID, targetID, newRoleID int64) (actorRole *db.Role, target *db.User, newRole *db.Role, err error) {
	if targetID <= 0 {
		return nil, nil, nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return nil, nil, nil, fmt.Errorf("%w: cannot change your own role", ErrBadRequest)
	}

	// Authorization before existence — see BanUser.
	actorRole, err = s.requirePerm(ctx, actorID, permissions.ManageRoles)
	if err != nil {
		return nil, nil, nil, err
	}
	target, err = s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return nil, nil, nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return nil, nil, nil, err
	}

	newRole, err = s.st.GetRoleByID(ctx, newRoleID)
	if err != nil || newRole == nil {
		return nil, nil, nil, fmt.Errorf("%w: role not found", ErrBadRequest)
	}
	// Administrator bypasses permission bits, never the hierarchy: the owner
	// role is above every admin, so only the owner can grant it.
	if newRole.Position >= actorRole.Position {
		return nil, nil, nil, fmt.Errorf("%w: cannot assign a role at or above your own rank", ErrForbidden)
	}
	return actorRole, target, newRole, nil
}

// ChangeUserRole assigns newRoleID to the target user. It enforces
// MANAGE_ROLES plus two hierarchy rules the admin panel previously had none
// of: the actor must strictly outrank the target, and may not hand out a role
// positioned at or above their own — otherwise any admin could promote anyone
// (including themselves via a second account) to Owner.
//
// It returns the role that was assigned so callers (the member_update
// broadcast and visibility refresh, in particular) can use it directly
// instead of re-reading it: a re-read is racing a possible concurrent role
// delete for no reason, since this call already loaded and validated the
// exact same row under the same request.
func (s *ModerationService) ChangeUserRole(ctx context.Context, actorID, targetID, newRoleID int64) (*db.Role, error) {
	_, target, newRole, err := s.AuthorizeRoleChange(ctx, actorID, targetID, newRoleID)
	if err != nil {
		return nil, err
	}

	if err := s.st.UpdateUserRole(ctx, targetID, newRoleID); err != nil {
		return nil, fmt.Errorf("%w: failed to update role: %v", ErrInternal, err)
	}
	// Drop the target's cached role immediately: without this a demotion keeps
	// granting the old bits (and the old rank) for up to permCacheTTL.
	s.perms.InvalidateUser(targetID)

	// Audit rows must survive a request canceled after the update committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_change", "user", targetID,
		fmt.Sprintf("changed %s role to %s", target.Username, newRole.Name))

	slog.Info("role changed", "actor_id", actorID, "target_id", targetID, "new_role_id", newRoleID)
	return newRole, nil
}

// ForceLogout revokes every session of the target user (the client's "Kick").
// Gated on KICK_MEMBERS plus the same hierarchy rule as ban, so a moderator
// cannot log out an admin or the owner.
func (s *ModerationService) ForceLogout(ctx context.Context, actorID, targetID int64) error {
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot force-logout yourself", ErrBadRequest)
	}

	// Authorization before existence — see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.KickMembers)
	if err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return err
	}

	if err := s.st.ForceLogoutUser(ctx, targetID); err != nil {
		return fmt.Errorf("%w: failed to log out user: %v", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the sessions were cut.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "force_logout", "user", targetID,
		"all sessions terminated")

	slog.Info("force logout", "actor_id", actorID, "target_id", targetID)
	return nil
}

// UnbanUser removes a ban on a target user.
func (s *ModerationService) UnbanUser(ctx context.Context, actorID, targetID int64) error {
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}

	// Authorization before existence — see BanUser.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return err
	}

	if err := s.st.UnbanUser(ctx, targetID); err != nil {
		return fmt.Errorf("%w: failed to unban user: %v", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the unban committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_unban", "user", targetID, "")

	slog.Info("user unbanned", "actor_id", actorID, "target_id", targetID)
	return nil
}
