package service

import (
	"context"
	"fmt"
)

// retentionChannel refuses a channel no retention policy can be set on: a missing one, a DM, and a thread
// (swept under its parent's policy).
func (s *RetentionService) retentionChannel(ctx context.Context, channelID int64) error {
	ch, err := lookupChannel(ctx, s.st, channelID)
	if err != nil {
		return err
	}
	if ch.Type == "dm" {
		return fmt.Errorf("%w: %w", ErrBadRequest, ErrRetentionDMChannel)
	}
	if ch.IsThread() {
		return fmt.Errorf("a thread follows its parent channel's retention%.0w", ErrBadRequest)
	}
	return nil
}
