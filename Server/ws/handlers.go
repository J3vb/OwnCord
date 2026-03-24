package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
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

// maxMessageLen is the maximum allowed message length in runes (Unicode code points).
const maxMessageLen = 4000

var sanitizer = bluemonday.StrictPolicy()

// HandleMessageForTest dispatches a raw WebSocket message from client c.
// Exported so ws_test package can invoke it directly without a real connection.
func (h *Hub) HandleMessageForTest(c *Client, raw []byte) {
	h.handleMessage(c, raw)
}

// HandleVoiceLeaveForTest calls handleVoiceLeave directly, simulating a
// disconnect-triggered cleanup without an explicit voice_leave message.
// Exported for ws_test package use only.
func (h *Hub) HandleVoiceLeaveForTest(c *Client) {
	h.handleVoiceLeave(c)
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
		result, dbErr := h.db.GetSessionWithBanStatus(c.tokenHash)
		if dbErr != nil || result == nil || auth.IsSessionExpired(result.ExpiresAt) {
			slog.Info("ws session expired, closing connection", "user_id", c.userID)
			h.kickClient(c)
			return
		}
		tempUser := &db.User{Banned: result.Banned, BanExpires: result.BanExpires}
		if auth.IsEffectivelyBanned(tempUser) {
			slog.Info("ws user banned, closing connection", "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
			h.kickClient(c)
			return
		}
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		c.mu.Lock()
		c.invalidCount++
		count := c.invalidCount
		c.mu.Unlock()

		slog.Warn("ws handleMessage invalid JSON", "user_id", c.userID, "err", err, "invalid_count", count)
		c.sendMsg(buildErrorMsg(ErrCodeInvalidJSON, "message must be valid JSON"))

		if count >= 10 {
			slog.Warn("ws too many invalid messages, closing connection", "user_id", c.userID, "invalid_count", count)
			h.kickClient(c)
		}
		return
	}

	// Valid parse — reset consecutive invalid counter.
	c.mu.Lock()
	c.invalidCount = 0
	c.mu.Unlock()

	// Request-scoped logger with correlation context.
	reqLog := slog.With(
		"user_id", c.userID,
		"msg_type", env.Type,
		"req_id", env.ID,
	)

	reqLog.Debug("ws ← client message")

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
	case "voice_token_refresh":
		h.handleVoiceTokenRefresh(c)
	case "voice_mute":
		h.handleVoiceMute(c, env.Payload)
	case "voice_deafen":
		h.handleVoiceDeafen(c, env.Payload)
	case "voice_camera":
		h.handleVoiceCamera(c, env.Payload)
	case "voice_screenshare":
		h.handleVoiceScreenshare(c, env.Payload)
	case "ping":
		c.sendMsg(buildJSON(map[string]any{"type": "pong"}))
	default:
		reqLog.Warn("ws handleMessage unknown type")
		c.sendMsg(buildErrorMsg(ErrCodeUnknownType, fmt.Sprintf("unknown message type: %s", env.Type)))
	}
}

