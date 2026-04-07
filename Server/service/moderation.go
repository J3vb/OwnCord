package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// ModerationService handles user ban/unban operations.
type ModerationService struct {
	st store.Store
}

// NewModerationService creates a ModerationService.
func NewModerationService(st store.Store) *ModerationService {
	return &ModerationService{st: st}
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

	if err := s.st.UnbanUser(targetID); err != nil {
		return fmt.Errorf("%w: failed to unban user", ErrInternal)
	}

	if err := s.st.LogAudit(actorID, "unban", "user", targetID, ""); err != nil {
		slog.Error("failed to log audit entry", "error", err)
	}

	slog.Info("user unbanned", "actor_id", actorID, "target_id", targetID)
	return nil
}
