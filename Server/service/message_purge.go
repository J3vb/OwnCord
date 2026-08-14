package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// maxPurgeLimit bounds one purge request. Matches the message page size, so a
// moderator can clear exactly what a client shows in one screenful and no
// single call can fan out an unbounded id list to every channel subscriber.
const maxPurgeLimit = 100

// PurgeMessages soft-deletes the newest limit non-deleted messages in a
// channel, optionally restricted to messages older than before.
//
// The actor needs READ_MESSAGES|MANAGE_MESSAGES on the channel (per-channel
// overrides apply), the same pair the single-message moderator delete and the
// pin toggle require — MANAGE_MESSAGES alone would let a role the admin panel's
// "Can access" toggle locked out of a private channel wipe it.
//
// DMs are rejected outright: a DM has no MANAGE_MESSAGES gate to check, so
// there is no participant-scoped authority a bulk delete could answer to.
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
	// Archived channels are read-only. PurgeMessages bypasses
	// checkSendPermission (it runs its own MANAGE_MESSAGES check below), so it
	// needs the shared gate directly — see requireChannelWritable in
	// message_perms.go.
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}
	if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages|permissions.ManageMessages) {
		return nil, fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}

	ids, err := s.st.PurgeChannelMessages(ctx, channelID, before, limit)
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

	return &PurgeMessagesResult{ChannelID: channelID, MessageIDs: ids}, nil
}
