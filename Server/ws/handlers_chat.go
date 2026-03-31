package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// registerChatHandlers registers all chat-related message handlers.
func registerChatHandlers(r *HandlerRegistry) {
	r.Register(MsgTypeChatSend, func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {
		h.handleChatSend(ctx, c, reqID, payload)
	})
	r.Register(MsgTypeChatEdit, func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {
		h.handleChatEdit(ctx, c, reqID, payload)
	})
	r.Register(MsgTypeChatDelete, func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {
		h.handleChatDelete(ctx, c, reqID, payload)
	})
}

type chatSendPayload struct {
	ChannelID   json.Number `json:"channel_id"`
	Content     string      `json:"content"`
	ReplyTo     *int64      `json:"reply_to"`
	Attachments []string    `json:"attachments"`
}

// handleChatSend processes a chat_send message.
func (h *Hub) handleChatSend(ctx context.Context, c *Client, reqID string, payload json.RawMessage) {
	ratKey := fmt.Sprintf("chat:%d", c.userID)
	if !h.limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		c.sendMsg(buildRateLimitError("too many messages", chatWindow.Seconds()))
		return
	}

	var p chatSendPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid chat_send payload"))
		return
	}
	channelID, err := p.ChannelID.Int64()
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be a positive integer"))
		return
	}

	ch, err := h.db.GetChannel(channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "channel not found"))
		return
	}

	isDM := ch.Type == "dm"
	if !h.checkChatSendPermission(c, channelID, isDM) {
		return
	}
	if !h.checkSlowMode(c, ch, channelID, isDM) {
		return
	}

	content, ok := h.validateChatContent(c, p.Content, p.Attachments)
	if !ok {
		return
	}

	if !isDM && len(p.Attachments) > 0 {
		if !h.requireChannelPerm(c, channelID, permissions.AttachFiles, "ATTACH_FILES") {
			return
		}
	}

	msgID, attachments, ok := h.persistChatMessage(c, channelID, content, p.ReplyTo, p.Attachments)
	if !ok {
		return
	}

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
	c.sendMsg(buildChatSendOK(reqID, msgID, msg.Timestamp))

	broadcast := buildChatMessage(msgID, channelID, c.userID, username, avatar, c.roleName, content, msg.Timestamp, p.ReplyTo, attachments)
	h.broadcastChatMessage(c, channelID, isDM, broadcast)
}

func (h *Hub) checkChatSendPermission(c *Client, channelID int64, isDM bool) bool {
	if isDM {
		ok, dmErr := h.db.IsDMParticipant(c.userID, channelID)
		if dmErr != nil {
			slog.Error("ws handleChatSend IsDMParticipant", "err", dmErr)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to check DM participation"))
			return false
		}
		if !ok {
			c.sendMsg(buildErrorMsg(ErrCodeForbidden, "you are not a participant in this DM"))
			return false
		}
		return true
	}
	return h.requireChannelPerm(c, channelID, permissions.ReadMessages|permissions.SendMessages, "SEND_MESSAGES")
}

func (h *Hub) checkSlowMode(c *Client, ch *db.Channel, channelID int64, isDM bool) bool {
	if isDM || ch.SlowMode <= 0 || h.hasChannelPerm(c, channelID, permissions.ManageMessages) {
		return true
	}
	slowKey := fmt.Sprintf("slow:%d:%d", c.userID, channelID)
	if !h.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
		c.sendMsg(buildErrorMsg(ErrCodeSlowMode, fmt.Sprintf("channel has %ds slow mode", ch.SlowMode)))
		return false
	}
	return true
}

func (h *Hub) validateChatContent(c *Client, raw string, attachments []string) (string, bool) {
	content := sanitizer.Sanitize(raw)
	if content == "" && len(attachments) == 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message content cannot be empty"))
		return "", false
	}
	if len([]rune(content)) > maxMessageLen {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "message content exceeds maximum length of 4000 characters"))
		return "", false
	}
	return content, true
}

func (h *Hub) persistChatMessage(c *Client, channelID int64, content string, replyTo *int64, attIDs []string) (int64, []map[string]any, bool) {
	msgID, err := h.db.CreateMessage(channelID, c.userID, content, replyTo)
	if err != nil {
		slog.Error("ws handleChatSend CreateMessage", "err", err)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to save message"))
		return 0, nil, false
	}

	attachments, ok := h.linkAttachments(c, msgID, attIDs)
	if !ok {
		return 0, nil, false
	}
	return msgID, attachments, true
}

