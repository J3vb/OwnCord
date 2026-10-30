package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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
// db.MaxReactionUsers. It shares the history read gate so a reaction pill never
// leaks membership of a channel the caller cannot read. The message must live in
// channelID (the channel the permission check ran against); a mismatch is
// not-found, not a broader lookup.
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
	if err != nil || msg == nil || msg.ChannelID != channelID || msg.Deleted {
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

// maxReactionRunes bounds a reaction string. A custom emoji is stored as its
// ":shortcode:" literal, so the ceiling is derived from MaxShortcodeLen plus the
// two colons; that keeps an emoji that renders in a message from being refused as
// a reaction. Unicode emoji, even long ZWJ sequences, sit far below it.
const maxReactionRunes = MaxShortcodeLen + 2

// validateEmoji applies the shared shape rules for a reaction emoji: non-empty,
// at most maxReactionRunes runes, no control characters, and unchanged by the
// sanitizer.
func validateEmoji(emoji string) error {
	if emoji == "" || len([]rune(emoji)) > maxReactionRunes {
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

// errReactionTargetNotFound is the single answer for a reaction target that is
// missing, deleted or not readable by the caller.
func errReactionTargetNotFound() error {
	return fmt.Errorf("%w: message not found", ErrNotFound)
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

	// A missing id, a deleted message and an unreadable channel all answer
	// identically: the history read check runs before any message-state answer.
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, errReactionTargetNotFound()
	}
	if err := s.requireChannelRead(ctx, userID, msg.ChannelID); err != nil {
		return nil, errReactionTargetNotFound()
	}
	if msg.Deleted {
		return nil, errReactionTargetNotFound()
	}

	participantIDs, isDM, err := s.reactionAudience(ctx, userID, msg.ChannelID)
	if err != nil {
		return nil, err
	}
	// After the read check and the audience check, so only a reader learns the
	// message is a system row (call or group event).
	if msg.Kind != db.MessageKindUser {
		return nil, fmt.Errorf("%w: cannot react to a system message", ErrBadRequest)
	}

	action := "add"
	if add {
		if err := s.st.AddReaction(ctx, msgID, userID, emoji); err != nil {
			if errors.Is(err, db.ErrReactionLimit) {
				return nil, fmt.Errorf("%w: %w: at most %d different reactions per message", ErrBadRequest, ErrReactionLimit, db.MaxDistinctReactions)
			}
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
		result.ParticipantIDs = participantIDs
	}

	return result, nil
}

// reactionAudience resolves the message's channel and enforces the channel-scoped
// gates on reacting: archived, DM participation, DM block, and the non-DM
// READ_MESSAGES|ADD_REACTIONS check. The gates handleReaction keeps (rate limit,
// message id, emoji validity, channel read check, deleted message) still run
// first. It also returns the DM participant ids, resolved before anything is
// mutated. The order of the checks is load-bearing.
func (s *MessageService) reactionAudience(ctx context.Context, userID, channelID int64) ([]int64, bool, error) {
	// Fail closed, as EditMessage/DeleteMessage (message_crud.go): a lookup failure
	// must not fall through to the non-DM branch, which passes on the base role mask
	// alone (no per-channel override exists for a DM) and skips IsDMParticipant and
	// RequireDMReachable.
	ch, chErr := s.st.GetChannel(ctx, channelID)
	if chErr != nil || ch == nil {
		return nil, false, errReactionTargetNotFound()
	}
	isDM := ch.Type == "dm"

	// Archived channels are read-only. This path skips checkSendPermission, so it
	// needs the gate directly (requireChannelWritable in message_perms.go).
	if err := requireChannelWritable(ch); err != nil {
		return nil, false, err
	}

	// permissions.CanAddReaction is the one predicate every reaction gate routes
	// through, so a timeout restricts reactions as it does a send.
	sub, subErr := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if subErr != nil {
		return nil, false, fmt.Errorf("%w: cannot react to this message", ErrForbidden)
	}

	var participantIDs []int64
	if isDM {
		if !sub.DMParticipant {
			return nil, false, errReactionTargetNotFound()
		}
		if err := denial(permissions.CanAddReaction(sub)); err != nil {
			return nil, false, err
		}
		// Resolve the fan-out audience before mutating anything: participants are
		// unaffected by the reaction, so failing here is cheap, whereas failing after the
		// commit would persist a reaction with nobody to broadcast it to while reporting
		// success.
		ids, pErr := s.DMAudience(ctx, channelID, userID)
		if pErr != nil {
			slog.Error("MessageService.handleReaction DMAudience", "err", pErr, "channel_id", channelID)
			return nil, false, fmt.Errorf("%w: failed to resolve DM participants", ErrInternal)
		}
		participantIDs = ids
	} else if err := denial(permissions.CanAddReaction(sub)); err != nil {
		return nil, false, err
	}

	return participantIDs, isDM, nil
}
