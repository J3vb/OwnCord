package service

import (
	"context"
	"fmt"
)

// retentionChannel refuses a channel no retention policy can be set on: a
// missing one, a DM (never in scope), and a thread, which is swept under its
// parent's policy.
func (s *RetentionService) retentionChannel(ctx context.Context, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		return fmt.Errorf("%w: %w", ErrBadRequest, ErrRetentionDMChannel)
	}
	if ch.IsThread() {
		return fmt.Errorf("a thread follows its parent channel's retention%.0w", ErrBadRequest)
	}
	return nil
}