func (h *Hub) linkAttachments(c *Client, msgID int64, attIDs []string) ([]map[string]any, bool) {
	if len(attIDs) == 0 {
		return nil, true
	}

	linked, linkErr := h.db.LinkAttachmentsToMessage(msgID, attIDs)
	if linkErr != nil {
		slog.Error("ws handleChatSend LinkAttachments", "err", linkErr, "msg_id", msgID)
		if delErr := h.db.DeleteMessage(msgID, c.userID, true); delErr != nil {
			slog.Error("ws handleChatSend DeleteMessage (cleanup)", "err", delErr, "msg_id", msgID)
		}
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to send message with attachments"))
		return nil, false
	}

	if linked == 0 {
		return nil, true
	}

	attMap, attErr := h.db.GetAttachmentsByMessageIDs([]int64{msgID})
	if attErr != nil {
		slog.Error("ws handleChatSend GetAttachments", "err", attErr)
		return nil, true
	}

	var attachments []map[string]any
	for _, ai := range attMap[msgID] {
		attachments = append(attachments, map[string]any{
			"id":       ai.ID,
			"filename": ai.Filename,
			"size":     ai.Size,
			"mime":     ai.Mime,
			"url":      ai.URL,
		})
	}
	return attachments, true
}

func (h *Hub) broadcastChatMessage(c *Client, channelID int64, isDM bool, broadcast []byte) {
	if !isDM {
		h.BroadcastToChannel(channelID, broadcast)
		return
	}

	participantIDs, pErr := h.db.GetDMParticipantIDs(channelID)
	if pErr != nil {
		slog.Error("ws handleChatSend GetDMParticipantIDs", "err", pErr, "channel_id", channelID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "message saved but delivery failed — please retry"))
		return
	}

	for _, pid := range participantIDs {
		h.SendToUser(pid, broadcast)
	}

	for _, pid := range participantIDs {
		if pid == c.userID {
			continue
		}
		if openErr := h.db.OpenDM(pid, channelID); openErr != nil {
			slog.Error("ws handleChatSend OpenDM", "err", openErr,
				"recipient_id", pid, "channel_id", channelID)
			continue
		}
		if c.user != nil {
			h.SendToUser(pid, buildDMChannelOpen(channelID, c.user))
		}
	}
}

// handleChatEdit processes a chat_edit message.
func (h *Hub) handleChatEdit(ctx context.Context, c *Client, _ string, payload json.RawMessage) {
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
	// Use an opaque error to prevent message-ID enumeration (IDOR).
	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot edit this message"))
		return
	}

	// Check channel type for DM-aware permission handling.
	editCh, chErr := h.db.GetChannel(msg.ChannelID)
	editIsDM := chErr == nil && editCh != nil && editCh.Type == "dm"

	if editIsDM {
		ok, dmErr := h.db.IsDMParticipant(c.userID, msg.ChannelID)
		if dmErr != nil || !ok {
			c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot edit this message"))
			return
		}
	} else {
		// Re-check that the user still has SendMessages permission on this channel.
		if !h.hasChannelPerm(c, msg.ChannelID, permissions.SendMessages) {
			c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot edit this message"))
			return
		}
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

	editedMsg := buildChatEdited(msgID, msg.ChannelID, content, editedAt)
	if editIsDM {
		h.broadcastToDMParticipants(msg.ChannelID, editedMsg)
	} else {
		h.BroadcastToChannel(msg.ChannelID, editedMsg)
	}
}

// handleChatDelete processes a chat_delete message.
func (h *Hub) handleChatDelete(ctx context.Context, c *Client, _ string, payload json.RawMessage) {
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

	// Use an opaque error to prevent message-ID enumeration (IDOR).
	msg, err := h.db.GetMessage(msgID)
	if err != nil || msg == nil {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot delete this message"))
		return
	}

	// Check channel type for DM-aware permission handling.
	delCh, chErr := h.db.GetChannel(msg.ChannelID)
	delIsDM := chErr == nil && delCh != nil && delCh.Type == "dm"

	if delIsDM {
		ok, dmErr := h.db.IsDMParticipant(c.userID, msg.ChannelID)
		if dmErr != nil || !ok {
			c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot delete this message"))
			return
		}
	} else {
		// Ensure the user still has at least ReadMessages on this channel.
		if !h.hasChannelPerm(c, msg.ChannelID, permissions.ReadMessages) {
			c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot delete this message"))
			return
		}
	}

	// In DMs, users can only delete their own messages (no mod override).
	isMod := !delIsDM && h.hasChannelPerm(c, msg.ChannelID, permissions.ManageMessages)
	if err := h.db.DeleteMessage(msgID, c.userID, isMod); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot delete this message"))
		return
	}

	slog.Debug("message deleted", "user_id", c.userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	_ = h.db.LogAudit(c.userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	deletedMsg := buildChatDeleted(msgID, msg.ChannelID)
	if delIsDM {
		h.broadcastToDMParticipants(msg.ChannelID, deletedMsg)
	} else {
		h.BroadcastToChannel(msg.ChannelID, deletedMsg)
	}
}
