package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// maxPurgeLimit bounds one purge to a message page, so no call fans out an unbounded id list.
const maxPurgeLimit = 100

// PurgeMessages soft-deletes the newest limit non-deleted messages in a channel, optionally only those older
// than before. Needs READ_MESSAGES|MANAGE_MESSAGES (the pair single delete requires): MANAGE_MESSAGES alone
// would let a role locked out of a private channel wipe it. DMs are rejected: no participant-scoped authority
// answers a bulk delete.
func (s *messageRemoval) PurgeMessages(ctx context.Context, userID, channelID int64, limit int, before int64) (*PurgeMessagesResult, error) {
	ratKey := auth.Key("chat_purge", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 5, time.Second) {
		return nil, ErrRateLimited
	}

	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be a positive integer", ErrBadRequest)
	}
	if limit < 1 {
		return nil, fmt.Errorf("%w: limit must be between 1 and %d", ErrBadRequest, maxPurgeLimit)
	}
	if before < 0 {
		return nil, fmt.Errorf("%w: before must be a non-negative integer", ErrBadRequest)
	}
	if limit > maxPurgeLimit {
		limit = maxPurgeLimit
	}

	ch, err := lookupChannel(ctx, s.st, channelID)
	if err != nil {
		return nil, err
	}
	if ch.Type == "dm" {
		return nil, fmt.Errorf("%w: bulk delete is not available in direct messages", ErrForbidden)
	}
	// This path skips checkSendPermission, so it needs the archived gate directly.
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}
	if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages|permissions.ManageMessages) {
		return nil, fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}

	// Flush queued mention increments first so increment and reversal stay symmetric; otherwise a purge inside
	// the coalesce window reverses before the increment lands and the flush raises a phantom badge or consumes a
	// real one.
	s.mentions.flushChannelMentionCounts(context.WithoutCancel(ctx), channelID)

	// The purge and the reversal of its mention badges run under the channel's emit
	// lock, so a reader's read-pointer move cannot land between them.
	ids, mcErr, err := s.mentions.removeAndReverseMentions(ctx, channelID, func() ([]int64, error) {
		return s.st.PurgeChannelMessagesWithAction(ctx, channelID, before, limit, userID, nil)
	})
	if err != nil {
		slog.Error("MessageService.PurgeMessages", "err", err, "channel_id", channelID)
		return nil, fmt.Errorf("%w: failed to purge messages", ErrInternal)
	}
	if ids == nil {
		ids = []int64{}
	}

	slog.Info("messages purged", "user_id", userID, "channel_id", channelID, "count", len(ids))
	// One audit row per purge; detached so a canceled request still records it.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "message_purge", "channel", channelID,
		fmt.Sprintf("purged %d messages, limit=%d, before=%d", len(ids), limit, before))

	// The reversal took back the purged messages' mention_count increments, as DeleteMessage does.
	if mcErr != nil {
		slog.Error("MessageService.PurgeMessages DecrementMentionCounts", "err", mcErr, "channel_id", channelID)
	}

	return &PurgeMessagesResult{ChannelID: channelID, MessageIDs: ids}, nil
}
