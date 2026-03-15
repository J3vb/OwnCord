package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/permissions"
)

// Rate limit windows.
const (
	chatRateLimit     = 10
	chatWindow        = time.Second
	typingRateLimit   = 1
	typingWindow      = 3 * time.Second
	presenceRateLimit = 1
	presenceWindow    = 10 * time.Second
	reactionRateLimit = 5
	reactionWindow    = time.Second
)

var sanitizer = bluemonday.StrictPolicy()

// HandleMessageForTest dispatches a raw WebSocket message from client c.
// Exported so ws_test package can invoke it directly without a real connection.
func (h *Hub) HandleMessageForTest(c *Client, raw []byte) {
	h.handleMessage(c, raw)
}

// handleMessage parses the envelope and dispatches to the appropriate handler.
func (h *Hub) handleMessage(c *Client, raw []byte) {
	// Periodic session expiry check: every SessionCheckInterval messages,
	// re-validate the session token. This catches sessions that are revoked or
	// expire while the WebSocket connection is still open.
	c.mu.Lock()
	c.msgCount++
	shouldCheck := c.msgCount >= SessionCheckInterval
	if shouldCheck {
		c.msgCount = 0
	}
	c.mu.Unlock()

	if shouldCheck && c.tokenHash != "" {
		sess, dbErr := h.db.GetSessionByTokenHash(c.tokenHash)
		if dbErr != nil || sess == nil || auth.IsSessionExpired(sess.ExpiresAt) {
			slog.Info("ws session expired, closing connection", "user_id", c.userID)
			h.kickClient(c)
			return
		}
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		slog.Warn("ws handleMessage invalid JSON", "user_id", c.userID, "err", err)
		c.sendMsg(buildErrorMsg("INVALID_JSON", "message must be valid JSON"))
		return
	}

	switch env.Type {
	case "chat_send":
		h.handleChatSend(c, env.ID, env.Payload)
	case "chat_edit":
		h.handleChatEdit(c, env.ID, env.Payload)
	case "chat_delete":
		h.handleChatDelete(c, env.ID, env.Payload)
	case "reaction_add":
		h.handleReaction(c, true, env.Payload)
	case "reaction_remove":
		h.handleReaction(c, false, env.Payload)
	case "typing_start":
		h.handleTyping(c, env.Payload)
	case "presence_update":
		h.handlePresence(c, env.Payload)
	case "channel_focus":
		h.handleChannelFocus(c, env.Payload)
	case "voice_join":
		h.handleVoiceJoin(c, env.Payload)
	case "voice_leave":
		h.handleVoiceLeave(c)
	case "voice_mute":
		h.handleVoiceMute(c, env.Payload)
	case "voice_deafen":
		h.handleVoiceDeafen(c, env.Payload)
	case "voice_offer", "voice_answer", "voice_ice":
		h.handleVoiceSignal(c, env.Type, env.Payload)
	case "soundboard_play":
		h.handleSoundboard(c, env.Payload)
	default:
		slog.Warn("ws handleMessage unknown type", "type", env.Type, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("UNKNOWN_TYPE", fmt.Sprintf("unknown message type: %s", env.Type)))
	}
}

