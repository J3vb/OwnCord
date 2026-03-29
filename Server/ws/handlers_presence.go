package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/owncord/server/permissions"
)

// registerPresenceHandlers registers presence, typing, and channel focus handlers.
func registerPresenceHandlers(r *HandlerRegistry) {
	r.Register(MsgTypeTypingStart, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleTyping(ctx, c, payload)
	})
	r.Register(MsgTypePresenceUpdate, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handlePresence(ctx, c, payload)
	})
	r.Register(MsgTypeChannelFocus, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleChannelFocus(ctx, c, payload)
	})
}

// handleTyping processes a typing_start message.
func (h *Hub) handleTyping(ctx context.Context, c *Client, payload json.RawMessage) {
	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be positive integer"))
		return
	}

	ratKey := fmt.Sprintf("typing:%d:%d", c.userID, channelID)
	if !h.limiter.Allow(ratKey, typingRateLimit, typingWindow) {
		return // silently drop; no error for typing throttle
	}

	// DM channels require participant check instead of role-based permissions.
	typCh, typChErr := h.db.GetChannel(channelID)
	if typChErr != nil || typCh == nil {
		return // silently drop for unknown channels
	}
	if typCh.Type == "dm" {
		ok, dmErr := h.db.IsDMParticipant(c.userID, channelID)
		if dmErr != nil || !ok {
			return // silently drop — not a DM participant
		}
	} else {
		if !h.hasChannelPerm(c, channelID, permissions.ReadMessages) {
			return // silently drop — no read permission on this channel
		}
	}

	var username string
	if c.user != nil {
		username = c.user.Username
	}

	// Broadcast to channel, excluding sender.
	if typCh.Type == "dm" {
		h.broadcastToDMParticipantsExclude(channelID, c.userID, buildTypingMsg(channelID, c.userID, username))
	} else {
		h.broadcastExclude(channelID, c.userID, buildTypingMsg(channelID, c.userID, username))
	}
}

// handlePresence processes a presence_update message.
func (h *Hub) handlePresence(ctx context.Context, c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("presence:%d", c.userID)
	if !h.limiter.Allow(ratKey, presenceRateLimit, presenceWindow) {
		c.sendMsg(buildRateLimitError("too many presence updates", presenceWindow.Seconds()))
		return
	}

	var p struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid presence_update payload"))
		return
	}
	validStatuses := map[string]bool{"online": true, "idle": true, "dnd": true, "offline": true}
	if !validStatuses[p.Status] {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "status must be online|idle|dnd|offline"))
		return
	}

	if err := h.db.UpdateUserStatus(c.userID, p.Status); err != nil {
		slog.Error("ws handlePresence UpdateUserStatus", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to update status"))
		return
	}

	h.BroadcastToAll(buildPresenceMsg(c.userID, p.Status))
}

// handleChannelFocus sets which channel the client is currently viewing,
// so channel-scoped broadcasts (chat messages, typing) reach them.
// Also updates read_states so unread counts decrease when the user views a channel.
func (h *Hub) handleChannelFocus(ctx context.Context, c *Client, payload json.RawMessage) {
	chID, err := parseChannelID(payload)
	if err != nil || chID <= 0 {
		slog.Debug("handleChannelFocus: invalid channel_id", "user_id", c.userID, "err", err)
		return
	}

	// DM channels use participant-based auth instead of role-based permissions.
	ch, chErr := h.db.GetChannel(chID)
	if chErr != nil || ch == nil {
		slog.Debug("handleChannelFocus: channel not found", "channel_id", chID)
		return
	}
	if ch.Type == "dm" {
		ok, dmErr := h.db.IsDMParticipant(c.userID, chID)
		if dmErr != nil || !ok {
			c.sendMsg(buildErrorMsg(ErrCodeForbidden, "not a participant in this DM"))
			return
		}
	} else {
		if !h.requireChannelPerm(c, chID, permissions.ReadMessages, "READ_MESSAGES") {
			return
		}
	}

	c.mu.Lock()
	prevCh := c.channelID
	c.channelID = chID
	c.mu.Unlock()

	slog.Debug("channel_focus", "user_id", c.userID, "channel_id", chID, "prev_channel_id", prevCh)

	// Mark channel as read by updating read_states to the latest message.
	latestID, latestErr := h.db.GetLatestMessageID(chID)
	if latestErr == nil && latestID > 0 {
		if rsErr := h.db.UpdateReadState(c.userID, chID, latestID); rsErr != nil {
			slog.Warn("handleChannelFocus UpdateReadState", "err", rsErr, "user_id", c.userID, "channel_id", chID)
		}
	}
}
