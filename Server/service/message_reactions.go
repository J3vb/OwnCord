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

// AddReaction adds a reaction to a message.
func (s *MessageService) AddReaction(ctx context.Context, userID, msgID int64, emoji string) (*ReactionResult, error) {
	return s.handleReaction(ctx, userID, msgID, emoji, true)
}

// RemoveReaction removes a reaction from a message.
func (s *MessageService) RemoveReaction(ctx context.Context, userID, msgID int64, emoji string) (*ReactionResult, error) {
	return s.handleReaction(ctx, userID, msgID, emoji, false)
}

// GetReactionUsers returns the users who reacted to msgID with emoji, capped at
// db.MaxReactionUsers. Gated by the same read check as fetching the channel's
// history, so a reaction pill never leaks membership of a channel the caller
// cannot read. The message must live in channelID — the URL's channel is what
// the permission check ran against, so a mismatch is a not-found, not a
// silently-broader lookup.
func (s *MessageService) GetReactionUsers(ctx context.Context, userID, channelID, msgID int64, emoji string) ([]db.ReactionUser, error) {
	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive", ErrBadRequest)
	}
	if err := validateEmoji(emoji); err != nil {
		return nil, err
	}
	if err := s.requireChannelRead(ctx, userID, channelID); err != nil {
		return nil, err
	}

	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil || msg.ChannelID != channelID {
		return nil, fmt.Errorf("%w: message not found", ErrNotFound)
	}

	users, err := s.st.GetReactionUsers(ctx, msgID, emoji, db.MaxReactionUsers)
	if err != nil {
		slog.Error("MessageService.GetReactionUsers", "err", err, "msg_id", msgID)
		return nil, fmt.Errorf("%w: failed to fetch reaction users", ErrInternal)
	}
	if users == nil {
		users = []db.ReactionUser{}
	}
	return users, nil
}

// validateEmoji applies the shared shape rules for a reaction emoji: non-empty,
// at most 32 runes, no control characters, and unchanged by the sanitizer.
func validateEmoji(emoji string) error {
	if emoji == "" || len([]rune(emoji)) > 32 {
		return fmt.Errorf("%w: invalid emoji", ErrBadRequest)
	}
	for _, r := range emoji {
		if r <= 0x1F || r == 0x7F {
			return fmt.Errorf("%w: emoji contains control characters", ErrBadRequest)
		}
	}
	if sanitizer.Sanitize(emoji) != emoji {
		return fmt.Errorf("%w: emoji contains unsafe content", ErrBadRequest)
	}
	return nil
}

func (s *MessageService) handleReaction(ctx context.Context, userID, msgID int64, emoji string, add bool) (*ReactionResult, error) {
	// Rate limit.
	ratKey := auth.Key("reaction", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 5, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive", ErrBadRequest)
	}
	if err := validateEmoji(emoji); err != nil {
		return nil, err
	}

	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: message not found", ErrBadRequest)
	}
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot react to deleted message", ErrBadRequest)
	}

	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	isDM := chErr == nil && ch != nil && ch.Type == "dm"

	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: not a DM participant", ErrBadRequest)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, msg.ChannelID); blkErr != nil {
			return nil, blkErr
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.AddReactions) {
		// Require READ_MESSAGES in addition to ADD_REACTIONS so a user cannot
		// react in a channel they cannot read. Mirrors checkSendPermission,
		// which requires ReadMessages|SendMessages for non-DM sends.
		return nil, fmt.Errorf("%w: missing ADD_REACTIONS permission", ErrForbidden)
	}

	action := "add"
	if add {
		if err := s.st.AddReaction(ctx, msgID, userID, emoji); err != nil {
			slog.Warn("MessageService.AddReaction", "err", err, "msg_id", msgID, "user_id", userID)
			return nil, fmt.Errorf("%w: reaction already exists", ErrConflict)
		}
	} else {
		action = "remove"
		if err := s.st.RemoveReaction(ctx, msgID, userID, emoji); err != nil {
			slog.Warn("MessageService.RemoveReaction", "err", err, "msg_id", msgID, "user_id", userID)
			return nil, fmt.Errorf("%w: reaction not found", ErrBadRequest)
		}
	}

	result := &ReactionResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		UserID:    userID,
		Emoji:     emoji,
		Action:    action,
		IsDM:      isDM,
	}

	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.handleReaction GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}