// handleChatSend processes a chat_send message.
func (h *Hub) handleChatSend(c *Client, reqID string, payload json.RawMessage) {
	// Rate limit.
	ratKey := fmt.Sprintf("chat:%d", c.userID)
	if !h.limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		c.sendMsg(buildRateLimitError("too many messages", chatWindow.Seconds()))
		return
	}

	var p struct {
		ChannelID  json.Number `json:"channel_id"`
		Content    string      `json:"content"`
		ReplyTo    *int64      `json:"reply_to"`
		Attachments []string   `json:"attachments"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid chat_send payload"))
		return
	}
	channelID, err := p.ChannelID.Int64()
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be a positive integer"))
		return
	}

	// Check channel exists.
	ch, err := h.db.GetChannel(channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "channel not found"))
		return
	}

	// Permission check.
	if !h.requireChannelPerm(c, channelID, permissions.ReadMessages|permissions.SendMessages, "SEND_MESSAGES") {
		return
	}

	// Slow mode enforcement: moderators with MANAGE_MESSAGES bypass it.
	if ch.SlowMode > 0 && !h.hasChannelPerm(c, channelID, permissions.ManageMessages) {
		slowKey := fmt.Sprintf("slow:%d:%d", c.userID, channelID)
		if !h.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			c.sendMsg(buildErrorMsg(ErrCodeSlowMode, fmt.Sprintf("channel has %ds slow mode", ch.SlowMode)))
			return
		}
	}

	// Sanitize and validate content length.
	content := sanitizer.Sanitize(p.Content)
	if content == "" && len(p.Attachments) == 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message content cannot be empty"))
		return
	}
	if len([]rune(content)) > maxMessageLen {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message content exceeds maximum length of 4000 characters"))
		return
	}

	// Check attachment permission before persisting anything.
	if len(p.Attachments) > 0 {
		if !h.requireChannelPerm(c, channelID, permissions.AttachFiles, "ATTACH_FILES") {
			return
		}
	}

	// Persist message.
	msgID, err := h.db.CreateMessage(channelID, c.userID, content, p.ReplyTo)
	if err != nil {
		slog.Error("ws handleChatSend CreateMessage", "err", err)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to save message"))
		return
	}

	// Link attachments if provided.
	var attachments []map[string]any
	if len(p.Attachments) > 0 {
		linked, linkErr := h.db.LinkAttachmentsToMessage(msgID, p.Attachments)
		if linkErr != nil {
			slog.Error("ws handleChatSend LinkAttachments", "err", linkErr, "msg_id", msgID)
			// Delete the orphaned message so it doesn't persist without its attachments.
			if delErr := h.db.DeleteMessage(msgID, c.userID, true); delErr != nil {
				slog.Error("ws handleChatSend DeleteMessage (cleanup)", "err", delErr, "msg_id", msgID)
			}
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to send message with attachments"))
			return
		}
		if linked > 0 {
			attMap, attErr := h.db.GetAttachmentsByMessageIDs([]int64{msgID})
			if attErr != nil {
				slog.Error("ws handleChatSend GetAttachments", "err", attErr)
			} else {
				for _, ai := range attMap[msgID] {
					attachments = append(attachments, map[string]any{
						"id":       ai.ID,
						"filename": ai.Filename,
						"size":     ai.Size,
						"mime":     ai.Mime,
						"url":      ai.URL,
					})
				}
			}
		}
	}

	// Retrieve to get timestamp.
	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("ws handleChatSend GetMessage after create", "err", err)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to retrieve message"))
		return
	}

	var username string
	var avatar *string
	if c.user != nil {
		username = c.user.Username
		avatar = c.user.Avatar
	}

	slog.Debug("message sent", "user", username, "channel_id", channelID, "msg_id", msgID)

	// Ack sender.
	c.sendMsg(buildChatSendOK(reqID, msgID, msg.Timestamp))

	// Broadcast to channel.
	broadcast := buildChatMessage(msgID, channelID, c.userID, username, avatar, c.roleName, content, msg.Timestamp, p.ReplyTo, attachments)
	h.BroadcastToChannel(channelID, broadcast)
}

// handleChatEdit processes a chat_edit message.
func (h *Hub) handleChatEdit(c *Client, _ string, payload json.RawMessage) {
	ratKey := fmt.Sprintf("chat_edit:%d", c.userID)
	if !h.limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		c.sendMsg(buildRateLimitError("too many edits", chatWindow.Seconds()))
		return
	}

	var p struct {
		MessageID json.Number `json:"message_id"`
		Content   string      `json:"content"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid chat_edit payload"))
		return
	}
	msgID, err := p.MessageID.Int64()
	if err != nil || msgID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message_id must be positive integer"))
		return
	}

	content := sanitizer.Sanitize(p.Content)
	if content == "" {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "content cannot be empty"))
		return
	}
	if len([]rune(content)) > maxMessageLen {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message too long"))
		return
	}

	// Fetch message first to get the channel ID for the permission check.
	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "message not found"))
		return
	}

	// Re-check that the user still has SendMessages permission on this channel.
	if !h.hasChannelPerm(c, msg.ChannelID, permissions.SendMessages) {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "no send permission in this channel"))
		return
	}

	// EditMessage checks ownership internally.
	if err := h.db.EditMessage(msgID, c.userID, content); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot edit this message"))
		return
	}

	// Re-fetch to get the updated edited_at timestamp.
	msg, err = h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("ws handleChatEdit GetMessage after edit", "err", err, "msg_id", msgID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "edit saved but broadcast failed"))
		return
	}

	editedAt := ""
	if msg.EditedAt != nil {
		editedAt = *msg.EditedAt
	}
	slog.Debug("message edited", "user_id", c.userID, "msg_id", msgID, "channel_id", msg.ChannelID)
	h.BroadcastToChannel(msg.ChannelID, buildChatEdited(msgID, msg.ChannelID, content, editedAt))
}