// handleChatSend processes a chat_send message.
func (h *Hub) handleChatSend(c *Client, reqID string, payload json.RawMessage) {
	// Rate limit.
	ratKey := fmt.Sprintf("chat:%d", c.userID)
	if !h.limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		c.sendMsg(buildErrorMsg("RATE_LIMITED", "too many messages"))
		return
	}

	var p struct {
		ChannelID  json.Number `json:"channel_id"`
		Content    string      `json:"content"`
		ReplyTo    *int64      `json:"reply_to"`
		Attachments []string   `json:"attachments"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid chat_send payload"))
		return
	}
	channelID, err := p.ChannelID.Int64()
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "channel_id must be a positive integer"))
		return
	}

	// Check channel exists.
	ch, err := h.db.GetChannel(channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg("NOT_FOUND", "channel not found"))
		return
	}

	// Permission check.
	if !h.hasChannelPerm(c, channelID, permissions.ReadMessages|permissions.SendMessages) {
		c.sendMsg(buildErrorMsg("FORBIDDEN", "missing SEND_MESSAGES permission"))
		return
	}

	// Slow mode enforcement: moderators with MANAGE_MESSAGES bypass it.
	if ch.SlowMode > 0 && !h.hasChannelPerm(c, channelID, permissions.ManageMessages) {
		slowKey := fmt.Sprintf("slow:%d:%d", c.userID, channelID)
		if !h.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			c.sendMsg(buildErrorMsg("SLOW_MODE", fmt.Sprintf("channel has %ds slow mode", ch.SlowMode)))
			return
		}
	}

	// Sanitize and validate content length.
	content := sanitizer.Sanitize(p.Content)
	if content == "" {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "message content cannot be empty"))
		return
	}
	if len([]rune(content)) > 4000 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "message content exceeds maximum length of 4000 characters"))
		return
	}

	// Persist.
	msgID, err := h.db.CreateMessage(channelID, c.userID, content, p.ReplyTo)
	if err != nil {
		slog.Error("ws handleChatSend CreateMessage", "err", err)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to save message"))
		return
	}

	// Retrieve to get timestamp.
	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("ws handleChatSend GetMessage after create", "err", err)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to retrieve message"))
		return
	}

	var username string
	var avatar *string
	if c.user != nil {
		username = c.user.Username
		avatar = c.user.Avatar
	}

	slog.Info("message sent", "user", username, "channel_id", channelID, "msg_id", msgID)

	// Ack sender.
	c.sendMsg(buildChatSendOK(reqID, msgID, msg.Timestamp))

	// Broadcast to channel.
	broadcast := buildChatMessage(msgID, channelID, c.userID, username, avatar, content, msg.Timestamp, p.ReplyTo)
	h.BroadcastToChannel(channelID, broadcast)
}

// handleChatEdit processes a chat_edit message.
func (h *Hub) handleChatEdit(c *Client, _ string, payload json.RawMessage) {
	var p struct {
		MessageID json.Number `json:"message_id"`
		Content   string      `json:"content"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid chat_edit payload"))
		return
	}
	msgID, err := p.MessageID.Int64()
	if err != nil || msgID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "message_id must be positive integer"))
		return
	}

	content := sanitizer.Sanitize(p.Content)
	if content == "" {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "content cannot be empty"))
		return
	}

	// EditMessage checks ownership internally.
	if err := h.db.EditMessage(msgID, c.userID, content); err != nil {
		c.sendMsg(buildErrorMsg("FORBIDDEN", "cannot edit this message"))
		return
	}

	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("ws handleChatEdit GetMessage after edit", "err", err)
		return
	}

	editedAt := ""
	if msg.EditedAt != nil {
		editedAt = *msg.EditedAt
	}
	slog.Info("message edited", "user_id", c.userID, "msg_id", msgID, "channel_id", msg.ChannelID)
	h.BroadcastToChannel(msg.ChannelID, buildChatEdited(msgID, msg.ChannelID, content, editedAt))
}

