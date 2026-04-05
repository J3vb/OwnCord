package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/owncord/server/permissions"
)

// registerReactionHandlers registers reaction_add and reaction_remove V2 handlers.
func registerReactionHandlers(r *HandlerRegistry, deps ReactionDeps) {
	r.RegisterV2(MsgTypeReactionAdd, reactionV2Handler(true), deps)
	r.RegisterV2(MsgTypeReactionRemove, reactionV2Handler(false), deps)
}

// reactionV2Handler returns a V2 handler for reaction_add (add=true) or
// reaction_remove (add=false). Both share identical validation and routing.
func reactionV2Handler(add bool) HandlerV2 {
	return func(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
		d := deps.(ReactionDeps)
		userID := info.UserID

		var msgID int64
		var emoji string
		if add {
			c := cmd.(ReactionAddCmd)
			msgID = c.MessageID()
			emoji = c.Emoji()
		} else {
			c := cmd.(ReactionRemoveCmd)
			msgID = c.MessageID()
			emoji = c.Emoji()
		}

		// Rate limit.
		ratKey := fmt.Sprintf("reaction:%d", userID)
		if d.Limiter != nil && !d.Limiter.Allow(ratKey, reactionRateLimit, reactionWindow) {
			return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many reactions"}}
		}

		// Validate fields.
		if msgID <= 0 {
			return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message_id must be positive integer"}}
		}
		if emoji == "" {
			return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "emoji cannot be empty"}}
		}
		if len(emoji) > 32 {
			return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "emoji too long"}}
		}
		// Reject control characters (U+0000-U+001F, U+007F) to prevent injection.
		for _, r := range emoji {
			if r < 0x20 || r == 0x7F {
				return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "emoji contains invalid characters"}}
			}
		}
		// Sanitize HTML to prevent stored XSS via emoji field.
		if sanitized := sanitizer.Sanitize(emoji); sanitized != emoji {
			return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "emoji contains invalid characters"}}
		}

		// Look up message.
		msg, err := d.DB.GetMessage(msgID)
		if err != nil || msg == nil {
			// Normalize: same error whether message doesn't exist or is in a
			// channel the user can't see (prevents IDOR information leak).
			return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "reaction failed"}}
		}

		// BUG-126: Reject reactions on soft-deleted messages.
		if msg.Deleted {
			return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "reaction failed"}}
		}

		// Check channel type for DM-aware permission handling.
		reactCh, chErr := d.DB.GetChannel(msg.ChannelID)
		reactIsDM := chErr == nil && reactCh != nil && reactCh.Type == "dm"

		if reactIsDM {
			ok, dmErr := d.DB.IsDMParticipant(userID, msg.ChannelID)
			if dmErr != nil || !ok {
				return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "reaction failed"}}
			}
		} else {
			if denied := requirePerm(d.DB, d.Permissions, userID, msg.ChannelID, permissions.AddReactions, "ADD_REACTIONS"); denied != nil {
				return *denied
			}
		}

		// Execute reaction.
		action := "add"
		if add {
			err = d.DB.AddReaction(msgID, userID, emoji)
		} else {
			action = "remove"
			err = d.DB.RemoveReaction(msgID, userID, emoji)
		}
		if err != nil {
			// Sanitize: never leak raw DB constraint errors to client.
			slog.Warn("reaction failed", "action", action, "msg_id", msgID, "user_id", userID, "err", err)
			return Result{Error: ClientError{Code: ErrCodeConflict, Message: "reaction failed"}}
		}

		reactionPayload := buildReactionUpdate(msgID, msg.ChannelID, userID, emoji, action)
		if reactIsDM {
			participantIDs, pErr := d.DB.GetDMParticipantIDs(msg.ChannelID)
			if pErr != nil {
				slog.Error("reactionV2Handler GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
				return Result{}
			}
			return Result{Events: []Event{ReactionDMEvent{
				channelID:      msg.ChannelID,
				participantIDs: participantIDs,
				payload:        reactionPayload,
			}}}
		}
		return Result{Events: []Event{ReactionChannelEvent{
			channelID: msg.ChannelID,
			payload:   reactionPayload,
		}}}
	}
}
