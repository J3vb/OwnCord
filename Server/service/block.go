package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// BlockService handles user block/unblock operations.
type BlockService struct {
	st store.Store
}

// NewBlockService creates a BlockService.
func NewBlockService(st store.Store) *BlockService {
	return &BlockService{st: st}
}

// BlockUser blocks a target user. Validates the target exists and
// prevents self-blocking.
func (s *BlockService) BlockUser(blockerID, targetID int64) error {
	ctx, span := telemetry.GlobalTracer("service/block").Start(context.Background(), "BlockService.BlockUser",
		telemetry.Int64("blocker_id", blockerID),
		telemetry.Int64("target_id", targetID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationMs, start,
			telemetry.String("method", "BlockUser"))
		span.End()
	}()

	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if blockerID == targetID {
		return fmt.Errorf("%w: cannot block yourself", ErrBadRequest)
	}

	target, err := s.st.GetUserByID(targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}

	if err := s.st.BlockUser(blockerID, targetID); err != nil {
		return fmt.Errorf("%w: failed to block user", ErrInternal)
	}

	slog.Info("user blocked", "blocker_id", blockerID, "target_id", targetID)
	return nil
}

// UnblockUser removes a block on a target user.
func (s *BlockService) UnblockUser(blockerID, targetID int64) error {
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if err := s.st.UnblockUser(blockerID, targetID); err != nil {
		return fmt.Errorf("%w: failed to unblock user", ErrInternal)
	}
	slog.Info("user unblocked", "blocker_id", blockerID, "target_id", targetID)
	return nil
}

// ListBlocked returns all user IDs blocked by the given user.
func (s *BlockService) ListBlocked(blockerID int64) ([]int64, error) {
	ids, err := s.st.ListBlockedUsers(blockerID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list blocked users", ErrInternal)
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, nil
}
