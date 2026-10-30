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

// maxPurgeLimit bounds one purge request. It matches the message page size, so a
// moderator clears what a client shows in a screenful and no call fans out an
// unbounded id list to every subscriber.
const maxPurgeLimit = 100

// PurgeMessages soft-deletes the newest limit non-deleted messages in a channel,
// optionally only those older than before.
// The actor needs READ_MESSAGES|MANAGE_MESSAGES on the channel (per-channel
// overrides apply), the pair the single-message moderator delete and the pin toggle
// require: MANAGE_MESSAGES alone would let a role the admin panel's "Can access"
// toggle locked out of a private channel wipe it. DMs are rejected outright: they
// have no MANAGE_MESSAGES gate, so no participant-scoped authority could answer to
// a bulk delete.
func (s *MessageService) PurgeMessages(ctx context.Context, userID, channelID int64, limit int, before int64) (*PurgeMessagesResult, error) {
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

	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		return nil, fmt.Errorf("%w: bulk delete is not available in direct messages", ErrForbidden)
	}
	// Archived channels are read-only. This path skips checkSendPermission, so it needs
	// the gate directly (requireChannelWritable in message_perms.go).
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}
	if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages|permissions.ManageMessages) {
		return nil, fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}

	// Flush every queued mention-badge increment for this channel before the purge
	// commits and the reversal below runs, so increment and reversal stay symmetric
	// (see FlushPendingMentionCounts). A message purged inside the worker's coalesce
	// window would otherwise be reversed before its increment landed, and the later
	// flush would raise a phantom badge or, skipped by the liveness guard, take a
	// genuine one with it.
	s.flushChannelMentionCounts(context.WithoutCancel(ctx), channelID)

	ids, err := s.st.PurgeChannelMessagesWithAction(ctx, channelID, before, limit, userID, nil)
	if err != nil {
		slog.Error("MessageService.PurgeMessages", "err", err, "channel_id", channelID)
		return nil, fmt.Errorf("%w: failed to purge messages", ErrInternal)
	}
	if ids == nil {
		ids = []int64{}
	}

	slog.Info("messages purged", "user_id", userID, "channel_id", channelID, "count", len(ids))
	// One audit row per purge, not per message. Audit rows must survive a
	// request canceled after the delete committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "message_purge", "channel", channelID,
		fmt.Sprintf("purged %d messages, limit=%d, before=%d", len(ids), limit, before))

	// Reverse the mention_count increments of every purged message,
	// the same correction a single moderator delete makes in DeleteMessage.
	// Detached from ctx for the same reason as the audit write above.
	if mcErr := s.reverseMentionCounts(context.WithoutCancel(ctx), channelID, ids); mcErr != nil {
		slog.Error("MessageService.PurgeMessages DecrementMentionCounts", "err", mcErr, "channel_id", channelID)
	}

	return &PurgeMessagesResult{ChannelID: channelID, MessageIDs: ids}, nil
}
