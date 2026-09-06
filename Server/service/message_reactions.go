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

// maxReactionRunes bounds a reaction string. Reactions are free-form text, so
// the ceiling has to clear the longest thing a client can legitimately react
// with: a custom emoji is stored as its ":shortcode:" literal, which is
// MaxShortcodeLen plus the two colons. Deriving it keeps the two from drifting
// into an emoji that renders in a message but is silently refused as a
// reaction. Unicode emoji, even long ZWJ sequences, sit far below this.
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

	participantIDs, isDM, err := s.reactionAudience(ctx, userID, msg.ChannelID)
	if err != nil {
		return nil, err
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
		result.ParticipantIDs = participantIDs
	}

	return result, nil
}

// reactionAudience resolves the channel a message lives in and enforces the
// channel-scoped gates on reacting in it — archived, DM participation, DM
// block, and the non-DM READ_MESSAGES|ADD_REACTIONS check. The gates its
// caller keeps (rate limit, message id, emoji validity, deleted message) stay
// in handleReaction and still run first. It also returns the DM participant
// ids, resolved here so they exist before anything is mutated. The order of
// the checks is load-bearing and unchanged.
func (s *MessageService) reactionAudience(ctx context.Context, userID, channelID int64) ([]int64, bool, error) {
	// Fail closed, mirroring EditMessage/DeleteMessage (message_crud.go): a
	// lookup failure must not fall through to the non-DM permission branch
	// below. That branch passes on the base role mask alone
	// (READ_MESSAGES|ADD_REACTIONS, no per-channel override exists for a DM),
	// skipping both IsDMParticipant and requireDMNotBlocked entirely.
	ch, chErr := s.st.GetChannel(ctx, channelID)
	if chErr != nil || ch == nil {
		return nil, false, fmt.Errorf("%w: cannot react to this message", ErrForbidden)
	}
	isDM := ch.Type == "dm"

	// Archived channels are read-only. handleReaction bypasses
	// checkSendPermission (it runs its own DM/permission branch below), so it
	// needs the shared gate directly — see requireChannelWritable in
	// message_perms.go.
	if err := requireChannelWritable(ch); err != nil {
		return nil, false, err
	}

	var participantIDs []int64
	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, channelID)
		if dmErr != nil || !ok {
			return nil, false, fmt.Errorf("%w: not a DM participant", ErrBadRequest)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, channelID); blkErr != nil {
			return nil, false, blkErr
		}
		// Resolve the fan-out audience before mutating anything. Participants
		// are unaffected by the reaction itself, so failing here is cheap;
		// fetching this after AddReaction/RemoveReaction commits (as this
		// used to) risked a reaction persisted with no participant list to
		// broadcast it to, which reactionV2Handler would then fan out to
		// nobody while reporting success to the caller.
		ids, pErr := s.dmAudience(ctx, channelID, userID)
		if pErr != nil {
			slog.Error("MessageService.handleReaction DMAudience", "err", pErr, "channel_id", channelID)
			return nil, false, fmt.Errorf("%w: failed to resolve DM participants", ErrInternal)
		}
		participantIDs = ids
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages|permissions.AddReactions) {
		// Require READ_MESSAGES in addition to ADD_REACTIONS so a user cannot
		// react in a channel they cannot read. Mirrors checkSendPermission,
		// which requires ReadMessages|SendMessages for non-DM sends.
		return nil, false, fmt.Errorf("%w: missing ADD_REACTIONS permission", ErrForbidden)
	}

	return participantIDs, isDM, nil
}
