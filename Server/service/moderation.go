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

// requireBanPermission verifies the actor holds BAN_MEMBERS (or the
// Administrator bypass). It deliberately takes no target: it runs before any
// target lookup so an actor without ban authority always sees Forbidden and
// never NotFound — the ban path cannot be used to enumerate user ids.
func (s *ModerationService) requireBanPermission(ctx context.Context, actorID int64) error {
	if s.perms == nil {
		// No permission service wired — fail closed rather than allow unchecked bans.
		return fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	actorRole, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || actorRole == nil {
		return fmt.Errorf("%w: failed to load actor role", ErrForbidden)
	}
	if !permissions.HasServerPerm(actorRole.Permissions, permissions.BanMembers) {
		return fmt.Errorf("%w: missing BAN_MEMBERS permission", ErrForbidden)
	}
	return nil
}

// requireOutranks enforces the role hierarchy: the actor must strictly
// outrank the target so a user cannot ban a peer or a higher-ranked user
// (e.g. the owner) — mirroring the position-based hierarchy used elsewhere.
// Runs after requireBanPermission and the existence check, so only callers
// that already hold ban authority reach it.
func (s *ModerationService) requireOutranks(ctx context.Context, actorID, targetID int64) error {
	actorRole, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || actorRole == nil {
		return fmt.Errorf("%w: failed to load actor role", ErrForbidden)
	}
	targetRole, err := s.perms.GetRoleForUser(ctx, targetID)
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
		return fmt.Errorf("%w: failed to ban user", ErrInternal)
	}

	// Audit rows must survive a request canceled after the ban committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_ban", "user", targetID, reason)

	slog.Info("user banned", "actor_id", actorID, "target_id", targetID, "reason", reason)
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
		return fmt.Errorf("%w: failed to unban user", ErrInternal)
	}

	// Audit rows must survive a request canceled after the unban committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_unban", "user", targetID, "")

	slog.Info("user unbanned", "actor_id", actorID, "target_id", targetID)
	return nil
}
