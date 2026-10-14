package service

import (
	"context"
	"fmt"
)

// checkReplyTarget requires a reply's target to be a message in the same
// channel that is not deleted. Every way of failing that gives one answer.
// SendMessage runs it after the retry lookup, so a retry of a committed send
// still gets its original message even if the target has gone since.
func (s *MessageService) checkReplyTarget(ctx context.Context, p SendMessageParams) error {
	if p.ReplyTo == nil {
		return nil
	}
	refs, err := s.st.GetReferencedMessages(ctx, p.ChannelID, []int64{*p.ReplyTo})
	if err != nil {
		return fmt.Errorf("%w: reply target lookup: %w", ErrInternal, err)
	}
	if ref := refs[*p.ReplyTo]; ref == nil || ref.Deleted {
		return fmt.Errorf("%w: reply target not found", ErrBadRequest)
	}
	return nil
}