// handleChatDelete processes a chat_delete message.
func (h *Hub) handleChatDelete(c *Client, _ string, payload json.RawMessage) {
	var p struct {
		MessageID json.Number `json:"message_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid chat_delete payload"))
		return
	}
	msgID, err := p.MessageID.Int64()
	if err != nil || msgID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "message_id must be positive integer"))
		return
	}

	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		c.sendMsg(buildErrorMsg("NOT_FOUND", "message not found"))
		return
	}

	isMod := h.hasChannelPerm(c, msg.ChannelID, permissions.ManageMessages)
	if err := h.db.DeleteMessage(msgID, c.userID, isMod); err != nil {
		c.sendMsg(buildErrorMsg("FORBIDDEN", "cannot delete this message"))
		return
	}

	slog.Info("message deleted", "user_id", c.userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	_ = h.db.LogAudit(c.userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))
	h.BroadcastToChannel(msg.ChannelID, buildChatDeleted(msgID, msg.ChannelID))
}

// handleReaction processes reaction_add and reaction_remove messages.
func (h *Hub) handleReaction(c *Client, add bool, payload json.RawMessage) {
	ratKey := fmt.Sprintf("reaction:%d", c.userID)
	if !h.limiter.Allow(ratKey, reactionRateLimit, reactionWindow) {
		c.sendMsg(buildErrorMsg("RATE_LIMITED", "too many reactions"))
		return
	}

	var p struct {
		MessageID json.Number `json:"message_id"`
		Emoji     string      `json:"emoji"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid reaction payload"))
		return
	}
	msgID, err := p.MessageID.Int64()
	if err != nil || msgID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "message_id must be positive integer"))
		return
	}
	if p.Emoji == "" {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "emoji cannot be empty"))
		return
	}
	if len(p.Emoji) > 32 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "emoji too long"))
		return
	}

	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		c.sendMsg(buildErrorMsg("NOT_FOUND", "message not found"))
		return
	}

	if !h.hasChannelPerm(c, msg.ChannelID, permissions.AddReactions) {
		c.sendMsg(buildErrorMsg("FORBIDDEN", "missing ADD_REACTIONS permission"))
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
		c.sendMsg(buildErrorMsg("CONFLICT", err.Error()))
		return
	}

	h.BroadcastToChannel(msg.ChannelID, buildReactionUpdate(msgID, msg.ChannelID, c.userID, p.Emoji, action))
}

// handleTyping processes a typing_start message.
func (h *Hub) handleTyping(c *Client, payload json.RawMessage) {
	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "channel_id must be positive integer"))
		return
	}

	ratKey := fmt.Sprintf("typing:%d:%d", c.userID, channelID)
	if !h.limiter.Allow(ratKey, typingRateLimit, typingWindow) {
		return // silently drop; no error for typing throttle
	}

	var username string
	if c.user != nil {
		username = c.user.Username
	}

	// Broadcast to channel, excluding sender.
	h.broadcastExclude(channelID, c.userID, buildTypingMsg(channelID, c.userID, username))
}

// handlePresence processes a presence_update message.
func (h *Hub) handlePresence(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("presence:%d", c.userID)
	if !h.limiter.Allow(ratKey, presenceRateLimit, presenceWindow) {
		c.sendMsg(buildErrorMsg("RATE_LIMITED", "too many presence updates"))
		return
	}

	var p struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid presence_update payload"))
		return
	}
	validStatuses := map[string]bool{"online": true, "idle": true, "dnd": true, "offline": true}
	if !validStatuses[p.Status] {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "status must be online|idle|dnd|offline"))
		return
	}

	if err := h.db.UpdateUserStatus(c.userID, p.Status); err != nil {
		slog.Error("ws handlePresence UpdateUserStatus", "err", err)
	}

	h.BroadcastToAll(buildPresenceMsg(c.userID, p.Status))
}

// hasChannelPerm reports whether the client's role has all the given permission bits.
// The ADMINISTRATOR bit bypasses all checks.
func (h *Hub) hasChannelPerm(c *Client, channelID int64, perm int64) bool {
	if c.user == nil {
		return false
	}
	role, err := h.db.GetRoleByID(c.user.RoleID)
	if err != nil || role == nil {
		return false
	}
	if role.Permissions&permissions.Administrator != 0 {
		return true
	}
	// Check channel overrides.
	allow, deny, err := h.db.GetChannelPermissions(channelID, role.ID)
	if err != nil {
		return false
	}
	effective := permissions.EffectivePerms(role.Permissions, allow, deny)
	return effective&perm == perm
}

// broadcastExclude sends msg to all channel members except excludeUserID.
func (h *Hub) broadcastExclude(channelID, excludeUserID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for uid, c := range h.clients {
		if uid == excludeUserID {
			continue
		}
		if channelID != 0 && c.channelID != channelID {
			continue
		}
		select {
		case c.send <- msg:
		default:
		}
	}
}

// handleChannelFocus sets which channel the client is currently viewing,
// so channel-scoped broadcasts (chat messages, typing) reach them.
func (h *Hub) handleChannelFocus(c *Client, payload json.RawMessage) {
	chID, err := parseChannelID(payload)
	if err != nil || chID <= 0 {
		return
	}
	c.mu.Lock()
	c.channelID = chID
	c.mu.Unlock()
}