// handleChatDelete processes a chat_delete message.
func (h *Hub) handleChatDelete(c *Client, _ string, payload json.RawMessage) {
	ratKey := fmt.Sprintf("chat_delete:%d", c.userID)
	if !h.limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		c.sendMsg(buildRateLimitError("too many deletes", chatWindow.Seconds()))
		return
	}

	var p struct {
		MessageID json.Number `json:"message_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid chat_delete payload"))
		return
	}
	msgID, err := p.MessageID.Int64()
	if err != nil || msgID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message_id must be positive integer"))
		return
	}

	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "message not found"))
		return
	}

	// Ensure the user still has at least ReadMessages on this channel.
	if !h.hasChannelPerm(c, msg.ChannelID, permissions.ReadMessages) {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "no read permission in this channel"))
		return
	}

	isMod := h.hasChannelPerm(c, msg.ChannelID, permissions.ManageMessages)
	if err := h.db.DeleteMessage(msgID, c.userID, isMod); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot delete this message"))
		return
	}

	slog.Debug("message deleted", "user_id", c.userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	_ = h.db.LogAudit(c.userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))
	h.BroadcastToChannel(msg.ChannelID, buildChatDeleted(msgID, msg.ChannelID))
}

// handleReaction processes reaction_add and reaction_remove messages.
func (h *Hub) handleReaction(c *Client, add bool, payload json.RawMessage) {
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
	// Reject control characters (U+0000–U+001F, U+007F) to prevent injection.
	for _, r := range p.Emoji {
		if r < 0x20 || r == 0x7F {
			c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "emoji contains invalid characters"))
			return
		}
	}

	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		// Normalize: return same error whether message doesn't exist or is in
		// a channel the user can't see (prevents IDOR information leak).
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "reaction failed"))
		return
	}

	if !h.requireChannelPerm(c, msg.ChannelID, permissions.AddReactions, "ADD_REACTIONS") {
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

	h.BroadcastToChannel(msg.ChannelID, buildReactionUpdate(msgID, msg.ChannelID, c.userID, p.Emoji, action))
}

// handleTyping processes a typing_start message.
func (h *Hub) handleTyping(c *Client, payload json.RawMessage) {
	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be positive integer"))
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

// requireChannelPerm checks whether the client has the given permission on the
// channel. If not, it sends a FORBIDDEN error to the client and returns false.
// The permLabel should be the human-readable permission name (e.g. "SEND_MESSAGES").
func (h *Hub) requireChannelPerm(c *Client, channelID int64, perm int64, permLabel string) bool {
	if h.hasChannelPerm(c, channelID, perm) {
		return true
	}
	slog.Warn("ws permission denied", "user_id", c.userID, "channel_id", channelID, "perm", permLabel)
	c.sendMsg(buildErrorMsg(ErrCodeForbidden, "missing "+permLabel+" permission"))
	return false
}

// broadcastExclude sends a message to all clients in the sender's channel
// EXCEPT the sender. Unlike hub.BroadcastToChannel, messages sent via this
// function are NOT stored in the replay ring buffer — they are ephemeral.
// This is correct for typing indicators but would be incorrect for messages
// that should survive reconnection replay.
func (h *Hub) broadcastExclude(channelID, excludeUserID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for uid, c := range h.clients {
		if uid == excludeUserID {
			continue
		}
		if channelID != 0 && c.getChannelID() != channelID {
			continue
		}
		c.sendMsg(msg)
	}
}

// handleChannelFocus sets which channel the client is currently viewing,
// so channel-scoped broadcasts (chat messages, typing) reach them.
// Also updates read_states so unread counts decrease when the user views a channel.
func (h *Hub) handleChannelFocus(c *Client, payload json.RawMessage) {
	chID, err := parseChannelID(payload)
	if err != nil || chID <= 0 {
		slog.Debug("handleChannelFocus: invalid channel_id", "user_id", c.userID, "err", err)
		return
	}

	// Permission check: user must have READ_MESSAGES on the target channel.
	if !h.requireChannelPerm(c, chID, permissions.ReadMessages, "READ_MESSAGES") {
		return
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
