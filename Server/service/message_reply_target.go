package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// checkReplyTarget requires a reply's target to be a message in the same
// channel that is not deleted. Every way of failing that gives one answer.
// SendMessage runs it after the retry lookup, so a retry of a committed send
// still gets its original message even if the target has gone since.
// It returns the target it read, nil when the send is not a reply, so the ping
// needs no second query.
func (s *MessageService) checkReplyTarget(ctx context.Context, p SendMessageParams) (*db.ReferencedMessage, error) {
	if p.ReplyTo == nil {
		return nil, nil
	}
	refs, err := s.st.GetReferencedMessages(ctx, p.ChannelID, []int64{*p.ReplyTo})
	if err != nil {
		return nil, fmt.Errorf("%w: reply target lookup: %w", ErrInternal, err)
	}
	ref := refs[*p.ReplyTo]
	if ref == nil || ref.Deleted {
		return nil, fmt.Errorf("%w: reply target not found", ErrBadRequest)
	}
	if ref.IsSystem {
		return nil, fmt.Errorf("%w: cannot reply to a system message", ErrBadRequest)
	}
	return ref, nil
}

// replyPingTarget is the user id a reply_ping adds to the mention set, 0 for
// none: the ping is off, the send is no reply, the parent author is unknown, the
// parent is an imported message (its owner is the hidden import account, not a
// person), or the sender replies to their own message.
func replyPingTarget(p SendMessageParams, ref *db.ReferencedMessage) int64 {
	if !p.ReplyPing || p.ReplyTo == nil || ref == nil || ref.User == nil || ref.User.ID == p.UserID ||
		ref.ImportedAuthor != nil {
		return 0
	}
	return ref.User.ID
}
