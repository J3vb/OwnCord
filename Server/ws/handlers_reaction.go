package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/owncord/server/permissions"
)

// registerReactionHandlers registers reaction_add and reaction_remove handlers.
func registerReactionHandlers(r *HandlerRegistry) {
	r.Register(MsgTypeReactionAdd, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleReaction(ctx, c, true, payload)
	})
	r.Register(MsgTypeReactionRemove, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleReaction(ctx, c, false, payload)
	})
}

// handleReaction processes reaction_add and reaction_remove messages.
func (h *Hub) handleReaction(_ context.Context, c *Client, add bool, payload json.RawMessage) {
	ratKey := fmt.Sprintf("reaction:%d", c.userID)
	if !h.limiter.Allow(ratKey, reactionRateLimit, reactionWindow) {
		c.sendMsg(buildRateLimitError("too many reactions", reactionWindow.Seconds()))
		return
	}

	var p struct {
		MessageID json.Number `json:"message_id"`
		Emoji     string      `json:"emoji"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid reaction payload"))
		return
	}
	msgID, err := p.MessageID.Int64()
	if err != nil || msgID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message_id must be positive integer"))
		return
	}
	if p.Emoji == "" {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "emoji cannot be empty"))
		return
	}
	if len(p.Emoji) > 32 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "emoji too long"))
		return
	}
	// Reject control characters (U+0000-U+001F, U+007F) to prevent injection.
	for _, r := range p.Emoji {
		if r < 0x20 || r == 0x7F {
			c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "emoji contains invalid characters"))
			return
		}
	}
	// Sanitize HTML to prevent stored XSS via emoji field.
	if sanitized := sanitizer.Sanitize(p.Emoji); sanitized != p.Emoji {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "emoji contains invalid characters"))
		return
	}

	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		// Normalize: return same error whether message doesn't exist or is in
		// a channel the user can't see (prevents IDOR information leak).
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "reaction failed"))
		return
	}

	// Check channel type for DM-aware permission handling.
	reactCh, chErr := h.db.GetChannel(msg.ChannelID)
	reactIsDM := chErr == nil && reactCh != nil && reactCh.Type == "dm"

	if reactIsDM {
		ok, dmErr := h.db.IsDMParticipant(c.userID, msg.ChannelID)
		if dmErr != nil || !ok {
			c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "reaction failed"))
			return
		}
	} else if !h.requireChannelPerm(c, msg.ChannelID, permissions.AddReactions, "ADD_REACTIONS") {
		return
	}

	action := "add"
	if add {
		err = h.db.AddReaction(msgID, c.userID, p.Emoji)
	} else {
		action = "remove"
		err = h.db.RemoveReaction(msgID, c.userID, p.Emoji)
	}
	if err != nil {
		// Sanitize: never leak raw DB constraint errors to client.
		slog.Warn("reaction failed", "action", action, "msg_id", msgID, "user_id", c.userID, "err", err)
		c.sendMsg(buildErrorMsg(ErrCodeConflict, "reaction failed"))
		return
	}

	reactionMsg := buildReactionUpdate(msgID, msg.ChannelID, c.userID, p.Emoji, action)
	if reactIsDM {
		h.broadcastToDMParticipants(msg.ChannelID, reactionMsg)
	} else {
		h.BroadcastToChannel(msg.ChannelID, reactionMsg)
	}
}
