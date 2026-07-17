package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// ModerationService handles user ban/unban operations.
type ModerationService struct {
	st    store.Store
	perms *PermissionService
}

// NewModerationService creates a ModerationService.
func NewModerationService(st store.Store, perms *PermissionService) *ModerationService {
	return &ModerationService{st: st, perms: perms}
}

// requireBanAuthority verifies the actor is allowed to ban/unban the target.
// The actor must hold BAN_MEMBERS (or Administrator, which bypasses permission
// checks) and must outrank the target in the role hierarchy — mirroring the
// position-based hierarchy used elsewhere (see admin/middleware.go and
// permissions.OwnerRolePosition). Returns ErrForbidden when either check fails.
func (s *ModerationService) requireBanAuthority(actorID, targetID int64) error {
	if s.perms == nil {
		// No permission service wired — fail closed rather than allow unchecked bans.
		return fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}

	actorRole, err := s.perms.GetRoleForUser(actorID)
	if err != nil || actorRole == nil {
		return fmt.Errorf("%w: failed to load actor role", ErrForbidden)
	}

	if !permissions.HasAdmin(actorRole.Permissions) &&
		!permissions.HasPerm(actorRole.Permissions, permissions.BanMembers) {
		return fmt.Errorf("%w: missing BAN_MEMBERS permission", ErrForbidden)
	}

	// Role hierarchy: the actor must strictly outrank the target so a user
	// cannot ban a peer or a higher-ranked user (e.g. the owner).
	targetRole, err := s.perms.GetRoleForUser(targetID)
	if err != nil || targetRole == nil {
		return fmt.Errorf("%w: failed to load target role", ErrForbidden)
	}
	if actorRole.Position <= targetRole.Position {
		return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
	}

	return nil
}

// BanUser bans a target user. Validates the target exists and
// prevents self-banning.
func (s *ModerationService) BanUser(actorID, targetID int64, reason string, expires *time.Time) error {
	ctx, span := telemetry.GlobalTracer("service/moderation").Start(context.Background(), "ModerationService.BanUser",
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

	target, err := s.st.GetUserByID(targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}

	// Authorization: actor must hold BAN_MEMBERS and outrank the target.
	if err := s.requireBanAuthority(actorID, targetID); err != nil {
		return err
	}

	if err := s.st.BanUser(targetID, reason, expires); err != nil {
		return fmt.Errorf("%w: failed to ban user", ErrInternal)
	}

	if err := s.st.LogAudit(actorID, "ban", "user", targetID, reason); err != nil {
		slog.Error("failed to log audit entry", "error", err)
	}

	slog.Info("user banned", "actor_id", actorID, "target_id", targetID, "reason", reason)
	return nil
}

// UnbanUser removes a ban on a target user.
func (s *ModerationService) UnbanUser(actorID, targetID int64) error {
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}

	target, err := s.st.GetUserByID(targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}

	// Authorization: actor must hold BAN_MEMBERS and outrank the target.
	if err := s.requireBanAuthority(actorID, targetID); err != nil {
		return err
	}

	if err := s.st.UnbanUser(targetID); err != nil {
		return fmt.Errorf("%w: failed to unban user", ErrInternal)
	}

	if err := s.st.LogAudit(actorID, "unban", "user", targetID, ""); err != nil {
		slog.Error("failed to log audit entry", "error", err)
	}

	slog.Info("user unbanned", "actor_id", actorID, "target_id", targetID)
	return nil
}
